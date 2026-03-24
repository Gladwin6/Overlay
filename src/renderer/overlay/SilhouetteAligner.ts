/**
 * SilhouetteAligner — Finds the best rotation by rendering the model at many
 * orientations and comparing edge silhouettes against the viewport capture.
 *
 * Runs in the overlay RENDERER process (has Three.js + WebGL).
 * Replaces the unreliable view cube tracker for rotation estimation.
 *
 * Algorithm:
 * 1. Pre-render model edges at ~500 orientations (fibonacci sphere sampling)
 * 2. When viewport frame arrives, extract edges
 * 3. Compare each pre-rendered edge image against viewport edges using Chamfer distance
 * 4. Refine the best match with ±5° perturbations
 * 5. Output: camera right/up vectors (same format as ViewCubeTracker cleanAxes)
 */

import * as THREE from 'three';

let ipcRenderer: any;
try { ipcRenderer = window.require('electron').ipcRenderer; } catch (_) {}

// ── Edge extraction (runs on viewport capture) ──────────────────

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

function distanceTransform(edges: Uint8Array, w: number, h: number): Float32Array {
  const dt = new Float32Array(w * h);
  const INF = w + h;
  for (let i = 0; i < w * h; i++) dt[i] = edges[i] > 0 ? 0 : INF;
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) { const i = y * w + x; dt[i] = Math.min(dt[i], dt[i - 1] + 1, dt[i - w] + 1); }
    for (let x = w - 2; x >= 0; x--) { dt[y * w + x] = Math.min(dt[y * w + x], dt[y * w + x + 1] + 1); }
  }
  for (let y = h - 2; y >= 0; y--) {
    for (let x = w - 2; x >= 0; x--) { const i = y * w + x; dt[i] = Math.min(dt[i], dt[i + 1] + 1, dt[i + w] + 1); }
    for (let x = 1; x < w; x++) { dt[y * w + x] = Math.min(dt[y * w + x], dt[y * w + x - 1] + 1); }
  }
  return dt;
}

function chamferScore(overlayEdges: Uint8Array, vpDT: Float32Array, w: number, h: number): number {
  let total = 0, count = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (overlayEdges[y * w + x] === 0) continue;
      total += vpDT[y * w + x];
      count++;
    }
  }
  return count > 10 ? total / count : Infinity;
}

// ── Fibonacci Sphere ─────────────────────────────────────────────

function fibonacciSpherePoint(index: number, total: number): [number, number, number] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (2 * index) / (total - 1);
  const radius = Math.sqrt(1 - y * y);
  const theta = goldenAngle * index;
  return [Math.cos(theta) * radius, y, Math.sin(theta) * radius];
}

// ── Stored orientation descriptor ────────────────────────────────

interface OrientationEntry {
  index: number;
  edgePixels: Uint8Array;  // binary edge image (RENDER_SIZE x RENDER_SIZE)
  quaternion: THREE.Quaternion;
  right: [number, number, number];
  up: [number, number, number];
  forward: [number, number, number];
}

// ── Main Aligner ─────────────────────────────────────────────────

const RENDER_SIZE = 100;        // Low-res for speed
const NUM_ORIENTATIONS = 2000;  // Dense coverage for smooth matching

export class SilhouetteAligner {
  private database: OrientationEntry[] = [];
  private isBuilding = false;
  private renderer: THREE.WebGLRenderer | null = null;
  private renderTarget: THREE.WebGLRenderTarget | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private lastMatchQuat: THREE.Quaternion | null = null;

