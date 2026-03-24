# Model-Based Pose Tracker Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Universal CAD overlay tracking that matches the 3D model's edges against the viewport capture — works with any CAD software without COM APIs or view cube detection.

**Architecture:** Precomputed view database (5000 orientations rendered on model load) + optical flow for smooth inter-frame tracking + periodic Chamfer edge matching for drift-free absolute pose correction. Edge extraction and matching run in a dedicated Worker thread. Database generation runs in the overlay renderer using `requestIdleCallback` batching.

**Tech Stack:** TypeScript, Three.js (offscreen rendering), Web Workers, Electron IPC

**Spec:** `docs/superpowers/specs/2026-03-12-model-pose-tracker-design.md`

**Project root:** `C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay/`

**No test infrastructure exists.** Validation is: `npm run build` succeeds + app runs correctly. Each task ends with a build check.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/main/tracking/EdgeExtractor.ts` | Canny edge detection + distance transform on grayscale viewport frames |
| `src/main/tracking/PoseDatabase.ts` | Stores precomputed edge descriptors, nearest-neighbor lookup by orientation histogram |
| `src/main/tracking/PoseOptimizer.ts` | Chamfer distance scoring, ±2° local refinement, translation/zoom estimation |
| `src/main/tracking/ModelPoseTracker.ts` | Orchestrator: routes frames to pose-worker, emits modelPoseUpdate events |
| `src/main/tracking/pose-worker.ts` | Dedicated Worker thread: runs EdgeExtractor + PoseDatabase lookup + PoseOptimizer |
| `src/renderer/overlay/PoseDatabaseGenerator.ts` | Renders 5000 edge maps in overlay renderer using requestIdleCallback, sends descriptors to main |

### Modified Files

| File | Changes |
|------|---------|
| `src/shared/types.ts` | Add 3 IPC channels, ModelPoseResult interface |
| `src/main/tracking/CVTracker.ts` | Add ModelPoseTracker member, route viewport frames, emit modelPoseUpdate |
| `src/main/index.ts` | Add modelPoseUpdate handler, send MODELPOSE_GENERATE on GLTF load, forward database IPC |
| `src/renderer/overlay/OverlayApp.tsx` | Add PoseDatabaseGenerator, listen for MODELPOSE_GENERATE, send database back |
| `src/renderer/setup/SetupApp.tsx` | Add model tracking status indicator |

---

## Chunk 1: Foundation — Types, Edge Extraction, Distance Transform

### Task 1: Add IPC channels and interfaces to shared types

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add ModelPoseResult interface and IPC channels**

In the `ViewCubeAxes` interface (~line 68), update the `strategy` field to include `'model'`:

```typescript
  strategy: 'color' | 'cube' | 'edges' | 'model';
```

After the existing `ViewCubeResult` interface (line 81), add:

```typescript
export interface ModelPoseResult {
  cleanAxes: ViewCubeAxes;
  panX: number;
  panY: number;
  zoom: number;
  confidence: number;
  chamferScore: number;
  strategy: 'database' | 'flow-only';
  latencyMs: number;
}
```

In the `IPC` const (after line 184), add:

```typescript
  // Model pose tracking
  MODELPOSE_GENERATE: 'modelpose:generate',
  MODELPOSE_DATABASE: 'modelpose:database',
  MODELPOSE_STATUS:   'modelpose:status',
```

- [ ] **Step 2: Build to verify**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`
Expected: Compiles successfully (new types are unused but valid)

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add ModelPoseResult interface and IPC channels for model pose tracking"
```

---

### Task 2: Implement EdgeExtractor

**Files:**
- Create: `src/main/tracking/EdgeExtractor.ts`

This module runs inside the pose-worker. Pure functions, no dependencies on Node or Electron.

- [ ] **Step 1: Create EdgeExtractor.ts**

```typescript
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
```

- [ ] **Step 2: Build to verify**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`
Expected: Compiles (file is not imported yet but must be valid TypeScript)

- [ ] **Step 3: Commit**

```bash
git add src/main/tracking/EdgeExtractor.ts
git commit -m "feat: add EdgeExtractor with adaptive Canny, distance transform, orientation histogram"
```

---

## Chunk 2: Pose Database and Optimizer

### Task 3: Implement PoseDatabase

**Files:**
- Create: `src/main/tracking/PoseDatabase.ts`

Stores precomputed edge descriptors and performs fast nearest-neighbor lookup.

- [ ] **Step 1: Create PoseDatabase.ts**

```typescript
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
```

- [ ] **Step 2: Build to verify**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/main/tracking/PoseDatabase.ts
git commit -m "feat: add PoseDatabase with Fibonacci sampling, histogram lookup, 3-stage pruning"
```

---

### Task 4: Implement PoseOptimizer

**Files:**
- Create: `src/main/tracking/PoseOptimizer.ts`

Chamfer scoring + local refinement + translation/zoom estimation.

- [ ] **Step 1: Create PoseOptimizer.ts**

```typescript
/**
 * PoseOptimizer — Chamfer distance scoring and local pose refinement.
 *
 * Given candidate orientations from PoseDatabase, scores each against
 * the viewport's distance transform, then refines with ±2° perturbations.
 *
 * Also estimates translation (pan) and zoom from matched edges.
 *
 * Runs in pose-worker thread. Pure math.
 */

