/**
 * Fusion360Bridge — Connects to the Fusion 360 Python add-in (fusion_bridge.py)
 * via TCP socket on port 3460 and streams camera frames.
 *
 * Fusion 360 uses a Python API (not COM), so the bridge is a Python add-in
 * that runs inside Fusion and acts as a TCP server.  This TypeScript side
 * is the TCP client.
 */

import { CadBridge, CameraFrame, BridgeStatus } from './CadBridge';
import * as net from 'net';

const TCP_PORT = 3460;
const TCP_HOST = '127.0.0.1';
const MAX_RECONNECT_ATTEMPTS = 60;   // ~30 seconds at 500ms intervals
const RECONNECT_DELAY_MS = 500;

export class Fusion360Bridge implements CadBridge {
  readonly name = 'Fusion 360';
  private socket: net.Socket | null = null;
  private buffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private _status: BridgeStatus = 'stopped';
  private frameCallback: ((frame: CameraFrame) => void) | null = null;
  private statusCallback: ((status: BridgeStatus, detail?: string) => void) | null = null;

  get status(): BridgeStatus { return this._status; }

  async start(): Promise<void> {
    this._status = 'connecting';
    this.statusCallback?.('connecting', `Connecting to Fusion 360 bridge on port ${TCP_PORT}...`);
    this.connectTcp();
  }

  stop(): void {
    this._status = 'stopped';
    this.statusCallback?.('stopped');
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.socket) { this.socket.destroy(); this.socket = null; }
  }

  onFrame(cb: (frame: CameraFrame) => void): void { this.frameCallback = cb; }
  onStatus(cb: (status: BridgeStatus, detail?: string) => void): void { this.statusCallback = cb; }

  // ---------------------------------------------------------------------------
  // TCP client
  // ---------------------------------------------------------------------------

  private connectTcp(attempt = 0): void {
    if (this._status === 'stopped') return;

    const sock = net.connect({ host: TCP_HOST, port: TCP_PORT });

    sock.on('connect', () => {
      this.socket = sock;
      this.buffer = '';
      this._status = 'live';
      this.statusCallback?.('live', 'Connected to Fusion 360');
      console.log('[Fusion360Bridge] Connected');
    });

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
            panX: f.scx || 0,
            panY: f.scy || 0,
            viewportWidth: f.vw || 1920,
            viewportHeight: f.vh || 1080,
            dpi: f.dpi || 96,
            isZUp: true,  // Fusion 360 is Z-up
            timestamp: f.ts || Date.now(),
          });
        } catch { /* skip malformed lines */ }
      }
    });

    sock.on('error', () => {
      if (this._status === 'stopped') return;
      if (attempt < MAX_RECONNECT_ATTEMPTS) {
        this._status = 'connecting';
        this.statusCallback?.('connecting', `Retrying (${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
        this.reconnectTimer = setTimeout(() => this.connectTcp(attempt + 1), RECONNECT_DELAY_MS);
      } else {
        this._status = 'error';
        this.statusCallback?.('error', `Could not connect to Fusion bridge on port ${TCP_PORT}. Is the add-in running?`);
      }
    });

    sock.on('close', () => {
      this.socket = null;
      if (this._status !== 'stopped') {
        this._status = 'connecting';
        this.statusCallback?.('connecting', 'Fusion 360 disconnected — reconnecting...');
        this.reconnectTimer = setTimeout(() => this.connectTcp(), 1000);
      }
    });
  }
}
