/**
 * NxBridge — Siemens NX Camera Bridge
 * Same pattern as SolidWorks/Inventor: launches NxBridge.exe, connects via named pipe.
 */

import { CadBridge, CameraFrame, BridgeStatus } from './CadBridge';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';

export class NxBridge implements CadBridge {
  readonly name = 'NX (Siemens)';
  private process: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private buffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private _status: BridgeStatus = 'stopped';
  private frameCallback: ((frame: CameraFrame) => void) | null = null;
  private statusCallback: ((status: BridgeStatus, detail?: string) => void) | null = null;

  get status(): BridgeStatus { return this._status; }

  private get exePath(): string {
    const packaged = path.join((process as any).resourcesPath ?? '', 'nx-bridge', 'NxBridge.exe');
    if (fs.existsSync(packaged)) return packaged;
    return path.join(__dirname, '..', '..', '..', '..', 'nx-bridge', 'bin', 'NxBridge.exe');
  }

  async start(): Promise<void> {
    this._status = 'connecting';
    this.statusCallback?.('connecting', 'Launching NxBridge.exe...');

    if (!fs.existsSync(this.exePath)) {
      this._status = 'not-installed';
      this.statusCallback?.('not-installed', `NxBridge.exe not found at: ${this.exePath}`);
      return;
    }

    this.process = spawn(this.exePath, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    this.process.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        if (line.startsWith('STATUS:')) {
          const msg = line.slice(7).trim();
          console.log('[NxBridge]', msg);
          if (msg.startsWith('Waiting for NX')) this._status = 'connecting';
          else if (msg.startsWith('Connected to NX')) { this._status = 'live'; this.statusCallback?.('live'); }
          else if (msg.startsWith('NX disconnected')) this._status = 'connecting';
        }
      }
    });

    this.process.stderr?.on('data', (d: Buffer) => console.error('[NxBridge stderr]', d.toString()));
    this.process.on('exit', (code) => {
      if (this._status !== 'stopped') { this._status = 'error'; this.statusCallback?.('error', `Exited ${code}`); }
    });

    setTimeout(() => this.connectPipe(), 2000);
  }

  stop(): void {
    this._status = 'stopped'; this.statusCallback?.('stopped');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy(); this.socket = null;
    this.process?.kill(); this.process = null;
  }

  onFrame(cb: (frame: CameraFrame) => void): void { this.frameCallback = cb; }
  onStatus(cb: (status: BridgeStatus, detail?: string) => void): void { this.statusCallback = cb; }

  private connectPipe(attempt = 0): void {
    if (this._status === 'stopped') return;
    const sock = net.connect('\\\\.\\pipe\\hanomi_nx_camera');

    sock.on('connect', () => { this.socket = sock; this.buffer = ''; });
    sock.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const f = JSON.parse(line);
          this.frameCallback?.({
            rotation: Array.from(f.r || []),
            scale: f.s || 1,
            panX: f.scx || 0, panY: f.scy || 0,
            viewportWidth: f.vw || 1920, viewportHeight: f.vh || 1080,
            dpi: f.dpi || 96, isZUp: true, timestamp: f.ts || Date.now(),
          });
        } catch {}
      }
    });
    sock.on('error', () => {
      if (this._status === 'stopped') return;
      if (attempt < 30) this.reconnectTimer = setTimeout(() => this.connectPipe(attempt + 1), 500);
      else { this._status = 'error'; this.statusCallback?.('error', 'Pipe connect failed'); }
    });
    sock.on('close', () => {
      this.socket = null;
      if (this._status !== 'stopped') this.reconnectTimer = setTimeout(() => this.connectPipe(), 1000);
    });
  }
}
