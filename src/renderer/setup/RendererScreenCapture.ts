/**
 * RendererScreenCapture — Captures frames from a persistent video stream in the renderer process.
 *
 * v2: Dual-mask architecture
 *   - Crops two regions from the video stream:
 *     1. View cube crop (RGBA, ~120x120px) → sent via CAPTURE_VIEWCUBE_FRAME
 *     2. Viewport crop (grayscale, larger) → sent via CAPTURE_VIEWPORT_FRAME
 *   - Falls back to full-screen grayscale (CAPTURE_FRAME) if no regions defined
 *
 * Uses navigator.mediaDevices.getUserMedia() with Electron's chromeMediaSource: 'desktop'
 * to get a real-time video stream (~30fps), then extracts frames at 10fps.
 */

const { ipcRenderer } = window.require('electron');
import { IPC, ScreenRegion } from '../../shared/types';

const CAPTURE_INTERVAL_MS = 33; // 30fps — fast enough for smooth tracking

// Legacy full-screen capture size (fallback when no ROI defined)
const LEGACY_WIDTH = 400;
const LEGACY_HEIGHT = 300;

// Maximum viewport capture dimensions (don't downsample as aggressively)
const MAX_VIEWPORT_WIDTH = 800;
const MAX_VIEWPORT_HEIGHT = 600;

export interface CaptureRegions {
  viewCube: ScreenRegion;   // Small region around the view cube (~120x120)
  viewport: ScreenRegion;   // Larger region around the model viewport
}

export type CropPreviewCallback = (
  vcDataUrl: string | null,
  vpDataUrl: string | null,
  vcSize: { width: number; height: number } | null,
  vpSize: { width: number; height: number } | null,
) => void;

export class RendererScreenCapture {
  private stream: MediaStream | null = null;

  /** Expose the raw MediaStream for WebRTC streaming */
  getStream(): MediaStream | null {
    return this.stream;
  }
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Dual-mask regions (screen-space coordinates)
  private regions: CaptureRegions | null = null;

  // Separate canvases for each crop
  private vcCanvas: HTMLCanvasElement | null = null;
  private vcCtx: CanvasRenderingContext2D | null = null;
  private vpCanvas: HTMLCanvasElement | null = null;
  private vpCtx: CanvasRenderingContext2D | null = null;

  // Video native resolution (for coordinate scaling)
  private videoWidth = 0;
  private videoHeight = 0;

  // Display origin in virtual screen space. ROI coords are absolute screen coords;
  // the video captures only this display (starting at 0,0), so we subtract the origin.
  private displayOriginX = 0;
  private displayOriginY = 0;

  // Crop preview callback (throttled ~2fps for debug UI)
  private cropPreviewCallback: CropPreviewCallback | null = null;
  private lastPreviewTs = 0;
  private static PREVIEW_THROTTLE_MS = 500;

  /**
   * Set the ROI regions. Call before start() or dynamically during capture.
   */
  setRegions(regions: CaptureRegions | null, displayBounds?: { x: number; y: number; width: number; height: number }): void {
    this.regions = regions;
    this.displayOriginX = displayBounds?.x ?? 0;
    this.displayOriginY = displayBounds?.y ?? 0;

    if (regions) {
      // Create viewcube crop canvas — minimum 150px on shortest side.
      // CRITICAL: preserve aspect ratio! Non-uniform stretch distorts axis directions
      // and causes axesToSpherical to compute wrong rotation.
      const VC_MIN_SIZE = 150;
      const vcScale = Math.max(1, VC_MIN_SIZE / Math.min(regions.viewCube.width, regions.viewCube.height));
      this.vcCanvas = document.createElement('canvas');
      this.vcCanvas.width = Math.round(regions.viewCube.width * vcScale);
      this.vcCanvas.height = Math.round(regions.viewCube.height * vcScale);
      this.vcCtx = this.vcCanvas.getContext('2d', { willReadFrequently: true });

      // Create viewport crop canvas (up to MAX_VIEWPORT dimensions)
      this.vpCanvas = document.createElement('canvas');
      const vpScale = Math.min(1, MAX_VIEWPORT_WIDTH / regions.viewport.width, MAX_VIEWPORT_HEIGHT / regions.viewport.height);
      this.vpCanvas.width = Math.round(regions.viewport.width * vpScale);
      this.vpCanvas.height = Math.round(regions.viewport.height * vpScale);
      this.vpCtx = this.vpCanvas.getContext('2d', { willReadFrequently: true });

      console.log(`[RendererCapture] Regions set — VC: ${regions.viewCube.width}x${regions.viewCube.height} @ (${regions.viewCube.x},${regions.viewCube.y}), VP: ${this.vpCanvas.width}x${this.vpCanvas.height} from ${regions.viewport.width}x${regions.viewport.height}`);
    } else {
      this.vcCanvas = null; this.vcCtx = null;
      this.vpCanvas = null; this.vpCtx = null;
      console.log('[RendererCapture] Regions cleared — using legacy full-screen mode');
    }
  }

