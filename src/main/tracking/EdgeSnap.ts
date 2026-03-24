/**
 * EdgeSnap — Aligns the overlay to the CAD viewport by comparing their edge images.
 *
 * Compares the overlay's rendered edges with the CAD viewport's edges and finds
 * a small translation + scale correction that best aligns them.
 *
 * View cube tracker provides rotation. EdgeSnap refines position and scale.
 * Runs on main thread but kept fast by using low-res images (200×150).
 */

// ── Lightweight Edge Extraction ──────────────────────────────────

function sobelEdges(src: Uint8Array, w: number, h: number, threshold: number): Uint8Array {
  const edges = new Uint8Array(w * h);
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
      edges[i] = (gx * gx + gy * gy > threshold * threshold) ? 255 : 0;
    }
  }
  return edges;
}

// ── Distance Transform (fast Manhattan) ──────────────────────────

function distanceTransform(edges: Uint8Array, w: number, h: number): Float32Array {
  const dt = new Float32Array(w * h);
  const INF = w + h;

  for (let i = 0; i < w * h; i++) dt[i] = edges[i] > 0 ? 0 : INF;

  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const i = y * w + x;
      dt[i] = Math.min(dt[i], dt[i - 1] + 1, dt[i - w] + 1);
    }
    for (let x = w - 2; x >= 0; x--) {
      dt[y * w + x] = Math.min(dt[y * w + x], dt[y * w + x + 1] + 1);
    }
  }
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

// ── Downsample grayscale image ───────────────────────────────────

function downsample(src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Uint8Array {
  const dst = new Uint8Array(dstW * dstH);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      dst[y * dstW + x] = src[Math.floor(y * scaleY) * srcW + Math.floor(x * scaleX)];
    }
  }
  return dst;
}

// ── Chamfer Score ────────────────────────────────────────────────

function chamferScore(
  overlayPixels: number[],  // flat [x0,y0, x1,y1, ...]
  count: number,
  dt: Float32Array,
  dtW: number, dtH: number,
  dx: number, dy: number,
): number {
  let total = 0;
  let valid = 0;

  for (let i = 0; i < count * 2; i += 2) {
    const xi = Math.round(overlayPixels[i] + dx);
    const yi = Math.round(overlayPixels[i + 1] + dy);
    if (xi < 0 || xi >= dtW || yi < 0 || yi >= dtH) continue;
    total += dt[yi * dtW + xi];
    valid++;
  }

  return valid > 10 ? total / valid : Infinity;
}

// ── Main EdgeSnap ────────────────────────────────────────────────

export interface EdgeSnapResult {
  deltaX: number;
  deltaY: number;
  score: number;
  latencyMs: number;
}

const PROCESS_W = 200;
const PROCESS_H = 150;

export class EdgeSnap {
  private frameCount = 0;
  private readonly INTERVAL = 5;  // Process every 5th frame (~2fps)
  private overlayEdges: Uint8Array | null = null;
  private overlayPixels: number[] = [];
  private overlayPixelCount = 0;
  private lastScore = Infinity;

  /** Receive overlay edge snapshot (already 200×150 binary from renderer) */
  setOverlaySnapshot(edgeData: Uint8Array, width: number, height: number): void {
    // Store as-is if already correct size, otherwise skip
    if (width !== PROCESS_W || height !== PROCESS_H) return;
    this.overlayEdges = edgeData;

    // Pre-extract edge pixel positions (do this once per snapshot, not per frame)
    this.overlayPixels = [];
    this.overlayPixelCount = 0;
    const step = 2;  // Sample every 2nd pixel for speed
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        if (edgeData[y * width + x] > 0) {
          this.overlayPixels.push(x, y);
          this.overlayPixelCount++;
        }
      }
    }
  }

  /** Process viewport frame. Returns correction or null. */
  processViewportFrame(
    viewportGray: Uint8Array,
    vpW: number, vpH: number,
  ): EdgeSnapResult | null {
    this.frameCount++;
    if (this.frameCount % this.INTERVAL !== 0) return null;
    if (!this.overlayEdges || this.overlayPixelCount < 15) return null;

    // Already well-aligned? Reduce frequency but don't skip entirely.
    if (this.lastScore < 3 && this.frameCount % (this.INTERVAL * 5) !== 0) return null;

    const t0 = Date.now();

    // Downsample viewport to match overlay snapshot resolution
    const ds = (vpW !== PROCESS_W || vpH !== PROCESS_H)
      ? downsample(viewportGray, vpW, vpH, PROCESS_W, PROCESS_H)
      : viewportGray;

    // Edge detection + distance transform
    const vpEdges = sobelEdges(ds, PROCESS_W, PROCESS_H, 40);
    const vpDT = distanceTransform(vpEdges, PROCESS_W, PROCESS_H);

    // Coarse-to-fine search: first wide (±20px, step 5), then refine (±4px, step 1)
    let bestScore = chamferScore(this.overlayPixels, this.overlayPixelCount, vpDT, PROCESS_W, PROCESS_H, 0, 0);
    let bestDX = 0, bestDY = 0;

    // Coarse pass: wide search range for initial alignment
    for (let dx = -20; dx <= 20; dx += 5) {
      for (let dy = -20; dy <= 20; dy += 5) {
        if (dx === 0 && dy === 0) continue;
        const score = chamferScore(this.overlayPixels, this.overlayPixelCount, vpDT, PROCESS_W, PROCESS_H, dx, dy);
        if (score < bestScore) {
          bestScore = score;
          bestDX = dx;
          bestDY = dy;
        }
      }
    }

    // Fine pass: refine around best coarse result
    const coarseDX = bestDX, coarseDY = bestDY;
    for (let dx = coarseDX - 4; dx <= coarseDX + 4; dx++) {
      for (let dy = coarseDY - 4; dy <= coarseDY + 4; dy++) {
        const score = chamferScore(this.overlayPixels, this.overlayPixelCount, vpDT, PROCESS_W, PROCESS_H, dx, dy);
        if (score < bestScore) {
          bestScore = score;
          bestDX = dx;
          bestDY = dy;
        }
      }
    }

    this.lastScore = bestScore;

    // Scale correction back to viewport pixel space
    const scaleX = vpW / PROCESS_W;
    const scaleY = vpH / PROCESS_H;

    return {
      deltaX: bestDX * scaleX,
      deltaY: bestDY * scaleY,
      score: bestScore,
      latencyMs: Date.now() - t0,
    };
  }

  reset(): void {
    this.frameCount = 0;
    this.overlayEdges = null;
    this.overlayPixels = [];
    this.overlayPixelCount = 0;
    this.lastScore = Infinity;
  }
}
