/**
 * PoseDatabase — Precomputed view database for fast orientation lookup.
 *
 * Stores compact edge descriptors for ~5000 orientations.
 * Lookup: compare incoming frame's histogram → top candidates → Chamfer scoring.
 *
 * Runs in pose-worker thread. Pure math, no DOM/Node dependencies.
 */

export interface PoseDescriptor {
  /** Fibonacci sphere index */
  index: number;
  /** Rotation matrix (3×3, row-major) for this orientation */
  rotation: Float32Array;  // 9 elements
  /** 16-bin edge orientation histogram (normalized) */
  histogram: Float32Array;
  /** 3D edge midpoints in model space (N×3, flat) — for re-projection at arbitrary poses */
  edgePoints3D: Float32Array;
  /** Number of edge points */
  pointCount: number;
  /** Bounding box aspect ratio (width/height) of projected edges */
  bboxAspect: number;
  /** Centroid of projected edges (normalized to [-1,1]) */
  centroidX: number;
  centroidY: number;
}

export interface PoseDatabaseData {
  descriptors: PoseDescriptor[];
  ready: boolean;
}

// ── Histogram Comparison ─────────────────────────────────────────

/** Cosine similarity between two normalized histograms. Returns 0-1 (1 = identical). */
function histogramSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 1e-8 ? dot / denom : 0;
}

// ── Database Class ───────────────────────────────────────────────

export class PoseDatabase {
  private descriptors: PoseDescriptor[] = [];
  private _ready = false;

  get ready(): boolean { return this._ready; }
  get size(): number { return this.descriptors.length; }

  /** Load precomputed descriptors (received from overlay renderer via IPC) */
  load(descriptors: PoseDescriptor[]): void {
    this.descriptors = descriptors;
    this._ready = descriptors.length > 0;
    console.log(`[PoseDB] Loaded ${descriptors.length} descriptors`);
  }

  /** Clear database and free memory */
  dispose(): void {
    this.descriptors = [];
    this._ready = false;
  }

  /**
   * Find top-K candidates matching the given frame descriptor.
   *
   * Three-stage pruning:
   * 1. Orientation histogram similarity (cosine) → top 50
   * 2. Bounding box aspect ratio filter (±30%) → reduce further
   * 3. Centroid distance filter (< 25% of image) → final ~5 candidates
   */
  findCandidates(
    frameHistogram: Float32Array,
    frameBboxAspect: number,
    frameCentroidX: number,
    frameCentroidY: number,
    topK: number = 5,
  ): PoseDescriptor[] {
    if (!this._ready) return [];

    // Stage 1: Histogram similarity → top 50
    const scored = this.descriptors.map(d => ({
      descriptor: d,
      similarity: histogramSimilarity(frameHistogram, d.histogram),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    let candidates = scored.slice(0, 50);

    // Stage 2: Bbox aspect ratio filter (±30%)
    if (frameBboxAspect > 0.01) {
      candidates = candidates.filter(c => {
        const ratio = c.descriptor.bboxAspect / frameBboxAspect;
        return ratio > 0.7 && ratio < 1.43;
      });
    }

    // Stage 3: Centroid distance filter
    candidates = candidates.filter(c => {
      const dx = c.descriptor.centroidX - frameCentroidX;
      const dy = c.descriptor.centroidY - frameCentroidY;
      return Math.sqrt(dx * dx + dy * dy) < 0.5;  // normalized coords, 0.5 = 25% of image
    });

    // Return top K by similarity
    return candidates.slice(0, topK).map(c => c.descriptor);
  }
}
