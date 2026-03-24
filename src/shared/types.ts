// ── Alignment & Tracking ─────────────────────────────────────────────

export interface AlignmentState {
  positionX: number;
  positionY: number;
  positionZ: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  scale: number;
  viewCubeAxes?: ViewCubeAxes | null;  // Raw detected axes for direct camera control
  axisMapping?: AxisMapping | null;   // Coordinate system mapping (e.g., Z-up → Y-up)
  viewportWidth?: number;   // Actual CAD viewport width in pixels (from ROI)
  viewportHeight?: number;  // Actual CAD viewport height in pixels (from ROI)
}

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  windowName?: string;
  sourceId?: string;
}

export interface WindowInfo {
  id: number;
  name: string;
  ownerName: string;
  bounds: { x: number; y: number; width: number; height: number };
  thumbnail?: string; // base64
}

export interface CVTrackingStatus {
  fps: number;
  trackedPoints: number;
  confidence: number;
  isTracking: boolean;
  frameDiff?: number; // Sum of absolute pixel differences between consecutive frames
}

// ── Overlay Settings ─────────────────────────────────────────────────

export interface OverlaySettings {
  opacity: number;
  edgeColor: string;
  showFaces: boolean;
  faceOpacity: number;
}

// ── Annotations ──────────────────────────────────────────────────────

export interface Annotation {
  id: string;
  worldPoint: { x: number; y: number; z: number };
  worldNormal: { x: number; y: number; z: number };
  text: string;
  createdAt: number;
}

// ── View Cube Tracking ──────────────────────────────────────────────

export interface ViewCubeAxes {
  x: [number, number] | null;  // 2D direction vector (normalized to [-1,1])
  y: [number, number] | null;
  z: [number, number] | null;
  pixelCounts: Record<string, number>;
  confidence: number;          // 0-1
  detectedAxes: number;        // how many axes found (0-3)
  strategy: 'color' | 'cube' | 'edges' | 'model';
}

export interface ViewCubeResult {
  rotationX: number;  // degrees — absolute, not delta
  rotationY: number;
  rotationZ: number;
  confidence: number;
  strategy: 'color' | 'cube' | 'edges' | 'model';
  latencyMs: number;
  axes?: ViewCubeAxes;  // raw detected axes for debug display
  cleanAxes?: ViewCubeAxes;  // orthogonality-constrained axes from reconstructFromTwoAxes
  axisMapping?: AxisMapping;  // coordinate system mapping (e.g., Z-up → Y-up)
}

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

// ── Axis Mapping (remap detected view cube axes to overlay axes) ────

export type AxisSource = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export interface AxisMapping {
  x: AxisSource;  // What drives overlay X-component
  y: AxisSource;  // What drives overlay Y-component
  z: AxisSource;  // What drives overlay Z-component
}

// ── Motion State (settle refinement) ────────────────────────────────

export type MotionState = 'active' | 'settling' | 'idle';

// ── Calibration ──────────────────────────────────────────────────────

export interface CalibrationProfile {
  id: string;
  name: string;
  windowName: string;
  trackingRegion: ScreenRegion;
  viewCubeRegion?: ScreenRegion;   // ROI for view cube detection
  viewportRegion?: ScreenRegion;   // ROI for optical flow (model area)
  alignment: AlignmentState;
  referenceScreenshot: string; // base64 grayscale
  createdAt: number;
}

// ── IPC Channels ─────────────────────────────────────────────────────

