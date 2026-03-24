# Hanomi Overlay — Development Log

## 2026-03-02 — Session 10: Direct Rotation Matrix Pipeline (BROKEN → LEARNINGS)

### What Was Attempted
Replaced the lossy spherical angle pipeline with a direct rotation matrix pipeline:
```
Old: 2D projections → quadratic solve → forward → spherical angles → EMA angles → overlay sin/cos → camera.up=(0,1,0)
New: 2D projections → quadratic solve → right/up → derive cleanAxes → EMA 6 values → send as viewCubeAxes → overlay builds camera directly
```

### Bugs Found

#### BUG #39: EMA on 6 independent axis values DESTROYS orthogonality
- **Symptom:** Overlay wireframe in completely wrong orientation, not matching CAD viewport at all.
- **Root cause:** EMA smoothing applied independently to 6 axis projection values (x[0], x[1], y[0], y[1], z[0], z[1]). After smoothing, the axes are NO LONGER at 90° to each other. OverlayApp's Gram-Schmidt only re-orthogonalizes up against right — but with badly non-orthogonal input, this produces unpredictable camera orientation.
- **CONSTRAINT:** The 3 reference axes ALWAYS form a cube — all angles MUST be 90°. After ANY smoothing, re-orthogonalize: extract right/up → Gram-Schmidt → forward = cross(right, up) → rebuild axes.
- **Status:** Not yet fixed.

#### BUG #40: camera.up = upOrtho vs camera.up = (0,1,0) — roll mismatch
- **Symptom:** Even with correct detection, overlay appears tilted relative to CAD viewport.
- **Root cause:** The old spherical path always set `camera.up = (0, 1, 0)` — zero roll. The new direct path sets `camera.up = upOrtho` — which includes detected roll. Even tiny roll errors (from noisy detection) cause visible tilt mismatch between overlay and CAD.
- **LEARNING:** The spherical path's forced up=(0,1,0) was a feature, not a bug. It eliminated roll noise. Direct path must only apply roll when detection is highly confident AND roll is significant.
- **Status:** Not yet fixed.

#### BUG #41: Removed applySmoothingAndFilter() — lost outlier rejection
- **Symptom:** Wild rotation jumps between frames (37° in one frame) not being caught.
- **Root cause:** Old pipeline had angle-based outlier rejection: jump > 30° + confidence < 0.6 → reject. New smoothCleanAxes() uses forward dot product < 0.5, which is too permissive (dot 0.76 passes even though rotation jumped 37°).
- **Fix needed:** Tighten to dot < 0.7 or add angle-magnitude check.
- **Status:** Not yet fixed.

#### BUG #42: Auto-detect Z-up threshold too aggressive
- **Symptom:** eDrawings (Z-up) misdetected as Y-up. Blue Z axis visually most vertical but auto-detect picks Y-up.
- **Root cause:** Auto-detect uses `Math.abs(axes[i][1])` (raw screen-Y component) as verticality metric. For isometric views: Z screen-Y = 0.33, Y screen-Y = 0.31 → Z NOT 1.3x larger, so Y-up vote wins. But Z's projection is mostly vertical (small X component = -0.15), while Y's is diagonal (large X = -0.49).
- **Fix needed:** Use `abs(y) / sqrt(x² + y²)` = cosine of angle from vertical. Z: 0.33/0.36 = 0.91 (very vertical). Y: 0.31/0.58 = 0.53 (diagonal). Z clearly wins.
- **Status:** Not yet fixed.

### Key Learnings (CONSTRAINTS FOR ALL FUTURE WORK)

1. **EMA on rotation components independently = WRONG.** Rotations live on SO(3), not R^6. Smoothing individual components breaks the manifold constraint (orthogonality). ALWAYS re-orthogonalize after smoothing, or use rotation-native smoothing (quaternion SLERP, axis-angle EMA).

2. **The 90° constraint makes the problem SIMPLER.** 3 orthogonal axes = 3 DOF (a rotation). Only need 2 clean axes — the 3rd is cross product. After getting 2 right, the ENTIRE rotation matrix is determined. Don't treat 6 values as independent — they're 3 DOF, not 6.

3. **camera.up = (0,1,0) was hiding roll noise.** The spherical path's forced vertical up eliminated an entire class of errors. Don't add roll to the overlay unless the detection is proven accurate for roll.

4. **Don't remove working outlier rejection.** When replacing a smoothing method, port the rejection thresholds too. The old 30° jump + low confidence check was battle-tested.

5. **Auto-detect verticality: use angle, not magnitude.** `abs(y_component)` fails when two axes have similar Y but very different angles from vertical. Use `abs(y) / length` = cosine of angle from vertical.

6. **Test the direct axes path in ISOLATION before enabling.** Should have compared direct path output vs spherical path output frame-by-frame before switching. The overlay preview looked okay but the actual camera build was wrong.

### Fix Applied (Session 11)
All 4 bugs fixed in `ViewCubeTracker.ts`:

1. **BUG #39 FIXED** — `buildSmoothedAxes()` now re-orthogonalizes after EMA:
   - Extracts right=[x[0],y[0],z[0]] and up=[-x[1],-y[1],-z[1]] from 6 smoothed values
   - Normalizes right, applies Gram-Schmidt to orthogonalize up, then rebuilds axis projections
   - Output is always an orthonormal camera basis regardless of EMA distortion

2. **BUG #40 FIXED** — Roll only applied when `|roll| > 5°` (in `reconstructFromTwoAxes`) AND `confidence >= 0.8` (in `analyze()`). Matches old spherical path's forced `camera.up=(0,1,0)`.

3. **BUG #41 FIXED** — Outlier dot threshold tightened `0.5 → 0.7` in `smoothCleanAxes()`. Catches ~45° jumps vs old ~60°.

4. **BUG #42 FIXED** — `autoDetectUpAxis()` now uses `abs(y)/length` (cosine of angle from vertical) instead of raw `abs(y)`. Correctly identifies Z-up in isometric views where two axes have similar Y magnitude but different angles.

---

## 2026-02-28 — Session 9b: Root Cause Found — Color Detection + Z-up Auto-Detect

### Key Insight
**eDrawings HAS colored axis lines at 155x150 crop.** Color detection finds R:519, G:568, B:824 pixels at 100% confidence. The cube corner detection code was solving the WRONG PROBLEM — it never even runs because color wins.

