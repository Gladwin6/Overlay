# Model-Based Pose Tracker — Design Spec

**Date:** 2026-03-12
**Goal:** Universal CAD overlay tracking that works with any CAD software by matching the 3D model's edges against the viewport capture — no COM API, no view cube, no axis mapping.

---

## 1. Problem

The current tracking system has two paths:
- **SW Bridge (COM)** — pixel-perfect but SolidWorks-only
- **View Cube Tracker** — universal but low accuracy, fragile color detection, axis mapping issues

We need a universal tracker that gives accurate absolute pose from any CAD software (SolidWorks, CATIA, Fusion 360, Inventor, Onshape, eDrawings, etc.).

## 2. Approach

**Hybrid: Precomputed View Database + Optical Flow**

- **View Database:** Pre-render the Three.js model from ~5000 orientations on model load. Store compact edge descriptors for fast lookup.
- **Optical Flow:** Use existing optical flow for smooth frame-to-frame tracking between correction frames.
- **Periodic Correction:** Every 5th viewport frame (~2fps), run edge matching against the database to get absolute pose and correct drift.

This combines the smoothness of optical flow with the drift-free accuracy of absolute pose estimation.

## 3. Architecture

### 3.1 New Files

| File | Location | Purpose |
|------|----------|---------|
| `PoseDatabase.ts` | `src/main/tracking/` | Stores precomputed edge descriptors, fast nearest-neighbor lookup |
| `EdgeExtractor.ts` | `src/main/tracking/` | Adaptive Canny edge extraction from viewport captures |
| `PoseOptimizer.ts` | `src/main/tracking/` | Chamfer distance scoring + local refinement |
| `ModelPoseTracker.ts` | `src/main/tracking/` | Orchestrator — ties all components together |
| `pose-worker.ts` | `src/main/tracking/` | Dedicated Worker thread for edge extraction + Chamfer matching |
| `PoseDatabaseGenerator.ts` | `src/renderer/overlay/` | Generates view database using existing Three.js scene in overlay renderer |

### 3.2 Integration Points

```
CVTracker
  ├── ViewCubeTracker  (existing, fallback when no model loaded)
  ├── ModelPoseTracker  (NEW — primary when model is loaded)
  │     └── pose-worker.ts  (dedicated Worker for edge extraction + Chamfer)
  └── Optical flow worker (existing, provides inter-frame smoothing)
```

**Activation logic:**
- Model loaded + viewport ROI drawn → ModelPoseTracker activates
- View cube ROI drawn, no model → ViewCubeTracker activates (fallback)
- SW Bridge started → both visual trackers pause (COM always wins)

**Frame routing in `CVTracker.pushViewportFrame()`:**
- Every frame → forwarded to optical flow worker (existing path, unchanged)
- Every 5th frame → also forwarded to ModelPoseTracker if active
- The optical flow worker's `isProcessing` guard applies only to its own pipeline, not to ModelPoseTracker
- Both pipelines run independently in separate Worker threads

**Teardown:** When model is unloaded or tracking stops, `ModelPoseTracker.dispose()` frees the database (~10MB), terminates `pose-worker`, and resets state. CVTracker calls this on `stop()` and on model unload.

### 3.3 Data Flow

**Database generation (on model load):**
```
Main process receives GLTF
  → sends IPC.MODEL_POSE_GENERATE to overlay renderer
  → PoseDatabaseGenerator (in overlay renderer, has Three.js + model)
      → renders 5000 edge maps using existing Three.js scene
      → computes descriptors
      → sends compact database via IPC.MODEL_POSE_DATABASE to main
  → ModelPoseTracker stores database, ready for matching
  → sends IPC.MODEL_POSE_STATUS ('ready') to setup panel
```

**Why overlay renderer, not a hidden window:** The overlay renderer already has the Three.js scene, model geometry, and EdgesGeometry loaded. Rendering 5000 frames in a separate hidden BrowserWindow would require duplicating the entire model loading pipeline. Instead, we batch the renders in `requestIdleCallback` chunks (100 orientations per idle frame) to avoid stuttering the live overlay. Total build time: ~8-15 seconds.

