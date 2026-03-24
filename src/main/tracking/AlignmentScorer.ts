/**
 * AlignmentScorer — Measures how well the overlay aligns with the CAD viewport.
 *
 * Compares overlay edge pixels against viewport edge pixels.
 * Outputs:
 *   - overlapPercent: % of overlay edges that have a viewport edge within N pixels
 *   - meanDistance: average distance from overlay edge pixels to nearest viewport edge
 *   - offsetX/Y: estimated position error (pixels)
 *   - rotationError: estimated angular error (degrees, approximate)
 *
 * Runs in main process on low-res images (200x150) for speed.
 */

// ── Edge + Distance Transform (same as EdgeSnap) ──────────────

function sobelEdges(gray: Uint8Array, w: number, h: number, threshold: number = 30): Uint8Array {
  const edges = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gray[i-w-1]+gray[i-w+1]-2*gray[i-1]+2*gray[i+1]-gray[i+w-1]+gray[i+w+1];
      const gy = -gray[i-w-1]-2*gray[i-w]-gray[i-w+1]+gray[i+w-1]+2*gray[i+w]+gray[i+w+1];
      edges[i] = (gx*gx + gy*gy > threshold*threshold) ? 255 : 0;
    }
  }
  return edges;
}

function distanceTransform(edges: Uint8Array, w: number, h: number): Float32Array {
  const dt = new Float32Array(w * h);
  const INF = w + h;
  for (let i = 0; i < w*h; i++) dt[i] = edges[i] > 0 ? 0 : INF;
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) { const i=y*w+x; dt[i]=Math.min(dt[i],dt[i-1]+1,dt[i-w]+1); }
    for (let x = w-2; x >= 0; x--) { dt[y*w+x]=Math.min(dt[y*w+x],dt[y*w+x+1]+1); }
  }
  for (let y = h-2; y >= 0; y--) {
    for (let x = w-2; x >= 0; x--) { const i=y*w+x; dt[i]=Math.min(dt[i],dt[i+1]+1,dt[i+w]+1); }
    for (let x = 1; x < w; x++) { dt[y*w+x]=Math.min(dt[y*w+x],dt[y*w+x-1]+1); }
  }
  return dt;
}

