/**
 * Screen Capture Manager
 *
 * Uses Electron's desktopCapturer for all screen capture operations.
 * No native module dependency — pure Electron APIs.
 *
 * IMPORTANT: All capture methods are async because desktopCapturer is async.
 */

import { desktopCapturer, nativeImage, screen } from 'electron';
import { ScreenRegion, WindowInfo } from '../../shared/types';

export interface DisplayInfo {
  width: number;
  height: number;
  scaleFactor: number;
}

export class ScreenCaptureManager {
  private lastCapture: { data: Uint8Array; width: number; height: number } | null = null;

  constructor() {
    // No native module needed
  }

  checkPermission(): boolean {
    // desktopCapturer handles permissions via macOS screen recording prompt
    return true;
  }

  getDisplayInfo(): DisplayInfo | null {
    try {
      const primary = screen.getPrimaryDisplay();
      return {
        width: primary.size.width,
        height: primary.size.height,
        scaleFactor: primary.scaleFactor,
      };
    } catch {
      return null;
    }
  }

  async listWindows(): Promise<WindowInfo[]> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 240, height: 160 },
      });

      return sources
        .filter((s) => s.name && s.name.trim().length > 0)
        .map((s) => ({
          id: parseInt(s.id.replace('window:', ''), 10) || 0,
          name: s.name,
          ownerName: '',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          thumbnail: s.thumbnail.toDataURL(),
        }));
    } catch (err) {
      console.error('[ScreenCapture] Failed to list windows:', err);
      return [];
    }
  }

  /** Pick the desktopCapturer source matching the given display, or fall back to sources[0]. */
  private async getSourceForDisplay(displayId?: number): Promise<Electron.DesktopCapturerSource | null> {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 800, height: 600 },
    });
    if (sources.length === 0) return null;
    if (!displayId) return sources[0];
    // Match by display_id string, then by index order
    const byId = sources.find(s => s.display_id === String(displayId));
    if (byId) return byId;
    const allDisplays = screen.getAllDisplays();
    const idx = allDisplays.findIndex(d => d.id === displayId);
    return idx >= 0 && idx < sources.length ? sources[idx] : sources[0];
  }

  /**
   * Capture a screen region and return raw grayscale pixel data.
   * Uses desktopCapturer to get a full-screen thumbnail, then crops to region.
   * Pass displayId to capture the correct monitor on multi-display setups.
   */
  async captureRegionGrayscale(region: ScreenRegion, displayId?: number): Promise<{ data: Uint8Array; width: number; height: number } | null> {
    try {
      const source = await this.getSourceForDisplay(displayId);
      if (!source) {
        console.warn('[ScreenCapture] No screen sources found');
        return null;
      }

      const thumbnail = source.thumbnail;
      const size = thumbnail.getSize();

      if (size.width === 0 || size.height === 0) {
        console.warn('[ScreenCapture] Thumbnail size is 0x0');
        return null;
      }

      // Get RGBA bitmap
      const bitmap = thumbnail.toBitmap();
      const fullW = size.width;
      const fullH = size.height;

      // Scale from display logical size to thumbnail pixel size.
      // Use the target display's size (not always primary).
      const allDisplays = screen.getAllDisplays();
      const display = (displayId ? allDisplays.find(d => d.id === displayId) : null) || screen.getPrimaryDisplay();
      const scaleX = fullW / display.size.width;
      const scaleY = fullH / display.size.height;
      // Region coords are absolute virtual-screen; subtract display origin for display-relative crop.
      const relX = region.x - display.bounds.x;
      const relY = region.y - display.bounds.y;

      const cropX = Math.max(0, Math.floor(relX * scaleX));
      const cropY = Math.max(0, Math.floor(relY * scaleY));
      const cropW = Math.min(fullW - cropX, Math.floor(region.width * scaleX));
      const cropH = Math.min(fullH - cropY, Math.floor(region.height * scaleY));

      if (cropW <= 0 || cropH <= 0) return null;

      // Convert RGBA to grayscale (ITU-R 601 luminance) with crop
      const gray = new Uint8Array(cropW * cropH);
      for (let y = 0; y < cropH; y++) {
        for (let x = 0; x < cropW; x++) {
          const srcIdx = ((cropY + y) * fullW + (cropX + x)) * 4;
          const r = bitmap[srcIdx];
          const g = bitmap[srcIdx + 1];
          const b = bitmap[srcIdx + 2];
          gray[y * cropW + x] = (r * 77 + g * 150 + b * 29) >> 8;
        }
      }

      this.lastCapture = { data: gray, width: cropW, height: cropH };
      return this.lastCapture;
    } catch (err) {
      console.error('[ScreenCapture] captureRegionGrayscale failed:', err);
      return null;
    }
  }

  async captureFullScreenGrayscale(displayId?: number): Promise<{ data: Uint8Array; width: number; height: number } | null> {
    try {
      const source = await this.getSourceForDisplay(displayId);
      if (!source) return null;

      const thumbnail = source.thumbnail;
      const size = thumbnail.getSize();
      if (size.width === 0 || size.height === 0) return null;

      const bitmap = thumbnail.toBitmap();
      const w = size.width;
      const h = size.height;

      const gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const r = bitmap[i * 4];
        const g = bitmap[i * 4 + 1];
        const b = bitmap[i * 4 + 2];
        gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
      }

      return { data: gray, width: w, height: h };
    } catch (err) {
      console.error('[ScreenCapture] captureFullScreenGrayscale failed:', err);
      return null;
    }
  }

  isAvailable(): boolean {
    // Always available — desktopCapturer is built into Electron
    return true;
  }
}
