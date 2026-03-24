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

// ── Viewport Edge Statistics ─────────────────────────────────────────

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

// ── Message Handler (Node.js worker_threads pattern) ─────────────────

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
