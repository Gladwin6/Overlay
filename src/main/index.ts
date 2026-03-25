import { app, ipcMain, dialog, protocol, desktopCapturer, BrowserWindow, globalShortcut } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

// Prevent EPIPE crashes when a child process pipe breaks (e.g. SwBridge.exe dies).
// Without this, any console.log in the main process throws an uncaught exception.
process.stdout?.on('error', (err: any) => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on('error', (err: any) => { if (err.code !== 'EPIPE') throw err; });

// Block third-party DLL injection (SolidWorks shell extensions crash file dialogs).
// SolidWorks registers thumbnail/property handlers that load into ANY process opening
// a file dialog. These DLLs are incompatible with Chromium and cause "Not Responding" crashes.
app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
import { OverlayWindow } from './windows/OverlayWindow';
import { SetupWindow } from './windows/SetupWindow';
import { SplashWindow } from './windows/SplashWindow';
import { CVTracker } from './tracking/CVTracker';
import { MotionDelta } from './tracking/MotionDecomposer';
import { DesktopSwitchDetector } from './tracking/DesktopSwitchDetector';
import { TemplateMatcher } from './tracking/TemplateMatcher';
import { CalibrationStore } from './calibration/CalibrationStore';
import { SWBridgeReceiver } from './tracking/SWBridgeReceiver';
import { EdgeSnap } from './tracking/EdgeSnap';
import { AlignmentScorer } from './tracking/AlignmentScorer';
import { IPC, AlignmentState, ScreenRegion, WindowInfo, ViewCubeResult, AxisMapping, ViewCubeAxes } from '../shared/types';
import { ReviewSession } from './review/ReviewSession';
import { BridgeManager } from './bridges/BridgeManager';
import type { CameraFrame } from './bridges/CadBridge';

// ── State ────────────────────────────────────────────────────────────

let splashWindow: SplashWindow | null = null;
let overlayWindow: OverlayWindow | null = null;
let setupWindow: SetupWindow | null = null;
let cvTracker: CVTracker | null = null;
let desktopSwitchDetector: DesktopSwitchDetector | null = null;
let templateMatcher: TemplateMatcher | null = null;
let calibrationStore: CalibrationStore | null = null;
let swBridge: SWBridgeReceiver | null = null;
let edgeSnap: EdgeSnap | null = null;
let reviewSession: ReviewSession | null = null;
let bridgeManager: BridgeManager | null = null;
let bridgeLive = false;
let bridgePaused = false; // Paused during native dialogs to prevent IPC flood
let alignmentScorer: AlignmentScorer | null = null;

let alignment: AlignmentState = {
  positionX: 0, positionY: 0, positionZ: 0,
  rotationX: 0, rotationY: 0, rotationZ: 0,
  scale: 1,
};

let selectedRegion: ScreenRegion | null = null;
let isTracking = false;
let mainLaunched = false;

// Dual-mask ROI regions (stored across tracking sessions)
let viewCubeRegion: ScreenRegion | null = null;
let viewportRegion: ScreenRegion | null = null;

// The display the user drew the ROI on — used to capture the correct screen on multi-monitor setups
let activeDisplay: Electron.Display | null = null;

// Axis mapping config (remap detected view cube axes to overlay axes)
let axisMapping: AxisMapping = { x: '+x', y: '+y', z: '+z' };

// Calibration rotation offset — computed via one-click "Sync" from setup panel
let rotationOffsetX = 0;
let rotationOffsetY = 0;

// Smoothing for optical flow motion
let smoothedDelta = { panX: 0, panY: 0, scale: 1 };
let motionStreak = 0;
let lastConfidence = 0;

// Helper: get a detected axis value by source key (e.g. '+z' → axes.z, '-y' → negated axes.y)
function getAxisValue(axes: ViewCubeAxes, source: string): [number, number] | null {
  const sign = source[0] === '-' ? -1 : 1;
  const key = source[1] as 'x' | 'y' | 'z';
  const v = axes[key];
  return v ? [v[0] * sign, v[1] * sign] : null;
}

/**
 * Apply calibration rotation offset to cleanAxes as a rotation matrix multiplication.
 * Builds Ry(yaw) * Rx(pitch) and applies to the right/up vectors derived from axes.
 * More correct than adding Euler angles (no gimbal lock).
 */
function rotateAxes(axes: ViewCubeAxes, offsetX: number, offsetY: number): ViewCubeAxes {
  if (Math.abs(offsetX) < 0.01 && Math.abs(offsetY) < 0.01) return axes;

  const ax = axes.x!, ay = axes.y!, az = axes.z!;

  // Extract right and up vectors from axis projections
  // right[i] = axes.i[0], up[i] = -axes.i[1]
  let right: [number, number, number] = [ax[0], ay[0], az[0]];
  let up: [number, number, number] = [-ax[1], -ay[1], -az[1]];

  // Build rotation matrix Ry(yaw) * Rx(pitch)
  const radX = offsetX * (Math.PI / 180);
  const radY = offsetY * (Math.PI / 180);
  const cx = Math.cos(radX), sx = Math.sin(radX);
  const cy = Math.cos(radY), sy = Math.sin(radY);

  // Combined Ry * Rx matrix:
  // [ cy,  sy*sx,  sy*cx ]
  // [ 0,   cx,    -sx    ]
  // [-sy,  cy*sx,  cy*cx ]
  const applyRot = (v: [number, number, number]): [number, number, number] => [
    cy * v[0] + sy * sx * v[1] + sy * cx * v[2],
    cx * v[1] - sx * v[2],
    -sy * v[0] + cy * sx * v[1] + cy * cx * v[2],
  ];

  right = applyRot(right);
  up = applyRot(up);

  // Convert back to axis projections: axes.i = [right[i], -up[i]]
  return {
    ...axes,
    x: [right[0], -up[0]],
    y: [right[1], -up[1]],
    z: [right[2], -up[2]],
  };
}

// ── App Lifecycle ────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Auto-approve screen sharing requests (Electron 33+ requirement)
  const { session, desktopCapturer: dc } = require('electron');
  session.defaultSession.setDisplayMediaRequestHandler(async (_request: any, callback: any) => {
    const sources = await dc.getSources({ types: ['screen'] });
    if (sources.length > 0) {
      callback({ video: sources[0] });
    } else {
      callback({});
    }
  });

  // Register custom protocol for loading local GLTF files
  try {
    protocol.handle('local-file', (request) => {
      const filePath = decodeURIComponent(request.url.replace('local-file://', ''));
      return new Response(fs.readFileSync(filePath));
    });
  } catch {
    // Fallback for older Electron
    try {
      protocol.registerFileProtocol('local-file', (request, callback) => {
        const filePath = decodeURIComponent(request.url.replace('local-file://', ''));
        callback({ path: filePath });
      });
    } catch { /* ignore */ }
  }

  // Show splash screen first
  splashWindow = new SplashWindow();

  // When splash finishes, create the main windows BEFORE destroying splash
  // (prevents window-all-closed → app.quit race condition)
  ipcMain.once('splash:complete', () => {
    setTimeout(() => {
      launchMainApp();
      // Destroy splash AFTER new windows exist
      setTimeout(() => {
        splashWindow?.destroy();
        splashWindow = null;
      }, 300);
    }, 500);
  });

  // Fallback: if splash doesn't complete in 20s, launch anyway
  setTimeout(() => {
    if (splashWindow && !splashWindow.win.isDestroyed()) {
      launchMainApp();
      setTimeout(() => {
        splashWindow?.destroy();
        splashWindow = null;
      }, 300);
    }
  }, 20000);
});

