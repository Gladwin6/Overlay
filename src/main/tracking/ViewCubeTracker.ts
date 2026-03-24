/**
 * ViewCubeTracker — Detects absolute 3D rotation from a CAD software's view cube / orientation gizmo.
 *
 * Ported from hanomi-platform's viewCubeTracker.js (the working implementation).
 *
 * Two strategies:
 *   1. Color-based axis detection — works for colored triads (SolidWorks, CATIA, Fusion 360, Onshape)
 *   2. Edge-based detection — fallback for monochrome cubes (Inventor, etc.)
 *
 * Rotation reconstruction:
 *   - 2D axis projections → camera right/up vectors → rotation matrix → spherical coordinates
 *   - CRITICAL: 2D projections must preserve MAGNITUDE (not unit-normalize).
 *     The projection length encodes how face-on each axis is.
 *
 * Input: RGBA pixel buffer of the cropped view cube region (~120x120px)
 * Output: absolute rotation in degrees { rotationX, rotationY, rotationZ } + confidence
 */

import { ViewCubeAxes, ViewCubeResult, AxisMapping, AxisSource } from '../../shared/types';

// ── HSV Conversion ──────────────────────────────────────────────────

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h: number, s = max === 0 ? 0 : d / max, v = max;
  if (d === 0) h = 0;
  else if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, v];
}

// ── Direction Computation via PCA (magnitude-preserving) ────────────
// Fits a line through the colored pixel cluster using Principal Component Analysis.
// Returns the dominant direction scaled by centroid distance / halfSize.
// PCA is far more robust than centroid — uses ALL pixels, finds direction of
// maximum variance, and is resistant to outlier/stray pixels.

function computeDirectionPCA(pixels: [number, number][], halfSize: number, prevDir?: [number, number] | null): [number, number] | null {
  const n = pixels.length;
  if (n < 3) return null;  // Lowered from 5 — cube-style indicators may have very few axis pixels

  // 1. Centroid
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += pixels[i][0]; my += pixels[i][1]; }
  mx /= n; my /= n;

  // 2. Covariance matrix [Cxx, Cxy; Cxy, Cyy]
  let cxx = 0, cxy = 0, cyy = 0;
  for (let i = 0; i < n; i++) {
    const dx = pixels[i][0] - mx;
    const dy = pixels[i][1] - my;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }
  cxx /= n; cxy /= n; cyy /= n;

  // 3. Dominant eigenvector of 2x2 symmetric matrix (closed-form)
  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = trace * trace - 4 * det;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const lambda1 = (trace + sqrtDisc) / 2;

  let ex: number, ey: number;
  if (Math.abs(cxy) > 1e-6) {
    ex = cxy;
    ey = lambda1 - cxx;
  } else {
    ex = cxx >= cyy ? 1 : 0;
    ey = cxx >= cyy ? 0 : 1;
  }

  const eLen = Math.sqrt(ex * ex + ey * ey);
  if (eLen < 1e-8) return null;
  ex /= eLen; ey /= eLen;

  // 4. Orient: use previous frame's direction for temporal consistency (stable),
  //    falling back to centroid direction (away from center) for first frame.
  const centroidDist = Math.sqrt(mx * mx + my * my);
  if (centroidDist < 2) return null;

  if (prevDir) {
    // Temporal consistency: pick the sign that matches previous frame's direction.
    // This prevents random flipping when centroid passes near image center.
    if (ex * prevDir[0] + ey * prevDir[1] < 0) { ex = -ex; ey = -ey; }
  } else {
    // First frame: orient away from center (same direction as centroid)
    if (ex * mx + ey * my < 0) { ex = -ex; ey = -ey; }
  }

  // 5. Scale by centroid distance to preserve magnitude
  const scale = centroidDist / halfSize;
  return [ex * scale, ey * scale];
}

// ── Color-Based Axis Detection ──────────────────────────────────────

function detectAxesByColor(
  data: Uint8Array | Uint8ClampedArray, w: number, h: number,
  prevAxes?: Pick<ViewCubeAxes, 'x' | 'y' | 'z'> | null,
): ViewCubeAxes {
  const cx = w / 2, cy = h / 2, half = Math.max(w, h) / 2;
  const rp: [number, number][] = [], gp: [number, number][] = [], bp: [number, number][] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      const [hue, sat, val] = rgbToHsv(r, g, b);
      // Baseline: skip grays AND dark pixels. val > 0.35 rejects dark app backgrounds
      // (e.g., eDrawings RGB(56,68,83) has val=0.325, sat=0.325 — looks "blue" but isn't an axis).
      // Real axis colors, even anti-aliased/blended with dark bg, stay above val=0.35.
      // Reject grays (sat < 0.15) and dark pixels (val < 0.35).
      // Saturation threshold 0.28 balances: rejects cube body colors (sat 0.15-0.25)
      // but keeps anti-aliased/blended axis pixels (sat typically 0.30-1.0).
      if (sat < 0.15 || val < 0.35) continue;
      if ((hue < 45 || hue > 315) && sat > 0.28) rp.push([x - cx, y - cy]);
      else if (hue > 65 && hue < 175 && sat > 0.28) gp.push([x - cx, y - cy]);
      else if (hue > 185 && hue < 295 && sat > 0.28) bp.push([x - cx, y - cy]);
    }
  }

  const det = [rp, gp, bp].filter(p => p.length >= 3).length;

  // Adaptive confidence — works for both triads (hundreds of pixels) and cubes (dozens).
  // Instead of comparing against image area (which penalizes cube-style indicators),
  // measure detection QUALITY: how many axes found + per-axis PCA reliability.
  //
  // Per-axis quality uses log scale — diminishing returns past ~30px:
  //   3px → 0.32,  7px → 0.57,  15px → 0.80,  30px → 1.0,  200px → 1.0
  // This naturally handles both: cube (7-27px/axis) and triad (50-300px/axis).
  let confidence = 0;
  if (det >= 2) {
    const baseConf = det >= 3 ? 1.0 : 0.6;
    const LOG2_30 = Math.log2(30);  // ~4.91 — 30px per axis = fully reliable PCA
    const axisQualities = [rp.length, gp.length, bp.length]
      .filter(n => n >= 3)
      .map(n => Math.min(1, Math.log2(Math.max(1, n)) / LOG2_30));
    const avgQuality = axisQualities.reduce((a, b) => a + b, 0) / axisQualities.length;
    confidence = baseConf * avgQuality;
  }

  const xDir = computeDirectionPCA(rp, half, prevAxes?.x);
  const yDir = computeDirectionPCA(gp, half, prevAxes?.y);
  const zDir = computeDirectionPCA(bp, half, prevAxes?.z);
  const fmt = (d: [number, number] | null) => d ? `(${d[0].toFixed(2)},${d[1].toFixed(2)})` : 'null';
  if (Math.random() < 0.1) console.log(`[VC-color] R:${rp.length}px→${fmt(xDir)} G:${gp.length}px→${fmt(yDir)} B:${bp.length}px→${fmt(zDir)}`);

  return {
    x: xDir,
    y: yDir,
    z: zDir,
    pixelCounts: { red: rp.length, green: gp.length, blue: bp.length },
    confidence,
    detectedAxes: det,
    strategy: 'color',
  };
}

// ── Edge-Based Axis Detection (fallback) ────────────────────────────

