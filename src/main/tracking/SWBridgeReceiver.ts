/**
 * SWBridgeReceiver
 *
 * Launches SwBridge.exe, connects to its named pipe, and streams camera data
 * from SolidWorks to the rest of the Electron main process.
 *
 * The bridge sends one JSON line per frame (~60 fps):
 *   r[9]  — 3×3 rotation matrix (column-major)
 *   s     — zoom scale
 *   tx/ty/tz — pan translation (model units)
 *   vw/vh — viewport dimensions
 *   ts    — Unix ms timestamp
 */

import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';

export interface SWCameraFrame {
  /** 9-element rotation matrix, row-major: row0=camRight, row1=camUp, row2=camBack */
  r:   number[];
  /** SolidWorks Scale2 (zoom factor) */
  s:   number;
  /** View-space translation of world origin (metres) */
  tx: number;
  ty: number;
  tz: number;
  /** Full 4×4 view matrix row-major: [R|t; 0 1] in SW world space (Z-up) */
  mv: number[];
  /** Viewport size in logical pixels */
  vw: number;
  vh: number;
  /** Logical display DPI (e.g. 96, 120, 144) */
  dpi: number;
  /** Model bounding-box centre offset from viewport centre, logical px (right=+, down=+) */
  scx: number;
  scy: number;
  /** Unix ms timestamp */
  ts: number;
}

export type SWBridgeStatus =
  | 'stopped'
  | 'launching'
  | 'connecting_pipe'
  | 'waiting_sw'
  | 'live'
  | 'error';

export class SWBridgeReceiver {
  private process: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private buffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private _status: SWBridgeStatus = 'stopped';

  private onFrame:  ((frame: SWCameraFrame) => void) | null = null;
  private onStatus: ((status: SWBridgeStatus, detail?: string) => void) | null = null;

  /** Path to SwBridge.exe — looks next to the main bundle, then in sw-bridge/bin */
  private get exePath(): string {
    // In packaged app: resources/sw-bridge/SwBridge.exe
    const packaged = path.join((process as any).resourcesPath ?? '', 'sw-bridge', 'SwBridge.exe');
    if (fs.existsSync(packaged)) return packaged;

    // In development: sw-bridge/bin/SwBridge.exe (relative to project root)
    const dev = path.join(__dirname, '..', '..', '..', '..', 'sw-bridge', 'bin', 'SwBridge.exe');
    return dev;
  }

  start(
    onFrame:  (frame: SWCameraFrame) => void,
    onStatus: (status: SWBridgeStatus, detail?: string) => void,
  ): void {
    this.onFrame  = onFrame;
    this.onStatus = onStatus;
    this.launchAndConnect();
  }

  stop(): void {
    this.setStatus('stopped');
    this.cleanup();
  }

  get status(): SWBridgeStatus { return this._status; }

  // ── Private ───────────────────────────────────────────────────────

  private setStatus(s: SWBridgeStatus, detail?: string) {
    this._status = s;
    this.onStatus?.(s, detail);
  }

  private launchAndConnect(): void {
    if (!fs.existsSync(this.exePath)) {
      this.setStatus('error', `SwBridge.exe not found at: ${this.exePath}\nRun sw-bridge/build.ps1 first.`);
      return;
    }

    this.setStatus('launching');

    // Launch the bridge exe
    this.process = spawn(this.exePath, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('STATUS:')) {
          const msg = line.slice(7).trim();
          console.log('[SwBridge]', msg);
          if (msg.startsWith('Waiting for SolidWorks')) this.setStatus('waiting_sw');
          else if (msg.startsWith('Connected to SolidWorks')) this.setStatus('live');
          else if (msg.startsWith('Reconnected'))            this.setStatus('live');
          else if (msg.startsWith('SolidWorks disconnected'))this.setStatus('waiting_sw');
        }
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error('[SwBridge stderr]', data.toString());
    });

    this.process.on('exit', (code) => {
      console.log(`[SwBridge] Process exited (code ${code})`);
      if (this._status !== 'stopped') {
        this.setStatus('error', `Bridge process exited with code ${code}`);
      }
    });

    // Give the exe time to start and create the pipe server
    this.setStatus('connecting_pipe');
    this.reconnectTimer = setTimeout(() => this.connectPipe(), 2000);
  }

  private connectPipe(attempt = 0): void {
    if (this._status === 'stopped') return;

    const PIPE_PATH = '\\\\.\\pipe\\hanomi_sw_camera';

    const sock = net.connect(PIPE_PATH);

    sock.on('connect', () => {
      console.log('[SwBridge] Pipe connected');
      this.socket = sock;
      this.buffer = '';
      // Status will be updated by bridge stdout
    });

    sock.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line) as SWCameraFrame;
          this.onFrame?.(frame);
        } catch { /* skip malformed */ }
      }
    });

    sock.on('error', () => {
      if (this._status === 'stopped') return;
      if (attempt < 30) {
        // Retry — exe may still be starting
        this.reconnectTimer = setTimeout(() => this.connectPipe(attempt + 1), 500);
      } else {
        this.setStatus('error', 'Could not connect to bridge pipe — check that SwBridge.exe is running');
      }
    });

    sock.on('close', () => {
      this.socket = null;
      if (this._status !== 'stopped') {
        this.setStatus('connecting_pipe');
        this.reconnectTimer = setTimeout(() => this.connectPipe(), 1000);
      }
    });
  }

  private cleanup(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.socket?.destroy();   this.socket   = null;
    this.process?.kill();     this.process  = null;
    this.onFrame  = null;
    this.onStatus = null;
    this.buffer   = '';
  }
}
