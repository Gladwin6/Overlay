/**
 * CV Tracker — Core orchestrator for computer vision-based viewport tracking.
 *
 * Architecture (v3 — dual-mask):
 *   1. Renderer crops two regions from the video stream:
 *      a. View cube crop (RGBA, ~120x120px) → CAPTURE_VIEWCUBE_FRAME
 *      b. Viewport crop (grayscale, ~800x600px) → CAPTURE_VIEWPORT_FRAME
 *   2. View cube frames → ViewCubeTracker → absolute rotation (no drift)
 *   3. Viewport frames → cv-worker (optical flow) → relative pan/zoom only
 *   4. Combined: absolute rotation + relative pan/zoom → alignment updates
 *
 * Falls back to legacy full-screen mode (CAPTURE_FRAME) if no ROI regions defined.
 *
 * Motion state machine for settle refinement:
 *   ACTIVE → SETTLING (3 low-flow frames) → IDLE (high-accuracy pass)
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import { ScreenCaptureManager } from './ScreenCaptureManager';
import { ViewCubeTracker } from './ViewCubeTracker';
import { ModelPoseTracker } from './ModelPoseTracker';
import { MotionDelta, DecomposerConfig } from './MotionDecomposer';
import { ScreenRegion, MotionState, ViewCubeResult } from '../../shared/types';
import { app } from 'electron';

/** Messages sent from the cv-worker back to CVTracker */
type WorkerMessage =
  | { type: 'initialized'; pointCount: number }
  | { type: 'motion'; delta: MotionDelta }
  | { type: 'reset' }
  | { type: 'error'; message: string };

// ── Diagnostic Logger ─────────────────────────────────────────────────
const LOG_DIR = path.join(app.getPath('userData'), 'tracking-debug');
const LOG_FILE = path.join(LOG_DIR, 'tracking.log');

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

let diagBuffer: string[] = [];
let diagFlushTimer: ReturnType<typeof setTimeout> | null = null;

function diagLog(msg: string) {
  const ts = new Date().toISOString();
  diagBuffer.push(`[${ts}] ${msg}\n`);

  // Batch flush every 2 seconds instead of sync write per line
  if (!diagFlushTimer) {
    diagFlushTimer = setTimeout(() => {
      const batch = diagBuffer.join('');
      diagBuffer = [];
      diagFlushTimer = null;
      try { fs.appendFile(LOG_FILE, batch, () => {}); } catch {}
    }, 2000);
  }
}

function pixelStats(data: Uint8Array): { min: number; max: number; mean: number; nonZero: number; stddev: number } {
  let min = 255, max = 0, sum = 0, nonZero = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v > 0) nonZero++;
  }
  const mean = sum / data.length;
  let varSum = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i] - mean;
    varSum += d * d;
  }
  const stddev = Math.sqrt(varSum / data.length);
  return { min, max, mean: Math.round(mean), nonZero, stddev: Math.round(stddev * 100) / 100 };
}

function savePGM(data: Uint8Array, width: number, height: number, filename: string) {
  const header = `P5\n${width} ${height}\n255\n`;
  const buf = Buffer.alloc(header.length + data.length);
  buf.write(header);
  data.forEach((v, i) => buf[header.length + i] = v);
  try { fs.writeFileSync(path.join(LOG_DIR, filename), buf); } catch (e) { diagLog(`PGM save error: ${e}`); }
}

export interface CVTrackerConfig {
  orbitSensitivity: number;
  panSensitivity: number;
  zoomSensitivity: number;
  smoothingFactor: number;
  minConfidence: number;
}

const DEFAULT_CONFIG: CVTrackerConfig = {
  orbitSensitivity: 0.3,
  panSensitivity: 1.0,
  zoomSensitivity: 0.002,
  smoothingFactor: 0.3,
  minConfidence: 0.02,
};

export interface CVStatus {
  fps: number;
  trackedPoints: number;
  confidence: number;
  isTracking: boolean;
  captureRegion: ScreenRegion | null;
  frameDiff?: number;
  motionState?: MotionState;
}

// Settle refinement constants
const SETTLE_LOW_FLOW_FRAMES = 3;  // consecutive low-flow frames to enter SETTLING
const SETTLE_IDLE_TIMEOUT = 500;    // ms of settling before IDLE
const LOW_FLOW_THRESHOLD = 0.5;     // pixels — below this = "low flow"

