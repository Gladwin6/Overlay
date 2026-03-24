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
