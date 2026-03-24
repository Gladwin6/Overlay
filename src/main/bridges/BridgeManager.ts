/**
 * BridgeManager — Auto-detects running CAD software and starts the
 * appropriate bridge for pixel-perfect overlay tracking.
 *
 * Usage:
 *   const mgr = new BridgeManager();
 *   await mgr.autoConnect();
 *   mgr.onFrame((frame) => { // update overlay });
 */

import { detectBestCad, detectRunningCad, DetectedCad, CadBridgeType } from './CadDetector';
import { CadBridge, CameraFrame, BridgeStatus } from './CadBridge';

export class BridgeManager {
  private bridge: CadBridge | null = null;
  private frameCallback: ((frame: CameraFrame) => void) | null = null;
  private statusCallback: ((status: BridgeStatus, cadName: string, detail?: string) => void) | null = null;
  private detectedCad: DetectedCad | null = null;

  /**
   * Scan for running CAD software and connect to the best one.
   */
  async autoConnect(): Promise<DetectedCad | null> {
    console.log('[BridgeManager] Scanning for CAD software...');
    const all = await detectRunningCad();
    console.log(`[BridgeManager] Found: ${all.map(d => d.name).join(', ') || 'none'}`);

    const best = await detectBestCad();
    if (!best) {
      console.log('[BridgeManager] No supported CAD software detected');
      this.statusCallback?.('stopped', 'none', 'No CAD software detected');
      return null;
    }

    this.detectedCad = best;
    console.log(`[BridgeManager] Best match: ${best.name} (${best.bridgeType}) PID=${best.pid}`);

    try {
      this.bridge = await this.createBridge(best.bridgeType);
      if (this.bridge) {
        this.bridge.onFrame((frame) => this.frameCallback?.(frame));
        this.bridge.onStatus((status, detail) => {
          this.statusCallback?.(status, best.name, detail);
        });
        await this.bridge.start();
        console.log(`[BridgeManager] Connected to ${best.name}`);
      }
    } catch (err: any) {
      console.error(`[BridgeManager] Failed to connect to ${best.name}:`, err.message);
      this.statusCallback?.('error', best.name, err.message);
    }

    return best;
  }

  /**
   * Stop the active bridge.
   */
  stop(): void {
    this.bridge?.stop();
    this.bridge = null;
    this.detectedCad = null;
  }

  /**
   * Register frame callback.
   */
  onFrame(cb: (frame: CameraFrame) => void): void {
    this.frameCallback = cb;
  }

  /**
   * Register status callback.
   */
  onStatus(cb: (status: BridgeStatus, cadName: string, detail?: string) => void): void {
    this.statusCallback = cb;
  }

  /**
   * Get the detected CAD info.
   */
  getDetectedCad(): DetectedCad | null {
    return this.detectedCad;
  }

  /**
   * Create the appropriate bridge for the detected CAD software.
   */
  private async createBridge(type: CadBridgeType): Promise<CadBridge | null> {
    switch (type) {
      case 'solidworks':
        // Use existing SwBridge.exe
        const { SolidWorksBridge } = await import('./SolidWorksBridge');
        return new SolidWorksBridge();

      // Future bridges:
      // case 'fusion360':
      //   const { Fusion360Bridge } = await import('./Fusion360Bridge');
      //   return new Fusion360Bridge();
      //
      // case 'inventor':
      //   const { InventorBridge } = await import('./InventorBridge');
      //   return new InventorBridge();
      //
      // case 'freecad':
      //   const { FreeCADBridge } = await import('./FreeCADBridge');
      //   return new FreeCADBridge();

      default:
        console.log(`[BridgeManager] No bridge available for ${type} — falling back to screen tracking`);
        this.statusCallback?.('not-installed', type, `Bridge for ${type} not yet implemented`);
        return null;
    }
  }
}