export const IPC = {
  // GLTF
  GLTF_LOAD: 'gltf:load',
  GLTF_DATA: 'gltf:data',

  // Tracking
  TRACKING_START: 'tracking:start',
  TRACKING_STOP: 'tracking:stop',
  TRACKING_STATUS: 'tracking:status',

  // Alignment
  ALIGNMENT_UPDATE: 'alignment:update',
  ALIGNMENT_RESET: 'alignment:reset',
  ALIGNMENT_NUDGE: 'alignment:nudge',

  // Windows
  WINDOWS_LIST: 'windows:list',
  WINDOWS_SELECT: 'windows:select',

  // Settings
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_GET: 'settings:get',

  // Calibration
  CALIBRATION_SAVE: 'calibration:save',
  CALIBRATION_LIST: 'calibration:list',
  CALIBRATION_DELETE: 'calibration:delete',
  CALIBRATION_APPLY: 'calibration:apply',

  // Overlay mode
  OVERLAY_TOGGLE: 'overlay:toggle',
  OVERLAY_ANNOTATE_MODE: 'overlay:annotate-mode',
  OVERLAY_ALIGN_MODE: 'overlay:align-mode',

  // Annotations
  ANNOTATION_ADD: 'annotation:add',
  ANNOTATION_REMOVE: 'annotation:remove',
  ANNOTATION_LIST: 'annotation:list',

  // Setup panel
  SETUP_RESIZE: 'setup:resize',
  SETUP_COLLAPSE: 'setup:collapse',

  // Renderer-side screen capture (video stream)
  CAPTURE_START: 'capture:start',    // main → renderer: start capturing (sends sourceId + regions)
  CAPTURE_STOP: 'capture:stop',      // main → renderer: stop capturing
  CAPTURE_FRAME: 'capture:frame',    // renderer → main: grayscale frame data (legacy full-screen)

  // Dual-mask capture (new architecture)
  CAPTURE_VIEWCUBE_FRAME: 'capture:viewcube-frame',  // renderer → main: RGBA viewcube crop
  CAPTURE_VIEWPORT_FRAME: 'capture:viewport-frame',  // renderer → main: grayscale viewport crop

  // ROI definition
  ROI_DEFINE: 'roi:define',          // setup → main: start ROI definition flow
  ROI_SCREENSHOT: 'roi:screenshot',  // main → setup: screenshot for ROI drawing
  ROI_REGIONS: 'roi:regions',        // setup → main: save defined regions
  ROI_VERIFY: 'roi:verify',          // main → overlay: show mask verification overlay
  ROI_CANCEL: 'roi:cancel',          // setup → main: cancel ROI definition, restore windows

  // View cube absolute rotation
  VIEWCUBE_ROTATION: 'viewcube:rotation',  // main → overlay/setup: absolute rotation from view cube

  // Axis mapping (remaps detected view cube axes to overlay axes)
  AXIS_MAPPING: 'axis:mapping',            // setup → main: AxisMapping config

  // Calibration sync (one-click offset alignment)
  CALIBRATION_SYNC: 'calibration:sync',    // setup → main: compute rotation offset from current state

  // SolidWorks COM bridge
  SW_BRIDGE_START:  'sw:bridge-start',     // setup → main: launch SwBridge.exe
  SW_BRIDGE_STOP:   'sw:bridge-stop',      // setup → main: stop bridge
  SW_BRIDGE_STATUS: 'sw:bridge-status',    // main → setup: connection status string
  SW_CAMERA_UPDATE: 'sw:camera-update',    // main → overlay: exact camera frame each tick

  // Model pose tracking
  MODELPOSE_GENERATE: 'modelpose:generate',
  MODELPOSE_DATABASE: 'modelpose:database',
  MODELPOSE_STATUS:   'modelpose:status',

  // Edge snap (overlay → main: periodic edge snapshot for alignment refinement)
  EDGESNAP_OVERLAY_EDGES: 'edgesnap:overlay-edges',

  // Review Session
  REVIEW_START: 'review:start',
  REVIEW_STOP: 'review:stop',
  REVIEW_STATUS: 'review:status',
  REVIEW_ROOM_CODE: 'review:room-code',
  REVIEW_CONTROL_REQUEST: 'review:control-request',
  REVIEW_CONTROL_GRANT: 'review:control-grant',
  REVIEW_CONTROL_DENY: 'review:control-deny',
  REVIEW_CONTROL_REVOKE: 'review:control-revoke',
  REVIEW_CHAT_SEND: 'review:chat-send',
  REVIEW_CHAT_MESSAGE: 'review:chat-message',
  REVIEW_ANNOTATION: 'review:annotation',
  REVIEW_ANNOTATION_DELETE: 'review:annotation-delete',
} as const;
