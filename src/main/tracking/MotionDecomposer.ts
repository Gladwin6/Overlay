/**
 * Motion Decomposer
 *
 * Converts 2D optical flow point pairs into motion deltas.
 *
 * v2: Simplified for dual-mask architecture.
 * Rotation is now handled by ViewCubeTracker (absolute, not from optical flow).
 * This module only computes pan (translation) and zoom (scale).
 *
 * Uses median-based statistics for robustness against outliers.
 */

export interface MotionDelta {
  deltaRotX: number;   // degrees (kept for interface compat, always 0 in viewport-only mode)
  deltaRotY: number;   // degrees
  deltaPanX: number;   // pixels
  deltaPanY: number;   // pixels
  deltaScale: number;  // multiplicative (1.0 = no change)
  confidence: number;  // 0-1
  trackedPoints: number;
}

export interface DecomposerConfig {
  orbitSensitivity: number;   // degrees per pixel of flow (default: 0.15) — used in legacy mode
  panSensitivity: number;     // output pixels per pixel of flow (default: 1.0)
  zoomSensitivity: number;    // scale per pixel of radial flow (default: 0.002)
  rotationThreshold: number;  // variance ratio above which motion is classified as rotation (default: 0.3) — legacy
  deadZone: number;           // minimum flow magnitude to register (default: 0.3)
  viewportOnly: boolean;      // true = skip rotation, only pan+zoom (dual-mask mode)
}

const DEFAULT_CONFIG: DecomposerConfig = {
  orbitSensitivity: 0.3,
  panSensitivity: 1.0,
  zoomSensitivity: 0.002,
  rotationThreshold: 0.3,
  deadZone: 0.3,
  viewportOnly: false,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
}

/**
 * Decompose optical flow into motion deltas.
 *
 * When config.viewportOnly=true (dual-mask mode):
 *   - Only computes pan and zoom
 *   - Rotation is always 0 (handled by ViewCubeTracker)
 *   - No static/moving point split needed (viewport crop has no UI chrome)
 *
 * When config.viewportOnly=false (legacy full-screen mode):
 *   - Full rotation/pan/zoom decomposition with static point filtering
 */