function launchMainApp() {
  if (mainLaunched) return; // Guard against double-call
  mainLaunched = true;

  overlayWindow = new OverlayWindow();
  setupWindow = new SetupWindow();

  // Initialize subsystems
  cvTracker = new CVTracker();
  desktopSwitchDetector = new DesktopSwitchDetector();
  templateMatcher = new TemplateMatcher();
  calibrationStore = new CalibrationStore();

  // Auto-detect CAD software and connect bridge
  bridgeManager = new BridgeManager();
  bridgeManager.onFrame((frame: CameraFrame) => {
    if (!bridgeLive || bridgePaused) return;
    // Send camera frame directly to overlay renderer
    try {
      if (overlayWindow?.win && !overlayWindow.win.isDestroyed()) {
        overlayWindow.win.webContents.send('bridge:camera', frame);
      }
    } catch (_) {}
  });
  let lastBridgeStatus = '';
  bridgeManager.onStatus((status, cadName, detail) => {
    // Deduplicate: only log + send IPC when status actually changes
    const key = `${status}:${cadName}`;
    if (key === lastBridgeStatus) return;
    lastBridgeStatus = key;

    console.log(`[BridgeManager] ${cadName}: ${status}${detail ? ' — ' + detail : ''}`);
    try {
      if (setupWindow?.win && !setupWindow.win.isDestroyed()) {
        setupWindow.win.webContents.send('bridge:status', { status, cadName, detail });
      }
    } catch (_) {}
    if (status === 'live') {
      bridgeLive = true;
      // Show overlay when bridge goes live
      if (overlayWindow) {
        overlayWindow.show();
        overlayWindow.win.moveTop();
      }
    } else if (status === 'stopped' || status === 'error') {
      bridgeLive = false;
      // Stop the bridge on error to prevent infinite reconnect spam
      if (status === 'error') {
        bridgeManager?.stop();
      }
    }
  });

  // Auto-detect on startup (after a small delay for windows to load)
  setTimeout(async () => {
    try {
      const detected = await bridgeManager!.autoConnect();
      if (detected) {
        console.log(`[Main] Auto-detected: ${detected.name} — bridge started`);
      } else {
        console.log('[Main] No CAD detected — using screen tracking fallback');
      }
    } catch (err: any) {
      console.error('[Main] Bridge auto-detect failed:', err.message);
    }
  }, 2000);

  // ── Monitor tracking: follow CAD window across displays ──────────────
  const { screen: electronScreen } = require('electron');
  let currentDisplayId = electronScreen.getPrimaryDisplay().id;

  // Use cursor position as proxy for which display the user is working on.
  // When cursor moves to a different display, move the overlay there.
  const monitorTracker = setInterval(() => {
    if (!overlayWindow || overlayWindow.win.isDestroyed()) return;
    try {
      const cursor = electronScreen.getCursorScreenPoint();
      const display = electronScreen.getDisplayNearestPoint(cursor);
      if (display.id !== currentDisplayId) {
        currentDisplayId = display.id;
        overlayWindow.moveToDisplay(display);
        overlayWindow.win.webContents.send('display-changed', {
          width: display.bounds.width,
          height: display.bounds.height,
        });
        console.log(`[Main] Overlay moved to display ${display.id} (${display.bounds.width}x${display.bounds.height})`);
      }
    } catch {}
  }, 1000);

  // Handle display changes (resolution, added/removed monitors)
  electronScreen.on('display-metrics-changed', (_event: any, display: any, changedMetrics: string[]) => {
    if (display.id === currentDisplayId && overlayWindow && !overlayWindow.win.isDestroyed()) {
      console.log(`[Main] Display metrics changed: ${changedMetrics.join(', ')}`);
      overlayWindow.moveToDisplay(display);
      overlayWindow.win.webContents.send('display-changed', {
        width: display.bounds.width,
        height: display.bounds.height,
      });
    }
  });

  electronScreen.on('display-removed', () => {
    console.log('[Main] Display removed — moving overlay to primary');
    const primary = electronScreen.getPrimaryDisplay();
    currentDisplayId = primary.id;
    overlayWindow?.moveToDisplay(primary);
  });

  // ── Global shortcuts: rotate overlay correction (Ctrl+Shift+X/Y/Z/R) ──
  const axes = ['x', 'y', 'z'] as const;
  for (const axis of axes) {
    globalShortcut.register(`Ctrl+Shift+${axis.toUpperCase()}`, () => {
      try {
        if (overlayWindow?.win && !overlayWindow.win.isDestroyed())
          overlayWindow.win.webContents.send('correction:rotate', axis);
      } catch (_) {}
    });
  }
  globalShortcut.register('Ctrl+Shift+R', () => {
    try {
      if (overlayWindow?.win && !overlayWindow.win.isDestroyed())
        overlayWindow.win.webContents.send('correction:reset');
    } catch (_) {}
  });

  // Load stored calibration templates
  for (const profile of calibrationStore.list()) {
    if (profile.referenceScreenshot) {
      const buf = Buffer.from(profile.referenceScreenshot, 'base64');
      templateMatcher.addTemplate(profile.id, new Uint8Array(buf), 200, 150);
    }
  }

// Smoothing buffer for optical flow - reduces jitter
const MOTION_SMOOTHING = 0.15;  // 0-1, lower = smoother but more lag (increased for more responsiveness)
const MOTION_DEADZONE = 0.3;    // ignore movements smaller than this (pixels) - lowered from 0.5
const CONFIDENCE_THRESHOLD = 0.10;  // minimum confidence to apply motion - lowered from 0.15
const MIN_POINTS = 10;           // minimum tracked points required - lowered from 20

  // Wire up CVTracker events
  cvTracker.on('motion', (delta: MotionDelta) => {
    desktopSwitchDetector?.onConfidence(delta.confidence, delta.trackedPoints);

    const hasGoodSignal = delta.confidence >= CONFIDENCE_THRESHOLD && delta.trackedPoints >= MIN_POINTS;
    
    if (hasGoodSignal) {
      motionStreak++;
    } else {
      motionStreak = 0;
      // Reset smoothing when signal is lost
      smoothedDelta = { panX: 0, panY: 0, scale: 1 };
    }

    // Only apply motion if we have at least one good frame (more responsive)
    if (hasGoodSignal && motionStreak >= 1) {
      // Apply deadzone to filter noise
      const panX = Math.abs(delta.deltaPanX) > MOTION_DEADZONE ? delta.deltaPanX : 0;
      const panY = Math.abs(delta.deltaPanY) > MOTION_DEADZONE ? delta.deltaPanY : 0;
      const scaleChange = Math.abs(delta.deltaScale - 1) > 0.002 ? delta.deltaScale : 1;
      
      // Strong exponential smoothing
      smoothedDelta.panX = smoothedDelta.panX * (1 - MOTION_SMOOTHING) + panX * MOTION_SMOOTHING;
      smoothedDelta.panY = smoothedDelta.panY * (1 - MOTION_SMOOTHING) + panY * MOTION_SMOOTHING;
      smoothedDelta.scale = smoothedDelta.scale * (1 - MOTION_SMOOTHING) + scaleChange * MOTION_SMOOTHING;

      // Apply rotation from optical flow (more stable than view cube)
      alignment.rotationX += delta.deltaRotX;
      alignment.rotationY += delta.deltaRotY;
      alignment.positionX += smoothedDelta.panX;
      alignment.positionY += smoothedDelta.panY;
      alignment.scale *= smoothedDelta.scale;

      broadcastAlignment();
    }
    
    lastConfidence = delta.confidence;
  });

  // View cube rotation updates — ABSOLUTE rotation
  // ViewCubeTracker applies axis mapping internally (Z-up → Y-up etc.)
  // and uses orthogonality-constrained reconstruction (best-2 axes + quadratic solve).
  // The returned rotationX/Y are already in the overlay's coordinate frame.
  cvTracker.on('viewCubeRotation', (result: ViewCubeResult) => {
    setupWindow?.win.webContents.send(IPC.VIEWCUBE_ROTATION, result);

    // Send raw detected axes directly to overlay — let the renderer build
    // the quaternion using the platform's proven approach (no Euler angles)
    if (result.confidence > 0.3 && result.axes) {
      try {
        if (overlayWindow?.win && !overlayWindow.win.isDestroyed()) {
          overlayWindow.win.webContents.send('viewcube:axes', {
            x: result.axes.x,
            y: result.axes.y,
            z: result.axes.z,
            confidence: result.confidence,
          });
        }
      } catch (_) {}
    }
  });

  cvTracker.on('modelPoseUpdate', (result: any) => {
    // Apply model pose to alignment when confidence is high enough
    if (result.confidence > 0.3 && result.cleanAxes) {
      alignment.viewCubeAxes = result.cleanAxes;
      // Model pose also provides pan and zoom
      if (Math.abs(result.panX) > 1) alignment.positionX = result.panX;
      if (Math.abs(result.panY) > 1) alignment.positionY = result.panY;
      if (result.zoom > 0.1) alignment.scale = result.zoom;
      broadcastAlignment();
      if (Math.random() < 0.1) {
        console.log(`[Main] ModelPose APPLIED: conf=${result.confidence.toFixed(2)} chamfer=${result.chamferScore.toFixed(1)}`);
      }
    }
  });

  cvTracker.on('modelPoseDatabaseStatus', (status: string) => {
    setupWindow?.win.webContents.send(IPC.MODELPOSE_STATUS, status);
  });

  cvTracker.on('status', (status: any) => {
    setupWindow?.win.webContents.send(IPC.TRACKING_STATUS, {
      ...status,
      isTracking,
    });
  });

  cvTracker.on('trackingLost', () => {
    console.log('[Main] Tracking lost — confidence dropped');
  });

  cvTracker.on('trackingRecovered', () => {
    console.log('[Main] Tracking recovered');
  });

  cvTracker.on('error', (err: Error) => {
    console.error('[Main] CVTracker error:', err);
  });

  // Wire up Desktop Switch Detector
  desktopSwitchDetector.on('desktopSwitch', () => {
    console.log('[Main] Desktop switch detected — collapsing setup, hiding overlay');
    setupWindow?.win.webContents.send(IPC.SETUP_COLLAPSE);
    overlayWindow?.hide();
    setTimeout(async () => {
      if (!cvTracker || !templateMatcher) return;

      const capture = await cvTracker.getCaptureManager().captureFullScreenGrayscale(activeDisplay?.id);
      if (!capture) {
        desktopSwitchDetector?.onNoMatch();
        return;
      }

      const result = templateMatcher.match(capture.data, capture.width, capture.height);
      if (result && result.confidence > 0.5) {
        const profile = calibrationStore?.get(result.profileId);
        if (profile) {
          alignment = { ...profile.alignment };
          broadcastAlignment();
          desktopSwitchDetector?.onMatchFound(result.profileId);
          console.log(`[Main] Desktop matched: ${profile.name} (confidence: ${result.confidence.toFixed(2)})`);
        }
      } else {
        desktopSwitchDetector?.onNoMatch();
        console.log('[Main] No desktop match found — manual alignment needed');
      }
    }, 500);
  });

  setupWindow.show();
  overlayWindow.show();

  setupIPC();

  console.log('[Main] Hanomi Overlay launched');
}