import type { PoseDescriptor } from './PoseDatabase';
import type { ViewCubeAxes } from '../../shared/types';

export interface PoseEstimate {
  /** Best rotation matrix (3×3 row-major) */
  rotation: Float32Array;
  /** Camera axis projections for overlay (reuses ViewCubeAxes format) */
  cleanAxes: ViewCubeAxes;
  /** Pan offset in pixels from viewport center */
  panX: number;
  panY: number;
  /** Zoom scale relative to database render size */
  zoom: number;
  /** Mean Chamfer distance (lower = better) */
  chamferScore: number;
  /** Confidence 0-1 (inverse normalized Chamfer) */
  confidence: number;
}

// ── 3×3 Matrix Operations ────────────────────────────────────────

/** Multiply two 3×3 row-major matrices */
function mat3Mul(a: Float32Array, b: Float32Array): Float32Array {
  const r = new Float32Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

/** Create rotation matrix from axis-angle (small angle approximation for perturbations) */
function smallRotation(dx: number, dy: number, dz: number): Float32Array {
  // Rodrigues' formula for small angles (radians)
  const cx = Math.cos(dx), sx = Math.sin(dx);
  const cy = Math.cos(dy), sy = Math.sin(dy);
  const cz = Math.cos(dz), sz = Math.sin(dz);

  // Rz * Ry * Rx
  return new Float32Array([
    cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
    cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
    -sy,     sx * cy,                cx * cy,
  ]);
}

// ── Projection (Orthographic) ────────────────────────────────────

/**
 * Project 3D edge points using a rotation matrix (orthographic = take X,Y after rotation).
 * Returns 2D points scaled to viewport dimensions.
 */
function projectEdgePoints(
  points3D: Float32Array,
  pointCount: number,
  rotation: Float32Array,
  viewW: number,
  viewH: number,
): { x: Float32Array; y: Float32Array; cx: number; cy: number; bboxW: number; bboxH: number } {
  const px = new Float32Array(pointCount);
  const py = new Float32Array(pointCount);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let sumX = 0, sumY = 0;

  for (let i = 0; i < pointCount; i++) {
    const x3 = points3D[i * 3];
    const y3 = points3D[i * 3 + 1];
    const z3 = points3D[i * 3 + 2];

    // Orthographic: projected X = dot(right, point), projected Y = dot(up, point)
    // rotation row0 = right, row1 = up
    const x2 = rotation[0] * x3 + rotation[1] * y3 + rotation[2] * z3;
    const y2 = rotation[3] * x3 + rotation[4] * y3 + rotation[5] * z3;

    // Scale to viewport (model is normalized to [-1,1] range in database)
    px[i] = (x2 + 1) * 0.5 * viewW;
    py[i] = (1 - y2) * 0.5 * viewH;  // Y flipped (screen Y down)

    sumX += px[i]; sumY += py[i];
    if (px[i] < minX) minX = px[i];
    if (px[i] > maxX) maxX = px[i];
    if (py[i] < minY) minY = py[i];
    if (py[i] > maxY) maxY = py[i];
  }

  return {
    x: px, y: py,
    cx: sumX / pointCount,
    cy: sumY / pointCount,
    bboxW: maxX - minX,
    bboxH: maxY - minY,
  };
}

// ── Chamfer Scoring ──────────────────────────────────────────────

/** Score projected edge points against distance transform. Lower = better. */
function chamferScore(
  px: Float32Array, py: Float32Array, pointCount: number,
  dt: Float32Array, dtW: number, dtH: number,
): number {
  let totalDist = 0;
  let validCount = 0;

  for (let i = 0; i < pointCount; i++) {
    const xi = Math.round(px[i]);
    const yi = Math.round(py[i]);
    if (xi < 0 || xi >= dtW || yi < 0 || yi >= dtH) continue;
    totalDist += dt[yi * dtW + xi];
    validCount++;
  }

  return validCount > 0 ? totalDist / validCount : Infinity;
}

// ── Rotation to CleanAxes ────────────────────────────────────────

/** Convert a 3×3 rotation matrix to ViewCubeAxes format for the overlay renderer. */
function rotationToCleanAxes(R: Float32Array): ViewCubeAxes {
  // cleanAxes: world axis i → screen as (right[i], -up[i])
  // R row0 = right, R row1 = up
  return {
    x: [R[0], -R[3]],   // world X → (right.x, -up.x)
    y: [R[1], -R[4]],   // world Y → (right.y, -up.y)
    z: [R[2], -R[5]],   // world Z → (right.z, -up.z)
    pixelCounts: {},
    confidence: 1.0,
    detectedAxes: 3,
    strategy: 'model',
  };
}

// ── Main Optimization ────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;

/**
 * Score candidate descriptors against viewport distance transform,
 * refine the best match with ±2° perturbations, estimate pan/zoom.
 */
export function optimizePose(
  candidates: PoseDescriptor[],
  dt: Float32Array,
  dtW: number,
  dtH: number,
  viewportEdgeCentroidX: number,
  viewportEdgeCentroidY: number,
  viewportEdgeBboxW: number,
  viewportEdgeBboxH: number,
): PoseEstimate | null {
  if (candidates.length === 0) return null;

  // ── Step 1: Score each candidate ────────────────────────────
  let bestScore = Infinity;
  let bestCandidate: PoseDescriptor | null = null;
  let bestProj: ReturnType<typeof projectEdgePoints> | null = null;

  for (const cand of candidates) {
    const proj = projectEdgePoints(
      cand.edgePoints3D, cand.pointCount, cand.rotation, dtW, dtH
    );
    const score = chamferScore(proj.x, proj.y, cand.pointCount, dt, dtW, dtH);
    if (score < bestScore) {
      bestScore = score;
      bestCandidate = cand;
      bestProj = proj;
    }
  }

  if (!bestCandidate || !bestProj) return null;

  // ── Step 2: Refine with ±2° perturbations (27 combos) ──────
  let bestRotation = bestCandidate.rotation;
  const perturbations = [-2, 0, 2];

  for (const dx of perturbations) {
    for (const dy of perturbations) {
      for (const dz of perturbations) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const pertRot = smallRotation(dx * DEG2RAD, dy * DEG2RAD, dz * DEG2RAD);
        const combinedRot = mat3Mul(pertRot, bestCandidate.rotation);
        const proj = projectEdgePoints(
          bestCandidate.edgePoints3D, bestCandidate.pointCount, combinedRot, dtW, dtH
        );
        const score = chamferScore(proj.x, proj.y, bestCandidate.pointCount, dt, dtW, dtH);
        if (score < bestScore) {
          bestScore = score;
          bestRotation = combinedRot;
          bestProj = proj;
        }
      }
    }
  }

  // ── Step 3: Translation from centroid comparison ────────────
  const panX = viewportEdgeCentroidX - bestProj.cx;
  const panY = viewportEdgeCentroidY - bestProj.cy;

  // ── Step 4: Zoom from bounding box comparison ──────────────
  const projDiag = Math.sqrt(bestProj.bboxW ** 2 + bestProj.bboxH ** 2);
  const vpDiag = Math.sqrt(viewportEdgeBboxW ** 2 + viewportEdgeBboxH ** 2);
  const zoom = (projDiag > 1 && vpDiag > 1) ? vpDiag / projDiag : 1;

  // ── Step 5: Confidence from Chamfer score ──────────────────
  // Normalize: score of 0 = perfect, score > 20 = bad match
  const confidence = Math.max(0, Math.min(1, 1 - bestScore / 20));

  return {
    rotation: bestRotation,
    cleanAxes: rotationToCleanAxes(bestRotation),
    panX,
    panY,
    zoom,
    chamferScore: bestScore,
    confidence,
  };
}
```

- [ ] **Step 2: Build to verify**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/main/tracking/PoseOptimizer.ts
git commit -m "feat: add PoseOptimizer with Chamfer scoring, perturbation refinement, pan/zoom estimation"
```