function detectAxesByEdges(
  data: Uint8Array | Uint8ClampedArray, w: number, h: number,
  prevAxes?: Pick<ViewCubeAxes, 'x' | 'y' | 'z'> | null,
): ViewCubeAxes {
  // Convert RGBA to grayscale
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    gray[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }

  // Sobel gradients
  const gM = new Float32Array(w * h);
  const gD = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const gx = -gray[(y - 1) * w + (x - 1)] + gray[(y - 1) * w + (x + 1)]
        - 2 * gray[y * w + (x - 1)] + 2 * gray[y * w + (x + 1)]
        - gray[(y + 1) * w + (x - 1)] + gray[(y + 1) * w + (x + 1)];
      const gy = -gray[(y - 1) * w + (x - 1)] - 2 * gray[(y - 1) * w + x] - gray[(y - 1) * w + (x + 1)]
        + gray[(y + 1) * w + (x - 1)] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + (x + 1)];
      gM[idx] = Math.sqrt(gx * gx + gy * gy);
      gD[idx] = Math.atan2(gy, gx);
    }
  }

  // Threshold at top 15% of gradient magnitudes
  const sorted = Array.from(gM).sort((a, b) => b - a);
  const thr = sorted[Math.floor(sorted.length * 0.15)] || 30;

  // Hough-like angle histogram
  const nBins = 180;
  const hist = new Float32Array(nBins);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w; x++) {
      const idx = y * w + x;
      if (gM[idx] < thr) continue;
      let ea = gD[idx] + Math.PI / 2;
      while (ea < 0) ea += Math.PI;
      while (ea >= Math.PI) ea -= Math.PI;
      hist[Math.floor((ea / Math.PI) * nBins) % nBins] += gM[idx];
    }
  }

  // Smooth histogram
  const sm = new Float32Array(nBins);
  const k = [0.05, 0.1, 0.2, 0.3, 0.2, 0.1, 0.05];
  for (let i = 0; i < nBins; i++) {
    let s = 0;
    for (let j = -3; j <= 3; j++) s += hist[(i + j + nBins) % nBins] * k[j + 3];
    sm[i] = s;
  }

  // Find up to 3 dominant line angles
  const minSep = 25;
  const peaks: { bin: number; strength: number }[] = [];
  for (let iter = 0; iter < 3; iter++) {
    let bb = -1, bv = 0;
    for (let i = 0; i < nBins; i++) {
      if (sm[i] > bv) {
        let ok = true;
        for (const p of peaks) {
          if (Math.min(Math.abs(i - p.bin), nBins - Math.abs(i - p.bin)) < minSep) { ok = false; break; }
        }
        if (ok) { bv = sm[i]; bb = i; }
      }
    }
    if (bb >= 0 && bv > 0) {
      peaks.push({ bin: bb, strength: bv });
      for (let j = -minSep; j <= minSep; j++) sm[(bb + j + nBins) % nBins] *= 0.1;
    }
  }

  if (peaks.length < 2) {
    return {
      x: null, y: null, z: null,
      pixelCounts: { edges: 0 },
      confidence: 0, detectedAxes: 0, strategy: 'edges',
    };
  }

  peaks.sort((a, b) => a.bin - b.bin);
  const dirs = peaks.map(p => {
    const a = (p.bin / nBins) * Math.PI;
    return [Math.cos(a), Math.sin(a)] as [number, number];
  });
  const peakStrengths = peaks.map(p => p.strength);
  const assigned = assignAxesToDirections(dirs, peakStrengths, prevAxes);

  return {
    x: assigned.x,
    y: assigned.y,
    z: assigned.z,
    pixelCounts: {
      edges: peaks.reduce((s, p) => s + p.strength, 0),
      xStrength: assigned.axisStrengths[0],
      yStrength: assigned.axisStrengths[1],
      zStrength: assigned.axisStrengths[2],
    },
    confidence: peaks.length >= 2 ? 0.5 + (peaks.length - 2) * 0.25 : 0,
    detectedAxes: peaks.length,
    strategy: 'edges',
  };
}

// ── Cube Corner Detection (monochrome view cubes) ─────────────────────
//
// For monochrome cubes (eDrawings, Inventor) where color detection finds 0 axes.
//
// Key insight: Under orthographic projection, a cube silhouette is a HEXAGON
// (generic viewpoint) or RECTANGLE (face-on). The 3 diagonals of the hexagon
// intersect at the "near corner" — the projected cube vertex closest to camera.
// The 3 vectors from near corner to inner hex vertices ARE the projected X/Y/Z
// axes with correct foreshortening. Same format reconstructFromTwoAxes() consumes.

/** Otsu threshold: find threshold that maximizes between-class variance */
function otsuThreshold(gray: Float32Array): number {
  const hist = new Float32Array(256);
  for (let i = 0; i < gray.length; i++) {
    hist[Math.min(255, Math.max(0, Math.round(gray[i])))]++;
  }

  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];

  let sumBg = 0, wBg = 0, maxVar = 0, bestT = 128;
  for (let t = 0; t < 256; t++) {
    wBg += hist[t];
    if (wBg === 0) continue;
    const wFg = total - wBg;
    if (wFg === 0) break;
    sumBg += t * hist[t];
    const meanBg = sumBg / wBg;
    const meanFg = (sumAll - sumBg) / wFg;
    const variance = wBg * wFg * (meanBg - meanFg) * (meanBg - meanFg);
    if (variance > maxVar) { maxVar = variance; bestT = t; }
  }
  return bestT;
}

/** Moore boundary tracing (8-connected) — returns ordered contour pixels */
function mooreBoundaryTrace(
  binary: Uint8Array, w: number, h: number
): [number, number][] {
  // Find a start pixel (top-left foreground pixel)
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (binary[y * w + x]) { sx = x; sy = y; break outer; }
    }
  }
  if (sx < 0) return [];

  // 8-connected neighbor offsets (clockwise from left)
  const dx = [-1, -1, 0, 1, 1, 1, 0, -1];
  const dy = [0, -1, -1, -1, 0, 1, 1, 1];

  const contour: [number, number][] = [[sx, sy]];
  let cx = sx, cy = sy;
  let dir = 0; // start looking left

  const maxIter = w * h * 2; // safety
  for (let iter = 0; iter < maxIter; iter++) {
    // Search clockwise from (dir + 5) mod 8 (= backtrack + 1)
    const startDir = (dir + 5) % 8;
    let found = false;
    for (let i = 0; i < 8; i++) {
      const d = (startDir + i) % 8;
      const nx = cx + dx[d], ny = cy + dy[d];
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && binary[ny * w + nx]) {
        cx = nx; cy = ny; dir = d;
        if (cx === sx && cy === sy) return contour; // closed
        contour.push([cx, cy]);
        found = true;
        break;
      }
    }
    if (!found) break;
  }
  return contour;
}

/** Convex hull via Andrew's monotone chain — deterministic, O(n log n) */
function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = pts.length;
  if (n <= 2) return pts;

  const cross = (O: [number, number], A: [number, number], B: [number, number]) =>
    (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);

  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = n - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
    upper.push(pts[i]);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Find corners on a convex hull by sharpest turning angles */
function findCornersOnHull(hull: [number, number][], maxCorners: number): [number, number][] {
  const n = hull.length;
  if (n <= maxCorners) return hull;

  // Compute turning angle at each hull vertex
  const angles: { idx: number; angle: number }[] = [];
  for (let i = 0; i < n; i++) {
    const prev = hull[(i - 1 + n) % n];
    const curr = hull[i];
    const next = hull[(i + 1) % n];
    const v1x = curr[0] - prev[0], v1y = curr[1] - prev[1];
    const v2x = next[0] - curr[0], v2y = next[1] - curr[1];
    const cross = v1x * v2y - v1y * v2x;
    const dot = v1x * v2x + v1y * v2y;
    const angle = Math.PI - Math.abs(Math.atan2(cross, dot)); // 0 = straight, π = sharp
    angles.push({ idx: i, angle });
  }

  // Sort by sharpest angle, select with minimum separation
  angles.sort((a, b) => b.angle - a.angle);
  const minSep = Math.max(2, Math.floor(n / (maxCorners * 2)));
  const selected: number[] = [];

  for (const a of angles) {
    if (selected.length >= maxCorners) break;
    let tooClose = false;
    for (const s of selected) {
      const d = Math.min(Math.abs(a.idx - s), n - Math.abs(a.idx - s));
      if (d < minSep) { tooClose = true; break; }
    }
    if (!tooClose) selected.push(a.idx);
  }

  // Maintain hull ordering
  selected.sort((a, b) => a - b);
  return selected.map(i => hull[i]);
}

