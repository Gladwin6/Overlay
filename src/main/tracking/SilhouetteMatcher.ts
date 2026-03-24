/**
 * SilhouetteMatcher — Finds the best rotation by comparing edge silhouettes.
 *
 * Instead of detecting the view cube (unreliable), this compares the overlay's
 * rendered edges at various rotations against the viewport's edges from screen capture.
 *
 * Uses Chamfer distance on low-res edge images (100x75) for fast matching.
 * Runs a coarse grid search first, then refines around the best match.
 *
 * Input: viewport grayscale frame (from screen capture)
 * Output: best-matching rotation as cleanAxes (same format as ViewCubeTracker)
 */

import type { ViewCubeAxes } from '../../shared/types';

// ── Edge Extraction ──────────────────────────────────────────────

function sobelEdges(gray: Uint8Array, w: number, h: number, threshold: number = 30): Uint8Array {
  const edges = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[i - w - 1] + gray[i - w + 1] +
        -2 * gray[i - 1] + 2 * gray[i + 1] +
        -gray[i + w - 1] + gray[i + w + 1];
      const gy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] +
         gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      edges[i] = (gx * gx + gy * gy > threshold * threshold) ? 255 : 0;
    }
  }
  return edges;
}

// ── Distance Transform (Manhattan) ────────────────────────────────

function distanceTransform(edges: Uint8Array, w: number, h: number): Float32Array {
  const dt = new Float32Array(w * h);
  const INF = w + h;
  for (let i = 0; i < w * h; i++) dt[i] = edges[i] > 0 ? 0 : INF;

  // Forward pass
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const i = y * w + x;
      dt[i] = Math.min(dt[i], dt[i - 1] + 1, dt[i - w] + 1);
    }
    for (let x = w - 2; x >= 0; x--) {
      dt[y * w + x] = Math.min(dt[y * w + x], dt[y * w + x + 1] + 1);
    }
  }
  // Backward pass
  for (let y = h - 2; y >= 0; y--) {
    for (let x = w - 2; x >= 0; x--) {
      const i = y * w + x;
      dt[i] = Math.min(dt[i], dt[i + 1] + 1, dt[i + w] + 1);
    }
    for (let x = 1; x < w; x++) {
      dt[y * w + x] = Math.min(dt[y * w + x], dt[y * w + x - 1] + 1);
    }
  }
  return dt;
}

// ── Chamfer Score ────────────────────────────────────────────────

function chamferScore(
  overlayEdges: Uint8Array, vpDT: Float32Array, w: number, h: number,
  dx: number = 0, dy: number = 0,
): number {
  let total = 0;
  let count = 0;
  const step = 2; // sample every 2nd pixel for speed

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (overlayEdges[y * w + x] === 0) continue;
      const xi = x + dx;
      const yi = y + dy;
      if (xi < 0 || xi >= w || yi < 0 || yi >= h) continue;
      total += vpDT[yi * w + xi];
      count++;
    }
  }

  return count > 5 ? total / count : Infinity;
}

// ── Downsample ───────────────────────────────────────────────────

function downsample(src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Uint8Array {
  const dst = new Uint8Array(dstW * dstH);
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      dst[y * dstW + x] = src[Math.floor(y * sy) * srcW + Math.floor(x * sx)];
    }
  }
  return dst;
}

// ── Main Matcher ─────────────────────────────────────────────────

export interface SilhouetteMatchResult {
  /** Best translation correction (pixels in viewport space) */
  deltaX: number;
  deltaY: number;
  /** Chamfer score (lower = better match) */
  score: number;
  /** Processing time */
  latencyMs: number;
}

const MATCH_W = 200;
const MATCH_H = 150;

export class SilhouetteMatcher {
  private overlayEdges: Uint8Array | null = null;
  private frameCount = 0;
  private readonly INTERVAL = 3; // Every 3rd frame
  private lastScore = Infinity;

  /**
   * Set the overlay's rendered edge image.
   * Called by the overlay renderer at ~1fps with a snapshot of the rendered edges.
   */
  setOverlayEdges(edgeData: Uint8Array, width: number, height: number): void {
    if (width === MATCH_W && height === MATCH_H) {
      this.overlayEdges = edgeData;
    } else {
      this.overlayEdges = downsample(edgeData, width, height, MATCH_W, MATCH_H);
    }
  }

  /**
   * Match viewport frame against overlay edges.
   * Returns translation correction or null.
   */
  match(viewportGray: Uint8Array, vpW: number, vpH: number): SilhouetteMatchResult | null {
    this.frameCount++;
    if (this.frameCount % this.INTERVAL !== 0) return null;
    if (!this.overlayEdges) return null;

    // Skip if already well-aligned (but recheck periodically)
    if (this.lastScore < 2 && this.frameCount % (this.INTERVAL * 10) !== 0) return null;

    const t0 = Date.now();

    // Downsample viewport to match size
    const ds = (vpW !== MATCH_W || vpH !== MATCH_H)
      ? downsample(viewportGray, vpW, vpH, MATCH_W, MATCH_H)
      : viewportGray;

    // Extract edges from viewport
    const vpEdges = sobelEdges(ds, MATCH_W, MATCH_H, 25);
    const vpDT = distanceTransform(vpEdges, MATCH_W, MATCH_H);

    // Coarse search: ±30px, step 6
    let bestScore = chamferScore(this.overlayEdges, vpDT, MATCH_W, MATCH_H, 0, 0);
    let bestDX = 0, bestDY = 0;

    for (let dx = -30; dx <= 30; dx += 6) {
      for (let dy = -30; dy <= 30; dy += 6) {
        if (dx === 0 && dy === 0) continue;
        const score = chamferScore(this.overlayEdges, vpDT, MATCH_W, MATCH_H, dx, dy);
        if (score < bestScore) {
          bestScore = score;
          bestDX = dx;
          bestDY = dy;
        }
      }
    }

    // Fine search: ±5px around best, step 1
    const cDX = bestDX, cDY = bestDY;
    for (let dx = cDX - 5; dx <= cDX + 5; dx++) {
      for (let dy = cDY - 5; dy <= cDY + 5; dy++) {
        const score = chamferScore(this.overlayEdges, vpDT, MATCH_W, MATCH_H, dx, dy);
        if (score < bestScore) {
          bestScore = score;
          bestDX = dx;
          bestDY = dy;
        }
      }
    }

    this.lastScore = bestScore;

    // Scale back to viewport pixel space
    const scaleX = vpW / MATCH_W;
    const scaleY = vpH / MATCH_H;

    return {
      deltaX: bestDX * scaleX,
      deltaY: bestDY * scaleY,
      score: bestScore,
      latencyMs: Date.now() - t0,
    };
  }

  reset(): void {
    this.overlayEdges = null;
    this.frameCount = 0;
    this.lastScore = Infinity;
  }
}