**Per-frame tracking:**
```
Setup renderer (screen capture, 10fps)
  → IPC.CAPTURE_VIEWPORT_FRAME → main process
  → CVTracker.pushViewportFrame()
      ├── Optical flow worker (every frame, ~2ms) [existing]
      └── ModelPoseTracker.processFrame() (every 5th frame)
            → posts viewport buffer to pose-worker thread
            → pose-worker runs:
                EdgeExtractor: Canny edges + distance transform
                PoseDatabase lookup: top-5 candidates
                PoseOptimizer: Chamfer score + refinement
            → posts result back to main thread
            → emits 'modelPoseUpdate'
              → main process updates alignment
                → IPC.ALIGNMENT_UPDATE → overlay renderer
```

## 4. Component Details

### 4.1 View Database Generation

**Triggered by:** Existing GLTF load flow. After model arrives in overlay renderer, main sends `IPC.MODEL_POSE_GENERATE`. The overlay's `PoseDatabaseGenerator` renders in batches using `requestIdleCallback` to avoid blocking the display.

**Orientation sampling:** Fibonacci sphere — ~5000 points, ~5° angular resolution, uniform coverage (no polar clustering). Covers full rotation space (yaw 0-360°, pitch -90° to +90°). **Roll is assumed zero** — most CAD software constrains the camera to upright orientation. Roll tracking deferred to optical flow delta if needed.

**Per orientation:**
1. Set orthographic camera to orientation (same frustum as overlay)
2. Render model edges only (`EdgesGeometry` with 20° threshold, same as overlay)
3. Read back edge pixel positions from 200×200 render target

**Edge point storage format:**
- From the rendered 200×200 edge image, collect all edge pixel positions
- Spatially subsample using a 10×10 grid: divide the 200×200 image into 400 cells (20×20px each), keep at most 1 representative edge point per cell
- Maximum ~200 representative 2D points per orientation
- **Also store the corresponding 3D model-space edge midpoints** (from `EdgesGeometry` segments). For each 2D point, find the nearest 3D edge segment midpoint via ray-casting against the model's edge geometry. This enables re-projection at arbitrary orientations during refinement.
- Per-orientation storage: 200 points × (3D: 3×Float32 + 2D: 2×Float32) = 200 × 20 bytes = **4KB**

**Descriptor per orientation:**
- **Orientation histogram** (16 bins of edge gradient directions) — shape signature for coarse lookup
- **Centroid** (2D position of edge mass center) — for candidate pruning
- **Bounding box aspect ratio** (width/height of edge extent) — for candidate pruning
- **Edge point count** — filter out degenerate views

**Total storage:** 5000 × (4KB points + 0.1KB descriptor) ≈ **20MB** in memory.

**Build time:** ~8-15 seconds depending on model complexity (batched, non-blocking). Tracking starts immediately with optical flow only; database corrections kick in once ready.

### 4.2 Edge Extraction (Adaptive)

**Runs in `pose-worker.ts`** — dedicated Worker thread, separate from optical flow worker.

**Input:** Viewport grayscale capture (downsampled to 400×300 for performance, from existing 800×600 capture).

**Auto-detection of CAD rendering mode:**

| Mode | Edge Density | Canny Low/High | Notes |
|------|-------------|----------------|-------|
| Shaded | <5% edge pixels | 30 / 80 | Catches silhouette edges |
| Shaded + edges | 5–15% | 50 / 120 | Clean edge lines (recommended) |
| Wireframe | >15% | 80 / 180 | Higher threshold cuts noise |

Auto-detected from edge density in first few frames. No user config needed.

**Pipeline (all in Worker thread):**
1. Gaussian blur (3×3) — suppress sensor/compression noise
2. Canny edge detection — adaptive thresholds per mode
3. Distance transform (Manhattan approximation for speed) — for Chamfer scoring

**Estimated time at 400×300:** ~8-12ms for Canny + distance transform in pure JS Worker.