### Root Causes Found

#### BUG #36: Wrong axis mapping — Z-up not detected
- **Symptom:** Rotation output nearly zero (-3°, -11°) despite clearly rotated isometric view.
- **Root cause:** Default axis mapping is identity (Y-up). eDrawings is Z-up. Without remapping, the vertical blue/Z direction is treated as depth, not height. Result: near-zero pitch for what's actually a big rotation.
- **Fix:** Auto-detect Z-up by checking which color axis has strongest vertical screen component. Runs once on first 3-axis detection. User's explicit mapping overrides auto-detect.

#### BUG #37: Blue channel contamination from cube body
- **Symptom:** B:824px vs R:519, G:568 — blue 58% higher than red.
- **Root cause:** eDrawings cube body has subtly colored faces (sat 0.20-0.30) that pass the `sat > 0.20` threshold for blue classification.
- **Fix:** Raised sat threshold from 0.20 to 0.35 for ALL axis colors.

#### BUG #38: Pixel count as axis strength selects contaminated axes
- **Symptom:** Reconstruction picks blue (824px) + green (568px) as strongest axes. But blue is the most contaminated.
- **Root cause:** `getAxisStrengths()` used raw pixel count. More pixels ≠ better quality. A contaminated axis has MORE pixels but its PCA centroid is pulled toward center → lower projection magnitude.
- **Fix:** Use projection magnitude `|dir|` (= centroid distance / halfSize) as strength instead of pixel count. The 90° constraint only needs 2 clean axes — magnitude picks the cleanest.

### Fundamental Constraint (LEARNING)
**The 3 reference axes MUST be 90° apart.** This means:
- You only need 2 axes correct — the 3rd is determined by cross product
- Pick the 2 CLEANEST axes (highest projection magnitude), not the 2 with most pixels
- `reconstructFromTwoAxes()` enforces orthogonality via quadratic constraint
- This makes the problem SIMPLER, not harder

---

## 2026-02-28 — Session 9: Cube Corner Detection + ROI Verify Shift Fix

### What Was Built
- **Cube corner detection (`detectAxesByCube()`):** New strategy for monochrome view cubes (eDrawings, Inventor) where color detection finds 0 axes. Detects cube silhouette hexagon, finds near corner via diagonal intersection, extracts 3D axis projections from edge vectors.
- **Algorithm:** Otsu threshold → Moore boundary trace → Douglas-Peucker (adaptive ε for 4-7 vertices) → hexagon diagonal intersection → edge vector extraction → feeds into existing `assignAxesToDirections()` + `reconstructFromTwoAxes()`.
- **Strategy chain:** `color (conf>0.15)` → `cube (conf>0.2)` → `edges (fallback)`.
- **Confidence:** 0.85 (hexagon/6v), 0.65 (pentagon/5v), 0.50 (rectangle/4v).
- **Files:** `ViewCubeTracker.ts` (+200 lines), `types.ts` (added `'cube'` to strategy union).

### Issues Found

#### BUG #34: ROI verify rectangles shift up by ~25px (menu bar height)
- **Symptom:** After drawing ROI rectangles, the verification rectangles in the overlay window appear shifted UP.
- **Root cause:** `ROI_VERIFY` handler in main/index.ts forwarded raw workArea-relative coords to the overlay window. Overlay window starts at screen y=0, but ROI coords are relative to workArea.y (~25px on macOS). The `ROI_REGIONS` handler correctly adds `workArea.y` offset, but `ROI_VERIFY` did NOT.
- **Fix:** Added workArea offset transform in `ROI_VERIFY` handler (same pattern as `ROI_REGIONS`).
- **Impact:** Verify display now aligns with where user actually drew. Capture coords were already correct (the `ROI_REGIONS` path handles offset).

#### BUG #35: Cube detection — model overlay not anchored to rotation (under investigation)
- **Symptom:** Rotation values change when rotating CAD, but 3D wireframe overlay doesn't follow properly.
- **Possible causes under investigation:**
  1. Axis labeling instability — `assignAxesToDirections()` heuristic may assign wrong X/Y/Z labels to cube edge vectors (no color to disambiguate)
  2. Axis mapping — eDrawings is Z-up, requires `{ x:'+x', y:'+z', z:'-y' }` mapping
  3. Douglas-Peucker vertex count instability — may switch between hex/pentagon/rectangle modes between frames
- **Added:** Diagnostic logging (`[VC-cube]`) for vertex count, near corner position, inner vertices.

---

## 2026-02-27 — Session 8: Axis Remapping + View Cube Detection Issues

### What Was Built
- **Axis Remapping:** Replaced `axisInversion` (3 flip booleans) with `axisMapping` (each overlay axis picks a source: `+x|-x|+y|-y|+z|-z`). Enables proper Z-up→Y-up conversion.
- **UI:** Per-axis cycle buttons + preset buttons (Default, Z-up) in Debug section
- **Files:** `types.ts` (AxisSource/AxisMapping types, IPC rename), `main/index.ts` (getAxisValue helper, remapping logic), `SetupApp.tsx` (new UI)

### Issues Found

#### BUG #28: View cube color detection fails on cube-style indicators
- **Symptom:** Only 13% confidence with SolidWorks view cube. R:15px G:27px B:7px.
- **Root cause:** Confidence formula expects hundreds of colored pixels (triad-style). Cube body dominates the ROI — colored axis lines are only ~50 pixels total. Blue at 7px barely above PCA minimum of 5.
- **Impact:** Tracking unreliable — axes can drop out at certain angles when lines go behind cube.
- **Fix plan (3 parts):**
  1. Lower PCA minimum: 5→3 pixels (ViewCubeTracker.ts line 42)
  2. Adaptive confidence: `max(30, w*h*0.015)` → `max(15, w*h*0.002)` (line 114)
  3. Temporal hold: keep last good axes for 3-5 frames during dropout

### Learnings
- **Cube-style view indicators starve color detection.** Triad = hundreds of colored pixels. Cube = dozens. Must make thresholds adaptive.
- **Axis remapping > axis inversion.** Flip (negate) can't swap axes. Full source mapping needed for cross-convention support (Z-up↔Y-up).

---