app.on('window-all-closed', () => {
  if (setupWindow || overlayWindow) {
    app.quit();
  }
});

app.on('before-quit', () => {
  cvTracker?.stop();
  overlayWindow?.destroy();
  setupWindow?.destroy();
});

// ── IPC Handlers ─────────────────────────────────────────────────────

function setupIPC() {
  // -- GLTF Loading --
  ipcMain.handle(IPC.GLTF_LOAD, async (_event, filePath?: string) => {
    let targetPath = filePath;

    if (!targetPath) {
      console.log('[Main] GLTF_LOAD: opening native dialog...');
      // Pause bridge frames during modal dialog — don't stop/restart
      // (stop + autoConnect spawns processes and floods the event loop)
      bridgePaused = true;

      try {
        const result = await dialog.showOpenDialog({
          title: 'Select GLTF/GLB File',
          defaultPath: app.getPath('desktop'),
          filters: [{ name: 'GLTF Files', extensions: ['gltf', 'glb'] }],
          properties: ['openFile'],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        targetPath = result.filePaths[0];
      } finally {
        bridgePaused = false;
      }
    }

    if (!targetPath || !fs.existsSync(targetPath)) {
      console.error('[Main] GLTF file not found:', targetPath);
      return null;
    }

    console.log('[Main] Loading GLTF:', targetPath);

    const fileUrl = `file://${targetPath}`;
    overlayWindow?.win.webContents.send(IPC.GLTF_DATA, {
      url: fileUrl,
      directory: path.dirname(targetPath),
      filename: path.basename(targetPath),
    });

    // Trigger model pose database generation in overlay renderer
    setTimeout(() => {
      overlayWindow?.win.webContents.send(IPC.MODELPOSE_GENERATE);
    }, 1000);  // Delay to let model load first

    setupWindow?.win.webContents.send(IPC.GLTF_DATA, {
      url: fileUrl,
      filename: path.basename(targetPath),
    });

    return { url: fileUrl, filename: path.basename(targetPath) };
  });

  // -- Window Listing --
  ipcMain.handle(IPC.WINDOWS_LIST, async (): Promise<WindowInfo[]> => {
    try {
      if (cvTracker) {
        return cvTracker.listWindows() as any;
      }
    } catch (e) {
      console.warn('[Main] Window listing failed:', e);
    }
    return [];
  });

  // -- Window Selection --
  ipcMain.on(IPC.WINDOWS_SELECT, (_event, region: ScreenRegion) => {
    selectedRegion = region;
    console.log('[Main] Selected tracking region:', region);
  });

  // -- ROI Definition --
  ipcMain.on(IPC.ROI_DEFINE, () => {
    console.log('[Main] ROI definition requested — expanding setup window for transparent drawing');

    // Hide overlay so it doesn't interfere with drawing
    if (overlayWindow && !overlayWindow.win.isDestroyed()) overlayWindow.hide();

    // Expand setup window to cover the entire work area (transparent background).
    // Use the display where the cursor currently is — this is where the CAD window is
    // on multi-monitor setups (not necessarily the primary display).
    if (setupWindow && !setupWindow.win.isDestroyed()) {
      const { screen } = require('electron');
      const cursorPos = screen.getCursorScreenPoint();
      const detectedDisplay = screen.getDisplayNearestPoint(cursorPos);
      activeDisplay = detectedDisplay;
      const workArea = detectedDisplay.workArea;
      console.log(`[Main] ROI definition on display id=${detectedDisplay.id} bounds=${JSON.stringify(detectedDisplay.bounds)}`);
      setupWindow.win.setBounds({
        x: workArea.x,
        y: workArea.y,
        width: workArea.width,
        height: workArea.height,
      });
      // Boost to highest always-on-top level so the drawing overlay sits above SolidWorks/Fusion.
      // Moving the window to a new display can cause it to lose z-order — moveTop() re-asserts it.
      setupWindow.win.setAlwaysOnTop(true, 'screen-saver');
      setupWindow.win.moveTop();
      setupWindow.win.focus();
      // Tell renderer to enter ROI drawing mode (no screenshot needed)
      setupWindow.win.webContents.send(IPC.ROI_SCREENSHOT, 'transparent');
    }
  });

  // -- ROI Regions Saved --
  ipcMain.on(IPC.ROI_REGIONS, (_event, regions: { viewCube: ScreenRegion; viewport: ScreenRegion }) => {
    // ROI coordinates are drawn in a window covering workArea (excluding menu bar).
    // Video capture starts at screen (0,0) including menu bar.
    // Convert workArea-relative coords → screen-absolute coords using the active display.
    const { screen: electronScreen } = require('electron');
    const display = activeDisplay || electronScreen.getPrimaryDisplay();
    const offsetX = display.workArea.x;  // Display left edge (non-zero for non-primary displays)
    const offsetY = display.workArea.y;  // Menu bar height on macOS (~25px), or display top offset

    viewCubeRegion = {
      ...regions.viewCube,
      x: regions.viewCube.x + offsetX,
      y: regions.viewCube.y + offsetY,
    };
    viewportRegion = {
      ...regions.viewport,
      x: regions.viewport.x + offsetX,
      y: regions.viewport.y + offsetY,
    };
    console.log(`[Main] ROI regions saved (offset +${offsetX},+${offsetY}, display id=${display.id}):`, JSON.stringify({ viewCube: viewCubeRegion, viewport: viewportRegion }));

    // Restore setup window to the top-right corner of the active display
    if (setupWindow && !setupWindow.win.isDestroyed()) {
      const PANEL_WIDTH = 300;
      const PANEL_HEIGHT = 640;
      setupWindow.win.setBounds({
        x: display.bounds.x + display.workAreaSize.width - PANEL_WIDTH - 16,
        y: display.bounds.y + 16,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
      }, true);
      // Restore normal always-on-top level (was boosted to screen-saver during ROI drawing)
      setupWindow.win.setAlwaysOnTop(true, 'screen-saver');
    }

    // Show overlay window back (was hidden during ROI definition)
    if (overlayWindow && !overlayWindow.win.isDestroyed()) {
      overlayWindow.show();
    }
  });

  // -- ROI Cancel (restore windows without saving) --
  ipcMain.on(IPC.ROI_CANCEL, () => {
    console.log('[Main] ROI definition cancelled — restoring windows');

    // Restore setup window to the top-right corner of the active display (or primary)
    if (setupWindow && !setupWindow.win.isDestroyed()) {
      const { screen } = require('electron');
      const display = activeDisplay || screen.getPrimaryDisplay();
      const PANEL_WIDTH = 300;
      const PANEL_HEIGHT = 640;
      setupWindow.win.setBounds({
        x: display.bounds.x + display.workAreaSize.width - PANEL_WIDTH - 16,
        y: display.bounds.y + 16,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
      }, true);
      // Restore normal always-on-top level (was boosted to screen-saver during ROI drawing)
      setupWindow.win.setAlwaysOnTop(true, 'screen-saver');
    }

    // Show overlay window back
    if (overlayWindow && !overlayWindow.win.isDestroyed()) {
      overlayWindow.show();
    }

    // Clear verification overlay
    overlayWindow?.win.webContents.send(IPC.ROI_VERIFY, null);
  });

  // -- ROI Verify (show mask overlay) --
  // ROI coords from setup are workArea-relative. Overlay window starts at screen (0,0).
  // Must add workArea offset so verify rectangles display at the correct screen position.
  // Use activeDisplay (set when ROI drawing started) — same display the user drew on.
  ipcMain.on(IPC.ROI_VERIFY, (_event, regions: { viewCube: ScreenRegion; viewport: ScreenRegion } | null) => {
    if (regions) {
      const { screen: electronScreen } = require('electron');
      const display = activeDisplay || electronScreen.getPrimaryDisplay();
      const offsetX = display.workArea.x;
      const offsetY = display.workArea.y;
      const adjusted = {
        viewCube: { ...regions.viewCube, x: regions.viewCube.x + offsetX, y: regions.viewCube.y + offsetY },
        viewport: { ...regions.viewport, x: regions.viewport.x + offsetX, y: regions.viewport.y + offsetY },
      };
      overlayWindow?.win.webContents.send(IPC.ROI_VERIFY, adjusted);
    } else {
      overlayWindow?.win.webContents.send(IPC.ROI_VERIFY, null);
    }
  });

  // -- Tracking Start/Stop --
  ipcMain.on(IPC.TRACKING_START, async () => {
    if (!selectedRegion) {
      selectedRegion = { x: 0, y: 0, width: 1920, height: 1080, windowName: 'Full Screen' };
      console.log('[Main] No region selected — using full screen');
    }

    const hasDualMask = viewCubeRegion !== null && viewportRegion !== null;
    isTracking = true;
    
    // Reset smoothing buffer on start
    smoothedDelta = { panX: 0, panY: 0, scale: 1 };
    motionStreak = 0;

    // Fix D: Check if setup window overlaps the view cube ROI.
    // If it does, reposition setup window to avoid corrupting the view cube capture.
    if (hasDualMask && viewCubeRegion && setupWindow) {
      const setupBounds = setupWindow.win.getBounds();
      const vc = viewCubeRegion;
      const overlaps = !(setupBounds.x + setupBounds.width < vc.x ||
                         setupBounds.x > vc.x + vc.width ||
                         setupBounds.y + setupBounds.height < vc.y ||
                         setupBounds.y > vc.y + vc.height);
      if (overlaps) {
        // Move setup window to the opposite horizontal side of the screen
        const newX = vc.x > setupBounds.width + 40
          ? 20  // View cube is on right → move setup to left
          : setupBounds.x; // Keep position if no overlap fix needed
        if (newX !== setupBounds.x) {
          setupWindow.win.setBounds({ ...setupBounds, x: newX });
          console.log(`[Main] Setup window repositioned to x=${newX} to avoid view cube ROI overlap`);
        } else {
          // Collapse instead if we can't reposition
          setupWindow.win.webContents.send(IPC.SETUP_COLLAPSE, true);
          console.log('[Main] Setup window collapsed to avoid view cube ROI overlap');
        }
      }
    }

    // Move overlay to the display where the CAD window is before showing it.
    // If CAD is on monitor 2, the overlay must cover that display — not the primary.
    if (overlayWindow) {
      const { screen: electronScreen } = require('electron');
      const primary = electronScreen.getPrimaryDisplay();
      
      // If activeDisplay wasn't set (user skipped ROI definition), detect from SolidWorks window position
      if (!activeDisplay) {
        // First try to find SolidWorks window
        const allWindows = await cvTracker?.listWindows() || [];
        const swWindow = allWindows.find(w => 
          w.name.toLowerCase().includes('solidworks') || 
          w.name.toLowerCase().includes('sldworks')
        );
        
        if (swWindow && swWindow.bounds) {
          // Find display containing the SolidWorks window
          const swCenterX = swWindow.bounds.x + swWindow.bounds.width / 2;
          const swCenterY = swWindow.bounds.y + swWindow.bounds.height / 2;
          const foundDisplay = electronScreen.getDisplayNearestPoint({ x: swCenterX, y: swCenterY });
          activeDisplay = foundDisplay;
          console.log(`[Main] Found SolidWorks on display id=${foundDisplay.id}`);
        } else {
          // Fallback: try cursor position
          const cursorPos = electronScreen.getCursorScreenPoint();
          const cursorDisplay = electronScreen.getDisplayNearestPoint(cursorPos);
          activeDisplay = cursorDisplay;
          
          // If only 2 displays and cursor is on primary, assume CAD is on secondary
          const allDisplays = electronScreen.getAllDisplays();
          if (allDisplays.length > 1 && cursorDisplay.id === primary.id) {
            const nonPrimary = allDisplays.find((d: Electron.Display) => d.id !== primary.id);
            if (nonPrimary) {
              activeDisplay = nonPrimary;
              console.log(`[Main] Multi-monitor: defaulting to non-primary display id=${nonPrimary.id}`);
            }
          }
        }
      }
      
      if (activeDisplay) {
        console.log(`[Main] Using display: id=${activeDisplay.id} bounds=${JSON.stringify(activeDisplay.bounds)}`);
        if (activeDisplay.id !== primary.id) {
          console.log(`[Main] Moving overlay to display id=${activeDisplay.id}`);
          overlayWindow.moveToDisplay(activeDisplay);
        }
      }
    }

    // Get a screen source ID for the renderer to open a video stream.
    // On multi-monitor setups, pick the source matching the display where the ROI was drawn.
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (sources.length > 0) {
        let chosenSource = sources[0]; // fallback

        if (activeDisplay && sources.length > 1) {
          const { screen: electronScreen } = require('electron');
          const allDisplays = electronScreen.getAllDisplays();
          const displayId = activeDisplay.id;

          // Try matching by display_id (works on Windows and macOS)
          const byId = sources.find(s => s.display_id === String(displayId));
          if (byId) {
            chosenSource = byId;
            console.log(`[Main] Matched screen source by display_id=${displayId}`);
          } else {
            // Fallback: match by index in display list (both APIs enumerate in the same order)
            const displayIndex = allDisplays.findIndex((d: Electron.Display) => d.id === displayId);
            if (displayIndex >= 0 && displayIndex < sources.length) {
              chosenSource = sources[displayIndex];
              console.log(`[Main] Matched screen source by display index=${displayIndex}`);
            } else {
              console.warn(`[Main] Could not match display id=${displayId} to a source — using sources[0]`);
            }
          }
        }

        const sourceId = chosenSource.id;
        console.log(`[Main] Sending CAPTURE_START to renderer with sourceId: ${sourceId}, dual-mask: ${hasDualMask}`);

        // Start video capture FIRST, then start tracking after a brief delay
        if (hasDualMask) {
          // Send regions + active display bounds so renderer can subtract the display origin.
          // ROI coords are absolute screen coords; video captures only the target display (0,0 origin).
          setupWindow?.win.webContents.send(IPC.CAPTURE_START, sourceId, {
            viewCube: viewCubeRegion,
            viewport: viewportRegion,
          }, activeDisplay?.bounds ?? null);
        } else {
          setupWindow?.win.webContents.send(IPC.CAPTURE_START, sourceId);
        }

        // Give renderer time to start capture before processing frames
        const region = selectedRegion || { x: 0, y: 0, width: 1920, height: 1080, windowName: 'Full Screen' };
        
        // Set initial position based on viewport ROI - this is critical!
        // The viewportRegion tells us exactly where the model is on screen
        if (viewportRegion && overlayWindow) {
          const { screen } = require('electron');
          const display = activeDisplay || screen.getPrimaryDisplay();
          
          // Calculate viewport center relative to overlay window center
          // viewportRegion is in screen coordinates
          // overlay should be positioned so model appears at center
          const vpCenterX = viewportRegion.x + viewportRegion.width / 2;
          const vpCenterY = viewportRegion.y + viewportRegion.height / 2;
          const overlayCenterX = display.bounds.x + display.bounds.width / 2;
          const overlayCenterY = display.bounds.y + display.bounds.height / 2;
          
          // Set initial alignment to match viewport position
          alignment.positionX = vpCenterX - overlayCenterX;
          alignment.positionY = vpCenterY - overlayCenterY;
          
          console.log(`[Main] Initial position set from ROI: (${alignment.positionX.toFixed(0)}, ${alignment.positionY.toFixed(0)})`);
          broadcastAlignment();
        }
        
        setTimeout(() => {
          cvTracker?.start(region, hasDualMask);
          // Load cached pose database if available
          if (cachedPoseDescriptors && cvTracker?.getModelPoseTracker()) {
            console.log(`[Main] Loading cached pose database: ${cachedPoseDescriptors.length} descriptors`);
            cvTracker.getModelPoseTracker()!.loadDatabase(cachedPoseDescriptors);
          }
          broadcastTrackingStatus();
          // Show overlay so silhouette aligner can receive frames and render
          if (overlayWindow) {
            overlayWindow.show();
            overlayWindow.win.moveTop();
          }
          console.log(`[Main] Tracking started (${hasDualMask ? 'dual-mask' : 'legacy push-based'})`);
        }, 500);
      } else {
        console.warn('[Main] No screen sources found for capture stream');
        // Still start tracker - it will just not receive frames
        cvTracker?.start(selectedRegion, hasDualMask);
        broadcastTrackingStatus();
      }
    } catch (err) {
      console.error('[Main] Failed to get screen sources:', err);
      cvTracker?.start(selectedRegion, hasDualMask);
      broadcastTrackingStatus();
    }

    // Hide mask verification overlay when tracking starts
    overlayWindow?.win.webContents.send(IPC.ROI_VERIFY, null);
  });

  ipcMain.on(IPC.TRACKING_STOP, () => {
    isTracking = false;
    cvTracker?.stop();
    setupWindow?.win.webContents.send(IPC.CAPTURE_STOP);
    broadcastTrackingStatus();
    // Reset smoothing buffer
    smoothedDelta = { panX: 0, panY: 0, scale: 1 };
    motionStreak = 0;
    console.log('[Main] Tracking stopped');
  });

  // -- Capture Frames --

  // Legacy full-screen frame
  ipcMain.on(IPC.CAPTURE_FRAME, (_event, dataBuffer: ArrayBuffer | Buffer, width: number, height: number) => {
    cvTracker?.pushFrame(dataBuffer, width, height);
  });

  // Dual-mask: view cube RGBA frame
  ipcMain.on(IPC.CAPTURE_VIEWCUBE_FRAME, (_event, rgbaBuffer: ArrayBuffer | Buffer, width: number, height: number) => {
    cvTracker?.pushViewCubeFrame(rgbaBuffer, width, height);
  });

  // Dual-mask: viewport grayscale frame
  let vpFrameCount = 0;
  ipcMain.on(IPC.CAPTURE_VIEWPORT_FRAME, (_event, dataBuffer: ArrayBuffer | Buffer, width: number, height: number) => {
    cvTracker?.pushViewportFrame(dataBuffer, width, height);

    // Alignment scoring: measure how well overlay matches viewport
    if (alignmentScorer) {
      const gray = new Uint8Array(Buffer.isBuffer(dataBuffer) ? dataBuffer : Buffer.from(dataBuffer as ArrayBuffer));
      const score = alignmentScorer.score(gray, width, height);
      if (score) {
        try {
          if (setupWindow?.win && !setupWindow.win.isDestroyed()) {
            setupWindow.win.webContents.send('alignment:score', score);
          }
        } catch (_) {}
        if (vpFrameCount % 100 === 0) {
          console.log(`[AlignmentScore] ${score.grade.toUpperCase()} — overlap=${score.overlapPercent}% dist=${score.meanDistance}px offset=(${score.offsetX},${score.offsetY}) ${score.latencyMs}ms`);
        }
      }
    }

    // Silhouette matching: every 10th frame, match viewport against database
    vpFrameCount++;
    if (vpFrameCount % 10 === 0 && silhouetteDB.length > 0) {
      const gray = new Uint8Array(Buffer.isBuffer(dataBuffer) ? dataBuffer : Buffer.from(dataBuffer as ArrayBuffer));
      const S = silhouetteRenderSize;
      const ds = silhouetteDownsample(gray, width, height, S, S);

      // Background subtraction: SolidWorks has a light gray gradient background.
      // Sample corners to detect background color, then threshold to isolate the part.
      const corners = [ds[0], ds[S-1], ds[(S-1)*S], ds[(S-1)*S+S-1]];
      const bgMean = (corners[0] + corners[1] + corners[2] + corners[3]) / 4;

      // Create part mask: pixels significantly darker than background = part
      const partMask = new Uint8Array(S * S);
      for (let i = 0; i < S * S; i++) {
        partMask[i] = Math.abs(ds[i] - bgMean) > 15 ? 255 : 0;
      }

      // Extract edges only from the part mask (not from SolidWorks UI)
      const vpEdges = silhouetteSobel(partMask, S, S);
      const vpDT = silhouetteDT(vpEdges, S, S);

      let bestScore = Infinity;
      let bestIdx = -1;
      for (let i = 0; i < silhouetteDB.length; i++) {
        const score = silhouetteScore(silhouetteDB[i].edgePixels, vpDT, S, S);
        if (score < bestScore) { bestScore = score; bestIdx = i; }
      }

      // Log best score every 50 frames regardless of threshold
      if (vpFrameCount % 50 === 0) {
        console.log(`[SilhouetteMatch] Best score=${bestScore.toFixed(1)} idx=${bestIdx}/${silhouetteDB.length}`);
      }

      if (bestIdx >= 0 && bestScore < 50) {  // Raised threshold to 50 for testing
        const best = silhouetteDB[bestIdx];
        // Send matched quaternion + camera vectors to overlay for rendering
        const matchData = {
          qx: best.qx, qy: best.qy, qz: best.qz, qw: best.qw,
          right: best.right, up: best.up, forward: best.forward,
          score: bestScore,
        };
        try {
          if (overlayWindow?.win && !overlayWindow.win.isDestroyed()) {
            overlayWindow.win.webContents.send('silhouette:match', matchData);
          }
        } catch (_) {}

        if (vpFrameCount % 50 === 0) {
          console.log(`[SilhouetteMatch] score=${bestScore.toFixed(1)} idx=${bestIdx}/${silhouetteDB.length}`);
        }
      }
    }

    // Edge snap: compare overlay edges with viewport edges
    if (edgeSnap) {
      const result = edgeSnap.processViewportFrame(new Uint8Array(dataBuffer as ArrayBuffer), width, height);
      if (result && result.score < 20 && (Math.abs(result.deltaX) > 1 || Math.abs(result.deltaY) > 1)) {
        // Apply correction gradually (50%) to avoid oscillation
        const factor = result.score < 5 ? 0.8 : 0.5;
        alignment.positionX += result.deltaX * factor;
        alignment.positionY += result.deltaY * factor;
        broadcastAlignment();
        if (Math.abs(result.deltaX) > 3 || Math.abs(result.deltaY) > 3) {
          console.log(`[EdgeSnap] dx=${result.deltaX.toFixed(0)} dy=${result.deltaY.toFixed(0)} score=${result.score.toFixed(1)} ${result.latencyMs}ms`);
        }
      }
    }
  });

  // Edge snap: receive overlay edge snapshot from overlay renderer
  ipcMain.on(IPC.EDGESNAP_OVERLAY_EDGES, (_event, buffer: ArrayBuffer | Buffer, width: number, height: number) => {
    if (!edgeSnap) {
      edgeSnap = new EdgeSnap();
      console.log('[Main] EdgeSnap initialized');
    }
    edgeSnap.setOverlaySnapshot(new Uint8Array(buffer as ArrayBuffer), width, height);

    // Also feed to alignment scorer
    if (!alignmentScorer) {
      alignmentScorer = new AlignmentScorer();
      console.log('[Main] AlignmentScorer initialized');
    }
    alignmentScorer.setOverlayEdges(new Uint8Array(buffer as ArrayBuffer), width, height);
  });

  // -- Quit --
  ipcMain.on('app:quit', () => { app.quit(); });

  // Hide/show overlay during drag-and-drop (overlay at screen-saver level blocks drag events)
  ipcMain.on('overlay:hide-for-drag', (_event, hide: boolean) => {
    if (!overlayWindow?.win || overlayWindow.win.isDestroyed()) return;
    if (hide) {
      overlayWindow.win.hide();
    } else {
      overlayWindow.show();
    }
  });

  // -- Alignment --
  ipcMain.on(IPC.ALIGNMENT_RESET, () => {
    alignment = {
      positionX: 0, positionY: 0, positionZ: 0,
      rotationX: 0, rotationY: 0, rotationZ: 0,
      scale: 1,
      viewCubeAxes: null,
    };
    broadcastAlignment();
  });

  ipcMain.on(IPC.ALIGNMENT_NUDGE, (_event, nudge: Partial<AlignmentState>) => {
    if (nudge.positionX !== undefined) alignment.positionX += nudge.positionX;
    if (nudge.positionY !== undefined) alignment.positionY += nudge.positionY;
    if (nudge.positionZ !== undefined) alignment.positionZ += nudge.positionZ;
    if (nudge.rotationX !== undefined) alignment.rotationX += nudge.rotationX;
    if (nudge.rotationY !== undefined) alignment.rotationY += nudge.rotationY;
    if (nudge.rotationZ !== undefined) alignment.rotationZ += nudge.rotationZ;
    if (nudge.scale !== undefined) alignment.scale *= nudge.scale;
    broadcastAlignment();
  });

  // -- Axis Mapping --
  ipcMain.on(IPC.AXIS_MAPPING, (_event, mapping: AxisMapping) => {
    axisMapping = mapping;
    // Forward to ViewCubeTracker — mapping is applied BEFORE rotation reconstruction
    cvTracker?.getViewCubeTracker()?.setAxisMapping(mapping);
    console.log(`[Main] Axis mapping: X=${mapping.x} Y=${mapping.y} Z=${mapping.z}`);
  });

  // -- Calibration Sync (one-click offset) --
  ipcMain.on(IPC.CALIBRATION_SYNC, () => {
    // Compute offset from current alignment vs last view cube reading
    // The offset compensates for GLTF export orientation ≠ CAD display orientation
    const lastVC = cvTracker?.getLastVCResult?.();
    if (lastVC) {
      rotationOffsetX = alignment.rotationX - lastVC.rotationX;
      rotationOffsetY = alignment.rotationY - lastVC.rotationY;
      console.log(`[Main] Calibration sync: offsetX=${rotationOffsetX.toFixed(1)} offsetY=${rotationOffsetY.toFixed(1)}`);
    } else {
      console.log('[Main] Calibration sync: no view cube reading available');
    }
  });

  // -- Overlay Toggle --
  ipcMain.on(IPC.OVERLAY_TOGGLE, (_event, visible: boolean) => {
    if (visible) {
      overlayWindow?.show();
    } else {
      overlayWindow?.hide();
    }
  });

  // -- Annotate Mode --
  ipcMain.on(IPC.OVERLAY_ANNOTATE_MODE, (_event, enabled: boolean) => {
    overlayWindow?.setClickThrough(!enabled);
  });

  // -- Align Mode --
  // The overlay is ALWAYS click-through — we never disable setIgnoreMouseEvents.
  // Drag-to-align is handled inside the setup panel's drag pad so the full-screen
  // overlay never blocks user input.
  ipcMain.on(IPC.OVERLAY_ALIGN_MODE, (_event, enabled: boolean) => {
    overlayWindow?.win.webContents.send(IPC.OVERLAY_ALIGN_MODE, enabled);
  });

  // -- SolidWorks COM Bridge --
  ipcMain.on(IPC.SW_BRIDGE_START, () => {
    if (swBridge) {
      swBridge.stop();
      swBridge = null;
    }

    swBridge = new SWBridgeReceiver();
    swBridge.start(
      // Called ~60fps with exact SolidWorks camera data
      (frame) => {
        try { if (overlayWindow?.win && !overlayWindow.win.isDestroyed()) overlayWindow.win.webContents.send(IPC.SW_CAMERA_UPDATE, frame); } catch (_) {}
      },
      // Called when bridge status changes
      (status, detail) => {
        console.log(`[Main] SW Bridge status: ${status}${detail ? ' — ' + detail : ''}`);
        try { if (setupWindow?.win && !setupWindow.win.isDestroyed()) setupWindow.win.webContents.send(IPC.SW_BRIDGE_STATUS, status, detail ?? ''); } catch (_) {}
        try { if (overlayWindow?.win && !overlayWindow.win.isDestroyed()) overlayWindow.win.webContents.send(IPC.SW_BRIDGE_STATUS, status, detail ?? ''); } catch (_) {}
        if (status === 'live') {
          overlayWindow?.show();

          // Auto-position overlay at the center of the SolidWorks CAD viewport.
          // positionX/Y are pixel offsets from the overlay window center.
          let initialPosX = 0, initialPosY = 0;
          if (viewportRegion) {
            const { screen: electronScreen } = require('electron');
            const display = activeDisplay || electronScreen.getPrimaryDisplay();
            // Viewport center in display-relative pixels
            const vpCx = (viewportRegion.x - display.bounds.x) + viewportRegion.width  / 2;
            const vpCy = (viewportRegion.y - display.bounds.y) + viewportRegion.height / 2;
            // Offset from overlay window center
            initialPosX = vpCx - display.bounds.width  / 2;
            initialPosY = vpCy - display.bounds.height / 2;
            console.log(`[Main] SW Bridge live — auto-centering overlay on CAD viewport: pos(${initialPosX.toFixed(0)}, ${initialPosY.toFixed(0)})`);
          }

          console.log(`[Main] SW Bridge live → pos=(${initialPosX.toFixed(0)},${initialPosY.toFixed(0)}) vpRegion=${JSON.stringify(viewportRegion)}`);
          alignment = {
            positionX: initialPosX, positionY: initialPosY, positionZ: 0,
            rotationX: 0, rotationY: 0, rotationZ: 0,
            scale: 1,
          };
          broadcastAlignment();
        }
      },
    );
  });

  ipcMain.on(IPC.SW_BRIDGE_STOP, () => {
    swBridge?.stop();
    swBridge = null;
    setupWindow?.win.webContents.send(IPC.SW_BRIDGE_STATUS, 'stopped', '');
  });

  // -- Model Pose Database --
  // Cache model pose descriptors so they're available when tracking starts later
  let cachedPoseDescriptors: any[] | null = null;

  ipcMain.on(IPC.MODELPOSE_DATABASE, (_event, descriptors: any[]) => {
    console.log(`[Main] Received model pose database: ${descriptors.length} descriptors`);
    cachedPoseDescriptors = descriptors;
    // Load into tracker if it's running
    if (cvTracker?.getModelPoseTracker()) {
      cvTracker.getModelPoseTracker()!.loadDatabase(descriptors);
    }
    setupWindow?.win.webContents.send(IPC.MODELPOSE_STATUS, 'ready');
  });

  // -- Silhouette Alignment Database (from overlay renderer) --
  let silhouetteDB: { edgePixels: Uint8Array; qx: number; qy: number; qz: number; qw: number; right: number[]; up: number[]; forward: number[] }[] = [];
  let silhouetteRenderSize = 100;
  let silhouetteFrameCount = 0;

  ipcMain.on('silhouette:database', (_event, entries: any[], renderSize: number) => {
    silhouetteRenderSize = renderSize;
    silhouetteDB = entries.map((e: any) => ({
      edgePixels: new Uint8Array(e.edgePixels),
      qx: e.qx, qy: e.qy, qz: e.qz, qw: e.qw,
      right: e.right, up: e.up, forward: e.forward,
    }));
    console.log(`[Main] Silhouette database received: ${silhouetteDB.length} entries, ${renderSize}px`);
  });

  // Silhouette matching helper functions (inline for simplicity)
  function silhouetteSobel(gray: Uint8Array, w: number, h: number): Uint8Array {
    const edges = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = -gray[i-w-1]+gray[i-w+1]-2*gray[i-1]+2*gray[i+1]-gray[i+w-1]+gray[i+w+1];
        const gy = -gray[i-w-1]-2*gray[i-w]-gray[i-w+1]+gray[i+w-1]+2*gray[i+w]+gray[i+w+1];
        edges[i] = (gx*gx+gy*gy > 400) ? 255 : 0; // threshold=20 (low — part mask is already clean)
      }
    }
    return edges;
  }

  function silhouetteDT(edges: Uint8Array, w: number, h: number): Float32Array {
    const dt = new Float32Array(w * h);
    const INF = w + h;
    for (let i = 0; i < w*h; i++) dt[i] = edges[i] > 0 ? 0 : INF;
    for (let y = 1; y < h; y++) {
      for (let x = 1; x < w; x++) { const i=y*w+x; dt[i]=Math.min(dt[i],dt[i-1]+1,dt[i-w]+1); }
      for (let x = w-2; x >= 0; x--) { dt[y*w+x]=Math.min(dt[y*w+x],dt[y*w+x+1]+1); }
    }
    for (let y = h-2; y >= 0; y--) {
      for (let x = w-2; x >= 0; x--) { const i=y*w+x; dt[i]=Math.min(dt[i],dt[i+1]+1,dt[i+w]+1); }
      for (let x = 1; x < w; x++) { dt[y*w+x]=Math.min(dt[y*w+x],dt[y*w+x-1]+1); }
    }
    return dt;
  }

  function silhouetteScore(overlayEdges: Uint8Array, vpDT: Float32Array, w: number, h: number): number {
    let total = 0, count = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        if (overlayEdges[y*w+x] === 0) continue;
        total += vpDT[y*w+x];
        count++;
      }
    }
    return count > 10 ? total / count : Infinity;
  }

  function silhouetteDownsample(src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Uint8Array {
    const dst = new Uint8Array(dstW * dstH);
    const sx = srcW/dstW, sy = srcH/dstH;
    for (let y = 0; y < dstH; y++)
      for (let x = 0; x < dstW; x++)
        dst[y*dstW+x] = src[Math.floor(y*sy)*srcW+Math.floor(x*sx)];
    return dst;
  }

  // -- Setup Panel Resize --
  ipcMain.on(IPC.SETUP_RESIZE, (_event, size: { width: number; height: number }) => {
    if (setupWindow && !setupWindow.win.isDestroyed()) {
      const bounds = setupWindow.win.getBounds();
      setupWindow.win.setBounds({
        x: bounds.x + bounds.width - size.width,  // keep right edge fixed
        y: bounds.y,
        width: size.width,
        height: size.height,
      }, true); // animate
    }
  });

  // -- Calibration --
  ipcMain.handle(IPC.CALIBRATION_SAVE, async (_event, name: string) => {
    if (!calibrationStore || !cvTracker) return null;

    let screenshotBase64 = '';
    const capture = await cvTracker.getCaptureManager().captureFullScreenGrayscale(activeDisplay?.id);
    if (capture) {
      screenshotBase64 = Buffer.from(capture.data).toString('base64');
    }

    const profile = calibrationStore.save({
      name,
      windowName: selectedRegion?.windowName || 'Unknown',
      trackingRegion: selectedRegion || { x: 0, y: 0, width: 1920, height: 1080 },
      viewCubeRegion: viewCubeRegion || undefined,
      viewportRegion: viewportRegion || undefined,
      alignment: { ...alignment },
      referenceScreenshot: screenshotBase64,
    });

    if (capture) {
      templateMatcher?.addTemplate(profile.id, capture.data, capture.width, capture.height);
    }

    return profile;
  });

  ipcMain.handle(IPC.CALIBRATION_LIST, async () => {
    return calibrationStore?.list() || [];
  });

  ipcMain.handle(IPC.CALIBRATION_DELETE, async (_event, id: string) => {
    templateMatcher?.removeTemplate(id);
    return calibrationStore?.delete(id) || false;
  });

  ipcMain.on(IPC.CALIBRATION_APPLY, (_event, id: string) => {
    const profile = calibrationStore?.get(id);
    if (profile) {
      alignment = { ...profile.alignment };
      selectedRegion = profile.trackingRegion;
      // Restore ROI regions from profile
      if (profile.viewCubeRegion) viewCubeRegion = profile.viewCubeRegion;
      if (profile.viewportRegion) viewportRegion = profile.viewportRegion;
      broadcastAlignment();
      console.log(`[Main] Applied calibration profile: ${profile.name}`);
    }
  });

  // -- CAD Bridge Manual Control --
  ipcMain.on('bridge:connect', async () => {
    if (bridgeManager) {
      bridgeManager.stop();
      const detected = await bridgeManager.autoConnect();
      if (detected) console.log(`[Main] Bridge reconnected: ${detected.name}`);
    }
  });

  ipcMain.on('bridge:disconnect', () => {
    bridgeManager?.stop();
    bridgeLive = false;
    console.log('[Main] Bridge disconnected');
  });

  // -- Review Session --
  ipcMain.on(IPC.REVIEW_START, () => {
    if (reviewSession) reviewSession.stop();
    reviewSession = new ReviewSession();
    // Show overlay window so vendor annotations are visible
    if (overlayWindow) {
      overlayWindow.show();
      overlayWindow.win.moveTop();
    }
    reviewSession.start(setupWindow!.win, overlayWindow?.win || null);
    console.log('[Main] Review session started');
  });

  ipcMain.on(IPC.REVIEW_STOP, () => {
    reviewSession?.stop();
    reviewSession = null;
    console.log('[Main] Review session stopped');
  });

  ipcMain.on(IPC.REVIEW_CONTROL_GRANT, () => {
    reviewSession?.grantControl();
  });

  ipcMain.on(IPC.REVIEW_CONTROL_DENY, () => {
    reviewSession?.denyControl();
  });

  ipcMain.on(IPC.REVIEW_CONTROL_REVOKE, () => {
    reviewSession?.revokeControl();
  });

  ipcMain.on(IPC.REVIEW_CHAT_SEND, (_event, text: string) => {
    reviewSession?.sendChat(text);
  });

  // Relay WebRTC signaling from renderer to server
  ipcMain.on('signal:offer', (_event, data: any) => {
    console.log('[Main] Relaying signal:offer to server');
    reviewSession?.relaySignal('signal:offer', data);
  });
  ipcMain.on('signal:answer', (_event, data: any) => {
    console.log('[Main] Relaying signal:answer to server');
    reviewSession?.relaySignal('signal:answer', data);
  });
  ipcMain.on('signal:ice', (_event, data: any) => {
    reviewSession?.relaySignal('signal:ice', data);
  });
}

