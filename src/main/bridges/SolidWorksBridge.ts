/**
 * SolidWorksBridge — Wraps the existing SWBridgeReceiver (SwBridge.exe)
 * as a CadBridge implementation.
 *
 * SwBridge.exe connects to SolidWorks via COM and streams camera data
 * over a named pipe at ~60fps.
 */

import { CadBridge, CameraFrame, BridgeStatus } from './CadBridge';
import { SWBridgeReceiver } from '../tracking/SWBridgeReceiver';

export class SolidWorksBridge implements CadBridge {
  readonly name = 'SolidWorks';
  private receiver: SWBridgeReceiver | null = null;
  private _status: BridgeStatus = 'stopped';
  private frameCallback: ((frame: CameraFrame) => void) | null = null;
  private statusCallback: ((status: BridgeStatus, detail?: string) => void) | null = null;

  get status(): BridgeStatus { return this._status; }

  async start(): Promise<void> {
    this._status = 'connecting';
    this.statusCallback?.('connecting', 'Launching SwBridge.exe...');

    try {
      this.receiver = new SWBridgeReceiver();
    } catch (err: any) {
      this._status = 'error';
      this.statusCallback?.('error', 'Failed to create SWBridgeReceiver: ' + err.message);
      return;
    }

    try {
    this.receiver.start(
      // Frame callback — convert SW format to standard CameraFrame
      (swFrame: any) => {
        if (!this.frameCallback) return;
        this.frameCallback({
          rotation: Array.from(swFrame.r || []),
          scale: swFrame.s || 1,
          panX: swFrame.scx || 0,
          panY: swFrame.scy || 0,
          viewportWidth: swFrame.vw || 1920,
          viewportHeight: swFrame.vh || 1080,
          dpi: swFrame.dpi || 96,
          isZUp: true, // SolidWorks is always Z-up
          timestamp: swFrame.ts || Date.now(),
        });
      },
      // Status callback
      (status: string, detail?: string) => {
        if (status === 'live') {
          this._status = 'live';
          this.statusCallback?.('live', detail);
        } else if (status === 'error') {
          this._status = 'error';
          this.statusCallback?.('error', detail);
        } else if (status === 'stopped') {
          this._status = 'stopped';
          this.statusCallback?.('stopped', detail);
        } else {
          this.statusCallback?.(this._status, detail);
        }
      }
    );
    } catch (err: any) {
      this._status = 'error';
      this.statusCallback?.('error', 'Bridge start failed: ' + err.message);
    }
  }

  stop(): void {
    this.receiver?.stop();
    this.receiver = null;
    this._status = 'stopped';
    this.statusCallback?.('stopped');
  }

  onFrame(callback: (frame: CameraFrame) => void): void {
    this.frameCallback = callback;
  }

  onStatus(callback: (status: BridgeStatus, detail?: string) => void): void {
    this.statusCallback = callback;
  }
}
