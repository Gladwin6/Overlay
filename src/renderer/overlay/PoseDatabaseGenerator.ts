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
        // Three.js matrices are column-major; extract rotation rows from matrixWorldInverse
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
