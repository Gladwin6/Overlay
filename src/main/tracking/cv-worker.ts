/**
 * CV Worker — runs in a Node.js worker_thread.
 *
 * Receives grayscale frame buffers from the main thread,
 * runs optical flow using jsfeat, and returns motion deltas.
 */

import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';

// Diagnostic logging from worker
function workerLog(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[CVWorker ${ts}] ${msg}`);
  // Also try to append to the same log file
  try {
    const logDir = process.env.TRACKING_LOG_DIR;
    if (logDir) {
      fs.appendFileSync(path.join(logDir, 'tracking.log'), `[${ts}] [WORKER] ${msg}\n`);
    }
  } catch {}
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
let jsfeat: any;
try {
  jsfeat = require('jsfeat');
  workerLog(`jsfeat loaded successfully. Version/keys: ${Object.keys(jsfeat).slice(0, 10).join(', ')}`);
  workerLog(`jsfeat.fast_corners: ${typeof jsfeat.fast_corners}`);
  workerLog(`jsfeat.optical_flow_lk: ${typeof jsfeat.optical_flow_lk}`);
  workerLog(`jsfeat.pyramid_t: ${typeof jsfeat.pyramid_t}`);
} catch (e: any) {
  workerLog(`FATAL: jsfeat require() FAILED: ${e.message}\n${e.stack}`);
}

import { decomposeFlow, DecomposerConfig, MotionDelta } from './MotionDecomposer';

// --- State ---
let prevPyr: any = null;
let currPyr: any = null;
let prevPoints: Float32Array | null = null;
let currPoints: Float32Array | null = null;
let pointStatus: Uint8Array | null = null;
let pointCount = 0;
let frameWidth = 0;
let frameHeight = 0;
let initialized = false;
let frameCounter = 0;
let lastFrameTime = 0;

// Block matching state - more stable than optical flow
let referenceFrame: Uint8Array | null = null;
let useBlockMatching = true;
let blockMatchSearchRange = 30;  // pixels to search

// Config (received from main thread)
// deadZone=0.3 suppresses sensor noise drift while still passing real motion
let config: DecomposerConfig = {
  orbitSensitivity: 0.3,
  panSensitivity: 1.0,
  zoomSensitivity: 0.002,
  rotationThreshold: 0.3,
  deadZone: 0.3,
  viewportOnly: false,  // true when in dual-mask mode (rotation from ViewCubeTracker)
};

const MAX_CORNERS = 300;
const MIN_CORNERS = 30;
const PYRAMID_LEVELS = 3;
const LK_WIN_SIZE = 21;
const LK_MAX_ITER = 30;
const LK_EPS = 0.01;

/**
 * Detect FAST corners and initialize tracking points.
 */
function initFeatures(grayData: Uint8Array, width: number, height: number): void {
  if (!jsfeat) {
    workerLog(`initFeatures ABORTED: jsfeat not loaded`);
    return;
  }

  frameWidth = width;
  frameHeight = height;

  // Check input data
  let inputMin = 255, inputMax = 0, inputNonZero = 0;
  for (let i = 0; i < Math.min(grayData.length, 10000); i++) {
    if (grayData[i] < inputMin) inputMin = grayData[i];
    if (grayData[i] > inputMax) inputMax = grayData[i];
    if (grayData[i] > 0) inputNonZero++;
  }
  workerLog(`initFeatures: ${width}x${height} (${grayData.length} bytes) | sample pixels: min=${inputMin} max=${inputMax} nonZero=${inputNonZero}/10000`);

  if (inputMax === 0) {
    workerLog(`*** ALL-BLACK FRAME — screen recording permission likely not granted ***`);
  }

  // Allocate pyramids
  prevPyr = new jsfeat.pyramid_t(PYRAMID_LEVELS);
  currPyr = new jsfeat.pyramid_t(PYRAMID_LEVELS);
  prevPyr.allocate(width, height, jsfeat.U8_t | jsfeat.C1_t);
  currPyr.allocate(width, height, jsfeat.U8_t | jsfeat.C1_t);

  // Copy grayscale data into first pyramid level
  const prevImg = prevPyr.data[0];
  prevImg.data.set(grayData);
  workerLog(`Pyramid level 0: ${prevImg.cols}x${prevImg.rows}, data.length=${prevImg.data.length}`);

  // Build pyramid
  prevPyr.build(prevPyr.data[0], true); // skip_first_level = true

  // Detect FAST corners — FIX: lowered threshold 20→10 for CAD UIs (low contrast edges)
  // BUG 28 FIX: allocate 5000 keypoint_t slots (was MAX_CORNERS*2=600).
  // jsfeat.fast_corners.detect writes directly to corners[i].x — if there are more
  // corners than slots, it crashes with "Cannot set properties of undefined (setting 'x')".
  // At threshold=10 on 400x300, jsfeat can find 2000+ corners.
  const CORNER_BUFFER_SIZE = 5000;
  jsfeat.fast_corners.set_threshold(10);
  const corners: any[] = [];
  for (let i = 0; i < CORNER_BUFFER_SIZE; i++) {
    corners.push(new jsfeat.keypoint_t(0, 0, 0, 0));
  }

  let detectedCount: number;
  try {
    detectedCount = jsfeat.fast_corners.detect(prevImg, corners, 5);
  } catch (e) {
    workerLog(`FAST detect crashed (${e}). Retrying with higher threshold...`);
    jsfeat.fast_corners.set_threshold(25);
    try {
      detectedCount = jsfeat.fast_corners.detect(prevImg, corners, 5);
    } catch (e2) {
      workerLog(`FAST detect crashed again (${e2}). Giving up on this frame.`);
      return;
    }
  }
  workerLog(`FAST corners detected: ${detectedCount} (buffer=${CORNER_BUFFER_SIZE}, border=5)`);

  // Sort by score (descending) and keep top MAX_CORNERS
  if (detectedCount > MAX_CORNERS) {
    corners.sort((a: any, b: any) => b.score - a.score);
    detectedCount = MAX_CORNERS;
  }

  // Store as flat arrays for optical flow
  pointCount = detectedCount;
  prevPoints = new Float32Array(pointCount * 2);
  currPoints = new Float32Array(pointCount * 2);
  pointStatus = new Uint8Array(pointCount);

  for (let i = 0; i < pointCount; i++) {
    prevPoints[i * 2] = corners[i].x;
    prevPoints[i * 2 + 1] = corners[i].y;
  }

  initialized = true;
  lastFrameTime = Date.now();

  console.log(`[CVWorker] initFeatures: ${pointCount} FAST corners detected (threshold=10) in ${width}x${height} frame`);
}

/**
 * Simple block matching using SAD (Sum of Absolute Differences) - faster than NCC.
 * Compares current frame to reference frame for stable CAD viewport tracking.
 */
function blockMatchCurrentFrame(
  refData: Uint8Array,
  currData: Uint8Array,
  width: number,
  height: number,
  searchRange: number
): { dx: number; dy: number; scale: number; confidence: number } {
  const blockSize = 24;
  const step = 3;  // Search step - higher = faster but less precise
  const numBlocksX = Math.max(1, Math.floor((width - 2 * searchRange) / (blockSize * 2)));
  const numBlocksY = Math.max(1, Math.floor((height - 2 * searchRange) / (blockSize * 2)));
  
  if (numBlocksX < 1 || numBlocksY < 1) {
    return { dx: 0, dy: 0, scale: 1, confidence: 0 };
  }

  // Sample a few blocks across the frame
  const dxList: number[] = [];
  const dyList: number[] = [];
  let totalMinSAD = 0;
  let validBlocks = 0;

  for (let by = 0; by < numBlocksY; by++) {
    for (let bx = 0; bx < numBlocksX; bx++) {
      const startX = searchRange + bx * blockSize * 2;
      const startY = searchRange + by * blockSize * 2;
      
      if (startX + blockSize >= width - searchRange || startY + blockSize >= height - searchRange) {
        continue;
      }

      // Compute reference block sum
      let refSum = 0;
      for (let y = 0; y < blockSize; y++) {
        for (let x = 0; x < blockSize; x++) {
          refSum += refData[(startY + y) * width + startX + x];
        }
      }
      const refMean = refSum / (blockSize * blockSize);

      let bestSAD = Infinity;
      let bestDx = 0;
      let bestDy = 0;

      // Search in a coarse grid first
      for (let dy = -searchRange; dy <= searchRange; dy += step) {
        for (let dx = -searchRange; dx <= searchRange; dx += step) {
          let sad = 0;
          
          for (let y = 0; y < blockSize; y++) {
            for (let x = 0; x < blockSize; x++) {
              const refVal = refData[(startY + y) * width + startX + x];
              const currVal = currData[(startY + dy + y) * width + startX + dx + x];
              sad += Math.abs(refVal - currVal);
            }
          }
          
          if (sad < bestSAD) {
            bestSAD = sad;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }

      // Refine around best position
      const refineRange = step;
      for (let dy = bestDy - refineRange; dy <= bestDy + refineRange; dy++) {
        for (let dx = bestDx - refineRange; dx <= bestDx + refineRange; dx++) {
          if (dx === bestDx && dy === bestDy) continue;
          
          let sad = 0;
          for (let y = 0; y < blockSize; y++) {
            for (let x = 0; x < blockSize; x++) {
              const refVal = refData[(startY + y) * width + startX + x];
              const currVal = currData[(startY + dy + y) * width + startX + dx + x];
              sad += Math.abs(refVal - currVal);
            }
          }
          
          if (sad < bestSAD) {
            bestSAD = sad;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }

      // Normalize SAD to confidence (lower SAD = higher confidence)
      const maxSAD = blockSize * blockSize * 128;  // Max possible SAD
      const confidence = Math.max(0, 1 - bestSAD / maxSAD);
      
      if (confidence > 0.2) {
        dxList.push(bestDx);
        dyList.push(bestDy);
        totalMinSAD += bestSAD;
        validBlocks++;
      }
    }
  }

  if (validBlocks < 2) {
    return { dx: 0, dy: 0, scale: 1, confidence: 0 };
  }

  // Use median to be robust against outliers
  dxList.sort((a, b) => a - b);
  dyList.sort((a, b) => a - b);
  const medianDx = dxList[Math.floor(dxList.length / 2)];
  const medianDy = dyList[Math.floor(dyList.length / 2)];
  
  const avgConfidence = Math.min(1, 1 - (totalMinSAD / validBlocks) / (blockSize * blockSize * 64));

  return { dx: medianDx, dy: medianDy, scale: 1, confidence: avgConfidence };
}

/**
 * Process a new frame: run optical flow and decompose motion.
 */
function processFrame(grayData: Uint8Array, width: number, height: number): MotionDelta | null {
  frameCounter++;
  if (!initialized || !prevPyr || !currPyr || !prevPoints || !currPoints || !pointStatus) {
    return null;
  }

  if (width !== frameWidth || height !== frameHeight) {
    initFeatures(grayData, width, height);
    return null;
  }

  const now = Date.now();
  const dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  // If we have a reference frame, use block matching (more stable)
  if (useBlockMatching && referenceFrame && referenceFrame.length === grayData.length) {
    const blockResult = blockMatchCurrentFrame(referenceFrame, grayData, width, height, blockMatchSearchRange);
    
    if (blockResult.confidence > 0.3) {
      workerLog(`Block match: dx=${blockResult.dx.toFixed(1)} dy=${blockResult.dy.toFixed(1)} conf=${blockResult.confidence.toFixed(2)}`);
      
      return {
        deltaRotX: 0,
        deltaRotY: 0,
        deltaPanX: blockResult.dx,
        deltaPanY: blockResult.dy,
        deltaScale: blockResult.scale,
        confidence: blockResult.confidence,
        trackedPoints: 100,  // Simulated for compatibility
      };
    }
  }

  // Fallback: use Lucas-Kanade optical flow
  // Copy new frame data into current pyramid
  const currImg = currPyr.data[0];
  currImg.data.set(grayData);
  currPyr.build(currPyr.data[0], true);

  // Run Lucas-Kanade optical flow
  jsfeat.optical_flow_lk.track(
    prevPyr,
    currPyr,
    prevPoints,
    currPoints,
    pointCount,
    LK_WIN_SIZE,
    LK_MAX_ITER,
    pointStatus,
    LK_EPS,
    0.0001
  );

  // BUG 29 diagnostic: count zero-flow vs non-zero-flow points
  let staticPts = 0;
  let movingPts = 0;
  let maxFlowMag = 0;
  for (let i = 0; i < pointCount; i++) {
    if (pointStatus[i] !== 1) continue;
    const dx = currPoints[i * 2] - prevPoints[i * 2];
    const dy = currPoints[i * 2 + 1] - prevPoints[i * 2 + 1];
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag < 0.5) staticPts++;
    else movingPts++;
    if (mag > maxFlowMag) maxFlowMag = mag;
  }
  // Log every 10th frame to avoid spam
  if (Math.random() < 0.1) {
    workerLog(`flow split: ${movingPts} moving / ${staticPts} static (maxMag=${maxFlowMag.toFixed(1)})`);
  }

  // Decompose flow into motion deltas
  const rawDelta = decomposeFlow(
    prevPoints,
    currPoints,
    pointStatus,
    frameWidth,
    frameHeight,
    config,
  );

  // FIX: Bypass Kalman filter — it was designed for absolute measurements
  // but we're feeding it per-frame deltas, causing motion to be attenuated
  // and then reversed. Pass raw deltas directly for now.
  const filteredDelta: MotionDelta = {
    deltaRotX: rawDelta.deltaRotX,
    deltaRotY: rawDelta.deltaRotY,
    deltaPanX: rawDelta.deltaPanX,
    deltaPanY: rawDelta.deltaPanY,
    deltaScale: rawDelta.deltaScale,
    confidence: rawDelta.confidence,
    trackedPoints: rawDelta.trackedPoints,
  };

  // Count surviving points
  let survivors = 0;
  for (let i = 0; i < pointCount; i++) {
    if (pointStatus[i] === 1) survivors++;
  }

  // Swap pyramids for next frame
  const tmpPyr = prevPyr;
  prevPyr = currPyr;
  currPyr = tmpPyr;

  // Compact surviving points or reinitialize if too few
  if (survivors < MIN_CORNERS) {
    initFeatures(grayData, width, height);
    return {
      deltaRotX: 0, deltaRotY: 0, deltaPanX: 0, deltaPanY: 0,
      deltaScale: 1, confidence: 0, trackedPoints: 0,
    };
  }

  const newPrevPoints = new Float32Array(survivors * 2);
  let idx = 0;
  for (let i = 0; i < pointCount; i++) {
    if (pointStatus[i] === 1) {
      newPrevPoints[idx * 2] = currPoints[i * 2];
      newPrevPoints[idx * 2 + 1] = currPoints[i * 2 + 1];
      idx++;
    }
  }
  prevPoints = newPrevPoints;
  currPoints = new Float32Array(survivors * 2);
  pointStatus = new Uint8Array(survivors);
  pointCount = survivors;

  // Throttle worker logging to avoid EPIPE (only log every 50th frame)
  if (frameCounter % 50 === 0) {
    console.log(`[CVWorker] motion: rot(${filteredDelta.deltaRotX.toFixed(3)},${filteredDelta.deltaRotY.toFixed(3)}) pan(${filteredDelta.deltaPanX.toFixed(1)},${filteredDelta.deltaPanY.toFixed(1)}) scale=${filteredDelta.deltaScale.toFixed(4)} conf=${filteredDelta.confidence.toFixed(2)} pts=${filteredDelta.trackedPoints}`);
  }

  return filteredDelta;
}

// --- Message Handler ---
if (parentPort) {
  parentPort.on('message', (msg: any) => {
    try {
      switch (msg.type) {
        case 'init': {
          const { data, width, height } = msg;
          const grayData = new Uint8Array(data);
          initFeatures(grayData, width, height);
          // Store reference frame for block matching
          referenceFrame = new Uint8Array(grayData);
          workerLog(`Reference frame stored for block matching: ${width}x${height}`);
          parentPort!.postMessage({ type: 'initialized', pointCount });
          break;
        }

        case 'frame': {
          const { data, width, height } = msg;
          const grayData = new Uint8Array(data);

          if (!initialized) {
            initFeatures(grayData, width, height);
            // Store reference frame for block matching
            referenceFrame = new Uint8Array(grayData);
            workerLog(`Reference frame stored for block matching: ${width}x${height}`);
            parentPort!.postMessage({ type: 'initialized', pointCount });
            return;
          }

          try {
            const delta = processFrame(grayData, width, height);
            if (delta) {
              parentPort!.postMessage({ type: 'motion', delta });
            }
          } catch (err: any) {
            workerLog(`processFrame error: ${err.message}`);
          }
          break;
        }

        case 'config': {
          config = { ...config, ...msg.config };
          break;
        }

        case 'reset': {
          initialized = false;
          prevPyr = null;
          currPyr = null;
          prevPoints = null;
          currPoints = null;
          pointStatus = null;
          pointCount = 0;
          referenceFrame = null;  // Clear reference frame
          parentPort!.postMessage({ type: 'reset' });
          break;
        }
      }
    } catch (err: any) {
      workerLog(`Message handler error: ${err.message}`);
      parentPort!.postMessage({ type: 'error', message: err.message });
    }
  });
}