// ── Broadcast Helpers ────────────────────────────────────────────────

function broadcastAlignment() {
  const alignmentWithViewport = {
    ...alignment,
    viewportWidth: viewportRegion?.width ?? 1920,
    viewportHeight: viewportRegion?.height ?? 1080,
  };
  // Throttle logging to avoid spam
  if (Math.random() < 0.02) {
    console.log(`[Main] broadcastAlignment: rot(${alignment.rotationX.toFixed(1)},${alignment.rotationY.toFixed(1)}) pos(${alignment.positionX.toFixed(1)},${alignment.positionY.toFixed(1)}) scale=${alignment.scale.toFixed(3)} vp=${alignmentWithViewport.viewportWidth}x${alignmentWithViewport.viewportHeight}`);
  }
  try { if (overlayWindow?.win && !overlayWindow.win.isDestroyed()) overlayWindow.win.webContents.send(IPC.ALIGNMENT_UPDATE, alignmentWithViewport); } catch (_) {}
  try { if (setupWindow?.win && !setupWindow.win.isDestroyed()) setupWindow.win.webContents.send(IPC.ALIGNMENT_UPDATE, alignmentWithViewport); } catch (_) {}
}

function broadcastTrackingStatus() {
  const status = cvTracker?.getStatus() || {
    fps: 0,
    trackedPoints: 0,
    confidence: 0,
    isTracking,
    captureRegion: null,
  };
  setupWindow?.win.webContents.send(IPC.TRACKING_STATUS, {
    ...status,
    isTracking,
  });
}

