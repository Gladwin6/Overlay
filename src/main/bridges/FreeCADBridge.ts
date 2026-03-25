/**
 * FreeCADBridge — FreeCAD Camera Bridge
 *
 * Unlike COM-based bridges, FreeCAD uses a Python script that streams
 * camera data over a TCP socket (port 3461). The Python script runs
 * inside FreeCAD's Python environment.
 *
 * This TypeScript wrapper connects to the TCP socket and parses frames.
 */

import { CadBridge, CameraFrame, BridgeStatus } from './CadBridge';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';

const FREECAD_BRIDGE_PORT = 3461;

export class FreeCADBridge implements CadBridge {
  readonly name = 'FreeCAD';
  private socket: net.Socket | null = null;
  private buffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private _status: BridgeStatus = 'stopped';
  private frameCallback: ((frame: CameraFrame) => void) | null = null;
  private statusCallback: ((status: BridgeStatus, detail?: string) => void) | null = null;

  get status(): BridgeStatus { return this._status; }

  /**
   * Path to the Python bridge script (for display/instructions to user).
   * The user must run this inside FreeCAD manually or via macro.
   */
  get scriptPath(): string {
    const packaged = path.join((process as any).resourcesPath ?? '', 'freecad-bridge', 'freecad_bridge.py');
    if (fs.existsSync(packaged)) return packaged;
    return path.join(__dirname, '..', '..', '..', '..', 'freecad-bridge', 'freecad_bridge.py');
  }

  async start(): Promise<void> {
    this._status = 'connecting';
    this.statusCallback?.('connecting', `Connecting to FreeCAD bridge on port ${FREECAD_BRIDGE_PORT}...`);

    // FreeCAD bridge is a Python script that the user runs inside FreeCAD.
    // We just connect to the TCP socket it creates.
    this.connectTcp();
  }

  stop(): void {
    this._status = 'stopped';
    this.statusCallback?.('stopped');
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.socket?.destroy(); this.socket = null;
  }

  onFrame(callback: (frame: CameraFrame) => void): void {
    this.frameCallback = callback;
  }

  onStatus(callback: (status: BridgeStatus, detail?: string) => void): void {
    this.statusCallback = callback;
  }

  private connectTcp(attempt = 0): void {
    if (this._status === 'stopped') return;

    const sock = net.connect({ host: '127.0.0.1', port: FREECAD_BRIDGE_PORT });

    sock.on('connect', () => {
      console.log('[FreeCADBridge] TCP connected');
      this.socket = sock;
      this.buffer = '';
      this._status = 'live';
      this.statusCallback?.('live', 'Connected to FreeCAD bridge');
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
            isZUp: true, // FreeCAD is Z-up
            timestamp: frame.ts || Date.now(),
          });
        } catch { /* skip malformed */ }
      }
    });

    sock.on('error', () => {
      if (this._status === 'stopped') return;
      if (attempt < 60) {
        // Retry more times since user may need to start the Python script manually
        this.reconnectTimer = setTimeout(() => this.connectTcp(attempt + 1), 2000);
      } else {
        this._status = 'error';
        this.statusCallback?.('error',
          `Could not connect to FreeCAD bridge on port ${FREECAD_BRIDGE_PORT}. ` +
          `Please run freecad_bridge.py inside FreeCAD.`
        );
      }
    });

    sock.on('close', () => {
      this.socket = null;
      if (this._status !== 'stopped') {
        this._status = 'connecting';
        this.statusCallback?.('connecting', 'FreeCAD bridge disconnected — reconnecting...');
        this.reconnectTimer = setTimeout(() => this.connectTcp(), 2000);
      }
    });
  }
}