---

## Chunk 3: Worker Thread and Orchestrator

### Task 5: Implement pose-worker.ts

**Files:**
- Create: `src/main/tracking/pose-worker.ts`

Dedicated Worker thread that runs edge extraction + database lookup + optimization.

- [ ] **Step 1: Create pose-worker.ts**

```typescript
/**
 * pose-worker.ts — Dedicated Worker for model-based pose estimation.
 *
 * Runs as a Node.js worker_threads Worker (NOT a Web Worker).
 * Uses parentPort for messaging (same pattern as cv-worker.ts).
 *
 * Message protocol:
 *   Inbound:
 *     { type: 'loadDatabase', descriptors: PoseDescriptor[] }
 *     { type: 'frame', data: ArrayBuffer, width: number, height: number }
 *     { type: 'reset' }
 *
 *   Outbound:
 *     { type: 'databaseLoaded', size: number }
 *     { type: 'pose', result: ModelPoseResult }
 *     { type: 'noPose', reason: string }
 *     { type: 'error', message: string }
 */

import { parentPort } from 'worker_threads';
import { extractEdges, resetEdgeExtractor } from './EdgeExtractor';
import { PoseDatabase } from './PoseDatabase';
import type { PoseDescriptor } from './PoseDatabase';
import { optimizePose } from './PoseOptimizer';
import type { ModelPoseResult } from '../../shared/types';

const db = new PoseDatabase();

// ── Viewport Edge Statistics ─────────────────────────────────────

function viewportEdgeStats(
  edges: Uint8Array, w: number, h: number
): { centroidX: number; centroidY: number; bboxW: number; bboxH: number; bboxAspect: number } {
  let sumX = 0, sumY = 0, count = 0;
  let minX = w, maxX = 0, minY = h, maxY = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (edges[y * w + x] === 0) continue;
      sumX += x; sumY += y; count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (count === 0) {
    return { centroidX: w / 2, centroidY: h / 2, bboxW: 0, bboxH: 0, bboxAspect: 1 };
  }

  const bboxW = maxX - minX;
  const bboxH = maxY - minY;

  return {
    centroidX: sumX / count,
    centroidY: sumY / count,
    bboxW,
    bboxH,
    bboxAspect: bboxH > 0 ? bboxW / bboxH : 1,
  };
}

// ── Message Handler (Node.js worker_threads pattern) ─────────────

if (!parentPort) throw new Error('pose-worker must run as a worker_threads Worker');

parentPort.on('message', (msg: any) => {
  try {
    switch (msg.type) {
      case 'loadDatabase': {
        const descriptors = msg.descriptors as PoseDescriptor[];
        resetEdgeExtractor();  // Reset edge detection state for new model
        db.load(descriptors);
        parentPort!.postMessage({ type: 'databaseLoaded', size: db.size });
        break;
      }

      case 'frame': {
        if (!db.ready) {
          parentPort!.postMessage({ type: 'noPose', reason: 'database not ready' });
          return;
        }

        const t0 = performance.now();
        const gray = new Uint8Array(msg.data);
        const w = msg.width as number;
        const h = msg.height as number;

        // 1. Edge extraction + distance transform
        const extraction = extractEdges(gray, w, h);

        // 2. Viewport edge statistics for candidate pruning
        const stats = viewportEdgeStats(extraction.edges, w, h);

        // Normalize centroid to [-1, 1]
        const normCentroidX = (stats.centroidX / w) * 2 - 1;
        const normCentroidY = (stats.centroidY / h) * 2 - 1;

        // 3. Find candidates from database
        const candidates = db.findCandidates(
          extraction.histogram,
          stats.bboxAspect,
          normCentroidX,
          normCentroidY,
          5
        );

        if (candidates.length === 0) {
          parentPort!.postMessage({ type: 'noPose', reason: 'no candidates found' });
          return;
        }

        // 4. Optimize pose (Chamfer scoring + refinement)
        const poseEstimate = optimizePose(
          candidates,
          extraction.dt, w, h,
          stats.centroidX, stats.centroidY,
          stats.bboxW, stats.bboxH,
        );

        if (!poseEstimate || poseEstimate.confidence < 0.1) {
          parentPort!.postMessage({
            type: 'noPose',
            reason: `low confidence: ${poseEstimate?.confidence.toFixed(2) ?? 'null'}`,
          });
          return;
        }

        const latencyMs = performance.now() - t0;

        const result: ModelPoseResult = {
          cleanAxes: poseEstimate.cleanAxes,
          panX: poseEstimate.panX,
          panY: poseEstimate.panY,
          zoom: poseEstimate.zoom,
          confidence: poseEstimate.confidence,
          chamferScore: poseEstimate.chamferScore,
          strategy: 'database',
          latencyMs,
        };

        parentPort!.postMessage({ type: 'pose', result });
        break;
      }

      case 'reset': {
        resetEdgeExtractor();
        db.dispose();
        parentPort!.postMessage({ type: 'databaseLoaded', size: 0 });
        break;
      }
    }
  } catch (err: any) {
    parentPort!.postMessage({ type: 'error', message: err.message || String(err) });
  }
});
```