  /**
   * Set a callback to receive throttled crop previews (~2fps) for debug UI.
   */
  setCropPreviewCallback(cb: CropPreviewCallback | null): void {
    this.cropPreviewCallback = cb;
  }

  async start(sourceId: string): Promise<void> {
    if (this.running) this.stop();

    console.log('[RendererCapture] Starting with sourceId:', sourceId);

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxWidth: 1920,
            maxHeight: 1080,
            minFrameRate: 15,
            maxFrameRate: 30,
          },
        } as any,
        audio: false,
      });
    } catch (err) {
      console.error('[RendererCapture] getUserMedia failed:', err);
      return;
    }

    // Create offscreen video element to receive the stream
    this.video = document.createElement('video');
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.play().catch((e) => console.warn('[RendererCapture] video.play() warning:', e));

    // Full-frame canvas (for legacy mode or getting the full frame to crop from)
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.running = true;

    // Wait for video to be ready before starting extraction
    this.video.addEventListener('loadedmetadata', () => {
      this.videoWidth = this.video!.videoWidth;
      this.videoHeight = this.video!.videoHeight;
      console.log(`[RendererCapture] Stream ready: ${this.videoWidth}x${this.videoHeight}`);

      // Set canvas to video native resolution for cropping accuracy
      if (this.canvas) {
        this.canvas.width = this.videoWidth;
        this.canvas.height = this.videoHeight;
      }

      this.startExtraction();
    });

    // If already ready (can happen with cached streams)
    if (this.video.readyState >= 2) {
      this.videoWidth = this.video.videoWidth;
      this.videoHeight = this.video.videoHeight;
      console.log(`[RendererCapture] Stream already ready: ${this.videoWidth}x${this.videoHeight}`);
      if (this.canvas) {
        this.canvas.width = this.videoWidth;
        this.canvas.height = this.videoHeight;
      }
      this.startExtraction();
    }
  }

  stop(): void {
    this.running = false;

    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }

    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }

    this.canvas = null;
    this.ctx = null;
    this.cropPreviewCallback = null;

    console.log('[RendererCapture] Stopped');
  }

  private startExtraction(): void {
    if (this.intervalId !== null) return; // Already extracting

    this.intervalId = setInterval(() => {
      if (!this.running) return;
      this.extractAndSend();
    }, CAPTURE_INTERVAL_MS);

    console.log(`[RendererCapture] Extracting frames at ${1000 / CAPTURE_INTERVAL_MS}fps (mode: ${this.regions ? 'dual-mask' : 'legacy'})`);
  }

  private extractAndSend(): void {
    if (!this.video || !this.ctx || !this.canvas) return;
    if (this.video.readyState < 2) return; // Not ready yet

    if (this.regions) {
      this.extractDualMask();
    } else {
      this.extractLegacy();
    }
  }

  /**
   * Dual-mask extraction: crop two regions from the full video frame.
   */
  private extractDualMask(): void {
    if (!this.video || !this.ctx || !this.canvas || !this.regions) return;
    if (!this.vcCtx || !this.vcCanvas || !this.vpCtx || !this.vpCanvas) return;

    // Draw full frame to main canvas at native resolution
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

    // ROI coords are absolute virtual-screen coordinates (may include a display origin offset).
    // The video stream captures only the target display, starting at pixel (0,0).
    // Subtract the display's screen origin so coords are display-relative before scaling.
    //
    // Scale accounts for video resolution vs display CSS size (handles Retina, DPI scaling).
    // We use screen.width/height (primary display CSS size) as the reference because that's
    // what getUserMedia resolution is capped against. For same-DPI multi-monitor setups this
    // is equivalent to the per-display CSS size.
    const scaleX = this.canvas.width / screen.width;
    const scaleY = this.canvas.height / screen.height;

    // ── View Cube Crop (RGBA — color info needed for axis detection) ──
    const vc = this.regions.viewCube;
    const vcSrcX = Math.round((vc.x - this.displayOriginX) * scaleX);
    const vcSrcY = Math.round((vc.y - this.displayOriginY) * scaleY);
    const vcSrcW = Math.round(vc.width * scaleX);
    const vcSrcH = Math.round(vc.height * scaleY);

    // Draw cropped region to VC canvas
    this.vcCtx.drawImage(
      this.canvas,
      vcSrcX, vcSrcY, vcSrcW, vcSrcH,
      0, 0, this.vcCanvas.width, this.vcCanvas.height
    );

    // Send RGBA data (color is critical for axis detection)
    const vcImageData = this.vcCtx.getImageData(0, 0, this.vcCanvas.width, this.vcCanvas.height);
    const vcBuffer = vcImageData.data.buffer.slice(0);
    ipcRenderer.send(IPC.CAPTURE_VIEWCUBE_FRAME, vcBuffer, this.vcCanvas.width, this.vcCanvas.height);

    // ── Viewport Crop (grayscale — for optical flow) ──
    const vp = this.regions.viewport;
    const vpSrcX = Math.round((vp.x - this.displayOriginX) * scaleX);
    const vpSrcY = Math.round((vp.y - this.displayOriginY) * scaleY);
    const vpSrcW = Math.round(vp.width * scaleX);
    const vpSrcH = Math.round(vp.height * scaleY);

    // Draw cropped region to VP canvas (may downscale slightly)
    this.vpCtx.drawImage(
      this.canvas,
      vpSrcX, vpSrcY, vpSrcW, vpSrcH,
      0, 0, this.vpCanvas.width, this.vpCanvas.height
    );

    // Convert to grayscale
    const vpImageData = this.vpCtx.getImageData(0, 0, this.vpCanvas.width, this.vpCanvas.height);
    const vpRgba = vpImageData.data;
    const vpW = this.vpCanvas.width;
    const vpH = this.vpCanvas.height;
    const vpGray = new Uint8Array(vpW * vpH);
    for (let i = 0; i < vpW * vpH; i++) {
      const ri = i * 4;
      vpGray[i] = (vpRgba[ri] * 77 + vpRgba[ri + 1] * 150 + vpRgba[ri + 2] * 29) >> 8;
    }

    const vpGrayBuffer = vpGray.buffer;
    ipcRenderer.send(IPC.CAPTURE_VIEWPORT_FRAME, vpGrayBuffer, vpW, vpH);

    // Throttled crop preview for debug UI (~2fps)
    if (this.cropPreviewCallback) {
      const now = performance.now();
      if (now - this.lastPreviewTs >= RendererScreenCapture.PREVIEW_THROTTLE_MS) {
        this.lastPreviewTs = now;
        this.cropPreviewCallback(
          this.vcCanvas!.toDataURL('image/png'),
          this.vpCanvas!.toDataURL('image/png'),
          { width: this.vcCanvas!.width, height: this.vcCanvas!.height },
          { width: this.vpCanvas!.width, height: this.vpCanvas!.height },
        );
      }
    }
  }

  /**
   * Legacy extraction: full screen downscaled to 400x300 grayscale.
   * Used when no ROI regions are defined (backwards compatible).
   */
  private extractLegacy(): void {
    if (!this.video || !this.ctx || !this.canvas) return;

    // Resize canvas for legacy mode
    if (this.canvas.width !== LEGACY_WIDTH || this.canvas.height !== LEGACY_HEIGHT) {
      this.canvas.width = LEGACY_WIDTH;
      this.canvas.height = LEGACY_HEIGHT;
    }

    const w = this.canvas.width;
    const h = this.canvas.height;

    // Draw current video frame to canvas (downscaled to 400x300)
    this.ctx.drawImage(this.video, 0, 0, w, h);

    // Get RGBA pixel data
    const imageData = this.ctx.getImageData(0, 0, w, h);
    const rgba = imageData.data;

    // Convert RGBA → grayscale (ITU-R 601 luminance)
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const ri = i * 4;
      gray[i] = (rgba[ri] * 77 + rgba[ri + 1] * 150 + rgba[ri + 2] * 29) >> 8;
    }

    // Send to main process — transfer the underlying buffer for zero-copy
    const buffer = gray.buffer;
    ipcRenderer.send(IPC.CAPTURE_FRAME, buffer, w, h);
  }
}
