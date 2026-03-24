/**
 * Desktop Switch Detector
 *
 * Monitors CVTracker confidence to detect macOS desktop switches.
 * When confidence drops below threshold for consecutive frames,
 * emits 'desktopSwitch'. Uses hysteresis to avoid false positives.
 */

import { EventEmitter } from 'events';

export interface DesktopSwitchConfig {
  confidenceThreshold: number;  // below this = "lost" (default: 0.05)
  lostFramesRequired: number;   // consecutive lost frames to trigger switch (default: 3)
  recoveredFramesRequired: number; // good frames needed to recover (default: 5)
}

const DEFAULT_CONFIG: DesktopSwitchConfig = {
  confidenceThreshold: 0.05,
  lostFramesRequired: 3,
  recoveredFramesRequired: 5,
};

type DetectorState = 'tracking' | 'lost' | 'searching' | 'matched';

export class DesktopSwitchDetector extends EventEmitter {
  private config: DesktopSwitchConfig;
  private state: DetectorState = 'tracking';
  private consecutiveLostFrames: number = 0;
  private consecutiveGoodFrames: number = 0;

  constructor(config: Partial<DesktopSwitchConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Feed a new confidence value from CVTracker.
   * Call this on every motion delta received.
   */
  onConfidence(confidence: number, trackedPoints: number): void {
    const isGood = confidence >= this.config.confidenceThreshold && trackedPoints > 0;

    switch (this.state) {
      case 'tracking':
        if (!isGood) {
          this.consecutiveLostFrames++;
          if (this.consecutiveLostFrames >= this.config.lostFramesRequired) {
            this.state = 'lost';
            this.consecutiveGoodFrames = 0;
            console.log('[DesktopSwitch] Confidence dropped — desktop switch detected');
            this.emit('desktopSwitch');
            // Transition to searching
            this.state = 'searching';
            this.emit('searching');
          }
        } else {
          this.consecutiveLostFrames = 0;
        }
        break;

      case 'searching':
        if (isGood) {
          this.consecutiveGoodFrames++;
          if (this.consecutiveGoodFrames >= this.config.recoveredFramesRequired) {
            this.state = 'tracking';
            this.consecutiveLostFrames = 0;
            console.log('[DesktopSwitch] Tracking recovered after search');
            this.emit('trackingRecovered');
          }
        } else {
          this.consecutiveGoodFrames = 0;
        }
        break;

      case 'matched':
        // After a template match, wait for good frames to confirm
        if (isGood) {
          this.consecutiveGoodFrames++;
          if (this.consecutiveGoodFrames >= this.config.recoveredFramesRequired) {
            this.state = 'tracking';
            this.consecutiveLostFrames = 0;
            this.emit('trackingRecovered');
          }
        } else {
          this.consecutiveGoodFrames = 0;
        }
        break;
    }
  }

  /**
   * Notify detector that a template match was found.
   */
  onMatchFound(profileId: string): void {
    this.state = 'matched';
    this.consecutiveGoodFrames = 0;
    console.log(`[DesktopSwitch] Match found: profile ${profileId}`);
    this.emit('matched', profileId);
  }

  /**
   * Notify detector that no template match was found.
   */
  onNoMatch(): void {
    console.log('[DesktopSwitch] No match found');
    this.emit('noMatch');
    // Stay in searching state
  }

  getState(): DetectorState {
    return this.state;
  }

  reset(): void {
    this.state = 'tracking';
    this.consecutiveLostFrames = 0;
    this.consecutiveGoodFrames = 0;
  }
}