- [ ] **Step 2: Build to verify**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`

Note: The worker file may need to be included in the TypeScript compilation. Check `tsconfig.main.json` includes `src/main/tracking/`. If not, we'll fix in the next step.

- [ ] **Step 3: Commit**

```bash
git add src/main/tracking/pose-worker.ts
git commit -m "feat: add pose-worker thread for edge extraction + database matching"
```

---

### Task 6: Implement ModelPoseTracker orchestrator

**Files:**
- Create: `src/main/tracking/ModelPoseTracker.ts`

- [ ] **Step 1: Create ModelPoseTracker.ts**

```typescript
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

    const workerPath = path.join(__dirname, 'pose-worker.js');
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
    if (!this.worker) {
      console.warn('[ModelPose] Cannot load database — worker not started');
      return;
    }
    this.worker.postMessage({ type: 'loadDatabase', descriptors });
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
    const buf = Buffer.from(grayBuffer);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    this.worker.postMessage({ type: 'frame', data: ab, width, height });
  }

  /** Clean up resources */
  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }
}
```

- [ ] **Step 2: Build to verify**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/main/tracking/ModelPoseTracker.ts
git commit -m "feat: add ModelPoseTracker orchestrator with worker lifecycle and frame routing"
```

---

## Chunk 4: Database Generator (Overlay Renderer)

### Task 7: Implement PoseDatabaseGenerator in overlay renderer

**Files:**
- Create: `src/renderer/overlay/PoseDatabaseGenerator.ts`

Renders 5000 edge maps using the existing Three.js scene in the overlay renderer. Uses `requestIdleCallback` to avoid stuttering the live display.

- [ ] **Step 1: Create PoseDatabaseGenerator.ts**

