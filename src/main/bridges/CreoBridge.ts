/**
 * CreoBridge — PTC Creo Camera Bridge
 * Same pattern as NX/Inventor: launches CreoBridge.exe, connects via named pipe.
 */

import { CadBridge, CameraFrame, BridgeStatus } from './CadBridge';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';

export class CreoBridge implements CadBridge {
  readonly name = 'Creo (PTC)';
  private process: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private buffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private _status: BridgeStatus = 'stopped';
  private frameCallback: ((frame: CameraFrame) => void) | null = null;
  private statusCallback: ((status: BridgeStatus, detail?: string) => void) | null = null;

  get status(): BridgeStatus { return this._status; }

  private get exePath(): string {
    const packaged = path.join((process as any).resourcesPath ?? '', 'creo-bridge', 'CreoBridge.exe');
    if (fs.existsSync(packaged)) return packaged;
    return path.join(__dirname, '..', '..', '..', '..', 'creo-bridge', 'bin', 'CreoBridge.exe');
  }

  async start(): Promise<void> {
    this._status = 'connecting';
    this.statusCallback?.('connecting', 'Launching CreoBridge.exe...');

    if (!fs.existsSync(this.exePath)) {
      this._status = 'not-installed';
      this.statusCallback?.('not-installed', `CreoBridge.exe not found at: ${this.exePath}`);
      return;
    }

    this.process = spawn(this.exePath, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        if (line.startsWith('STATUS:')) {
          const msg = line.slice(7).trim();
          console.log('[CreoBridge]', msg);
          if (msg.startsWith('Waiting for Creo')) this._status = 'connecting';
          else if (msg.startsWith('Connected to Creo')) {
            this._status = 'live';
            this.statusCallback?.('live');
          }
          else if (msg.startsWith('Creo disconnected')) this._status = 'connecting';
        }
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error('[CreoBridge stderr]', data.toString());
    });

    this.process.on('exit', (code) => {
      console.log(`[CreoBridge] Process exited (code ${code})`);
      if (this._status !== 'stopped') {
        this._status = 'error';
        this.statusCallback?.('error', `Bridge process exited with code ${code}`);
      }
    });

    setTimeout(() => this.connectPipe(), 2000);
  }

  stop(): void {
    this._status = 'stopped';
    this.statusCallback?.('stopped');
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.socket?.destroy(); this.socket = null;
    this.process?.kill(); this.process = null;
  }

  onFrame(callback: (frame: CameraFrame) => void): void {
    this.frameCallback = callback;
  }

  onStatus(callback: (status: BridgeStatus, detail?: string) => void): void {
    this.statusCallback = callback;
  }

  private connectPipe(attempt = 0): void {
    if (this._status === 'stopped') return;
    const PIPE_PATH = '\\\\.\\pipe\\hanomi_creo_camera';
    const sock = net.connect(PIPE_PATH);

    sock.on('connect', () => {
      console.log('[CreoBridge] Pipe connected');
      this.socket = sock;
      this.buffer = '';
    });

    sock.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          this.frameCallback?.({
            rotation: Array.from(frame.r || []),
            scale: frame.s || 1,
            panX: frame.scx || 0,
            panY: frame.scy || 0,
            viewportWidth: frame.vw || 1920,
            viewportHeight: frame.vh || 1080,
            dpi: frame.dpi || 96,
            isZUp: true, // Creo is Z-up
            timestamp: frame.ts || Date.now(),
          });
        } catch { /* skip malformed */ }
      }
    });

    sock.on('error', () => {
      if (this._status === 'stopped') return;
      if (attempt < 30) {
        this.reconnectTimer = setTimeout(() => this.connectPipe(attempt + 1), 500);
      } else {
        this._status = 'error';
        this.statusCallback?.('error', 'Could not connect to Creo bridge pipe');
      }
    });

    sock.on('close', () => {
      this.socket = null;
      if (this._status !== 'stopped') {
        this.reconnectTimer = setTimeout(() => this.connectPipe(), 1000);
      }
    });
  }
}