/** Line-line intersection: returns parameter t for P = a + t*(b-a) */
function lineLineIntersect(
  a: [number, number], b: [number, number],
  c: [number, number], d: [number, number],
): [number, number] | null {
  const dx1 = b[0] - a[0], dy1 = b[1] - a[1];
  const dx2 = d[0] - c[0], dy2 = d[1] - c[1];
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-8) return null; // parallel
  const t = ((c[0] - a[0]) * dy2 - (c[1] - a[1]) * dx2) / denom;
  return [a[0] + t * dx1, a[1] + t * dy1];
}

/** Distance from point to polygon centroid */
function dist(a: [number, number], b: [number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
}

function detectAxesByCube(
  data: Uint8Array | Uint8ClampedArray, w: number, h: number,
  prevAxes?: Pick<ViewCubeAxes, 'x' | 'y' | 'z'> | null,
): ViewCubeAxes {
  const cx = w / 2, cy = h / 2, half = Math.max(w, h) / 2;

  // Step 1: RGBA → grayscale → Otsu threshold → binary
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    gray[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  const threshold = otsuThreshold(gray);
  const binary = new Uint8Array(w * h);
  // Determine if cube is lighter or darker than background
  // Check corners for background color
  const corners = [gray[0], gray[w - 1], gray[(h - 1) * w], gray[(h - 1) * w + w - 1]];
  const bgMean = corners.reduce((a, b) => a + b, 0) / 4;
  const cubeIsLight = bgMean < threshold;
  for (let i = 0; i < w * h; i++) {
    binary[i] = cubeIsLight ? (gray[i] >= threshold ? 1 : 0) : (gray[i] < threshold ? 1 : 0);
  }

  // Check silhouette area
  let fgCount = 0;
  for (let i = 0; i < binary.length; i++) fgCount += binary[i];
  if (fgCount < w * h * 0.05) {
    return { x: null, y: null, z: null, pixelCounts: { cube: 0 }, confidence: 0, detectedAxes: 0, strategy: 'cube' };
  }

  // Step 2: Moore boundary trace → convex hull → curvature corners
  const contour = mooreBoundaryTrace(binary, w, h);
  if (contour.length < 12) {
    return { x: null, y: null, z: null, pixelCounts: { cube: contour.length }, confidence: 0, detectedAxes: 0, strategy: 'cube' };
  }

  // Convex hull of contour — deterministic, ignores noise concavities
  const hull = convexHull(contour);
  if (hull.length < 4) {
    return { x: null, y: null, z: null, pixelCounts: { cube: contour.length }, confidence: 0, detectedAxes: 0, strategy: 'cube' };
  }

  // Find 4-7 sharpest corners on the hull
  const polygon = findCornersOnHull(hull, 7);
  if (polygon.length < 4) {
    return { x: null, y: null, z: null, pixelCounts: { cube: contour.length }, confidence: 0, detectedAxes: 0, strategy: 'cube' };
  }

  const n = polygon.length;
  let nearCorner: [number, number] | null = null;
  let innerVertices: [number, number][] = [];
  let confidence = 0;

  if (n === 6) {
    // ── Hexagonal case: intersect diagonals to find near corner ──
    // 3 diagonals connect opposite vertices: (0,3), (1,4), (2,5)
    const diag1 = lineLineIntersect(polygon[0], polygon[3], polygon[1], polygon[4]);
    const diag2 = lineLineIntersect(polygon[0], polygon[3], polygon[2], polygon[5]);

    if (diag1 && diag2) {
      // Average both intersection estimates for robustness
      nearCorner = [(diag1[0] + diag2[0]) / 2, (diag1[1] + diag2[1]) / 2];

      // Verify near corner is approximately inside the hexagon
      // (check it's reasonably close to centroid)
      const centroid: [number, number] = [
        polygon.reduce((s, v) => s + v[0], 0) / 6,
        polygon.reduce((s, v) => s + v[1], 0) / 6,
      ];
      const hexRadius = Math.max(...polygon.map(v => dist(v, centroid)));
      if (dist(nearCorner, centroid) > hexRadius * 1.5) {
        nearCorner = null; // bad intersection, likely not a cube
      }
    }

    if (nearCorner) {
      // Inner vertices = the 3 hex vertices closest to the near corner
      const sorted = polygon.map((v, i) => ({ v, i, d: dist(v, nearCorner!) }))
        .sort((a, b) => a.d - b.d);
      innerVertices = sorted.slice(0, 3).map(s => s.v);
      confidence = 0.85;
    }
  } else if (n === 5) {
    // ── Pentagonal case: one edge nearly aligned with view ──
    // Find the vertex with smallest interior angle (the near corner candidate)
    let minAngle = Infinity, minIdx = 0;
    for (let i = 0; i < 5; i++) {
      const prev = polygon[(i + 4) % 5];
      const curr = polygon[i];
      const next = polygon[(i + 1) % 5];
      const v1x = prev[0] - curr[0], v1y = prev[1] - curr[1];
      const v2x = next[0] - curr[0], v2y = next[1] - curr[1];
      const dot = v1x * v2x + v1y * v2y;
      const cross = v1x * v2y - v1y * v2x;
      const angle = Math.abs(Math.atan2(cross, dot));
      if (angle < minAngle) { minAngle = angle; minIdx = i; }
    }
    nearCorner = polygon[minIdx];
    // Inner vertices = the 2 adjacent vertices (in a pentagon, near corner connects to 2 inner verts)
    innerVertices = [
      polygon[(minIdx + 1) % 5],
      polygon[(minIdx + 4) % 5],
    ];
    confidence = 0.65;
  } else if (n === 4) {
    // ── Rectangular case: face-on view ──
    // Near corner = vertex where 2 shorter edges meet
    const edges: { len: number; idx: number }[] = [];
    for (let i = 0; i < 4; i++) {
      edges.push({ len: dist(polygon[i], polygon[(i + 1) % 4]), idx: i });
    }
    // Find vertex incident to 2 shortest edges
    const edgeLens = edges.map(e => e.len);
    const avgLen = edgeLens.reduce((a, b) => a + b, 0) / 4;
    // Vertex scores: sum of incident edge lengths (lower = more likely near corner)
    let minScore = Infinity, minIdx = 0;
    for (let i = 0; i < 4; i++) {
      const score = edgeLens[i] + edgeLens[(i + 3) % 4];
      if (score < minScore) { minScore = score; minIdx = i; }
    }
    nearCorner = polygon[minIdx];
    innerVertices = [
      polygon[(minIdx + 1) % 4],
      polygon[(minIdx + 3) % 4],
    ];
    confidence = 0.50;
  } else {
    // 7 vertices — try to reduce by merging closest pair, then retry as 6
    // For now, fall through with 0 confidence
    return { x: null, y: null, z: null, pixelCounts: { cube: contour.length }, confidence: 0, detectedAxes: 0, strategy: 'cube' };
  }

  if (!nearCorner || innerVertices.length < 2) {
    return { x: null, y: null, z: null, pixelCounts: { cube: contour.length }, confidence: 0, detectedAxes: 0, strategy: 'cube' };
  }

  console.log(`[VC-cube] ${n} vertices, nearCorner=(${nearCorner[0].toFixed(0)},${nearCorner[1].toFixed(0)}), ` +
    `innerVerts=${innerVertices.length}, fgRatio=${(fgCount / (w * h)).toFixed(2)}`);

  // Step 5: Extract edge vectors (near corner → inner vertex), centered & normalized
  const dirs: [number, number][] = innerVertices.map(v => {
    const ex = (v[0] - nearCorner![0]) / half;
    const ey = (v[1] - nearCorner![1]) / half;
    return [ex, ey] as [number, number];
  });

  // Strengths proportional to edge length (longer = more face-on = stronger signal)
  const strengths = dirs.map(d => Math.sqrt(d[0] * d[0] + d[1] * d[1]));

  // Reduce confidence if silhouette area is very small
  const areaRatio = fgCount / (w * h);
  if (areaRatio < 0.1) confidence *= 0.7;

  // Use existing axis assignment infrastructure
  const assigned = assignAxesToDirections(dirs, strengths, prevAxes);

  return {
    x: assigned.x,
    y: assigned.y,
    z: assigned.z,
    pixelCounts: {
      cube: fgCount,
      vertices: n,
      xStrength: assigned.axisStrengths[0],
      yStrength: assigned.axisStrengths[1],
      zStrength: assigned.axisStrengths[2],
    },
    confidence,
    detectedAxes: dirs.length,
    strategy: 'cube',
  };
}

/** Angular distance between two 2D directions, accounting for line symmetry (0 to π/2) */
function angleBetween2D(a: [number, number], b: [number, number]): number {
  const lenA = Math.sqrt(a[0] * a[0] + a[1] * a[1]);
  const lenB = Math.sqrt(b[0] * b[0] + b[1] * b[1]);
  if (lenA < 1e-8 || lenB < 1e-8) return Math.PI / 2;
  const cosAngle = Math.abs((a[0] * b[0] + a[1] * b[1]) / (lenA * lenB));
  return Math.acos(Math.min(1, cosAngle));
}

interface AssignedAxes {
  x: [number, number] | null;
  y: [number, number] | null;
  z: [number, number] | null;
  axisStrengths: [number, number, number];
}

function assignAxesToDirections(
  dirs: [number, number][],
  peakStrengths: number[],
  prevAxes?: Pick<ViewCubeAxes, 'x' | 'y' | 'z'> | null,
): AssignedAxes {
  const result: AssignedAxes = { x: null, y: null, z: null, axisStrengths: [0, 0, 0] };
  if (dirs.length < 2) return result;

  // Temporal matching: if we have previous axes, match by angular similarity
  if (prevAxes) {
    const prevEntries: { axis: 'x' | 'y' | 'z'; dir: [number, number] }[] = [];
    if (prevAxes.x) prevEntries.push({ axis: 'x', dir: prevAxes.x });
    if (prevAxes.y) prevEntries.push({ axis: 'y', dir: prevAxes.y });
    if (prevAxes.z) prevEntries.push({ axis: 'z', dir: prevAxes.z });

    if (prevEntries.length >= 2) {
      // Build all (newDir → prevAxis) pairs sorted by angular distance
      const pairs: { newIdx: number; axis: 'x' | 'y' | 'z'; angle: number }[] = [];
      for (let ni = 0; ni < dirs.length; ni++) {
        for (const pe of prevEntries) {
          pairs.push({ newIdx: ni, axis: pe.axis, angle: angleBetween2D(dirs[ni], pe.dir) });
        }
      }
      pairs.sort((a, b) => a.angle - b.angle);

      // Greedy assignment: best match first
      const usedNew = new Set<number>();
      const usedAxis = new Set<string>();
      for (const p of pairs) {
        if (usedNew.has(p.newIdx) || usedAxis.has(p.axis)) continue;
        if (p.angle > Math.PI / 4) continue; // reject matches > 45°
        result[p.axis] = dirs[p.newIdx];
        const axisIdx = p.axis === 'x' ? 0 : p.axis === 'y' ? 1 : 2;
        result.axisStrengths[axisIdx] = peakStrengths[p.newIdx] || 0;
        usedNew.add(p.newIdx);
        usedAxis.add(p.axis);
      }

      if (usedNew.size >= 2) return result;
    }
  }

  // Fallback: original heuristic (no history or insufficient matches)
  const sc = dirs.map((d, i) => ({ dir: d, vert: Math.abs(d[1]), idx: i }));
  sc.sort((a, b) => b.vert - a.vert);
  const yD = sc[0].dir;
  const yF: [number, number] = yD[1] > 0 ? [-yD[0], -yD[1]] : [yD[0], yD[1]];
  result.y = yF;
  result.axisStrengths[1] = peakStrengths[sc[0].idx] || 0;

  const rem = sc.slice(1);
  rem.sort((a, b) => a.vert - b.vert);
  const xD = rem[0].dir;
  const xF: [number, number] = xD[0] < 0 ? [-xD[0], -xD[1]] : [xD[0], xD[1]];
  result.x = xF;
  result.axisStrengths[0] = peakStrengths[rem[0].idx] || 0;

  if (rem.length > 1) {
    result.z = rem[1].dir;
    result.axisStrengths[2] = peakStrengths[rem[1].idx] || 0;
  }

  return result;
}

// ── Rotation Reconstruction from 2D Axis Projections ─────────────────
//
// Core algorithm: reconstruct full 3D camera rotation from 2D projections of
// world axes. Uses the orthogonality constraint (all 3 world axes are exactly
// 90° apart) to solve for the camera rotation from only 2 axis projections.
//
// The overlay camera uses:
//   camera.position = dist * (sin(rotY)*cos(rotX), sin(rotX), cos(rotY)*cos(rotX))
//   camera.lookAt(0, 0, 0)
//
// So from the camera forward direction (= camera position normalized):
//   rotationX = asin(forward.y)              → elevation / pitch
//   rotationY = atan2(forward.x, forward.z)  → azimuth / yaw

function vec3Normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len < 1e-8) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function vec3Cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vec3Length(v: [number, number, number]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

// ── Orthogonal Rotation Recovery from 2 Axes ───────────────────────────
//
// Given 2D screen projections of any 2 world axes, solves for the full camera
// rotation matrix using the orthogonality constraint.
//
// Math: The camera right/up vectors in world space have components:
//   right[i] = k·p_i[0],  right[j] = k·p_j[0],  right[missing] = u
//   up[i]    = -k·p_i[1], up[j]    = -k·p_j[1], up[missing]    = v
// where k is a scale factor.
//
// Constraints |right|=1, |up|=1, right·up=0 give a quadratic in s = k²:
//   s²(C²-AB) + s(A+B) - 1 = 0
// where A = a₁²+a₂², B = b₁²+b₂², C = a₁·b₁+a₂·b₂
//
// Discriminant = (A-B)² + 4C² ≥ 0 always, so real solutions are guaranteed.
// Sign ambiguity (u = ±√...) resolved via temporal consistency with prevForward.

function reconstructFromTwoAxes(
  idx1: number, p1: [number, number],
  idx2: number, p2: [number, number],
  prevForward: [number, number, number] | null,
): { rotationX: number; rotationY: number; rotationZ: number; forward: [number, number, number]; cleanAxes: ViewCubeAxes } | null {
  if (idx1 === idx2) return null;

  const a1 = p1[0], b1 = p1[1];
  const a2 = p2[0], b2 = p2[1];

  const A = a1 * a1 + a2 * a2;
  const B = b1 * b1 + b2 * b2;
  const C = a1 * b1 + a2 * b2;

  // Quadratic: qa·s² + qb·s + qc = 0 where s = k²
  const qa = C * C - A * B;
  const qb = A + B;
  const qc = -1;

  let s: number;
  if (Math.abs(qa) < 1e-10) {
    // Degenerate to linear: qb·s = 1
    if (qb < 1e-10) return null;
    s = 1 / qb;
  } else {
    const disc = qb * qb - 4 * qa * qc; // = (A-B)² + 4C² ≥ 0
    if (disc < 0) return null;
    const sqrtDisc = Math.sqrt(disc);
    const s1 = (-qb + sqrtDisc) / (2 * qa);
    const s2 = (-qb - sqrtDisc) / (2 * qa);
    // Need s > 0 and s·A ≤ 1 and s·B ≤ 1 (so u² ≥ 0 and v² ≥ 0)
    const maxS = Math.min(A > 1e-10 ? 1 / A : 1e6, B > 1e-10 ? 1 / B : 1e6);
    const valid = [s1, s2].filter(v => v > 1e-10 && v <= maxS + 1e-6);
    if (valid.length === 0) return null;
    s = Math.min(...valid);
  }

  const k = Math.sqrt(s);
  const idx3 = 3 - idx1 - idx2; // the missing axis index

  // Unknown component magnitudes
  const u2 = Math.max(0, 1 - s * A);
  const uMag = Math.sqrt(u2);

  // Try both signs of u — each gives a valid rotation (opposite hemispheres)
  const candidates: { forward: [number, number, number]; rotationZ: number; rNorm: [number, number, number]; upOrtho: [number, number, number] }[] = [];

  for (const signU of [1, -1]) {
    const u = signU * uMag;
    let v: number;
    if (Math.abs(u) > 1e-8) {
      v = s * C / u; // from orthogonality: u·v = s·C
    } else {
      // u ≈ 0 → v = ±√(1 - s·B), pick sign consistent with s·C ≈ 0
      const vMag = Math.sqrt(Math.max(0, 1 - s * B));
      v = s * C < 0 ? -vMag : vMag;
    }

    // Verify |up| ≈ 1
    const upLen2 = s * B + v * v;
    if (Math.abs(upLen2 - 1) > 0.15) continue;

    // Build right and up vectors in world space
    const right: [number, number, number] = [0, 0, 0];
    const up: [number, number, number] = [0, 0, 0];
    right[idx1] = k * a1;
    right[idx2] = k * a2;
    right[idx3] = u;
    up[idx1] = -k * b1;
    up[idx2] = -k * b2;
    up[idx3] = v;

    const rawFwd = vec3Cross(right, up);
    if (vec3Length(rawFwd) < 0.1) continue;
    const fwd = vec3Normalize(rawFwd);

    // Roll detection from reconstructed right/up
    const rNorm = vec3Normalize(right);
    const upOrtho = vec3Normalize(vec3Cross(fwd, rNorm));
    // Only preserve roll when it's significant AND detection is highly reliable.
    // Tiny roll errors (< 5°) from noisy detection cause visible overlay tilt.
    // The old spherical path forced camera.up=(0,1,0) which silently zeroed roll —
    // that was a feature. Only apply roll when > 5° so it represents real camera tilt.
    // Confidence gate (>= 0.8) applied at the analyze() call site, not here.
    const rawRoll = Math.atan2(rNorm[1], upOrtho[1]) * (180 / Math.PI);
    const rotZ = Math.abs(rawRoll) > 5 && Math.abs(rawRoll) <= 30 ? rawRoll : 0;

    candidates.push({ forward: fwd, rotationZ: rotZ, rNorm, upOrtho });
  }

  if (candidates.length === 0) return null;

  // Pick candidate most consistent with previous forward direction
  let best: { forward: [number, number, number]; rotationZ: number; rNorm: [number, number, number]; upOrtho: [number, number, number] };
  if (prevForward && candidates.length > 1) {
    const dot0 = candidates[0].forward[0] * prevForward[0]
               + candidates[0].forward[1] * prevForward[1]
               + candidates[0].forward[2] * prevForward[2];
    const dot1 = candidates[1].forward[0] * prevForward[0]
               + candidates[1].forward[1] * prevForward[1]
               + candidates[1].forward[2] * prevForward[2];
    best = dot0 >= dot1 ? candidates[0] : candidates[1];
  } else {
    // No previous — prefer forward with positive Z (default camera position)
    best = candidates[0];
    if (candidates.length > 1 && candidates[1].forward[2] > candidates[0].forward[2]) {
      best = candidates[1];
    }
  }

  const forward = best.forward;
  const rotationX = Math.asin(Math.max(-1, Math.min(1, forward[1]))) * (180 / Math.PI);
  const rotationY = Math.atan2(forward[0], forward[2]) * (180 / Math.PI);

  // Derive clean axis projections from the orthonormal right/up vectors.
  // World axis i projects to screen as (right[i], -up[i]).
  const r = best.rNorm;
  const u = best.upOrtho;
  const cleanAxes: ViewCubeAxes = {
    x: [r[0], -u[0]],
    y: [r[1], -u[1]],
    z: [r[2], -u[2]],
    pixelCounts: {},
    confidence: 1.0,  // orthogonality-constrained — always fully consistent
    detectedAxes: 3,
    strategy: 'color',  // placeholder, overwritten by caller
  };

  return { rotationX, rotationY, rotationZ: best.rotationZ, forward, cleanAxes };
}

// ── Axis Strength Extraction ────────────────────────────────────────────

/** Get axis strengths — uses PROJECTION MAGNITUDE (|dir|) for color strategy.
 * Projection magnitude = centroid distance from center / halfSize.
 * This is the RIGHT metric: a contaminated axis has centroid pulled toward center → low |dir| → not selected.
 * Pixel count is the WRONG metric: a contaminated axis has MORE pixels but WORSE direction.
 * The 90° constraint only needs 2 clean axes — magnitude picks the cleanest two. */
function getAxisStrengths(axes: ViewCubeAxes): [number, number, number] {
  // For ALL strategies: use the direction vector magnitude as strength.
  // This ensures the 2 axes with strongest screen projection (= most reliable PCA) are chosen.
  const mag = (d: [number, number] | null): number =>
    d ? Math.sqrt(d[0] * d[0] + d[1] * d[1]) : 0;
  return [mag(axes.x), mag(axes.y), mag(axes.z)];
}

// ── Best-2 Rotation Reconstruction ──────────────────────────────────────
//
// Always uses the 2 strongest detected axes and solves for the rotation via
// the orthogonality-constrained quadratic. This enforces the 90° constraint
// on EVERY frame and prevents the weakest/noisiest axis from corrupting the result.

function axesToSpherical(
  xDir: [number, number] | null,
  yDir: [number, number] | null,
  zDir: [number, number] | null,
  strengths: [number, number, number],
  prevForward: [number, number, number] | null,
): { rotationX: number; rotationY: number; rotationZ: number; forward: [number, number, number]; cleanAxes: ViewCubeAxes } | null {
  // Collect detected axes with their strengths
  const axes: { idx: number; dir: [number, number]; strength: number }[] = [];
  if (xDir) axes.push({ idx: 0, dir: xDir, strength: strengths[0] });
  if (yDir) axes.push({ idx: 1, dir: yDir, strength: strengths[1] });
  if (zDir) axes.push({ idx: 2, dir: zDir, strength: strengths[2] });

  if (axes.length < 2) return null;

  // Always use the 2 strongest axes — enforce orthogonality via quadratic solve
  axes.sort((a, b) => b.strength - a.strength);

  return reconstructFromTwoAxes(
    axes[0].idx, axes[0].dir,
    axes[1].idx, axes[1].dir,
    prevForward,
  );
}

// ── Main Tracker Class ──────────────────────────────────────────────

export type DetectStrategy = 'auto' | 'color' | 'cube' | 'edges';

export class ViewCubeTracker {
  private strategy: DetectStrategy = 'auto';
  private prevRotation: { rotationX: number; rotationY: number; rotationZ: number } | null = null;
  private prevForward: [number, number, number] | null = null;

  // Axis mapping: remap detected view cube axes to overlay axes.
  // Default for Z-up CAD (SolidWorks, eDrawings): { x:'+x', y:'+z', z:'-y' }
  // For Y-up CAD (Fusion 360): { x:'+x', y:'+y', z:'+z' }
  private axisMapping: AxisMapping = { x: '+x', y: '+z', z: '-y' };
  private userSetMapping: boolean = false;   // true = user explicitly set mapping, don't auto-detect
  private autoDetectDone: boolean = false;   // true = auto-detection already ran
  private autoDetectVotes: { zUp: number; yUp: number; xUp: number } = { zUp: 0, yUp: 0, xUp: 0 };
  private static readonly AUTO_DETECT_VOTES_NEEDED = 3;  // Need 3 consistent votes

  // Temporal axis consistency: stores last detected axes for matching edge detection
  // assignments across frames. Updated after every successful detection (color or edges).
  private prevDetectedAxes: Pick<ViewCubeAxes, 'x' | 'y' | 'z'> | null = null;

  // Temporal hold: keep last good result for a few frames during axis dropout
  // (cube-style indicators lose axes momentarily when they go behind the cube body)
  private lastGoodResult: ViewCubeResult | null = null;
  private framesSinceGood: number = 0;
  private static readonly MAX_HOLD_FRAMES = 3;

  // Cube strategy EMA — cube detection is inherently noisier than color, needs smoothing
  private static readonly CUBE_EMA_ALPHA = 0.5; // Faster response (0.5 = ~2 frame lag at 30fps)

  // General temporal smoothing (all strategies)
  private smoothedRotation: { x: number; y: number; z: number } | null = null;
  private consecutiveRejections: number = 0;
  private static readonly MAX_CONSECUTIVE_REJECTIONS = 2; // Recover faster from rejections

  // Smoothed clean axes (EMA on 6 axis projection values)
  private smoothedAxes: { x: [number, number]; y: [number, number]; z: [number, number] } | null = null;

  setStrategy(s: DetectStrategy): void {
    if (this.strategy !== s) {
      this.strategy = s;
      // Reset temporal hold state when strategy changes
      this.lastGoodResult = null;
      this.framesSinceGood = 0;
    }
  }

  setAxisMapping(mapping: AxisMapping): void {
    this.axisMapping = mapping;
    this.userSetMapping = true;  // User explicitly chose — don't auto-detect
    console.log(`[VC] Axis mapping set by user: X=${mapping.x} Y=${mapping.y} Z=${mapping.z}`);
  }

  /** Auto-detect Z-up vs Y-up from detected axis directions.
   * The axis with the strongest VERTICAL screen component is the "up" axis.
   * If it's Z (blue) → Z-up CAD (eDrawings, SolidWorks). If Y (green) → Y-up (Fusion).
   * Runs once on first successful 3-axis detection. Does NOT override user's explicit mapping. */
  private autoDetectUpAxis(axes: ViewCubeAxes): void {
    if (this.userSetMapping || this.autoDetectDone) return;
    if (!axes.x || !axes.y || !axes.z) return;

    // Use cosine of angle from vertical (abs(y)/length) — not raw abs(y).
    // Raw abs(y) fails when two axes have similar Y magnitude but very different angles.
    // Example (isometric): Z screen=(−0.15, 0.33) → cosine 0.91 (very vertical).
    //                       Y screen=(−0.49, 0.31) → cosine 0.53 (diagonal).
    // abs(y) alone: Z=0.33 vs Y=0.31 — nearly identical, Y-up vote can win incorrectly.
    const xLen = Math.sqrt(axes.x[0] ** 2 + axes.x[1] ** 2);
    const yLen = Math.sqrt(axes.y[0] ** 2 + axes.y[1] ** 2);
    const zLen = Math.sqrt(axes.z[0] ** 2 + axes.z[1] ** 2);
    const xVert = xLen > 1e-8 ? Math.abs(axes.x[1]) / xLen : 0;
    const yVert = yLen > 1e-8 ? Math.abs(axes.y[1]) / yLen : 0;
    const zVert = zLen > 1e-8 ? Math.abs(axes.z[1]) / zLen : 0;

    // Vote: which axis is most vertical this frame? Require 1.3x dominance.
    if (zVert > yVert * 1.3 && zVert > xVert * 1.3) {
      this.autoDetectVotes.zUp++;
    } else if (xVert > yVert * 1.3 && xVert > zVert * 1.3) {
      this.autoDetectVotes.xUp++;
    } else {
      this.autoDetectVotes.yUp++;
    }

    const needed = ViewCubeTracker.AUTO_DETECT_VOTES_NEEDED;
    const v = this.autoDetectVotes;
    console.log(`[VC] Auto-detect vote: zUp=${v.zUp} yUp=${v.yUp} xUp=${v.xUp} (need ${needed})`);

    if (v.zUp >= needed) {
      this.autoDetectDone = true;
      this.axisMapping = { x: '+x', y: '+z', z: '-y' };
      console.log(`[VC] Auto-detected Z-UP. Mapping: X=+x Y=+z Z=-y`);
    } else if (v.xUp >= needed) {
      this.autoDetectDone = true;
      this.axisMapping = { x: '+y', y: '+x', z: '+z' };
      console.log(`[VC] Auto-detected X-UP. Mapping: X=+y Y=+x Z=+z`);
    } else if (v.yUp >= needed) {
      this.autoDetectDone = true;
      console.log(`[VC] Auto-detected Y-UP. Keeping identity mapping.`);
    }
    // If no axis has enough votes yet, keep trying next frame
  }

  /** Remap detected axes and strengths according to axis mapping (e.g., Z-up → Y-up) */
  private applyMapping(
    axes: ViewCubeAxes,
    strengths: [number, number, number],
  ): { dirs: { x: [number, number] | null; y: [number, number] | null; z: [number, number] | null }; str: [number, number, number] } {
    const getDir = (source: AxisSource): [number, number] | null => {
      const sign = source[0] === '-' ? -1 : 1;
      const key = source[1] as 'x' | 'y' | 'z';
      const v = axes[key];
      return v ? [v[0] * sign, v[1] * sign] : null;
    };
    const getStr = (source: AxisSource): number => {
      const idx = { x: 0, y: 1, z: 2 }[source[1] as 'x' | 'y' | 'z'];
      return strengths[idx];
    };
    return {
      dirs: {
        x: getDir(this.axisMapping.x),
        y: getDir(this.axisMapping.y),
        z: getDir(this.axisMapping.z),
      },
      str: [getStr(this.axisMapping.x), getStr(this.axisMapping.y), getStr(this.axisMapping.z)],
    };
  }

  /**
   * Apply EMA smoothing and outlier rejection to a ViewCubeResult.
   * Returns the smoothed result, or null if the frame was rejected as an outlier.
   */
  private applySmoothingAndFilter(result: ViewCubeResult): ViewCubeResult | null {
    if (!this.smoothedRotation) {
      // First frame — initialize from result
      this.smoothedRotation = { x: result.rotationX, y: result.rotationY, z: result.rotationZ };
      this.consecutiveRejections = 0;
      return result;
    }

    // Compute angular differences (wraparound-safe)
    const diffX = Math.abs(angleDiff(result.rotationX, this.smoothedRotation.x));
    const diffY = Math.abs(angleDiff(result.rotationY, this.smoothedRotation.y));
    const diffZ = Math.abs(angleDiff(result.rotationZ, this.smoothedRotation.z));
    const maxDiff = Math.max(diffX, diffY, diffZ);

    // Outlier rejection: only reject extreme jumps at very low confidence
    if (maxDiff > 45 && result.confidence < 0.4 && this.consecutiveRejections < ViewCubeTracker.MAX_CONSECUTIVE_REJECTIONS) {
      this.consecutiveRejections++;
      return {
        ...result,
        rotationX: this.smoothedRotation.x,
        rotationY: this.smoothedRotation.y,
        rotationZ: this.smoothedRotation.z,
      };
    }

    this.consecutiveRejections = 0;

    // Nearly pass-through at high confidence for minimal lag
    const alpha = Math.min(1.0, 0.5 + 0.5 * result.confidence);

    this.smoothedRotation.x = lerpAngle(this.smoothedRotation.x, result.rotationX, alpha);
    this.smoothedRotation.y = lerpAngle(this.smoothedRotation.y, result.rotationY, alpha);
    this.smoothedRotation.z = lerpAngle(this.smoothedRotation.z, result.rotationZ, alpha);

    return {
      ...result,
      rotationX: this.smoothedRotation.x,
      rotationY: this.smoothedRotation.y,
      rotationZ: this.smoothedRotation.z,
    };
  }

  private resetSmoothing(): void {
    this.smoothedRotation = null;
    this.consecutiveRejections = 0;
    this.smoothedAxes = null;
  }

  /**
   * EMA smoothing on clean axis projections (6 values: x[0],x[1], y[0],y[1], z[0],z[1]).
   * Outlier rejection via forward-vector dot product (more robust than angle-diff check).
   * Returns smoothed cleanAxes as a ViewCubeAxes, or null if rejected as outlier.
   */
  private smoothCleanAxes(cleanAxes: ViewCubeAxes, confidence: number): ViewCubeAxes | null {
    // NO EMA on individual axis values — that breaks orthogonality and causes
    // axes to rotate independently. Instead, pass cleanAxes through directly.
    // The renderer uses quaternion slerp for smooth interpolation, which
    // inherently preserves orthogonality (rotation on SO(3) manifold).
    return cleanAxes;
  }

  /**
   * Build a ViewCubeAxes from the current smoothedAxes state.
   * CRITICAL: Re-orthogonalize after EMA to restore the SO(3) manifold constraint.
   *
   * EMA on 6 independent axis values breaks orthogonality — the 3 axes are no longer
   * at 90° to each other after smoothing. This produces wrong camera orientations.
   *
   * Fix: extract camera right/up vectors from the 6 smoothed values, apply Gram-Schmidt,
   * then rebuild the axis projections from the orthonormal basis.
   *
   * Axis projections: world axis i projects to screen as (right[i], -up[i]).
   * So: right = [x[0], y[0], z[0]]  and  up = [-x[1], -y[1], -z[1]]
   */
  private buildSmoothedAxes(sourceAxes: ViewCubeAxes): ViewCubeAxes {
    const s = this.smoothedAxes!;

    // Extract camera right and up vectors from 6 smoothed values
    let rx = s.x[0], ry = s.y[0], rz = s.z[0];  // right vector components
    let ux = -s.x[1], uy = -s.y[1], uz = -s.z[1]; // up vector components

    const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz);

    if (rLen < 1e-8 || uLen < 1e-8) {
      // Degenerate — return raw smoothed values as fallback
      return {
        x: [s.x[0], s.x[1]], y: [s.y[0], s.y[1]], z: [s.z[0], s.z[1]],
        pixelCounts: sourceAxes.pixelCounts, confidence: sourceAxes.confidence,
        detectedAxes: 3, strategy: sourceAxes.strategy,
      };
    }

    // Normalize right
    rx /= rLen; ry /= rLen; rz /= rLen;

    // Gram-Schmidt: orthogonalize up against right
    const dot = ux * rx + uy * ry + uz * rz;
    ux -= dot * rx; uy -= dot * ry; uz -= dot * rz;
    const uLen2 = Math.sqrt(ux * ux + uy * uy + uz * uz);

    if (uLen2 < 1e-8) {
      // Degenerate — return raw smoothed values as fallback
      return {
        x: [s.x[0], s.x[1]], y: [s.y[0], s.y[1]], z: [s.z[0], s.z[1]],
        pixelCounts: sourceAxes.pixelCounts, confidence: sourceAxes.confidence,
        detectedAxes: 3, strategy: sourceAxes.strategy,
      };
    }
    ux /= uLen2; uy /= uLen2; uz /= uLen2;

    // Rebuild axis projections from orthonormal right/up:
    // world axis i → screen as (right[i], -up[i])
    return {
      x: [rx, -ux],
      y: [ry, -uy],
      z: [rz, -uz],
      pixelCounts: sourceAxes.pixelCounts,
      confidence: sourceAxes.confidence,
      detectedAxes: 3,
      strategy: sourceAxes.strategy,
    };
  }

  /**
   * Analyze a view cube crop and return absolute rotation.
   *
   * @param rgbaData  RGBA pixel data of the view cube crop
   * @param width     Width of the crop in pixels
   * @param height    Height of the crop in pixels
   * @returns ViewCubeResult with absolute rotation, or null if detection failed
   */
  analyze(rgbaData: Uint8Array | Uint8ClampedArray, width: number, height: number): ViewCubeResult | null {
    const t0 = Date.now();

    let axes: ViewCubeAxes;

    if (this.strategy === 'color') {
      axes = detectAxesByColor(rgbaData, width, height, this.prevDetectedAxes);
    } else if (this.strategy === 'cube') {
      axes = detectAxesByCube(rgbaData, width, height, this.prevDetectedAxes);
    } else if (this.strategy === 'edges') {
      axes = detectAxesByEdges(rgbaData, width, height, this.prevDetectedAxes);
    } else {
      // Auto: color → cube corner → edges (fallback chain)
      const colorResult = detectAxesByColor(rgbaData, width, height, this.prevDetectedAxes);
      if (colorResult.confidence > 0.15 && colorResult.detectedAxes >= 2) {
        axes = colorResult;
      } else {
        const cubeResult = detectAxesByCube(rgbaData, width, height, this.prevDetectedAxes);
        if (cubeResult.confidence > 0.2) {
          axes = cubeResult;
        } else {
          axes = detectAxesByEdges(rgbaData, width, height, this.prevDetectedAxes);
        }
      }
    }

    // Store detected axes for temporal consistency (used by edge detection next frame)
    if (axes.detectedAxes >= 2) {
      this.prevDetectedAxes = { x: axes.x, y: axes.y, z: axes.z };
    }

    if (axes.confidence < 0.05) {
      // Temporal hold: return last good result if within hold window
      this.framesSinceGood++;
      if (this.lastGoodResult && this.framesSinceGood <= ViewCubeTracker.MAX_HOLD_FRAMES) {
        return { ...this.lastGoodResult, latencyMs: Date.now() - t0 };
      }
      return null;
    }

    // Auto-detect Z-up vs Y-up on first successful detection (unless user set it)
    if (axes.strategy === 'color' && axes.detectedAxes >= 3) {
      this.autoDetectUpAxis(axes);
    }

    // Use RAW (unmapped) axes for rotation reconstruction.
    // Axis mapping (Z-up → Y-up) was previously applied here, but it breaks
    // orthogonality — the remapped axes no longer form a proper triad, causing
    // decoupled axis motion (e.g., Z rotates while X/Y stay frozen).
    // Instead, pass raw RGB axes to the solver and let the renderer handle
    // coordinate system conversion (same approach as hanomi-platform).
    const rawStrengths = getAxisStrengths(axes);
    const result = axesToSpherical(axes.x, axes.y, axes.z, rawStrengths, this.prevForward);
    if (!result) {
      // Temporal hold for failed spherical conversion too
      this.framesSinceGood++;
      if (this.lastGoodResult && this.framesSinceGood <= ViewCubeTracker.MAX_HOLD_FRAMES) {
        return { ...this.lastGoodResult, latencyMs: Date.now() - t0 };
      }
      return null;
    }

    let { forward, cleanAxes } = result;
    let flipped = false;

    // Hemisphere flip detection — cross(right, up) can point in either of two
    // opposite directions. If it flipped vs previous frame, negate forward and
    // recompute euler angles. Equivalent to platform's q.dot(prevQ) < 0 → negate.
    if (this.prevForward) {
      const dot = forward[0] * this.prevForward[0]
                + forward[1] * this.prevForward[1]
                + forward[2] * this.prevForward[2];
      if (dot < 0) {
        forward = [-forward[0], -forward[1], -forward[2]];
        result.rotationX = Math.asin(Math.max(-1, Math.min(1, forward[1]))) * (180 / Math.PI);
        result.rotationY = Math.atan2(forward[0], forward[2]) * (180 / Math.PI);
        flipped = true;
        // Hemisphere flip for cleanAxes: negate screen-X components (right vector)
        if (cleanAxes.x && cleanAxes.y && cleanAxes.z) {
          cleanAxes = {
            ...cleanAxes,
            x: [-cleanAxes.x[0], cleanAxes.x[1]],
            y: [-cleanAxes.y[0], cleanAxes.y[1]],
            z: [-cleanAxes.z[0], cleanAxes.z[1]],
          };
        }
      }
    }
    this.prevForward = [forward[0], forward[1], forward[2]];

    // Set cleanAxes strategy to match the actual detection strategy
    cleanAxes.strategy = axes.strategy;

    // Smooth cleanAxes via EMA (replaces angle-based smoothing for ALL strategies)
    const smoothed = this.smoothCleanAxes(cleanAxes, axes.confidence);

    this.prevRotation = { rotationX: result.rotationX, rotationY: result.rotationY, rotationZ: result.rotationZ };

    // Derive display angles from smoothed axes for debug
    let finalCleanAxes = smoothed || cleanAxes;
    const debugR: [number, number, number] = [finalCleanAxes.x![0], finalCleanAxes.y![0], finalCleanAxes.z![0]];
    const debugU: [number, number, number] = [-finalCleanAxes.x![1], -finalCleanAxes.y![1], -finalCleanAxes.z![1]];
    const debugFwd = vec3Normalize(vec3Cross(debugR, debugU));
    const debugRotX = Math.asin(Math.max(-1, Math.min(1, debugFwd[1]))) * (180 / Math.PI);
    const debugRotY = Math.atan2(debugFwd[0], debugFwd[2]) * (180 / Math.PI);

    if (Math.random() < 0.1) console.log(`[VC] forward=(${debugFwd[0].toFixed(2)},${debugFwd[1].toFixed(2)},${debugFwd[2].toFixed(2)}) ` +
      `flip=${flipped} rot=(${debugRotX.toFixed(1)},${debugRotY.toFixed(1)}) conf=${axes.confidence.toFixed(2)}`);

    // Confidence gate for roll: only trust rotationZ when detection is highly confident.
    // Below 0.8, set roll to 0. This matches the old spherical path's forced camera.up=(0,1,0).
    const finalRotZ = axes.confidence >= 0.8 ? result.rotationZ : 0;

    const vcResult: ViewCubeResult = {
      rotationX: debugRotX,
      rotationY: debugRotY,
      rotationZ: finalRotZ,
      confidence: axes.confidence,
      strategy: axes.strategy,
      latencyMs: Date.now() - t0,
      axes,
      cleanAxes: finalCleanAxes,
      axisMapping: { ...this.axisMapping },
    };

    // Save as last good result for temporal hold
    this.lastGoodResult = vcResult;
    this.framesSinceGood = 0;

    return vcResult;
  }

  /**
   * High-precision analysis — used during settle refinement (IDLE state).
   * Runs with no temporal smoothing for maximum accuracy.
   */
  analyzeHighPrecision(rgbaData: Uint8Array | Uint8ClampedArray, width: number, height: number): ViewCubeResult | null {
    const t0 = Date.now();

    // Try color first (most precise), then cube corner, then edges
    let axes = detectAxesByColor(rgbaData, width, height, this.prevDetectedAxes);
    if (axes.confidence < 0.15 || axes.detectedAxes < 2) {
      const cubeResult = detectAxesByCube(rgbaData, width, height, this.prevDetectedAxes);
      if (cubeResult.confidence > 0.2) {
        axes = cubeResult;
      } else {
        axes = detectAxesByEdges(rgbaData, width, height, this.prevDetectedAxes);
      }
    }

    // Store detected axes for temporal consistency
    if (axes.detectedAxes >= 2) {
      this.prevDetectedAxes = { x: axes.x, y: axes.y, z: axes.z };
    }

    if (axes.confidence < 0.05) return null;

    // Auto-detect Z-up in high precision too
    if (axes.strategy === 'color' && axes.detectedAxes >= 3) {
      this.autoDetectUpAxis(axes);
    }

    // Use RAW axes (no mapping) — same fix as analyze()
    const rawStrengths = getAxisStrengths(axes);
    const euler = axesToSpherical(axes.x, axes.y, axes.z, rawStrengths, this.prevForward);
    if (!euler) return null;

    // Hemisphere flip detection — must be consistent with analyze()
    let { forward, cleanAxes } = euler;
    if (this.prevForward) {
      const dot = forward[0] * this.prevForward[0]
                + forward[1] * this.prevForward[1]
                + forward[2] * this.prevForward[2];
      if (dot < 0) {
        forward = [-forward[0], -forward[1], -forward[2]];
        euler.rotationX = Math.asin(Math.max(-1, Math.min(1, forward[1]))) * (180 / Math.PI);
        euler.rotationY = Math.atan2(forward[0], forward[2]) * (180 / Math.PI);
        // Hemisphere flip for cleanAxes: negate screen-X components
        if (cleanAxes.x && cleanAxes.y && cleanAxes.z) {
          cleanAxes = {
            ...cleanAxes,
            x: [-cleanAxes.x[0], cleanAxes.x[1]],
            y: [-cleanAxes.y[0], cleanAxes.y[1]],
            z: [-cleanAxes.z[0], cleanAxes.z[1]],
          };
        }
      }
    }
    // Update prevForward so analyze() stays in sync
    this.prevForward = [forward[0], forward[1], forward[2]];

    cleanAxes.strategy = axes.strategy;

    // Smooth cleanAxes (outlier rejection still useful in high-precision)
    const smoothed = this.smoothCleanAxes(cleanAxes, axes.confidence);
    const finalCleanAxes = smoothed || cleanAxes;

    // Derive display angles from smoothed axes
    const hpR: [number, number, number] = [finalCleanAxes.x![0], finalCleanAxes.y![0], finalCleanAxes.z![0]];
    const hpU: [number, number, number] = [-finalCleanAxes.x![1], -finalCleanAxes.y![1], -finalCleanAxes.z![1]];
    const hpFwd = vec3Normalize(vec3Cross(hpR, hpU));

    const hpResult: ViewCubeResult = {
      rotationX: Math.asin(Math.max(-1, Math.min(1, hpFwd[1]))) * (180 / Math.PI),
      rotationY: Math.atan2(hpFwd[0], hpFwd[2]) * (180 / Math.PI),
      rotationZ: euler.rotationZ,
      confidence: axes.confidence,
      strategy: axes.strategy,
      latencyMs: Date.now() - t0,
      axes,
      cleanAxes: finalCleanAxes,
    };

    return hpResult;
  }

  reset(): void {
    this.prevRotation = null;
    this.prevForward = null;
    this.prevDetectedAxes = null;
    this.lastGoodResult = null;
    this.framesSinceGood = 0;
    this.autoDetectDone = false;  // Re-detect on next tracking session
    this.autoDetectVotes = { zUp: 0, yUp: 0, xUp: 0 };
    this.smoothedAxes = null;
    this.resetSmoothing();
  }
}

// ── Utilities ───────────────────────────────────────────────────────

/** Signed angular difference (a - b), handling wraparound */
function angleDiff(a: number, b: number): number {
  let diff = a - b;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return diff;
}

/** Lerp between two angles, handling wraparound */
function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return a + diff * t;
}