```typescript
/**
 * PoseDatabaseGenerator — Renders edge maps from the Three.js model at ~5000
 * orientations using requestIdleCallback batching.
 *
 * Runs in the overlay renderer process (has access to Three.js + WebGL).
 * Sends compact descriptors to main process via IPC when complete.
 */

import * as THREE from 'three';
import { IPC } from '../../shared/types';

const { ipcRenderer } = window.require('electron');

interface GeneratorConfig {
  /** Number of orientations to sample */
  orientationCount: number;
  /** Render target size (square) */
  renderSize: number;
  /** Orientations to process per idle callback batch */
  batchSize: number;
  /** EdgesGeometry angle threshold (degrees) */
  edgeThreshold: number;
  /** Maximum edge points to store per orientation */
  maxPointsPerOrientation: number;
}

const DEFAULT_CONFIG: GeneratorConfig = {
  orientationCount: 5000,
  renderSize: 200,
  batchSize: 50,
  edgeThreshold: 20,
  maxPointsPerOrientation: 200,
};

/** Fibonacci sphere point generation (matching PoseDatabase.ts) */
function fibonacciRotation(index: number, total: number): THREE.Matrix4 {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (2 * index) / (total - 1);
  const radius = Math.sqrt(1 - y * y);
  const theta = goldenAngle * index;
  const x = Math.cos(theta) * radius;
  const z = Math.sin(theta) * radius;

  // Camera position on sphere, looking at origin
  const position = new THREE.Vector3(x, y, z).multiplyScalar(200);
  const lookAt = new THREE.Vector3(0, 0, 0);
  const up = new THREE.Vector3(0, 1, 0);

  // Handle near-pole degeneracy
  if (Math.abs(y) > 0.999) {
    up.set(1, 0, 0);
  }

  const mat = new THREE.Matrix4();
  mat.lookAt(position, lookAt, up);
  return mat;
}

/** Extract 3D edge midpoints from the model's EdgesGeometry meshes */
function extractEdgeMidpoints(modelGroup: THREE.Group): Float32Array {
  const points: number[] = [];

  modelGroup.traverse((child: any) => {
    if (child.isLineSegments && child.geometry) {
      const pos = child.geometry.getAttribute('position');
      if (!pos) return;

      // Get world matrix to transform points to model space
      child.updateWorldMatrix(true, false);
      const worldMatrix = child.matrixWorld;

      for (let i = 0; i < pos.count; i += 2) {
        // Midpoint of each edge segment
        const x = (pos.getX(i) + pos.getX(i + 1)) / 2;
        const y = (pos.getY(i) + pos.getY(i + 1)) / 2;
        const z = (pos.getZ(i) + pos.getZ(i + 1)) / 2;

        const v = new THREE.Vector3(x, y, z).applyMatrix4(worldMatrix);
        points.push(v.x, v.y, v.z);
      }
    }
  });

  return new Float32Array(points);
}

/** Subsample points to fit in a grid (max N points, spatially uniform) */
function subsamplePoints(
  projected2D: { x: number; y: number }[],
  maxPoints: number,
  renderSize: number,
): { indices: number[] } {
  // Grid-based subsampling: divide into cells, keep 1 point per cell
  const cellCount = Math.ceil(Math.sqrt(maxPoints));
  const cellSize = renderSize / cellCount;
  const grid = new Map<string, number>();  // cell key → point index

  for (let i = 0; i < projected2D.length; i++) {
    const cx = Math.floor(projected2D[i].x / cellSize);
    const cy = Math.floor(projected2D[i].y / cellSize);
    const key = `${cx},${cy}`;
    if (!grid.has(key)) {
      grid.set(key, i);
    }
  }

  return { indices: Array.from(grid.values()).slice(0, maxPoints) };
}

/** Compute 16-bin orientation histogram from rendered edge image */
function computeHistogram(edgePixels: Uint8Array, w: number, h: number): Float32Array {
  const BINS = 16;
  const hist = new Float32Array(BINS);

  // Simple gradient direction histogram from edge pixel neighborhoods
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (edgePixels[i] === 0) continue;

      // Sobel-like gradient at this edge pixel
      const gx = (edgePixels[i + 1] > 0 ? 1 : 0) - (edgePixels[i - 1] > 0 ? 1 : 0);
      const gy = (edgePixels[i + w] > 0 ? 1 : 0) - (edgePixels[i - w] > 0 ? 1 : 0);
      if (gx === 0 && gy === 0) continue;

      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      const bin = Math.min(BINS - 1, Math.floor((angle / Math.PI) * BINS));
      hist[bin]++;
    }
  }

  // Normalize
  let sum = 0;
  for (let i = 0; i < BINS; i++) sum += hist[i];
  if (sum > 0) for (let i = 0; i < BINS; i++) hist[i] /= sum;
  return hist;
}

// ── Main Generator ───────────────────────────────────────────────

export class PoseDatabaseGenerator {
  private config: GeneratorConfig;
  private renderer: THREE.WebGLRenderer | null = null;
  private renderTarget: THREE.WebGLRenderTarget | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private isGenerating = false;

  constructor(config: Partial<GeneratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate the view database from the model.
   * Uses requestIdleCallback to batch renders and avoid blocking the UI.
   */
  generate(
    modelGroup: THREE.Group,
    onProgress?: (pct: number) => void,
  ): void {
    if (this.isGenerating) return;
    this.isGenerating = true;

    const { orientationCount, renderSize, batchSize } = this.config;

    // Setup offscreen renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    this.renderer.setSize(renderSize, renderSize);

    this.renderTarget = new THREE.WebGLRenderTarget(renderSize, renderSize);

    // Orthographic camera matching the overlay's setup
    const frustum = renderSize / 12;
    this.camera = new THREE.OrthographicCamera(
      -frustum / 2, frustum / 2, frustum / 2, -frustum / 2, 0.1, 2000
    );

    // Create a scene with just edges (white lines on black background)
    const edgeScene = new THREE.Scene();
    edgeScene.background = new THREE.Color(0x000000);

    // Clone edges only (white material for edge detection)
    const edgeGroup = new THREE.Group();
    modelGroup.traverse((child: any) => {
      if (child.isLineSegments && child.geometry) {
        const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff });
        const edgeMesh = new THREE.LineSegments(child.geometry.clone(), edgeMat);
        edgeMesh.applyMatrix4(child.matrixWorld);
        edgeGroup.add(edgeMesh);
      }
    });
    edgeScene.add(edgeGroup);

    // Extract 3D edge midpoints (once, shared across all orientations)
    const allEdgePoints3D = extractEdgeMidpoints(modelGroup);
    const totalEdgeMidpoints = allEdgePoints3D.length / 3;

    // Normalize edge points to [-1, 1] range
    let maxCoord = 0;
    for (let i = 0; i < allEdgePoints3D.length; i++) {
      maxCoord = Math.max(maxCoord, Math.abs(allEdgePoints3D[i]));
    }
    if (maxCoord > 0) {
      for (let i = 0; i < allEdgePoints3D.length; i++) {
        allEdgePoints3D[i] /= maxCoord;
      }
    }

    const descriptors: any[] = [];
    const readBuffer = new Uint8Array(renderSize * renderSize * 4);
    let currentIndex = 0;

    const processBatch = () => {
      if (!this.isGenerating) return;

      const batchEnd = Math.min(currentIndex + batchSize, orientationCount);

      for (let i = currentIndex; i < batchEnd; i++) {
        // Set camera orientation
        const lookAtMatrix = fibonacciRotation(i, orientationCount);
        this.camera!.position.setFromMatrixPosition(
          new THREE.Matrix4().makeTranslation(0, 0, 200).premultiply(lookAtMatrix)
        );
        // Extract rotation from lookAt matrix
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        lookAtMatrix.decompose(pos, quat, scale);

        this.camera!.position.set(0, 0, 200).applyQuaternion(quat);
        this.camera!.up.set(0, 1, 0).applyQuaternion(quat);
        this.camera!.lookAt(0, 0, 0);
        this.camera!.updateMatrixWorld();

        // Render to offscreen target
        this.renderer!.setRenderTarget(this.renderTarget!);
        this.renderer!.render(edgeScene, this.camera!);
        this.renderer!.readRenderTargetPixels(
          this.renderTarget!, 0, 0, renderSize, renderSize, readBuffer
        );

        // Convert RGBA to binary edge image (white = edge)
        const edgePixels = new Uint8Array(renderSize * renderSize);
        for (let j = 0; j < renderSize * renderSize; j++) {
          edgePixels[j] = readBuffer[j * 4] > 128 ? 255 : 0;
        }

        // Compute edge pixel positions for projection
        const projected2D: { x: number; y: number }[] = [];
        for (let y = 0; y < renderSize; y++) {
          for (let x = 0; x < renderSize; x++) {
            if (edgePixels[y * renderSize + x] > 0) {
              projected2D.push({ x, y });
            }
          }
        }

        if (projected2D.length < 5) continue;  // Skip degenerate views

        // Subsample for storage
        const { indices } = subsamplePoints(
          projected2D, this.config.maxPointsPerOrientation, renderSize
        );

        // For each subsampled 2D point, find the corresponding 3D midpoint
        // by projecting all 3D points and finding nearest to each 2D point
        // (simplified: use the indices directly since we're sampling from projected2D)
        // Store the 3D points for re-projection at arbitrary orientations
        const sampledPoints3D = new Float32Array(indices.length * 3);
        // Project all 3D points to find correspondences
        const camMatrix = this.camera!.matrixWorldInverse;
        const projMatrix = this.camera!.projectionMatrix;
        const mvp = projMatrix.clone().multiply(camMatrix);

        for (let si = 0; si < indices.length; si++) {
          // Find nearest 3D edge midpoint to this projected 2D pixel
          const px = projected2D[indices[si]].x;
          const py = projected2D[indices[si]].y;
          let bestDist = Infinity;
          let bestIdx = 0;

          for (let mi = 0; mi < totalEdgeMidpoints; mi++) {
            const v = new THREE.Vector3(
              allEdgePoints3D[mi * 3],
              allEdgePoints3D[mi * 3 + 1],
              allEdgePoints3D[mi * 3 + 2],
            ).applyMatrix4(mvp);

            // NDC to pixel
            const sx = ((v.x + 1) / 2) * renderSize;
            const sy = ((1 - v.y) / 2) * renderSize;
            const dist = (sx - px) ** 2 + (sy - py) ** 2;
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = mi;
            }
          }

          sampledPoints3D[si * 3] = allEdgePoints3D[bestIdx * 3];
          sampledPoints3D[si * 3 + 1] = allEdgePoints3D[bestIdx * 3 + 1];
          sampledPoints3D[si * 3 + 2] = allEdgePoints3D[bestIdx * 3 + 2];
        }

        // Compute descriptor
        const histogram = computeHistogram(edgePixels, renderSize, renderSize);

        // Centroid and bbox
        let sumX = 0, sumY = 0;
        let minX = renderSize, maxX = 0, minY = renderSize, maxY = 0;
        for (const p of projected2D) {
          sumX += p.x; sumY += p.y;
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        const centroidX = ((sumX / projected2D.length) / renderSize) * 2 - 1;
        const centroidY = ((sumY / projected2D.length) / renderSize) * 2 - 1;
        const bboxW = maxX - minX;
        const bboxH = maxY - minY;
        const bboxAspect = bboxH > 0 ? bboxW / bboxH : 1;

        // Extract rotation matrix (3×3 row-major) from camera
        const camMat = this.camera!.matrixWorldInverse;
        const rotation = new Float32Array([
          camMat.elements[0], camMat.elements[4], camMat.elements[8],
          camMat.elements[1], camMat.elements[5], camMat.elements[9],
          camMat.elements[2], camMat.elements[6], camMat.elements[10],
        ]);

        descriptors.push({
          index: i,
          rotation,
          histogram,
          edgePoints3D: sampledPoints3D,
          pointCount: indices.length,
          bboxAspect,
          centroidX,
          centroidY,
        });
      }

      currentIndex = batchEnd;
      const pct = Math.round((currentIndex / orientationCount) * 100);
      onProgress?.(pct);

      if (currentIndex < orientationCount) {
        // Schedule next batch
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(processBatch, { timeout: 100 });
        } else {
          setTimeout(processBatch, 16);
        }
      } else {
        // Done — send database to main process
        console.log(`[PoseDBGen] Generated ${descriptors.length} descriptors`);
        ipcRenderer.send(IPC.MODELPOSE_DATABASE, descriptors);
        this.cleanup();
      }
    };

    // Start processing
    console.log(`[PoseDBGen] Starting: ${orientationCount} orientations, ${renderSize}px, batch=${batchSize}`);
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(processBatch, { timeout: 100 });
    } else {
      setTimeout(processBatch, 16);
    }
  }

  /** Cancel generation */
  cancel(): void {
    this.isGenerating = false;
    this.cleanup();
  }

  private cleanup(): void {
    this.isGenerating = false;
    this.renderTarget?.dispose();
    this.renderer?.dispose();
    this.renderTarget = null;
    this.renderer = null;
    this.camera = null;
  }
}
```