**Viewport clutter handling:**
- Chamfer matching uses **one-directional scoring** (model-to-viewport only): for each model edge point, look up distance in viewport DT. This is inherently robust to extra edges in the viewport (grid lines, UI elements, other parts) because those edges only *help* (they don't increase the score for model edges that happen to fall on them). Only missing model edges increase the score.
- The viewport ROI crop already excludes toolbars, feature tree, and ribbon.
- For further clutter rejection: after finding the best pose, use the model's projected bounding box to mask out viewport regions far from the model before computing the final score.

### 4.3 Pose Matching Pipeline

**Runs every 5th viewport frame (~2fps) in `pose-worker.ts`:**

| Step | Operation | Time |
|------|-----------|------|
| 1 | Downsample 800×600 → 400×300 | ~1ms |
| 2 | Canny edge detection + distance transform | ~10ms |
| 3 | Descriptor comparison against 5000 database entries | ~3ms |
| 4 | Top-5 candidates: project stored 3D edge points, Chamfer score | ~5ms |
| 5 | Best match: ±2° perturbations (27 combos), pick lowest score | ~3ms |
| **Total** | **in Worker thread (non-blocking)** | **~22ms** |

Since this runs in a Worker thread at 2fps, the 22ms latency is invisible — the main thread and optical flow continue uninterrupted.

**Candidate pruning (step 3):**
Three-stage filter before Chamfer scoring:
1. **Orientation histogram** — cosine similarity, keep top 50
2. **Bounding box aspect ratio** — reject candidates where aspect ratio differs by >30% from viewport edges bbox
3. **Centroid position** — reject candidates where centroid is >25% of image size from viewport edge centroid
4. **Chamfer score** — full scoring on remaining ~5 candidates

**Chamfer scoring (steps 4-5):**
- For a candidate pose: rotate stored 3D edge midpoints by candidate rotation matrix, project to 2D (orthographic = just take X,Y components after rotation)
- Scale projected points to match viewport resolution (400×300)
- For each projected point, look up distance in the viewport's distance transform
- Score = mean distance. Lower = better alignment.

**Translation estimation:**
- After finding best rotation: compute the distance-transform-weighted centroid of model's projected edge points (points with low DT values = good matches, weighted higher)
- Compare with model centroid in projection → difference = pan offset
- More robust than raw viewport edge centroid (ignores clutter)

**Zoom estimation:**
- Compare model bounding box diagonal in best-match projection vs bounding box diagonal of matched viewport edges
- Ratio = zoom scale factor

### 4.4 Pose Optimizer (Refinement)

After coarse database lookup finds the best orientation (±5° accuracy):
1. Try 27 perturbations: ±2° on each of 3 rotation axes (3³ = 27)
2. For each: multiply stored 3D edge points by perturbation rotation matrix, project, score against distance transform
3. Pick lowest Chamfer score → refined pose (~2° accuracy)
4. Pure math (3×3 matrix multiply + take X,Y) — no WebGL needed, runs in Worker

### 4.5 Smoothing & Blending

**Between correction frames (8 of 10 frames):**
- Optical flow provides smooth delta (rotation + pan + zoom)
- Applied on top of last absolute pose from ModelPoseTracker
- Maximum drift between corrections: ~0.5° rotation, ~2px translation

**On correction frame:**
- Exponential smoothing: `pose = 0.6 * correction + 0.4 * opticalFlowEstimate`
- Prevents visual jumps when correction disagrees with flow
- If Chamfer confidence is very high (score < threshold), trust correction fully (alpha = 0.9)

### 4.6 Failure Handling

| Condition | Behavior |
|-----------|----------|
| Best Chamfer score > rejection threshold | Reject match, use optical flow only for this cycle |
| 5+ consecutive rejections | Emit `trackingLost`, hold last good pose, keep trying |
| Model has <20 edge segments | Warn "insufficient geometry", fall back to ViewCubeTracker |
| Symmetric model (top-3 candidates have similar scores) | Use optical flow temporal continuity to disambiguate |
| Viewport fully occluded (no edges detected) | Hold last good pose, resume when edges reappear |
| Database not ready yet | Optical flow only until database build completes |

## 5. Output Format

```typescript
interface ModelPoseResult {
  // Camera orientation as axis projections — feeds directly into
  // the existing viewCubeAxes path in OverlayApp.tsx (lines 247-273).
  // This avoids Euler angle gimbal lock and matches the existing renderer.
  cleanAxes: ViewCubeAxes;   // camera right/up as 2D projections of world X/Y/Z

  // Translation and zoom
  panX: number;              // pixels from viewport center
  panY: number;              // pixels from viewport center
  zoom: number;              // scale relative to initial model size

  // Diagnostics
  confidence: number;        // 0-1, inverse normalized Chamfer score
  chamferScore: number;      // raw mean distance (lower = better)
  strategy: 'database' | 'flow-only';  // which path produced this result
  latencyMs: number;         // time in pose-worker
}
```

**Why `cleanAxes` instead of Euler angles:** The overlay renderer already has a robust camera path for `viewCubeAxes` (OverlayApp.tsx lines 247-273) that builds the camera from 2D axis projections via Gram-Schmidt orthogonalization. Using this path avoids gimbal lock, avoids the Euler-to-camera conversion, and reuses tested code. The `cleanAxes` are derived from the best-match rotation matrix:
- `cleanAxes.x = [R[0][0], -R[1][0]]` (world X projected to screen right, screen down)
- `cleanAxes.y = [R[0][1], -R[1][1]]` (world Y projected)
- `cleanAxes.z = [R[0][2], -R[1][2]]` (world Z projected)

where R is the 3×3 camera rotation matrix from the best match.

**Main process handler:** Same pattern as existing `viewCubeRotation`:
```typescript
cvTracker.on('modelPoseUpdate', (result: ModelPoseResult) => {
  if (result.confidence > 0.3) {
    alignment.viewCubeAxes = result.cleanAxes;
    alignment.positionX = result.panX;
    alignment.positionY = result.panY;
    alignment.scale = result.zoom;
    broadcastAlignment();
  }
});
```

## 6. Setup Panel Changes

**Minimal UI additions:**
- Status indicator in tracking section: "Model Tracking: building database (42%)..." → "Model Tracking: LIVE"
- Tooltip: "For best tracking accuracy, set your CAD software to 'Shaded with Edges' display mode"
- No new buttons, config, or ROI drawing needed — activates automatically when model is loaded

## 7. Activation Priority

| Condition | Active Tracker |
|-----------|---------------|
| SW Bridge live | SW Bridge (COM) — highest priority, pauses visual trackers |
| Model loaded + viewport ROI | ModelPoseTracker — primary visual tracker |
| View cube ROI only (no model) | ViewCubeTracker — fallback |
| Nothing configured | Manual alignment only |

## 8. IPC Channels (New)

| Channel | Value | Direction | Purpose |
|---------|-------|-----------|---------|
| `IPC.MODELPOSE_GENERATE` | `'modelpose:generate'` | main → overlay | Request database generation |
| `IPC.MODELPOSE_DATABASE` | `'modelpose:database'` | overlay → main | Send precomputed view database |
| `IPC.MODELPOSE_STATUS` | `'modelpose:status'` | main → setup | Build progress ("building" / "ready" / "error") |

Follows existing `namespace:action` convention (e.g., `sw:camera-update`, `gltf:load`).

## 9. Performance Budget

| Operation | Frequency | Target Time | Thread |
|-----------|-----------|-------------|--------|
| Database generation | Once on model load | 8-15 seconds | Overlay renderer (idle callbacks) |
| Optical flow (existing) | 10fps | <5ms | cv-worker thread |
| Edge extraction + matching | 2fps (every 5th frame) | <25ms | pose-worker thread |
| Main thread overhead | 10fps | <2ms | Main thread (IPC routing only) |

The main thread never does heavy computation. Edge extraction and Chamfer matching run entirely in `pose-worker.ts`.

## 10. Limitations & Future Work

**Known limitations:**
- ~2-5° rotation accuracy. Sufficient for visual overlay alignment.
- Roll assumed zero (most CAD software constrains upright camera). Optical flow can track small roll deltas.
- Symmetrical models may have ambiguous orientations — optical flow resolves via temporal continuity.
- Build time 8-15 seconds, scales with model complexity. Very complex models (>100K edges) may take >30 seconds.
- Requires model to be visible in viewport. Full occlusion = tracking lost, optical flow holds last pose.
- One-directional Chamfer is robust to viewport clutter but can be fooled by dense grid overlays that coincidentally match model edges.

**Future improvements:**
- Hierarchical database (coarse 1000 + fine 10000 around current pose) for sub-degree accuracy
- GPU-accelerated distance transform for faster Chamfer scoring
- Multi-resolution edge matching for robustness to zoom level changes
- Roll estimation via edge orientation histogram comparison
