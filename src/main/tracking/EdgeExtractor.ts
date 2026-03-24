/**
 * EdgeExtractor — Adaptive Canny edge detection + distance transform.
 *
 * Runs in pose-worker thread. Pure math, no DOM/Node dependencies.
 *
 * Input: grayscale Uint8Array (width × height)
 * Output: edge bitmap + distance transform for Chamfer scoring
 */

// ── Gaussian Blur (3×3) ──────────────────────────────────────────

function gaussianBlur3x3(src: Uint8Array, w: number, h: number): Uint8Array {
  const dst = new Uint8Array(w * h);
  // Kernel: [1,2,1; 2,4,2; 1,2,1] / 16
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      dst[i] = (
        src[i - w - 1] + 2 * src[i - w] + src[i - w + 1] +
        2 * src[i - 1] + 4 * src[i] + 2 * src[i + 1] +
        src[i + w - 1] + 2 * src[i + w] + src[i + w + 1]
      ) >> 4;
    }
  }
  return dst;
}

// ── Sobel Gradients ──────────────────────────────────────────────

function sobelGradients(
  src: Uint8Array, w: number, h: number
): { magnitude: Float32Array; direction: Float32Array } {
  const magnitude = new Float32Array(w * h);
  const direction = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -src[i - w - 1] + src[i - w + 1] +
        -2 * src[i - 1] + 2 * src[i + 1] +
        -src[i + w - 1] + src[i + w + 1];
      const gy =
        -src[i - w - 1] - 2 * src[i - w] - src[i - w + 1] +
         src[i + w - 1] + 2 * src[i + w] + src[i + w + 1];
      magnitude[i] = Math.sqrt(gx * gx + gy * gy);
      direction[i] = Math.atan2(gy, gx);
    }
  }
  return { magnitude, direction };
}

// ── Non-Maximum Suppression ──────────────────────────────────────

function nonMaxSuppression(
  mag: Float32Array, dir: Float32Array, w: number, h: number
): Float32Array {
  const out = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m === 0) continue;

      // Quantize direction to 0°, 45°, 90°, 135°
      let angle = dir[i] * (180 / Math.PI);
      if (angle < 0) angle += 180;

      let m1: number, m2: number;
      if (angle < 22.5 || angle >= 157.5) {
        m1 = mag[i - 1]; m2 = mag[i + 1];             // horizontal
      } else if (angle < 67.5) {
        m1 = mag[i - w + 1]; m2 = mag[i + w - 1];     // 45°
      } else if (angle < 112.5) {
        m1 = mag[i - w]; m2 = mag[i + w];              // vertical
      } else {
        m1 = mag[i - w - 1]; m2 = mag[i + w + 1];     // 135°
      }

      out[i] = (m >= m1 && m >= m2) ? m : 0;
    }
  }
  return out;
}

// ── Hysteresis Thresholding ──────────────────────────────────────

function hysteresis(
  nms: Float32Array, w: number, h: number, low: number, high: number
): Uint8Array {
  const edges = new Uint8Array(w * h);

  // Mark strong and weak edges
  for (let i = 0; i < w * h; i++) {
    if (nms[i] >= high) edges[i] = 2;       // strong
    else if (nms[i] >= low) edges[i] = 1;   // weak
  }

  // Propagate: weak edges adjacent to strong become strong
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (edges[i] !== 1) continue;
        // Check 8 neighbors for strong edge
        if (
          edges[i - w - 1] === 2 || edges[i - w] === 2 || edges[i - w + 1] === 2 ||
          edges[i - 1] === 2 || edges[i + 1] === 2 ||
          edges[i + w - 1] === 2 || edges[i + w] === 2 || edges[i + w + 1] === 2
        ) {
          edges[i] = 2;
          changed = true;
        }
      }
    }
  }

  // Final: only strong edges survive
  for (let i = 0; i < w * h; i++) {
    edges[i] = edges[i] === 2 ? 255 : 0;
  }
  return edges;
}

// ── Distance Transform (Manhattan approximation) ─────────────────

