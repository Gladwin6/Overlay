/**
 * CadBridge — Common interface for all CAD software bridges.
 *
 * Each bridge reads camera data from a specific CAD software's API
 * and emits standardized camera frames.
 *
 * Implementations:
 *   - SolidWorksBridge (COM API via SwBridge.exe)
 *   - Fusion360Bridge (Python script via Fusion API)
 *   - InventorBridge (COM API)
 *   - FreeCADBridge (Python API)
 *   - etc.
 */

export interface CameraFrame {
  /** 3x3 rotation matrix (row-major) in the CAD's native coordinate system */
  rotation: number[];
  /** Scale/zoom factor */
  scale: number;
  /** Translation from viewport center (pixels) */
  panX: number;
  panY: number;
  /** Viewport dimensions */
  viewportWidth: number;
  viewportHeight: number;
  /** DPI of the display */
  dpi: number;
  /** Is the CAD coordinate system Z-up? */
  isZUp: boolean;
  /** Timestamp */
  timestamp: number;
}

export type BridgeStatus = 'stopped' | 'connecting' | 'live' | 'error' | 'not-installed';

export interface CadBridge {
  /** Human-readable name */
  readonly name: string;

  /** Current status */
  readonly status: BridgeStatus;

  /** Start the bridge — connect to the CAD software */
  start(): Promise<void>;

  /** Stop the bridge */
  stop(): void;

  /** Register callback for camera frames (~60fps) */
  onFrame(callback: (frame: CameraFrame) => void): void;

  /** Register callback for status changes */
  onStatus(callback: (status: BridgeStatus, detail?: string) => void): void;
}