## 2026-02-27 — Session 7: Phase 1 — ROI Debug View (Verify Capture + Masks)

### What Was Built
Implemented Phase 1 of the ROI-based tracking pipeline: debug visualization for verifying ROI capture crops are correct before wiring tracking.

**Changes:**

1. **`RendererScreenCapture.ts`** — Added `CropPreviewCallback` type and `setCropPreviewCallback()` method. In `extractDualMask()`, after sending crops to main, calls the callback with canvas data URLs at ~2fps (500ms throttle). Cleans up callback on `stop()`.

2. **`SetupApp.tsx`** — Added new "Debug" section (visible when ROI is defined) that shows:
   - Live View Cube crop preview (RGBA, ~120x120, pixel-rendered)
   - Live CAD Region crop preview (color, up to 800x600)
   - Region coordinates + dimensions
   - "LIVE" badge when previews are streaming
   - Message prompting to start tracking when previews aren't active yet

3. **ROI flow verified end-to-end:** ROI_DEFINE → ROI_SCREENSHOT → drawing → ROI_REGIONS → ROI_VERIFY overlay (blue=VC, green=CAD) → confirmation. All IPC handlers in main/index.ts correctly forward to appropriate windows.

### BUGS FOUND & FIXED

#### BUG 30: ROI screenshot captures expanded panel instead of clean desktop
- **Symptom:** Setup window expands to fullscreen FIRST, then captures screenshot. Screenshot shows the giant panel itself. User sees their own panel content as the drawing background.
- **Root cause:** In main/index.ts ROI_DEFINE handler, `setBounds()` was called BEFORE `desktopCapturer.getSources()`.
- **Fix:** Hide setup + overlay windows first (400ms delay), capture clean desktop screenshot, THEN expand setup window and show ROI overlay.
- **Also added:** `ROI_CANCEL` IPC channel to restore windows on cancel (window was stuck fullscreen).

#### BUG 31: Debug crop previews are black/grey — DPR coordinate scaling bug (CRITICAL)
- **Symptom:** View Cube crop shows black, CAD Region crop shows grey. Both crops land on wrong screen positions.
- **Root cause:** `extractDualMask()` used `screen.width * window.devicePixelRatio` to map ROI coords to video pixels. On Retina (DPR=2), this halves the scale, making crops land at 50% of the correct position. ROI coords are CSS screen space; the formula should be `videoSize / cssScreenSize` with NO DPR.
- **Fix:** Removed `(window.devicePixelRatio || 1)` from scale calculation.
- **Lesson:** ROI coords = CSS screen space. Video resolution varies (capped at 1920x1080). The ratio `videoRes / cssScreenRes` handles DPR automatically for any video resolution.

#### BUG 32: ROI instruction bar pushes canvas down, distorting coordinate mapping
- **Symptom:** Full-width instruction bar at top of ROI overlay takes 41px, pushing canvas down. Screenshot is squished into smaller area, causing Y-coordinate offset.
- **Fix:** Redesigned as floating pill overlay (position: absolute) with canvas filling the entire window area. Instruction + buttons float over the canvas without affecting layout.

### Naming Change
- Renamed all user-facing "Viewport" → "CAD Region" (user request). Internal variable names unchanged.

#### BUG 33: Menu bar Y offset makes ROI rectangles shift down
- **Symptom:** After drawing ROI rectangles, the regions appear shifted down by ~25px (macOS menu bar height).
- **Root cause:** Screenshot approach captures from (0,0) = top of screen including menu bar. But the drawing window starts at `workArea.y` (~25px below). All Y coordinates are offset by menu bar height.
- **Fix:** Completely removed screenshot-based approach. ROI overlay is now transparent — user draws directly on their desktop. Window covers `workArea` bounds, coordinates are pixel-perfect without any mapping.