export function decomposeFlow(
  prevPoints: Float32Array,
  currPoints: Float32Array,
  status: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  config: DecomposerConfig = DEFAULT_CONFIG,
): MotionDelta {
  // Collect valid flow vectors
  const flowX: number[] = [];
  const flowY: number[] = [];
  const validPrev: { x: number; y: number }[] = [];

  const pointCount = status.length;
  for (let i = 0; i < pointCount; i++) {
    if (status[i] !== 1) continue;
    const px = prevPoints[i * 2];
    const py = prevPoints[i * 2 + 1];
    const cx = currPoints[i * 2];
    const cy = currPoints[i * 2 + 1];
    flowX.push(cx - px);
    flowY.push(cy - py);
    validPrev.push({ x: px, y: py });
  }

  const trackedPoints = flowX.length;
  const confidence = pointCount > 0 ? trackedPoints / pointCount : 0;

  if (trackedPoints < 4) {
    return { deltaRotX: 0, deltaRotY: 0, deltaPanX: 0, deltaPanY: 0, deltaScale: 1, confidence, trackedPoints };
  }

  // In viewport-only mode, all points are on the model (no static UI chrome)
  // so we use all flow vectors directly. No need for static/moving split.
  let useFlowX = flowX;
  let useFlowY = flowY;
  let usePrev = validPrev;

  if (!config.viewportOnly) {
    // Legacy: separate static vs moving points
    const STATIC_THRESHOLD = 0.5;
    const movingFlowX: number[] = [];
    const movingFlowY: number[] = [];
    const movingPrev: { x: number; y: number }[] = [];

    for (let i = 0; i < trackedPoints; i++) {
      const mag = Math.sqrt(flowX[i] * flowX[i] + flowY[i] * flowY[i]);
      if (mag >= STATIC_THRESHOLD) {
        movingFlowX.push(flowX[i]);
        movingFlowY.push(flowY[i]);
        movingPrev.push(validPrev[i]);
      }
    }

    if (movingFlowX.length >= 8) {
      useFlowX = movingFlowX;
      useFlowY = movingFlowY;
      usePrev = movingPrev;
    }
  }

  const useCount = useFlowX.length;

  // Step 1: Median flow → base translation
  const medDX = median(useFlowX);
  const medDY = median(useFlowY);

  // Dead zone check
  const flowMag = Math.sqrt(medDX * medDX + medDY * medDY);
  const varX0 = variance(useFlowX);
  const varY0 = variance(useFlowY);
  const totalFlowVariance = Math.sqrt(varX0 + varY0);
  if (flowMag < config.deadZone && totalFlowVariance < config.deadZone) {
    return { deltaRotX: 0, deltaRotY: 0, deltaPanX: 0, deltaPanY: 0, deltaScale: 1, confidence, trackedPoints };
  }

  // Step 2: Compute residuals after removing median translation
  const residualX: number[] = [];
  const residualY: number[] = [];
  for (let i = 0; i < useCount; i++) {
    residualX.push(useFlowX[i] - medDX);
    residualY.push(useFlowY[i] - medDY);
  }

  // Step 3: Zoom from radial divergence
  const centroidX = usePrev.reduce((s, p) => s + p.x, 0) / useCount;
  const centroidY = usePrev.reduce((s, p) => s + p.y, 0) / useCount;

  const radialComponents: number[] = [];
  for (let i = 0; i < useCount; i++) {
    const toPointX = usePrev[i].x - centroidX;
    const toPointY = usePrev[i].y - centroidY;
    const dist = Math.sqrt(toPointX * toPointX + toPointY * toPointY);
    if (dist < 5) continue;

    const nx = toPointX / dist;
    const ny = toPointY / dist;
    const radial = residualX[i] * nx + residualY[i] * ny;
    radialComponents.push(radial);
  }

  const medianRadial = radialComponents.length > 2 ? median(radialComponents) : 0;
  const deltaScale = 1.0 + medianRadial * config.zoomSensitivity;

  // Step 4: Rotation vs pan
  let deltaRotX = 0;
  let deltaRotY = 0;
  let deltaPanX = medDX * config.panSensitivity;
  let deltaPanY = medDY * config.panSensitivity;

  if (!config.viewportOnly) {
    // Legacy mode: detect rotation from flow variance
    const varX = variance(useFlowX);
    const varY = variance(useFlowY);
    const totalVariance = Math.sqrt(varX + varY);
    const totalMedianFlow = Math.abs(medDX) + Math.abs(medDY) + 0.001;
    const rotationIndicator = Math.min(totalVariance / totalMedianFlow, 2.0);

    if (rotationIndicator > config.rotationThreshold) {
      const rotFraction = Math.min((rotationIndicator - config.rotationThreshold) / (1.0 - config.rotationThreshold), 1.0);

      // Use angular velocity from cross product instead of median flow
      // (median cancels for rotation — left/right sides move opposite)
      const angVelocities: number[] = [];
      for (let i = 0; i < useCount; i++) {
        const rx = usePrev[i].x - centroidX;
        const ry = usePrev[i].y - centroidY;
        const r2 = rx * rx + ry * ry;
        if (r2 < 100) continue;  // skip center points
        angVelocities.push((rx * useFlowY[i] - ry * useFlowX[i]) / r2);
      }
      const medAngVel = angVelocities.length >= 4 ? median(angVelocities) : 0;
      const avgR = Math.min(imageWidth, imageHeight) * 0.25;
      deltaRotY = medAngVel * avgR * config.orbitSensitivity * rotFraction;
      deltaRotX = -medDY * config.orbitSensitivity * rotFraction;  // vertical pan still works for pitch

      deltaPanX *= (1.0 - rotFraction);
      deltaPanY *= (1.0 - rotFraction);
    }
  }
  // In viewportOnly mode: deltaRotX and deltaRotY stay 0
  // Rotation comes from ViewCubeTracker (absolute)

  return {
    deltaRotX,
    deltaRotY,
    deltaPanX,
    deltaPanY,
    deltaScale: Math.max(0.9, Math.min(1.1, deltaScale)),
    confidence,
    trackedPoints,
  };
}