function downsample(src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Uint8Array {
  const dst = new Uint8Array(dstW * dstH);
  const sx = srcW/dstW, sy = srcH/dstH;
  for (let y = 0; y < dstH; y++)
    for (let x = 0; x < dstW; x++)
      dst[y*dstW+x] = src[Math.floor(y*sy)*srcW + Math.floor(x*sx)];
  return dst;
}

// ── Score Result ─────────────────────────────────────────────────

export interface AlignmentScore {
  /** % of overlay edge pixels within 3px of a viewport edge (0-100) */
  overlapPercent: number;
  /** Average distance from overlay edge to nearest viewport edge (pixels at process resolution) */
  meanDistance: number;
  /** Estimated position offset X (pixels at viewport resolution) */
  offsetX: number;
  /** Estimated position offset Y (pixels at viewport resolution) */
  offsetY: number;
  /** Quality grade: 'perfect' | 'good' | 'fair' | 'poor' */
  grade: 'perfect' | 'good' | 'fair' | 'poor';
  /** Processing time ms */
  latencyMs: number;
}

// ── Main Scorer ──────────────────────────────────────────────────

const SCORE_W = 200;
const SCORE_H = 150;
const CLOSE_THRESHOLD = 3; // pixels — "close enough" to count as overlapping

export class AlignmentScorer {
  private overlayEdges: Uint8Array | null = null;
  private overlayPixels: { x: number; y: number }[] = [];
  private frameCount = 0;

  /**
   * Set the overlay's rendered edge snapshot.
   * Called at ~1fps from the overlay renderer.
   */
  setOverlayEdges(edgeData: Uint8Array, width: number, height: number): void {
    if (width === SCORE_W && height === SCORE_H) {
      this.overlayEdges = edgeData;
    } else {
      this.overlayEdges = downsample(edgeData, width, height, SCORE_W, SCORE_H);
    }

    // Pre-extract overlay edge pixel positions
    this.overlayPixels = [];
    for (let y = 0; y < SCORE_H; y++) {
      for (let x = 0; x < SCORE_W; x++) {
        if (this.overlayEdges[y * SCORE_W + x] > 0) {
          this.overlayPixels.push({ x, y });
        }
      }
    }
  }

  /**
   * Score the alignment by comparing overlay edges against viewport edges.
   * Call every ~0.5s (not every frame).
   */
  score(viewportGray: Uint8Array, vpW: number, vpH: number): AlignmentScore | null {
    this.frameCount++;
    if (this.frameCount % 15 !== 0) return null; // ~2fps at 30fps input
    if (!this.overlayEdges || this.overlayPixels.length < 10) return null;

    const t0 = Date.now();

    // Downsample viewport
    const ds = (vpW !== SCORE_W || vpH !== SCORE_H)
      ? downsample(viewportGray, vpW, vpH, SCORE_W, SCORE_H)
      : viewportGray;

    // Background subtraction (isolate part from SolidWorks gray BG)
    const corners = [ds[0], ds[SCORE_W-1], ds[(SCORE_H-1)*SCORE_W], ds[(SCORE_H-1)*SCORE_W+SCORE_W-1]];
    const bgMean = (corners[0]+corners[1]+corners[2]+corners[3]) / 4;
    const partMask = new Uint8Array(SCORE_W * SCORE_H);
    for (let i = 0; i < SCORE_W * SCORE_H; i++) {
      partMask[i] = Math.abs(ds[i] - bgMean) > 15 ? 255 : 0;
    }

    // Edge detection on part mask
    const vpEdges = sobelEdges(partMask, SCORE_W, SCORE_H, 20);
    const vpDT = distanceTransform(vpEdges, SCORE_W, SCORE_H);

    // Score: for each overlay edge pixel, measure distance to nearest viewport edge
    let totalDist = 0;
    let closeCount = 0;
    let sumDX = 0, sumDY = 0;

    for (const p of this.overlayPixels) {
      const dist = vpDT[p.y * SCORE_W + p.x];
      totalDist += dist;
      if (dist <= CLOSE_THRESHOLD) closeCount++;
    }

    const overlapPercent = (closeCount / this.overlayPixels.length) * 100;
    const meanDistance = totalDist / this.overlayPixels.length;

    // Estimate position offset: find the shift that minimizes chamfer distance
    let bestDX = 0, bestDY = 0, bestScore = meanDistance;
    for (let dx = -10; dx <= 10; dx += 2) {
      for (let dy = -10; dy <= 10; dy += 2) {
        if (dx === 0 && dy === 0) continue;
        let total = 0, count = 0;
        for (let i = 0; i < this.overlayPixels.length; i += 3) { // sample every 3rd
          const px = this.overlayPixels[i].x + dx;
          const py = this.overlayPixels[i].y + dy;
          if (px >= 0 && px < SCORE_W && py >= 0 && py < SCORE_H) {
            total += vpDT[py * SCORE_W + px];
            count++;
          }
        }
        const score = count > 0 ? total / count : Infinity;
        if (score < bestScore) {
          bestScore = score;
          bestDX = dx;
          bestDY = dy;
        }
      }
    }

    const scaleX = vpW / SCORE_W;
    const scaleY = vpH / SCORE_H;

    let grade: AlignmentScore['grade'];
    if (overlapPercent > 80 && meanDistance < 2) grade = 'perfect';
    else if (overlapPercent > 60 && meanDistance < 4) grade = 'good';
    else if (overlapPercent > 40 && meanDistance < 8) grade = 'fair';
    else grade = 'poor';

    return {
      overlapPercent: Math.round(overlapPercent),
      meanDistance: Math.round(meanDistance * 10) / 10,
      offsetX: Math.round(bestDX * scaleX),
      offsetY: Math.round(bestDY * scaleY),
      grade,
      latencyMs: Date.now() - t0,
    };
  }
}
