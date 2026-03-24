/**
 * Template Matcher
 *
 * Uses Normalized Cross-Correlation (NCC) at multiple scales to match
 * a reference screenshot against the current screen capture.
 *
 * Performance strategy: Downsample both by 4x, coarse search with stride=4,
 * refine at 1x around best candidate.
 */

export interface TemplateMatchResult {
  profileId: string;
  confidence: number;   // 0-1 (NCC score)
  offsetX: number;      // pixel offset from stored position
  offsetY: number;
}

interface ReferenceTemplate {
  profileId: string;
  data: Uint8Array;     // grayscale pixels
  width: number;
  height: number;
}

export class TemplateMatcher {
  private templates: Map<string, ReferenceTemplate> = new Map();
  private readonly DOWNSAMPLE = 4;
  private readonly COARSE_STRIDE = 4;
  private readonly MIN_CONFIDENCE = 0.5;

  /**
   * Store a reference screenshot for a calibration profile.
   * Automatically downsample to ~200px wide for storage.
   */
  addTemplate(profileId: string, grayData: Uint8Array, width: number, height: number): void {
    // Downsample to ~200px wide
    const targetW = 200;
    const scale = targetW / width;
    const targetH = Math.floor(height * scale);
    const downsampled = this.downsample(grayData, width, height, targetW, targetH);

    this.templates.set(profileId, {
      profileId,
      data: downsampled,
      width: targetW,
      height: targetH,
    });

    console.log(`[TemplateMatcher] Added template: ${profileId} (${targetW}x${targetH})`);
  }

  removeTemplate(profileId: string): void {
    this.templates.delete(profileId);
  }

  /**
   * Match screen capture against all stored templates.
   * Returns best match above MIN_CONFIDENCE, or null.
   */
  match(screenGray: Uint8Array, screenW: number, screenH: number): TemplateMatchResult | null {
    if (this.templates.size === 0) return null;

    let bestResult: TemplateMatchResult | null = null;
    let bestScore = this.MIN_CONFIDENCE;

    // Downsample screen for coarse search
    const dsW = Math.floor(screenW / this.DOWNSAMPLE);
    const dsH = Math.floor(screenH / this.DOWNSAMPLE);
    const dsScreen = this.downsample(screenGray, screenW, screenH, dsW, dsH);

    for (const [id, template] of this.templates) {
      // Downsample template too
      const dsTplW = Math.floor(template.width / this.DOWNSAMPLE);
      const dsTplH = Math.floor(template.height / this.DOWNSAMPLE);

      if (dsTplW < 4 || dsTplH < 4) continue;

      const dsTpl = this.downsample(template.data, template.width, template.height, dsTplW, dsTplH);

      // Coarse NCC search at downsampled resolution
      const coarseResult = this.nccSearch(dsScreen, dsW, dsH, dsTpl, dsTplW, dsTplH, this.COARSE_STRIDE);

      if (coarseResult.score > bestScore) {
        // Refine: search a small window around the coarse match at full template resolution
        const refineX = coarseResult.x * this.DOWNSAMPLE;
        const refineY = coarseResult.y * this.DOWNSAMPLE;

        // Extract a region around the coarse match from full-res screen
        const margin = template.width;
        const rx = Math.max(0, refineX - margin);
        const ry = Math.max(0, refineY - margin);
        const rw = Math.min(screenW - rx, template.width + margin * 2);
        const rh = Math.min(screenH - ry, template.height + margin * 2);

        if (rw >= template.width && rh >= template.height) {
          const region = this.extractRegion(screenGray, screenW, screenH, rx, ry, rw, rh);
          const fineResult = this.nccSearch(region, rw, rh, template.data, template.width, template.height, 1);

          if (fineResult.score > bestScore) {
            bestScore = fineResult.score;
            bestResult = {
              profileId: id,
              confidence: fineResult.score,
              offsetX: rx + fineResult.x,
              offsetY: ry + fineResult.y,
            };
          }
        } else {
          // Use coarse result directly
          bestScore = coarseResult.score;
          bestResult = {
            profileId: id,
            confidence: coarseResult.score,
            offsetX: refineX,
            offsetY: refineY,
          };
        }
      }
    }

    return bestResult;
  }

  /**
   * NCC (Normalized Cross-Correlation) sliding window search.
   */
  private nccSearch(
    screen: Uint8Array, sw: number, sh: number,
    template: Uint8Array, tw: number, th: number,
    stride: number,
  ): { x: number; y: number; score: number } {
    let bestX = 0, bestY = 0, bestScore = -1;

    // Precompute template stats
    let tSum = 0, tSumSq = 0;
    const tLen = tw * th;
    for (let i = 0; i < tLen; i++) {
      tSum += template[i];
      tSumSq += template[i] * template[i];
    }
    const tMean = tSum / tLen;
    const tStd = Math.sqrt(tSumSq / tLen - tMean * tMean);
    if (tStd < 1) return { x: 0, y: 0, score: 0 }; // flat template

    for (let sy = 0; sy <= sh - th; sy += stride) {
      for (let sx = 0; sx <= sw - tw; sx += stride) {
        // Compute NCC for this position
        let sSum = 0, sSumSq = 0, cross = 0;
        for (let ty = 0; ty < th; ty++) {
          const sRow = (sy + ty) * sw + sx;
          const tRow = ty * tw;
          for (let tx = 0; tx < tw; tx++) {
            const sv = screen[sRow + tx];
            const tv = template[tRow + tx];
            sSum += sv;
            sSumSq += sv * sv;
            cross += sv * tv;
          }
        }
        const sMean = sSum / tLen;
        const sStd = Math.sqrt(sSumSq / tLen - sMean * sMean);
        if (sStd < 1) continue;

        const ncc = (cross / tLen - sMean * tMean) / (sStd * tStd);

        if (ncc > bestScore) {
          bestScore = ncc;
          bestX = sx;
          bestY = sy;
        }
      }
    }

    return { x: bestX, y: bestY, score: bestScore };
  }

  private extractRegion(
    src: Uint8Array, sw: number, sh: number,
    x: number, y: number, w: number, h: number,
  ): Uint8Array {
    const dst = new Uint8Array(w * h);
    for (let dy = 0; dy < h; dy++) {
      const srcOffset = (y + dy) * sw + x;
      const dstOffset = dy * w;
      for (let dx = 0; dx < w; dx++) {
        dst[dstOffset + dx] = src[srcOffset + dx];
      }
    }
    return dst;
  }

  private downsample(
    src: Uint8Array, sw: number, sh: number,
    dw: number, dh: number,
  ): Uint8Array {
    const dst = new Uint8Array(dw * dh);
    const xr = sw / dw;
    const yr = sh / dh;
    for (let y = 0; y < dh; y++) {
      const sy = Math.floor(y * yr);
      for (let x = 0; x < dw; x++) {
        const sx = Math.floor(x * xr);
        dst[y * dw + x] = src[sy * sw + sx];
      }
    }
    return dst;
  }
}
