/**
 * ModelPoseTracker — Orchestrator for model-based pose estimation.
 *
 * Routes viewport frames to the pose-worker thread at 2fps (every 5th frame).
 * Emits 'modelPoseUpdate' events with absolute pose results.
 * Manages the pose-worker lifecycle and database loading.
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { ModelPoseResult } from '../../shared/types';
import type { PoseDescriptor } from './PoseDatabase';

export class ModelPoseTracker extends EventEmitter {
  private worker: Worker | null = null;
  private frameCount = 0;
  private _databaseReady = false;
  private _active = false;

  /** How often to run pose matching (every Nth viewport frame) */
  private readonly MATCH_INTERVAL = 5;  // 10fps / 5 = 2fps

  get databaseReady(): boolean { return this._databaseReady; }
  get active(): boolean { return this._active; }

  /** Start the pose worker thread */
  start(): void {
    if (this.worker) return;

    const workerPath = path.resolve(__dirname, 'pose-worker.js');
    console.log('[ModelPose] Worker path:', workerPath);
    this.worker = new Worker(workerPath);

    this.worker.on('message', (msg: any) => {
      switch (msg.type) {
        case 'databaseLoaded':
          this._databaseReady = msg.size > 0;
          console.log(`[ModelPose] Database ${this._databaseReady ? 'loaded' : 'cleared'}: ${msg.size} entries`);
          this.emit('databaseStatus', this._databaseReady ? 'ready' : 'empty');
          break;

        case 'pose':
          this.emit('modelPoseUpdate', msg.result as ModelPoseResult);
          break;

        case 'noPose':
          // Silently skip — optical flow handles inter-frame tracking
          if (this.frameCount % 50 === 0) {
            console.log(`[ModelPose] No pose: ${msg.reason}`);
          }
          break;

        case 'error':
          console.error(`[ModelPose] Worker error: ${msg.message}`);
          this.emit('error', new Error(msg.message));
          break;
      }
    });

    this.worker.on('error', (err) => {
      console.error('[ModelPose] Worker crashed:', err);
      this.emit('error', err);
    });

    this.worker.on('exit', (code) => {
      console.log(`[ModelPose] Worker exited (code ${code})`);
      this.worker = null;
      // Auto-restart if still active and was running (not intentionally stopped)
      if (this._active && code !== 0) {
        console.log('[ModelPose] Auto-restarting worker...');
        setTimeout(() => this.start(), 500);
      }
    });

    this._active = true;
    this.frameCount = 0;
    console.log('[ModelPose] Started');
  }

  /** Stop the pose worker */
  stop(): void {
    this._active = false;
    this._databaseReady = false;
    this.frameCount = 0;

    if (this.worker) {
      this.worker.postMessage({ type: 'reset' });
      this.worker.terminate();
      this.worker = null;
    }

    console.log('[ModelPose] Stopped');
  }

  /** Load precomputed database descriptors into the worker */
  loadDatabase(descriptors: PoseDescriptor[]): void {
    // Auto-start worker if needed (database can arrive before tracking starts)
    if (!this.worker) {
      console.log('[ModelPose] Auto-starting worker to receive database');
      this.start();
    }
    this.worker!.postMessage({ type: 'loadDatabase', descriptors });
  }

  /**
   * Push a viewport frame for processing.
   * Called by CVTracker on every viewport frame.
   * Only processes every Nth frame (2fps) — skips the rest.
   */
  pushFrame(grayBuffer: ArrayBuffer | Buffer, width: number, height: number): void {
    if (!this._active || !this.worker || !this._databaseReady) return;

    this.frameCount++;
    if (this.frameCount % this.MATCH_INTERVAL !== 0) return;

    // Send frame to worker (isolate ArrayBuffer to avoid Buffer pool sharing issues)
    const buf = Buffer.isBuffer(grayBuffer)
      ? (grayBuffer as Buffer)
      : Buffer.from(grayBuffer as ArrayBuffer);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    this.worker.postMessage({ type: 'frame', data: ab, width, height });
  }

  /** Clean up resources */
  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }
}