- [ ] **Step 2: Build to verify**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/overlay/PoseDatabaseGenerator.ts
git commit -m "feat: add PoseDatabaseGenerator with requestIdleCallback batching and 3D edge midpoint extraction"
```

---

## Chunk 5: Integration — Wire Everything Together

### Task 8: Integrate ModelPoseTracker into CVTracker

**Files:**
- Modify: `src/main/tracking/CVTracker.ts`

- [ ] **Step 1: Add ModelPoseTracker to CVTracker**

Add import at top of file (after existing imports):

```typescript
import { ModelPoseTracker } from './ModelPoseTracker';
```

Add field after `viewCubeTracker` declaration (~line 110):

```typescript
private modelPoseTracker: ModelPoseTracker;
```

In constructor (~line 150), after `this.viewCubeTracker = new ViewCubeTracker();`:

```typescript
this.modelPoseTracker = new ModelPoseTracker();
this.modelPoseTracker.on('modelPoseUpdate', (result) => {
  this.emit('modelPoseUpdate', result);
});
this.modelPoseTracker.on('databaseStatus', (status) => {
  this.emit('modelPoseDatabaseStatus', status);
});
```

Add public accessor:

```typescript
getModelPoseTracker(): ModelPoseTracker {
  return this.modelPoseTracker;
}
```

In `start()` method, add after existing worker start:

```typescript
this.modelPoseTracker.start();
```

In `stop()` method, add:

```typescript
this.modelPoseTracker.stop();
```

In `pushViewportFrame()` method (~line 274), add at the end (after the optical flow worker post):

```typescript
// Also route to model pose tracker (it internally throttles to every 5th frame)
this.modelPoseTracker.pushFrame(dataBuffer, width, height);
```

- [ ] **Step 2: Build to verify**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/main/tracking/CVTracker.ts
git commit -m "feat: integrate ModelPoseTracker into CVTracker with frame routing"
```