#### BUG 34: ViewCubeTracker orientation detection uses broken Euler math (CRITICAL)
- **Symptom:** View cube axis detection finds colored pixels but computed rotationX/Y/Z are wrong (don't match actual CAD orientation).
- **Root cause:** `axesToEuler()` used naive `atan2` on 2D axis projections to get Euler angles. This is mathematically incorrect — 2D projections don't map to Euler angles via simple arctangent. The hanomi-platform's `axesToQuaternion()` correctly builds a rotation matrix from camera basis vectors (right/up/forward) derived from the 2D projections.
- **Fix:** Replaced `axesToEuler()` with `axesToSpherical()` that:
  1. Builds `right` and `up` camera basis vectors from 2D axis projections (same as platform)
  2. Computes `forward = cross(right, up)` (camera position direction)
  3. Extracts spherical coordinates: `rotationX = asin(forward.y)`, `rotationY = atan2(forward.x, forward.z)`
  4. No Three.js needed — pure vector math (runs in main process)
- **Also added:** `axes` field to `ViewCubeResult` so debug panel shows raw pixel counts (R/G/B) and 2D direction vectors.
- **Lesson:** For reconstructing 3D rotation from 2D axis projections: ALWAYS build the rotation matrix from camera basis vectors, never use naive atan2 on individual axes.

#### BUG 35: ROI drawing overlay shows grey screen — can't see desktop
- **Symptom:** Entering ROI drawing mode covers the entire screen with a grey tint. User can't see the CAD software underneath to draw ROI boxes.
- **Root cause:** ROI drawing overlay div had `background: 'rgba(0,0,0,0.15)'` — semi-transparent black covering everything.
- **Fix:** Changed to `background: 'transparent'`.

#### BUG 36: ROI drawing shows white frosted glass — #root covers desktop
- **Symptom:** Even after fixing the overlay div background, the entire screen shows a white frosted glass effect during ROI drawing.
- **Root cause:** The `#root` div in `setup/index.html` has `background: rgba(255,255,255,0.97)` and `backdrop-filter: blur(20px) saturate(1.8)` — the frosted glass panel style. When setup window expands to fullscreen for ROI drawing, #root covers everything.
- **Fix:** Added `useEffect` in `ROIDrawingOverlay` that temporarily sets `#root` to transparent (removes background, backdrop-filter, box-shadow, border-radius) on mount, restores original styles on unmount.

#### BUG 37: Cursor changes when hovering over overlay wireframe
- **Symptom:** User's cursor keeps flickering/changing to an arrow when moving mouse over the transparent overlay area where wireframe lines are rendered.
- **Root cause:** Electron's `setIgnoreMouseEvents(true, { forward: true })` still processes CSS cursor styles for non-transparent pixels. The wireframe canvas has opaque pixels (lines/faces), so when cursor passes over them, the overlay's `cursor: 'default'` overrides the CAD app's cursor.
- **Fix:** Added `pointerEvents: 'none'` to the overlay container when NOT in align mode. Only enables pointer events during align mode (drag to rotate/pan/zoom). This prevents the overlay's HTML from affecting the cursor at all during normal use.

#### BUG 38: Absolute rotation — no manual alignment needed
- **Symptom:** Relative rotation tracking (offset-based) didn't work because user doesn't do manual alignment. Delta was always near zero since base was (0,0,0).
- **Root cause:** Tried to implement relative tracking (save base alignment + first VC reading as reference, then apply deltas). But user explicitly wants NO manual alignment — the view cube should directly orient the model.
- **Fix:** Reverted to absolute rotation. `axesToSpherical()` with corrected math gives the camera orientation directly. `alignment.rotationX/Y/Z = result.rotationX/Y/Z`. Removed unused `baseAlignment`/`referenceVCRotation` variables.
- **Lesson:** The view cube gives ABSOLUTE orientation. GLTF and eDrawings both use Y-up coordinate system. Absolute rotation should "just work" with correct 2D→3D math. Don't add offset layers that require manual calibration.

### Key Learnings
- **Debug preview = essential.** The live crop previews immediately revealed the DPR bug. Without them, we'd never know the crops were landing in the wrong place. Always add visual debugging BEFORE wiring tracking logic.
- **DPR in coordinate mapping = common trap.** On Retina, `screen.width` is CSS width (1440) but video might be 1920x1080 (capped). `videoSize / cssScreenSize` naturally handles DPR for any video resolution.
- **Screenshot timing matters.** Must hide all app windows before capturing desktop, otherwise screenshot includes the app itself.
- **Floating UI over canvas > fixed layout bar.** Bars take up layout space and shift coordinate mappings. Floating pills (position: absolute, pointerEvents: none) don't affect canvas dimensions.
- **Transparent overlay > screenshot for ROI drawing.** Removes all coordinate mapping issues (menu bar offset, DPR, screenshot timing). Coordinates are pixel-perfect.
- **2D→3D rotation reconstruction: build rotation matrix, not naive atan2.** The platform's approach (right/up→forward→spherical) is mathematically correct. Euler atan2 on individual axis projections is fundamentally wrong.
- **Electron `{ forward: true }` + opaque pixels = cursor flicker.** Use `pointerEvents: 'none'` on overlay content when in click-through mode to prevent cursor changes.
- **Absolute rotation > relative with manual offset.** If both source (CAD view cube) and target (overlay camera) use the same coordinate convention (Y-up), absolute rotation maps directly. Don't add offset/reference layers.

---

## 2026-02-26 — Session 6: BUG 29 — Ignore Static Points in MotionDecomposer

### Problem
Tracking pipeline fully operational (10fps capture, 300+ FAST corners, 199-235 tracked points at 100% confidence) but motion output always exactly zero. `frameDiff=242,972` (significant screen change) yet `rot(0.0000,0.0000)`. Root cause: FAST corners prefer sharp, high-contrast features (text/icons/buttons) so the top-300 corners by score sit on static UI (menu bar, toolbars, dock), not the CAD viewport. Median flow = 0 even during rotation.

### Fix (BUG 29)
1. **`MotionDecomposer.ts`** — After collecting all flow vectors, split into static (<0.5px magnitude) vs moving (>=0.5px) clusters. If >=8 moving points exist, compute median/variance/radial from movers only, ignoring static UI. Falls back to all points if everything is static (correct ZERO_MOTION).
2. **`cv-worker.ts`** — Added flow magnitude diagnostic logging (every ~10th frame): reports `N moving / M static (maxMag=X.X)` to tracking log for verifying the split works.

### Key Insight
- BUG 29: The MotionDecomposer's median-based approach assumes most tracked points are on the moving object. When >50% of corners sit on static UI, the median is dominated by zero-flow vectors and real motion is invisible. The fix partitions points by flow magnitude before computing statistics.

---

## 2026-02-26 — Session 1: Bootstrap & First Launch

### What Was Built
Took ~3,500 lines of uncompiled code across 31 files → fully building Electron app.

### BUGS FOUND & FIXED

#### BUG 1: App quits after splash screen (CRITICAL)
- **Symptom:** Splash animation plays fine, then app just closes. No setup panel, no overlay.
- **Root cause:** `splashWindow.destroy()` removes the ONLY window → Electron's `window-all-closed` event fires → `app.quit()` runs BEFORE `launchMainApp()` creates new windows.
- **Fix:** Create new windows FIRST via `launchMainApp()`, THEN destroy splash 300ms later. Also guarded `window-all-closed` so it only quits if `setupWindow` or `overlayWindow` exist.
- **Lesson:** In Electron, NEVER destroy a window if it's the last one unless you've already created replacements or guarded `window-all-closed`.

#### BUG 2: Wrong dist paths — Electron can't find HTML files
- **Symptom:** Windows created but blank/crash — HTML files not found.
- **Root cause:** `tsconfig.main.json` has `rootDir: ./src`, so `src/main/index.ts` compiles to `dist/main/main/index.js` (extra `main/` nesting). Window files used `path.join(__dirname, '..', 'renderer', ...)` which resolved to wrong location.
- **Fix:** Changed all window `loadFile` paths from `'..', 'renderer'` to `'..', '..', '..', 'renderer'`. Changed `package.json` main from `dist/main/index.js` to `dist/main/main/index.js`.
- **Lesson:** Always verify runtime paths after tsc compilation. `rootDir`/`outDir` interaction creates unexpected nesting.

#### BUG 3: GLTFLoader import path wrong
- **Symptom:** Webpack fails — can't resolve `three/addons/loaders/GLTFLoader.js`.
- **Root cause:** three@0.160 uses `three/examples/jsm/` not `three/addons/`. The `/addons/` alias was added in later three.js versions.
- **Fix:** Changed to `three/examples/jsm/loaders/GLTFLoader.js`.

#### BUG 4: Duplicate MotionDelta interface
- **Symptom:** TypeScript compile error about conflicting types.
- **Root cause:** `MotionDelta` defined in both `shared/types.ts` and `MotionDecomposer.ts`. The one in `types.ts` had an extra `timestamp` field nobody used.
- **Fix:** Removed the duplicate from `types.ts`. The canonical one lives in `MotionDecomposer.ts`.

#### BUG 5: No type declarations for jsfeat and window.require
- **Symptom:** TypeScript errors on `require('jsfeat')` and `window.require('electron')`.
- **Fix:** Created `src/types/jsfeat.d.ts` and `src/types/electron-renderer.d.ts`. Added to both tsconfigs.

#### BUG 6: Strict null check in SplashApp closure
- **Symptom:** TS18047 `'built' is possibly null` inside `requestAnimationFrame` callback.
- **Root cause:** TypeScript doesn't carry null narrowing into closures.
- **Fix:** Captured into local `const b = built` after the null check.

#### BUG 7: Native module dependency (ScreenCaptureManager)
- **Symptom:** Screen capture always returns null — native `.node` module never compiled.
- **Fix:** Complete rewrite using Electron's `desktopCapturer` API. All capture methods now async. CVTracker updated to use recursive `setTimeout` instead of `setInterval`.

#### BUG 8: `protocol.registerFileProtocol` deprecated in Electron 33
- **Fix:** Added try/catch with `protocol.handle()` (new API) fallback to `registerFileProtocol` (old API).

#### BUG 9: No Hanomi logo on splash
- **Status:** In progress — logo files copied to assets/, need to embed in SplashApp.

#### BUG 10: Setup panel looks nothing like prototype
- **Symptom:** Plain macOS window with basic buttons, not the floating glass panel from prototype.
- **Fix:** Complete redesign of SetupApp.tsx — collapsible sections (Model, Tracking, Align, Calibration), frosted glass panel style, frameless transparent window positioned at right edge of screen.
- **SetupWindow changes:** frameless, transparent, 300x640, positioned top-right, rounded corners via CSS.
- **Lesson:** The prototype HTML at `hanomi-platform/` has the canonical UI design. Reference `CADOverlayPrototype_v6.html` lines 1427-1622 for the floating panel pattern.

#### BUG 11: WebkitAppRegion not valid in React CSSProperties
- **Symptom:** TypeScript error TS2353 — WebkitAppRegion not in Properties type.
- **Fix:** Use string key `'-webkit-app-region': 'drag'` with `@ts-ignore` — Electron-specific CSS property.

#### BUG 12: Overlay & Setup don't follow across macOS desktop swipes (CRITICAL)
- **Symptom:** User swipes 4 fingers to switch macOS Desktops — overlay disappears, stays on the old desktop.
- **Root cause:** `OverlayWindow` had `setVisibleOnAllWorkspaces(true)` but `SetupWindow` did NOT. Both windows must have this set for the app to follow across Spaces.
- **Fix:** Added `this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` to `SetupWindow.ts` constructor, right before `setAlwaysOnTop`.
- **Lesson:** In Electron, `setVisibleOnAllWorkspaces` must be set on EVERY window you want visible across macOS Spaces, not just the overlay.

#### BUG 13: Wrong logo — sharp PNG instead of pixel art
- **Symptom:** Splash screen shows a clean, sharp Hanomi logo instead of the iconic pixelated version.
- **Root cause:** `src/shared/logo.ts` contained a large high-res PNG base64. The canonical Hanomi logo is the pixel-art version from `init_platform_animation.html` — a smaller PNG rendered on a 44x36 canvas then CSS-scaled to 88x72 for the chunky pixel look.
- **Fix:** Replaced `logo.ts` with the pixel logo base64 (`LOGO_PIXEL_BASE64`) + canvas dimensions. Updated `SplashApp.tsx` to use a `<canvas>` element with `imageRendering: 'pixelated'` instead of `<img>`. Added `PixelLogo` React component.
- **Source:** `[app] Initial Loading /init_platform_animation.html` lines 152-168 — the `LOGO_B64` constant and `drawLogo()` function.
- **Lesson:** The pixel logo from `init_platform_animation.html` is the canonical Hanomi brand asset. Always use canvas-based rendering at 44x36 → 88x72 CSS for the pixel art effect.

#### BUG 14: Setup panel shifts when file dialog opens
- **Symptom:** Clicking "Upload 3D Model" opens macOS file picker, which pushes the setup panel to the left.
- **Root cause:** `dialog.showOpenDialog(setupWindow!.win, ...)` parents the dialog to the setup window. macOS auto-repositions the parent when a dialog appears near screen edges.
- **Fix:** Removed parent window parameter — now `dialog.showOpenDialog({...})` without `setupWindow!.win`.
- **Lesson:** Don't parent Electron dialogs to frameless windows positioned at screen edges.

#### BUG 15: Alignment via nudge buttons is impractical
- **Symptom:** Users can't align the wireframe to CAD viewport with tiny +/-2° rotation and +/-5px pan buttons. Too tedious for initial rough alignment.
- **Fix:** Added **Align Mode** — user clicks "Start Aligning", overlay becomes interactive:
  - **Left-drag** = rotate (0.3°/px sensitivity)
  - **Shift+drag** = pan (1:1 pixel mapping)
  - **Scroll** = zoom (4% per tick)
  - **Right-drag** = pan (alternative)
  - Visual indicator bar at top of screen: "ALIGN MODE — Drag to rotate · Shift+drag to pan · Scroll to zoom"
  - "Done Aligning" button exits mode, overlay returns to click-through
- **Implementation:** New `IPC.OVERLAY_ALIGN_MODE` channel. OverlayApp handles mouseDown/Move/Up/Wheel events. SetupApp has toggle button.
- **Nudge buttons kept** as secondary fine-tune controls below the align button.
- **Lesson:** Primary alignment must be direct manipulation (mouse drag), not incremental buttons.

#### BUG 16: No Hanomi logo in setup panel header
- **Symptom:** Setup panel header shows generic "H" box instead of Hanomi logo.
- **Fix:** Added `PixelLogoSmall` component — same pixel art canvas approach as splash (44x36 → 44x36 CSS).

### FILES MODIFIED
| File | What Changed |
|------|-------------|
| `src/types/jsfeat.d.ts` | CREATED — jsfeat type declaration |
| `src/types/electron-renderer.d.ts` | CREATED — Window.require type |
| `src/shared/types.ts` | Removed duplicate MotionDelta |
| `tsconfig.main.json` | Added `src/types/**/*` |
| `tsconfig.renderer.json` | Added `src/types/**/*` |
| `package.json` | Fixed main entry path |
| `src/main/index.ts` | Fixed splash→main transition, async capture, protocol |
| `src/main/windows/OverlayWindow.ts` | Fixed HTML path, added webSecurity:false |
| `src/main/windows/SetupWindow.ts` | Fixed HTML path, increased height |
| `src/main/windows/SplashWindow.ts` | Fixed HTML path |
| `src/main/tracking/ScreenCaptureManager.ts` | REWRITTEN — desktopCapturer |
| `src/main/tracking/CVTracker.ts` | Async capture, recursive setTimeout |
| `src/renderer/overlay/OverlayApp.tsx` | Fixed GLTFLoader import + path |
| `src/renderer/setup/SetupApp.tsx` | Added calibration profiles UI |
| `src/renderer/splash/SplashApp.tsx` | Fixed null check closure, pixel logo canvas |
| `src/shared/logo.ts` | REWRITTEN — pixel art logo (was sharp PNG) |
| `src/main/windows/SetupWindow.ts` | Added setVisibleOnAllWorkspaces |

---

## 2026-02-26 — Session 2: Tracking Pipeline Deep Fix

### What Was Fixed
CV tracking pipeline was completely non-functional — wireframe overlay not responding to CAD viewport movement at all. Deep analysis of the entire pipeline revealed multiple parameter issues.

### BUGS FOUND & FIXED

#### BUG 17: CV tracking pipeline not producing motion (CRITICAL)
- **Symptom:** Wireframe overlay does NOT move when user rotates/pans CAD viewport. Tracking shows "ON" but zero motion.
- **Root cause (multi-factor):**
  1. **FAST corner threshold too high (20):** CAD software UIs have low-contrast edges. Threshold 20 was filtering out most features, leaving too few tracking points.
  2. **Dead zone too high (0.5 pixels):** At 800x600 capture → 400px process width, small CAD rotations produce sub-pixel flow. Dead zone of 0.5 killed all small motions.
  3. **Kalman filter measurement noise too high (r=0.5):** Overly conservative — smoothed out real motion signals, especially small ones.
  4. **Orbit sensitivity too low (0.15 deg/px):** Even when flow was detected, the resulting rotation was too small to be visible.
  5. **Capture interval too fast (100ms):** desktopCapturer on macOS needs ~50-150ms per call. 100ms interval with async processing caused frame drops.
  6. **Min confidence too high (0.05):** Motion events were gated by confidence — CAD toolbars and static UI elements reduce the tracked/total ratio.
- **Fixes applied:**
  - `cv-worker.ts`: FAST threshold 20→10, dead zone 0.5→0.15, Kalman r=0.5→0.2, orbit sensitivity 0.15→0.3
  - `CVTracker.ts`: captureInterval 100→150ms, minConfidence 0.05→0.02
  - `MotionDecomposer.ts`: dead zone 0.5→0.15
  - Added diagnostic logging throughout pipeline (capture timing, feature count, motion values)
- **Key insight:** hanomi-platform uses NO CV tracking — it's direct mouse interaction with Three.js. The overlay app's approach is fundamentally more complex (screen observation vs direct input).

#### BUG 18: No tracking diagnostics visible to user
- **Symptom:** User had no way to know if tracking was working or what was failing.
- **Fix:** Enhanced tracking section in SetupApp with:
  - Step-by-step workflow guide (load model → select window → start tracking)
  - Color-coded confidence indicator (green >30%, orange >10%, red <10%)
  - Confidence progress bar
  - Live alignment values display (rotation, position, scale)
- **Lesson:** Always surface diagnostic info to the user — "the UX should be so that the user cannot be wrong."

### FILES MODIFIED
| File | What Changed |
|------|-------------|
| `src/main/tracking/cv-worker.ts` | FAST threshold 20→10, Kalman r 0.5→0.2, dead zone 0.5→0.15, orbit sensitivity 0.15→0.3 |
| `src/main/tracking/CVTracker.ts` | captureInterval 100→150, minConfidence 0.05→0.02, added capture timing logs |
| `src/main/tracking/MotionDecomposer.ts` | dead zone 0.5→0.15, orbit sensitivity 0.15→0.3 |
| `src/renderer/setup/SetupApp.tsx` | Live tracking diagnostics, alignment values, step-by-step guide, confidence bar |

---

## 2026-02-26 — Session 3: UI Fixes & Diagnostic Logging

### BUGS FOUND & FIXED

#### BUG 19: Splash screen crashes with JS error
- **Symptom:** Initial splash screen (attractor animation) fails to load, JavaScript error. App hangs at black screen.
- **Root cause:** `AttractorRenderer.ts` `buildTrajectories()` or Three.js setup can throw at runtime. No try-catch around the animation sequence.
- **Fix:** Wrapped entire `run()` async sequence in try-catch. If animation fails, `notifyComplete()` is still called → app proceeds to main windows.
- **Lesson:** Always wrap cinematic/animation sequences in try-catch. A splash crash must never block the actual app.

#### BUG 20: Setup panel loads twice (two windows)
- **Symptom:** Two setup panels appear, stacked on top of each other.
- **Root cause:** `launchMainApp()` called twice — once from `splash:complete` handler, once from the 20-second fallback timeout. No guard variable.
- **Fix:** Added `let mainLaunched = false` flag. `launchMainApp()` returns immediately if already called.
- **Lesson:** ALWAYS guard singleton initialization functions. Multiple event sources can trigger the same function.

#### BUG 21: Setup panel not collapsible — blocks CAD viewport
- **Symptom:** 300x640 floating panel permanently covers the right side of screen. User can't interact with CAD viewport behind it.
- **Fix:** Made setup panel fully collapsible:
  - Collapsed state: 300x56px — shows only Hanomi logo + "Hanomi Overlay v1.0" + expand chevron
  - Expanded state: 300x640px — full panel with all sections
  - Click collapsed bar to expand, click chevron to collapse
  - Window resizes via `IPC.SETUP_RESIZE` — keeps right edge fixed position
  - Auto-collapse on desktop switch (DesktopSwitchDetector fires → main sends `IPC.SETUP_COLLAPSE`)
- **Lesson:** Floating overlay panels MUST be collapsible. Users need to access what's behind them.

#### BUG 22: Window selection UI unnecessary complexity
- **Symptom:** "Refresh Window List" button and window picker confused users. Tracking should just work on full screen.
- **Fix:** Removed window list entirely. Tracking always captures full screen. CAD viewport is assumed to be behind the overlay at all times.
- **Lesson:** Don't expose internal implementation details (which window to capture) as UI. Just make it work.

#### BUG 23: Desktop switch should auto-hide overlay
- **Symptom:** When user swipes between macOS desktops, the overlay stays visible even though the CAD viewport is gone.
- **Fix:** On `desktopSwitch` event: auto-collapse setup panel + hide overlay. User re-expands when they return to the CAD desktop.

#### BUG 24: Tracking pipeline still showing 0 pts 0% (INVESTIGATING)
- **Symptom:** After all parameter tuning, tracking shows 1 fps, 0 pts, 0% confidence. No motion detected at all.
- **Root cause (suspected):** Either macOS screen recording permission not granted (desktopCapturer returns blank thumbnails) or jsfeat crashing silently in worker thread.
- **Diagnostic system added:** Comprehensive logging to `~/Library/Application Support/hanomi-overlay/tracking-debug/tracking.log`:
  - Pixel statistics per frame (min, max, mean, stddev, nonZero count)
  - Blank frame detection with screen recording permission warning
  - Worker spawn/error/exit logging
  - PGM frame dumps (first 3 frames saved as grayscale images)
  - jsfeat load verification in worker
- **Status:** Awaiting log data from next tracking session.

### FILES MODIFIED
| File | What Changed |
|------|-------------|
| `src/main/index.ts` | `mainLaunched` guard, `SETUP_RESIZE` handler, desktop switch auto-collapse |
| `src/shared/types.ts` | Added `SETUP_RESIZE`, `SETUP_COLLAPSE` IPC channels |
| `src/renderer/setup/SetupApp.tsx` | REWRITTEN — collapsible panel, window resize IPC, removed window list |
| `src/renderer/splash/SplashApp.tsx` | try-catch around animation sequence |
| `src/main/tracking/CVTracker.ts` | Comprehensive diagnostic logging, PGM frame dumps, pixel stats |
| `src/main/tracking/cv-worker.ts` | jsfeat load verification, worker-side diagnostic logging |
| `src/main/tracking/ScreenCaptureManager.ts` | Added thumbnail size warning log |

### ARCHITECTURE NOTES
- **Tracking chain:** desktopCapturer (800x600 thumbnail, ~7fps) → grayscale → CVTracker → cv-worker (jsfeat optical flow) → MotionDecomposer → Kalman → IPC → OverlayApp camera
- **Desktop switching:** DesktopSwitchDetector monitors confidence drops → TemplateMatcher NCC → CalibrationStore profiles → auto-collapse setup + hide overlay
- **Three windows:** Splash (cinematic, destroys after) → Setup (collapsible control panel) + Overlay (transparent fullscreen)
- **Collapsible panel:** Collapsed=56px (logo bar), Expanded=640px (full panel). Resize via IPC keeps right edge fixed.
- **Critical tuning parameters:** FAST threshold=10, dead zone=0.15px, Kalman r=0.2, orbit sensitivity=0.3 deg/px, capture interval=150ms

---

## 2026-02-26 — Session 4: Tracking Pipeline — Zero Alignment Root Cause

### SYMPTOM
After session 3 fixes, tracking progressed from "0 pts 0%" to "183 pts 100% confidence" — BUT alignment remained at rot(0.0, 0.0) pos(0, 0) s=1.00. The pipeline detects features and tracks points, but NO motion accumulates.

### ROOT CAUSE ANALYSIS (3 critical bugs)

#### BUG 25: Kalman filter fundamentally misused on deltas (CRITICAL)
- **Symptom:** Motion deltas get attenuated and then reversed by Kalman filter.
- **Root cause:** The `KalmanFilter1D` is designed for filtering **absolute measurements** (e.g., position). But cv-worker was feeding it **per-frame deltas** (change in rotation per frame). When you feed a delta of +2° into a Kalman with state=0, it returns ~1.7° (attenuated). Next frame if delta=0, the Kalman state is still ~1.5° and it returns ~0.3° even though nothing moved. Over time the positive and negative spurious values cancel, resulting in near-zero net accumulation.
- **Fix:** Bypassed Kalman filter entirely — pass raw deltas from MotionDecomposer directly. Smoothing can be added later using an exponential moving average on deltas, not a Kalman state estimator.
- **Lesson:** Kalman filters are for STATE ESTIMATION of absolute values. If your signal is already a delta/rate, you need either: (a) accumulate into state THEN filter the state, or (b) use a simple EMA on deltas. Never feed deltas into a Kalman as if they're absolute measurements.

#### BUG 26: Dead zone still killing legitimate motion (from 0.15→0)
- **Symptom:** Even with deadZone=0.15, small but real viewport rotations produce median flow < 0.15px at 400px processing width and 2fps.
- **Root cause:** The dead zone check in MotionDecomposer combines two conditions with AND: `flowMag < deadZone AND totalFlowVariance < deadZone`. For pure translation (CAD orbit), medDX≈5px but variance is low. For small translations, medDX can be 0.1-0.15px — right at the threshold.
- **Fix:** Set dead zone to 0 (disabled). Let ALL motion through. Noise filtering can be added later at the alignment accumulation level, not the per-frame decomposition level.
- **Additional issue:** For pure rotation (rotating around viewport center), median flow cancels out (left side moves opposite to right side). `deltaRotY = medDX * sensitivity` but medDX≈0 for rotation. The variance IS high, but the decomposer uses median flow AS the rotation signal, which is fundamentally wrong for in-place rotation. This is a design flaw in the rotation detection — future fix needed.
- **Lesson:** Never add dead zones during development. Get the pipeline working end-to-end first with raw values. Add filtering later once you can see what the actual signal looks like.

#### BUG 27: desktopCapturer.getSources() may return cached/identical frames
- **Symptom:** 100% confidence (ALL 183 points track perfectly) is suspicious — in real viewport motion, some points should be lost (confidence typically 60-90%).
- **Root cause (suspected):** `desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 800, height: 600 } })` is designed for one-shot thumbnail capture, not continuous video streaming. Calling it repeatedly at 150ms intervals may return cached OS-level thumbnails on macOS, resulting in identical frames.
- **Diagnostic added:** Frame-difference detection — computes sum of absolute pixel differences between consecutive frames. If `frameDiff === 0`, frames are identical (frozen). Displayed in setup panel as "frame diff: N" with red "(FROZEN!)" warning when 0.
- **Next step:** If frames ARE frozen, replace `desktopCapturer.getSources()` with `navigator.mediaDevices.getUserMedia()` + video stream approach (renderer-side capture with canvas frame extraction).
- **Lesson:** `desktopCapturer.getSources()` is NOT a screen recording API. For real-time tracking, use `getUserMedia()` with a screen source to get a continuous video stream.

### FIXES APPLIED

| Fix | File | Change |
|-----|------|--------|
| Bypass Kalman | `cv-worker.ts` | Removed all `kalmanXxx.predict()` and `kalmanXxx.update()` calls. Raw deltas pass through directly. |
| Dead zone → 0 | `cv-worker.ts` | `deadZone: 0.15` → `deadZone: 0` |
| Dead zone → 0 | `MotionDecomposer.ts` | `deadZone: 0.15` → `deadZone: 0` |
| Frame diff detection | `CVTracker.ts` | Added `prevFrameData`, `frameDiffSum`. Compares consecutive frames pixel-by-pixel. Logs warning if frames are identical. |
| Frame diff in status | `CVTracker.ts` + `types.ts` | Added `frameDiff` to `CVTrackingStatus` and `CVStatus`. Broadcast to setup panel. |
| Frame diff display | `SetupApp.tsx` | Shows "frame diff: N" under alignment values. Red "(FROZEN!)" warning when 0. |
| Enhanced motion logging | `CVTracker.ts` | Every motion event logged with `HAS_MOTION` or `ZERO_MOTION` tag + frame diff value. |

### FILES MODIFIED
| File | What Changed |
|------|-------------|
| `src/main/tracking/cv-worker.ts` | Bypassed Kalman filter, dead zone → 0 |
| `src/main/tracking/MotionDecomposer.ts` | Dead zone → 0 |
| `src/main/tracking/CVTracker.ts` | Frame-diff detection, enhanced motion logging, frameDiff in status |
| `src/shared/types.ts` | `frameDiff` field in CVTrackingStatus |
| `src/renderer/setup/SetupApp.tsx` | Frame diff display in tracking diagnostics |

### LEARNINGS (RULES)
1. **Kalman filters are for state estimation, not delta filtering.** If your signal is a per-frame delta, use EMA not Kalman.
2. **Remove ALL dead zones during development.** Get raw signal working first, filter later.
3. **desktopCapturer.getSources() is NOT a streaming API.** For real-time capture, use getUserMedia() with screen source.
4. **100% tracking confidence is a red flag.** In real motion, some points should be lost. 100% means frames are likely identical.
5. **Always add frame-difference detection** when building a real-time capture pipeline. It's the single most diagnostic metric for capture issues.
6. **Test tracking with active viewport rotation** — not just static screens. The "it works but nothing moves" symptom requires the user to be actively changing the screen content.

---

## 2026-02-26 — Session 5: Replace Screenshot API with Video Stream

### WHAT WAS BUILT
Replaced the `desktopCapturer.getSources()` screenshot-based capture (2fps, ~400ms per call) with a persistent video stream using `navigator.mediaDevices.getUserMedia()` (30fps stream, 10fps frame extraction). This is the fix for BUG 27 — identical/cached frames from the screenshot API.

### ARCHITECTURE CHANGE
```
BEFORE (broken — 2fps screenshots):
  Main: CVTracker loop → ScreenCaptureManager.captureRegionGrayscale()
    → desktopCapturer.getSources() [~400ms] → thumbnail → grayscale → worker

AFTER (real-time — 10fps stream):
  Main sends CAPTURE_START (sourceId) to Setup Renderer
  Setup Renderer: getUserMedia() → persistent video stream (30fps)
    → setInterval 100ms: drawImage(video→canvas) → grayscale → IPC → Main
  Main: ipcMain.on(CAPTURE_FRAME) → cvTracker.pushFrame() → worker
```

### FILES MODIFIED
| File | What Changed |
|------|-------------|
| `src/shared/types.ts` | Added `CAPTURE_START`, `CAPTURE_STOP`, `CAPTURE_FRAME` IPC channels |
| `src/renderer/setup/RendererScreenCapture.ts` | **CREATED** — renderer-side capture class using getUserMedia + canvas frame extraction at 10fps |
| `src/main/tracking/CVTracker.ts` | **REWRITTEN** — removed captureAndProcess() loop, removed captureTimer, removed downscaleGrayscale. Added `pushFrame(data, width, height)` public method. Now push-based instead of pull-based. |
| `src/main/index.ts` | TRACKING_START now gets sourceId via desktopCapturer.getSources() and sends CAPTURE_START to renderer. TRACKING_STOP sends CAPTURE_STOP. Added CAPTURE_FRAME handler relaying to cvTracker.pushFrame(). |
| `src/renderer/setup/SetupApp.tsx` | Added capture lifecycle: listens for CAPTURE_START/STOP, manages RendererScreenCapture instance via ref, cleanup on unmount. |

### KEY DETAILS
- `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId } } })` — same macOS permission as desktopCapturer
- Frame extraction: video → offscreen canvas (400x300) → getImageData → RGBA→grayscale → IPC send
- 120KB per frame at 10fps = 1.2MB/s IPC — trivial overhead
- SetupWindow has `backgroundThrottling: false` — capture continues when panel collapsed
- ScreenCaptureManager kept for template matching (one-shot captures fine there)
- cv-worker.ts, MotionDecomposer.ts, OverlayApp.tsx — NOT changed (downstream pipeline unchanged)

### VERIFICATION
- `npm run build` — compiles without errors (webpack + tsc)
- All IPC channels properly wired in compiled output
- pushFrame() verified in compiled CVTracker.js