  /**
   * Build the orientation database from the loaded model.
   * Pre-renders edges at NUM_ORIENTATIONS viewing angles.
   */
  buildDatabase(modelGroup: THREE.Group, onProgress?: (pct: number) => void): void {
    if (this.isBuilding) return;
    this.isBuilding = true;
    this.database = [];

    console.log(`[SilhouetteAligner] Building database: ${NUM_ORIENTATIONS} orientations at ${RENDER_SIZE}px`);

    // Setup offscreen renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    this.renderer.setSize(RENDER_SIZE, RENDER_SIZE);
    this.renderTarget = new THREE.WebGLRenderTarget(RENDER_SIZE, RENDER_SIZE);

    const frustum = RENDER_SIZE / 12;
    this.camera = new THREE.OrthographicCamera(-frustum / 2, frustum / 2, frustum / 2, -frustum / 2, 0.1, 2000);

    // Create edge-only scene
    const edgeScene = new THREE.Scene();
    edgeScene.background = new THREE.Color(0x000000);
    const edgeGroup = new THREE.Group();
    modelGroup.traverse((child: any) => {
      if (child.isLineSegments && child.geometry) {
        const mat = new THREE.LineBasicMaterial({ color: 0xffffff });
        const mesh = new THREE.LineSegments(child.geometry.clone(), mat);
        mesh.applyMatrix4(child.matrixWorld);
        edgeGroup.add(mesh);
      }
    });
    edgeScene.add(edgeGroup);

    const readBuffer = new Uint8Array(RENDER_SIZE * RENDER_SIZE * 4);
    let batchIndex = 0;
    const BATCH_SIZE = 25;

    const processBatch = () => {
      if (!this.isBuilding) return;

      const end = Math.min(batchIndex + BATCH_SIZE, NUM_ORIENTATIONS);

      for (let i = batchIndex; i < end; i++) {
        const [px, py, pz] = fibonacciSpherePoint(i, NUM_ORIENTATIONS);
        const pos = new THREE.Vector3(px, py, pz).multiplyScalar(200);
        const up = new THREE.Vector3(0, 1, 0);
        if (Math.abs(py) > 0.999) up.set(1, 0, 0);

        this.camera!.position.copy(pos);
        this.camera!.up.copy(up);
        this.camera!.lookAt(0, 0, 0);
        this.camera!.updateMatrixWorld();

        // Render
        this.renderer!.setRenderTarget(this.renderTarget!);
        this.renderer!.render(edgeScene, this.camera!);
        this.renderer!.readRenderTargetPixels(this.renderTarget!, 0, 0, RENDER_SIZE, RENDER_SIZE, readBuffer);

        // Convert to binary edges
        const edges = new Uint8Array(RENDER_SIZE * RENDER_SIZE);
        let edgeCount = 0;
        for (let j = 0; j < RENDER_SIZE * RENDER_SIZE; j++) {
          edges[j] = readBuffer[j * 4] > 128 ? 255 : 0;
          if (edges[j]) edgeCount++;
        }
        if (edgeCount < 10) continue; // Skip degenerate views

        // Extract camera basis vectors
        const camMat = this.camera!.matrixWorld;
        const right: [number, number, number] = [camMat.elements[0], camMat.elements[1], camMat.elements[2]];
        const camUp: [number, number, number] = [camMat.elements[4], camMat.elements[5], camMat.elements[6]];
        const forward: [number, number, number] = [camMat.elements[8], camMat.elements[9], camMat.elements[10]];

        const quat = new THREE.Quaternion();
        quat.setFromRotationMatrix(camMat);

        this.database.push({ index: i, edgePixels: edges, quaternion: quat, right, up: camUp, forward });
      }

      batchIndex = end;
      const pct = Math.round((batchIndex / NUM_ORIENTATIONS) * 100);
      onProgress?.(pct);

      if (batchIndex < NUM_ORIENTATIONS) {
        setTimeout(processBatch, 0);  // Use setTimeout, not rAF (works even if window is hidden)
      } else {
        console.log(`[SilhouetteAligner] Database built: ${this.database.length} entries`);

        // Send database to main process for matching (main receives viewport frames)
        if (ipcRenderer) {
          const compactDB = this.database.map(entry => ({
            edgePixels: Array.from(entry.edgePixels),  // Uint8Array → number[] for IPC
            qx: entry.quaternion.x, qy: entry.quaternion.y,
            qz: entry.quaternion.z, qw: entry.quaternion.w,
            right: entry.right, up: entry.up, forward: entry.forward,
          }));
          ipcRenderer.send('silhouette:database', compactDB, RENDER_SIZE);
          console.log(`[SilhouetteAligner] Sent ${compactDB.length} entries to main process`);
        }

        this.renderer!.dispose();
        this.renderTarget!.dispose();
        this.renderer = null;
        this.renderTarget = null;
        this.isBuilding = false;
      }
    };

    setTimeout(processBatch, 0);
  }

  /**
   * Match a viewport frame against the database.
   * Returns the best-matching quaternion and camera vectors.
   */
  match(viewportGray: Uint8Array, vpW: number, vpH: number): {
    quaternion: THREE.Quaternion;
    right: [number, number, number];
    up: [number, number, number];
    forward: [number, number, number];
    score: number;
    latencyMs: number;
  } | null {
    if (this.database.length === 0) return null;

    const t0 = performance.now();

    // Downsample viewport to match render size
    const ds = new Uint8Array(RENDER_SIZE * RENDER_SIZE);
    const sx = vpW / RENDER_SIZE;
    const sy = vpH / RENDER_SIZE;
    for (let y = 0; y < RENDER_SIZE; y++) {
      for (let x = 0; x < RENDER_SIZE; x++) {
        ds[y * RENDER_SIZE + x] = viewportGray[Math.floor(y * sy) * vpW + Math.floor(x * sx)];
      }
    }

    // Extract edges and distance transform from viewport
    const vpEdges = sobelEdges(ds, RENDER_SIZE, RENDER_SIZE, 25);
    const vpDT = distanceTransform(vpEdges, RENDER_SIZE, RENDER_SIZE);

    // Score every database entry
    let bestScore = Infinity;
    let bestEntry: OrientationEntry | null = null;

    for (const entry of this.database) {
      const score = chamferScore(entry.edgePixels, vpDT, RENDER_SIZE, RENDER_SIZE);
      if (score < bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    if (!bestEntry || bestScore > 20) return null;

    this.lastMatchQuat = bestEntry.quaternion.clone();

    return {
      quaternion: bestEntry.quaternion,
      right: bestEntry.right,
      up: bestEntry.up,
      forward: bestEntry.forward,
      score: bestScore,
      latencyMs: performance.now() - t0,
    };
  }

  get ready(): boolean {
    return this.database.length > 0 && !this.isBuilding;
  }

  dispose(): void {
    this.isBuilding = false;
    this.database = [];
    this.renderer?.dispose();
    this.renderTarget?.dispose();
  }
}