---

### Task 9: Wire IPC in main process

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add modelPoseUpdate handler**

After the existing `viewCubeRotation` handler (~line 237), add:

```typescript
cvTracker.on('modelPoseUpdate', (result: any) => {
  if (result.confidence > 0.3) {
    console.log(`[Main] ModelPose: conf=${result.confidence.toFixed(2)} chamfer=${result.chamferScore.toFixed(1)} ${result.latencyMs.toFixed(0)}ms`);

    alignment.viewCubeAxes = result.cleanAxes || null;
    // Pan and zoom from model pose (only if confidence is high enough)
    if (result.confidence > 0.5) {
      alignment.positionX = result.panX;
      alignment.positionY = result.panY;
      alignment.scale = result.zoom;
    }
    broadcastAlignment();
  }
});

cvTracker.on('modelPoseDatabaseStatus', (status: string) => {
  setupWindow?.win.webContents.send(IPC.MODELPOSE_STATUS, status);
});
```

- [ ] **Step 2: Add MODELPOSE_DATABASE handler**

After the SW_BRIDGE handlers (~line 795), add:

```typescript
// -- Model Pose Database --
ipcMain.on(IPC.MODELPOSE_DATABASE, (_event, descriptors: any[]) => {
  console.log(`[Main] Received model pose database: ${descriptors.length} descriptors`);
  cvTracker?.getModelPoseTracker()?.loadDatabase(descriptors);
  setupWindow?.win.webContents.send(IPC.MODELPOSE_STATUS, 'ready');
});
```