export function distanceTransform(edges: Uint8Array, w: number, h: number): Float32Array {
  const dt = new Float32Array(w * h);
  const INF = w + h;

  // Initialize: 0 on edge pixels, INF elsewhere
  for (let i = 0; i < w * h; i++) {
    dt[i] = edges[i] > 0 ? 0 : INF;
  }

  // Forward pass (top-left to bottom-right)
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const i = y * w + x;
      dt[i] = Math.min(dt[i], dt[i - 1] + 1, dt[i - w] + 1);
    }
    // Right-to-left within row
    for (let x = w - 2; x >= 0; x--) {
      const i = y * w + x;
      dt[i] = Math.min(dt[i], dt[i + 1] + 1);
    }
  }

  // Backward pass (bottom-right to top-left)
  for (let y = h - 2; y >= 0; y--) {
    for (let x = w - 2; x >= 0; x--) {
      const i = y * w + x;
      dt[i] = Math.min(dt[i], dt[i + 1] + 1, dt[i + w] + 1);
    }
    // Left-to-right within row
    for (let x = 1; x < w; x++) {
      const i = y * w + x;
      dt[i] = Math.min(dt[i], dt[i - 1] + 1);
    }
  }

  return dt;
}

// ── Adaptive Canny Thresholds ────────────────────────────────────

export type RenderMode = 'shaded' | 'shaded-edges' | 'wireframe';

function detectRenderMode(edgeDensity: number): RenderMode {
  if (edgeDensity < 0.05) return 'shaded';
  if (edgeDensity < 0.15) return 'shaded-edges';
  return 'wireframe';
}

function getCannyThresholds(mode: RenderMode): { low: number; high: number } {
  switch (mode) {
    case 'shaded':       return { low: 30, high: 80 };
    case 'shaded-edges': return { low: 50, high: 120 };
    case 'wireframe':    return { low: 80, high: 180 };
  }
}

// ── Edge Orientation Histogram ───────────────────────────────────

export function edgeOrientationHistogram(
  edges: Uint8Array, direction: Float32Array, w: number, h: number, nBins: number
): Float32Array {
  const hist = new Float32Array(nBins);
  for (let i = 0; i < w * h; i++) {
    if (edges[i] === 0) continue;
    let angle = direction[i];
    if (angle < 0) angle += Math.PI;  // Map to [0, π)
    const bin = Math.min(nBins - 1, Math.floor((angle / Math.PI) * nBins));
    hist[bin]++;
  }
  // Normalize
  let sum = 0;
  for (let i = 0; i < nBins; i++) sum += hist[i];
  if (sum > 0) for (let i = 0; i < nBins; i++) hist[i] /= sum;
  return hist;
}

// ── Main Extract Function ────────────────────────────────────────

export interface EdgeExtractionResult {
  edges: Uint8Array;           // binary edge image (0 or 255)
  dt: Float32Array;            // distance transform
  histogram: Float32Array;     // 16-bin orientation histogram
  edgeDensity: number;         // fraction of edge pixels
  renderMode: RenderMode;
  width: number;
  height: number;
}

let detectedMode: RenderMode | null = null;
let modeFrameCount = 0;

export function extractEdges(
  gray: Uint8Array, w: number, h: number
): EdgeExtractionResult {
  // 1. Gaussian blur
  const blurred = gaussianBlur3x3(gray, w, h);

  // 2. Sobel gradients
  const { magnitude, direction } = sobelGradients(blurred, w, h);

  // 3. Auto-detect render mode from first few frames
  // Do a quick threshold to estimate edge density
  if (!detectedMode || modeFrameCount < 5) {
    const tempEdges = hysteresis(
      nonMaxSuppression(magnitude, direction, w, h),
      w, h, 50, 120  // middle thresholds for detection
    );
    let count = 0;
    for (let i = 0; i < w * h; i++) if (tempEdges[i] > 0) count++;
    const density = count / (w * h);
    detectedMode = detectRenderMode(density);
    modeFrameCount++;
  }

  // 4. Canny with adaptive thresholds
  const thresholds = getCannyThresholds(detectedMode);
  const nms = nonMaxSuppression(magnitude, direction, w, h);
  const edges = hysteresis(nms, w, h, thresholds.low, thresholds.high);

  // 5. Edge density
  let edgeCount = 0;
  for (let i = 0; i < w * h; i++) if (edges[i] > 0) edgeCount++;
  const edgeDensity = edgeCount / (w * h);

  // 6. Distance transform
  const dt = distanceTransform(edges, w, h);

  // 7. Orientation histogram (16 bins)
  const histogram = edgeOrientationHistogram(edges, direction, w, h, 16);

  return { edges, dt, histogram, edgeDensity, renderMode: detectedMode, width: w, height: h };
}

/** Reset render mode detection (call when tracking restarts) */
export function resetEdgeExtractor(): void {
  detectedMode = null;
  modeFrameCount = 0;
}