// ── Exports for other modules ────────────────────────────────────────

export function getAlignment() { return alignment; }
export function setAlignment(a: AlignmentState) {
  alignment = a;
  broadcastAlignment();
}

// ── HTTP Annotation Server (receives annotations from platform) ──────

const ANNOTATION_PORT = 3456;

const annotationServer = http.createServer((req, res) => {
  // CORS headers for platform
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/annotations') {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try {
        const annotation = JSON.parse(body);
        console.log('[AnnotationServer] Received:', annotation.text || annotation.id, '| overlayWindow:', !!overlayWindow?.win);
        // Forward to overlay renderer
        if (overlayWindow?.win && !overlayWindow.win.isDestroyed()) {
          overlayWindow.win.webContents.send('platform:annotation', annotation);
          console.log('[AnnotationServer] Forwarded to overlay renderer');
        } else {
          console.log('[AnnotationServer] No overlay window — annotation dropped!');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/annotations/delete') {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        if (overlayWindow?.win && !overlayWindow.win.isDestroyed()) {
          overlayWindow.win.webContents.send('platform:annotation-delete', id);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

annotationServer.listen(ANNOTATION_PORT, '127.0.0.1', () => {
  console.log(`[AnnotationServer] Listening on http://127.0.0.1:${ANNOTATION_PORT}`);
});