- [ ] **Step 3: Trigger database generation on GLTF load**

In the existing GLTF load handler (where `GLTF_DATA` is sent, ~line 335), add after the overlay send:

```typescript
// Trigger model pose database generation in overlay renderer
overlayWindow?.win.webContents.send(IPC.MODELPOSE_GENERATE);
```

- [ ] **Step 4: Build to verify**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: wire model pose IPC — database handler, pose update handler, GLTF trigger"
```

---

### Task 10: Add database generation to overlay renderer

**Files:**
- Modify: `src/renderer/overlay/OverlayApp.tsx`

- [ ] **Step 1: Import PoseDatabaseGenerator**

Add import at top:

```typescript
import { PoseDatabaseGenerator } from './PoseDatabaseGenerator';
```

- [ ] **Step 2: Add generator ref and IPC listener**

Inside the `OverlayApp` function, after the existing refs (~line 44), add:

```typescript
const poseDbGeneratorRef = useRef<PoseDatabaseGenerator | null>(null);
```

Add a new `useEffect` after the GLTF_DATA handler useEffect (~line 225):

```typescript
useEffect(() => {
  const handleGenerate = () => {
    const { modelGroup } = stateRef.current;
    if (!modelGroup) {
      console.warn('[Overlay] MODELPOSE_GENERATE received but no model loaded');
      return;
    }

    console.log('[Overlay] Starting pose database generation...');
    if (poseDbGeneratorRef.current) {
      poseDbGeneratorRef.current.cancel();
    }

    poseDbGeneratorRef.current = new PoseDatabaseGenerator();
    poseDbGeneratorRef.current.generate(modelGroup, (pct) => {
      if (pct % 10 === 0) {
        console.log(`[Overlay] Pose database: ${pct}%`);
      }
    });
  };

  ipcRenderer.on(IPC.MODELPOSE_GENERATE, handleGenerate);
  return () => {
    ipcRenderer.removeListener(IPC.MODELPOSE_GENERATE, handleGenerate);
    poseDbGeneratorRef.current?.cancel();
  };
}, []);
```

- [ ] **Step 3: Build to verify**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/overlay/OverlayApp.tsx
git commit -m "feat: add PoseDatabaseGenerator trigger on MODELPOSE_GENERATE in overlay renderer"
```

---

### Task 11: Add status indicator to setup panel

**Files:**
- Modify: `src/renderer/setup/SetupApp.tsx`

- [ ] **Step 1: Add model pose status state**

In the state declarations (~line 85), add:

```typescript
const [modelPoseStatus, setModelPoseStatus] = useState<string>('');
```

Add useEffect for the status:

```typescript
useEffect(() => {
  const handler = (_e: any, status: string) => {
    setModelPoseStatus(status);
  };
  ipcRenderer.on(IPC.MODELPOSE_STATUS, handler);
  return () => { ipcRenderer.removeListener(IPC.MODELPOSE_STATUS, handler); };
}, []);
```

- [ ] **Step 2: Add status indicator in tracking section**

Find the tracking section in the JSX (near the SW Bridge status, ~line 489). Add after the view cube debug section:

```tsx
{modelPoseStatus && (
  <div style={{
    padding: '4px 8px',
    fontSize: 10,
    color: modelPoseStatus === 'ready' ? '#4caf50' : '#ff9800',
    background: modelPoseStatus === 'ready' ? '#e8f5e9' : '#fff3e0',
    borderRadius: 4,
    marginTop: 4,
  }}>
    Model Tracking: {modelPoseStatus === 'ready' ? 'LIVE' : 'building database...'}
    {modelPoseStatus === 'ready' && (
      <span style={{ fontSize: 9, color: '#888', marginLeft: 6 }}>
        Tip: Use &quot;Shaded with Edges&quot; in CAD for best accuracy
      </span>
    )}
  </div>
)}
```

- [ ] **Step 3: Build to verify**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/setup/SetupApp.tsx
git commit -m "feat: add model pose tracking status indicator to setup panel"
```

---

## Chunk 6: Build, Test, and Validate

### Task 12: Verify full build and run

- [ ] **Step 1: Full build**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm run build`

Expected: Clean compilation with no errors.

- [ ] **Step 2: Fix any TypeScript errors**

If there are compilation errors, fix them. Common issues:
- Missing imports
- Type mismatches between IPC messages
- Worker path resolution (may need to adjust `tsconfig.main.json`)

- [ ] **Step 3: Start the app and load a model**

Run: `cd "C:/Users/team/overlay/app Overlay APP/app Overlay APP/hanomi-overlay" && npm start`

- Load a GLTF/STEP model via the setup panel
- Watch console for: `[PoseDBGen] Starting: 5000 orientations...`
- Wait for: `[Main] Received model pose database: XXXX descriptors`
- Setup panel should show: "Model Tracking: LIVE"

- [ ] **Step 4: Test tracking**

- Draw a viewport ROI around the CAD model area
- Start tracking
- Rotate the model in SolidWorks (or any CAD software)
- Watch console for: `[Main] ModelPose: conf=X.XX chamfer=X.X XXms`
- Overlay should track the model rotation

- [ ] **Step 5: Commit all remaining fixes**

```bash
git add -A
git commit -m "fix: resolve build issues and validate model pose tracking end-to-end"
```