export class CVTracker extends EventEmitter {
  private captureManager: ScreenCaptureManager;
  private viewCubeTracker: ViewCubeTracker;
  private modelPoseTracker: ModelPoseTracker;
  private worker: Worker | null = null;
  private config: CVTrackerConfig;
  private region: ScreenRegion | null = null;
  private isRunning: boolean = false;
  private isProcessing: boolean = false;
  private processingTimeout: NodeJS.Timeout | null = null;

  // Dual-mask mode
  private dualMaskMode: boolean = false;

  // FPS tracking
  private frameCount: number = 0;
  private fpsStartTime: number = 0;
  private currentFps: number = 0;

  // Last known status
  private lastTrackedPoints: number = 0;
  private lastConfidence: number = 0;

  // Diagnostic frame counter
  private diagFrameCount: number = 0;
  private vcDiagFrameCount: number = 0;

  // Frame-difference detection
  private prevFrameData: Uint8Array | null = null;
  private frameDiffSum: number = 0;

  // View cube result cache (latest absolute rotation)
  private lastVCResult: ViewCubeResult | null = null;

  // Motion state machine (settle refinement)
  private motionState: MotionState = 'active';
  private lowFlowFrameCount: number = 0;
  private settleTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<CVTrackerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.captureManager = new ScreenCaptureManager();
    this.viewCubeTracker = new ViewCubeTracker();
    this.modelPoseTracker = new ModelPoseTracker();
    this.modelPoseTracker.on('modelPoseUpdate', (result) => {
      this.emit('modelPoseUpdate', result);
    });
    this.modelPoseTracker.on('databaseStatus', (status) => {
      this.emit('modelPoseDatabaseStatus', status);
    });
  }

  /** Access the view cube tracker (e.g., to set axis mapping) */
  getViewCubeTracker(): ViewCubeTracker {
    return this.viewCubeTracker;
  }

  getModelPoseTracker(): ModelPoseTracker {
    return this.modelPoseTracker;
  }

  /** Get the last successful view cube result (for calibration sync) */
  getLastVCResult(): ViewCubeResult | null {
    return this.lastVCResult;
  }

  /**
   * Start tracking — spawns the worker. Frames are received externally via pushFrame().
   */
  start(region: ScreenRegion, dualMask: boolean = false): void {
    if (this.isRunning) this.stop();

    ensureLogDir();
    try { fs.writeFileSync(LOG_FILE, ''); } catch {}
    diagLog(`=== TRACKING SESSION START (${dualMask ? 'dual-mask' : 'legacy'}) ===`);
    diagLog(`Region: ${JSON.stringify(region)}`);
    diagLog(`Config: ${JSON.stringify(this.config)}`);
    diagLog(`Log dir: ${LOG_DIR}`);

    this.region = region;
    this.isRunning = true;
    this.isProcessing = false;
    this.dualMaskMode = dualMask;
    this.frameCount = 0;
    this.fpsStartTime = Date.now();
    this.diagFrameCount = 0;
    this.vcDiagFrameCount = 0;
    this.prevFrameData = null;
    this.frameDiffSum = 0;
    this.lastVCResult = null;
    this.motionState = 'active';
    this.lowFlowFrameCount = 0;

    this.viewCubeTracker.reset();
    this.spawnWorker();
    this.modelPoseTracker.start();

    console.log(`[CVTracker] Started (${dualMask ? 'dual-mask' : 'legacy'}) — waiting for frames from renderer`);
  }

  stop(): void {
    this.isRunning = false;

    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout);
      this.processingTimeout = null;
    }

    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.prevFrameData = null;
    this.modelPoseTracker.stop();

    console.log('[CVTracker] Stopped');
  }

  // ── View Cube Frame (RGBA) ────────────────────────────────────────

  /**
   * Push an RGBA view cube crop from the renderer.
   * Runs ViewCubeTracker to get absolute rotation.
   */
  pushViewCubeFrame(rgbaBuffer: ArrayBuffer | Buffer, width: number, height: number): void {
    if (!this.isRunning) return;

    this.vcDiagFrameCount++;
    const data = new Uint8Array(rgbaBuffer);

    // Save first frame as diagnostic
    if (this.vcDiagFrameCount === 1) {
      // Save as PPM (RGBA → RGB)
      const header = `P6\n${width} ${height}\n255\n`;
      const rgb = Buffer.alloc(header.length + width * height * 3);
      rgb.write(header);
      for (let i = 0; i < width * height; i++) {
        rgb[header.length + i * 3] = data[i * 4];
        rgb[header.length + i * 3 + 1] = data[i * 4 + 1];
        rgb[header.length + i * 3 + 2] = data[i * 4 + 2];
      }
      try { fs.writeFileSync(path.join(LOG_DIR, `viewcube_${width}x${height}.ppm`), rgb); } catch {}
      diagLog(`Saved viewcube PPM: ${width}x${height}`);
    }

    // Run view cube tracker
    const useHighPrecision = this.motionState === 'idle';
    const result = useHighPrecision
      ? this.viewCubeTracker.analyzeHighPrecision(data, width, height)
      : this.viewCubeTracker.analyze(data, width, height);

    if (result) {
      this.lastVCResult = result;

      if (this.vcDiagFrameCount <= 10 || this.vcDiagFrameCount % 10 === 0) {
        diagLog(`VC #${this.vcDiagFrameCount}: rot(${result.rotationX.toFixed(1)},${result.rotationY.toFixed(1)},${result.rotationZ.toFixed(1)}) conf=${result.confidence.toFixed(2)} ${result.strategy} ${result.latencyMs}ms ${useHighPrecision ? '[HI-PREC]' : ''}`);
      }

      // Emit view cube rotation for UI display
      this.emit('viewCubeRotation', result);
    } else {
      if (this.vcDiagFrameCount <= 10 || this.vcDiagFrameCount % 20 === 0) {
        diagLog(`VC #${this.vcDiagFrameCount}: NO DETECTION`);
      }
    }
  }

  // ── Viewport Frame (Grayscale) — for optical flow pan/zoom ────────

  /**
   * Push a grayscale viewport crop from the renderer.
   * Runs optical flow for pan/zoom detection.
   */
  pushViewportFrame(dataBuffer: ArrayBuffer | Buffer, width: number, height: number): void {
    if (!this.isRunning || !this.worker) return;
    if (this.isProcessing) return; // Worker still processing previous frame

    this.diagFrameCount++;
    const data = new Uint8Array(dataBuffer);

    // Pixel statistics only on first few frames and then rarely (expensive on 800×600)
    if (this.diagFrameCount <= 5 || this.diagFrameCount % 100 === 0) {
      const stats = pixelStats(data);
      diagLog(`VP Frame #${this.diagFrameCount}: ${width}x${height} | pixels: min=${stats.min} max=${stats.max} mean=${stats.mean} stddev=${stats.stddev}`);
    }

    // Save first frame
    if (this.diagFrameCount <= 1) {
      savePGM(data, width, height, `viewport_${width}x${height}.pgm`);
      diagLog(`Saved viewport PGM: ${width}x${height}`);
    }

    // Frame-difference detection (reuse buffer to avoid GC churn)
    if (this.prevFrameData && this.prevFrameData.length === data.length) {
      let diffSum = 0;
      for (let i = 0; i < data.length; i++) {
        diffSum += Math.abs(data[i] - this.prevFrameData[i]);
      }
      this.frameDiffSum = diffSum;
    }
    if (!this.prevFrameData || this.prevFrameData.length !== data.length) {
      this.prevFrameData = new Uint8Array(data.length);
    }
    this.prevFrameData.set(data);

    // Send to worker
    this.isProcessing = true;
    this.clearProcessingTimeout();
    this.processingTimeout = setTimeout(() => {
      if (this.isProcessing) {
        console.warn('[CVTracker] Processing timeout — force-resetting');
        this.isProcessing = false;
      }
    }, 500);

    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.worker.postMessage(
      { type: 'frame', data: buffer, width, height },
      [buffer],
    );

    // Track FPS
    this.frameCount++;
    const elapsed = (Date.now() - this.fpsStartTime) / 1000;
    if (elapsed >= 1) {
      this.currentFps = Math.round(this.frameCount / elapsed);
      this.frameCount = 0;
      this.fpsStartTime = Date.now();
      this.emit('status', this.getStatus());
    }

    // Route to model pose tracker (internally throttles to every 5th frame)
    this.modelPoseTracker.pushFrame(dataBuffer, width, height);
  }

  // ── Legacy Full-Screen Frame ─────────────────────────────────────

  /**
   * Push a full-screen grayscale frame (legacy mode, no ROI).
   */
  pushFrame(dataBuffer: ArrayBuffer | Buffer, width: number, height: number): void {
    if (!this.isRunning || !this.worker) return;
    if (this.isProcessing) return;

    this.diagFrameCount++;
    const data = new Uint8Array(dataBuffer);

    const stats = pixelStats(data);
    const isBlank = stats.max === 0 || stats.stddev < 1;

    if (this.diagFrameCount <= 10 || this.diagFrameCount % 5 === 0) {
      diagLog(`Frame #${this.diagFrameCount}: ${width}x${height} pushed | pixels: min=${stats.min} max=${stats.max} mean=${stats.mean} stddev=${stats.stddev} nonZero=${stats.nonZero}/${data.length} ${isBlank ? '*** BLANK FRAME ***' : 'OK'}`);
    }

    if (this.diagFrameCount <= 3) {
      savePGM(data, width, height, `frame_${this.diagFrameCount}_${width}x${height}.pgm`);
      diagLog(`Saved frame PGM: frame_${this.diagFrameCount}_${width}x${height}.pgm`);
    }

    if (isBlank && this.diagFrameCount <= 5) {
      diagLog(`*** BLANK FRAME — likely macOS screen recording permission NOT granted ***`);
    }

    // Frame-difference detection (reuse buffer to avoid GC churn)
    if (this.prevFrameData && this.prevFrameData.length === data.length) {
      let diffSum = 0;
      for (let i = 0; i < data.length; i++) {
        diffSum += Math.abs(data[i] - this.prevFrameData[i]);
      }
      this.frameDiffSum = diffSum;

      if (this.diagFrameCount <= 20 || this.diagFrameCount % 10 === 0) {
        const avgDiff = diffSum / data.length;
        diagLog(`Frame diff #${this.diagFrameCount}: sum=${diffSum} avg=${avgDiff.toFixed(2)} ${diffSum === 0 ? '*** IDENTICAL FRAMES ***' : 'OK'}`);
      }
    }
    if (!this.prevFrameData || this.prevFrameData.length !== data.length) {
      this.prevFrameData = new Uint8Array(data.length);
    }
    this.prevFrameData.set(data);

    // Send to worker
    this.isProcessing = true;
    this.clearProcessingTimeout();
    this.processingTimeout = setTimeout(() => {
      if (this.isProcessing) {
        console.warn('[CVTracker] Processing timeout — force-resetting');
        this.isProcessing = false;
      }
    }, 500);

    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.worker.postMessage(
      { type: 'frame', data: buffer, width, height },
      [buffer],
    );

    this.frameCount++;
    const elapsed = (Date.now() - this.fpsStartTime) / 1000;
    if (elapsed >= 1) {
      this.currentFps = Math.round(this.frameCount / elapsed);
      this.frameCount = 0;
      this.fpsStartTime = Date.now();
      this.emit('status', this.getStatus());
    }
  }

  // ── Motion State Machine (Settle Refinement) ────────────────────

  private updateMotionState(delta: MotionDelta): void {
    const flowMag = Math.sqrt(
      delta.deltaPanX * delta.deltaPanX + delta.deltaPanY * delta.deltaPanY
    ) + Math.abs(delta.deltaScale - 1.0) * 100;

    if (flowMag < LOW_FLOW_THRESHOLD) {
      this.lowFlowFrameCount++;
    } else {
      this.lowFlowFrameCount = 0;
      if (this.motionState !== 'active') {
        diagLog(`Motion state: → ACTIVE (flow=${flowMag.toFixed(2)})`);
        this.motionState = 'active';
        if (this.settleTimer) {
          clearTimeout(this.settleTimer);
          this.settleTimer = null;
        }
      }
    }

    if (this.motionState === 'active' && this.lowFlowFrameCount >= SETTLE_LOW_FLOW_FRAMES) {
      this.motionState = 'settling';
      diagLog(`Motion state: → SETTLING`);
      this.settleTimer = setTimeout(() => {
        if (this.motionState === 'settling') {
          this.motionState = 'idle';
          diagLog(`Motion state: → IDLE (high-precision mode)`);
          this.emit('motionStateChanged', 'idle');
        }
      }, SETTLE_IDLE_TIMEOUT);
    }
  }

  getStatus(): CVStatus {
    return {
      fps: this.currentFps,
      trackedPoints: this.lastTrackedPoints,
      confidence: this.lastConfidence,
      isTracking: this.isRunning,
      captureRegion: this.region,
      frameDiff: this.frameDiffSum,
      motionState: this.motionState,
    };
  }

  getLastViewCubeResult(): ViewCubeResult | null {
    return this.lastVCResult;
  }

  isDualMask(): boolean {
    return this.dualMaskMode;
  }

  updateConfig(config: Partial<CVTrackerConfig>): void {
    this.config = { ...this.config, ...config };

    if (this.worker) {
      const decomposerConfig: Partial<DecomposerConfig> = {
        orbitSensitivity: this.config.orbitSensitivity,
        panSensitivity: this.config.panSensitivity,
        zoomSensitivity: this.config.zoomSensitivity,
        viewportOnly: this.dualMaskMode,
      };
      this.worker.postMessage({ type: 'config', config: decomposerConfig });
    }
  }

  checkPermission(): boolean {
    return this.captureManager.checkPermission();
  }

  async listWindows() {
    return this.captureManager.listWindows();
  }

  getCaptureManager(): ScreenCaptureManager {
    return this.captureManager;
  }

  // --- Private ---

  private spawnWorker(): void {
    const workerPath = path.join(__dirname, 'cv-worker.js');
    diagLog(`Spawning worker from: ${workerPath}`);
    diagLog(`Worker file exists: ${fs.existsSync(workerPath)}`);

    try {
      this.worker = new Worker(workerPath, {
        env: { ...process.env, TRACKING_LOG_DIR: LOG_DIR },
      });
      diagLog(`Worker spawned successfully`);
    } catch (e) {
      diagLog(`WORKER SPAWN FAILED: ${e}`);
      return;
    }

    // Tell worker if we're in viewport-only mode
    if (this.dualMaskMode) {
      this.worker.postMessage({ type: 'config', config: { viewportOnly: true } });
    }

    this.worker.on('message', (msg: WorkerMessage) => {
      switch (msg.type) {
        case 'initialized':
          diagLog(`Worker initialized: ${msg.pointCount} feature points`);
          this.lastTrackedPoints = msg.pointCount;
          this.isProcessing = false;
          this.clearProcessingTimeout();
          break;

        case 'motion': {
          const delta: MotionDelta = msg.delta;
          this.lastTrackedPoints = delta.trackedPoints;
          this.lastConfidence = delta.confidence;
          this.isProcessing = false;
          this.clearProcessingTimeout();

          // Update motion state machine
          this.updateMotionState(delta);

          const hasMotion = Math.abs(delta.deltaRotX) > 0.001 || Math.abs(delta.deltaRotY) > 0.001
            || Math.abs(delta.deltaPanX) > 0.01 || Math.abs(delta.deltaPanY) > 0.01
            || Math.abs(delta.deltaScale - 1.0) > 0.0001;

          if (this.diagFrameCount <= 5 || this.diagFrameCount % 50 === 0) {
            diagLog(`Motion #${this.diagFrameCount}: conf=${delta.confidence.toFixed(3)} pts=${delta.trackedPoints} rot(${delta.deltaRotX.toFixed(4)},${delta.deltaRotY.toFixed(4)}) pan(${delta.deltaPanX.toFixed(2)},${delta.deltaPanY.toFixed(2)}) scale=${delta.deltaScale.toFixed(5)} state=${this.motionState}`);
          }

          if (delta.confidence >= this.config.minConfidence) {
            this.emit('motion', delta);
          }

          if (delta.confidence < this.config.minConfidence && delta.trackedPoints === 0) {
            this.emit('trackingLost');
          } else if (delta.confidence >= this.config.minConfidence) {
            this.emit('trackingRecovered');
          }
          break;
        }

        case 'reset':
          this.isProcessing = false;
          this.clearProcessingTimeout();
          break;

        case 'error':
          diagLog(`Worker message handler error: ${msg.message}`);
          break;
      }
    });

    this.worker.on('error', (err: Error) => {
      diagLog(`WORKER ERROR: ${err.message}\n${err.stack}`);
      this.isProcessing = false;
      this.emit('error', err);
    });

    this.worker.on('exit', (code: number) => {
      diagLog(`WORKER EXIT: code=${code}, isRunning=${this.isRunning}`);
      if (code !== 0 && this.isRunning) {
        this.isProcessing = false;
        setTimeout(() => {
          if (this.isRunning) this.spawnWorker();
        }, 500);
      }
    });
  }

  private clearProcessingTimeout(): void {
    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout);
      this.processingTimeout = null;
    }
  }
}
