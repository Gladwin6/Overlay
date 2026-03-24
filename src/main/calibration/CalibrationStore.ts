/**
 * Calibration Store
 *
 * CRUD for calibration profiles via electron-store.
 * Each profile stores alignment, tracking region, and reference screenshot
 * for multi-desktop re-alignment.
 */

import Store from 'electron-store';
import { CalibrationProfile, AlignmentState, ScreenRegion } from '../../shared/types';

interface StoreSchema {
  profiles: CalibrationProfile[];
}

export class CalibrationStore {
  private store: Store<StoreSchema>;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'hanomi-calibration',
      defaults: {
        profiles: [],
      },
    });
  }

  /**
   * Get all calibration profiles.
   */
  list(): CalibrationProfile[] {
    return this.store.get('profiles', []);
  }

  /**
   * Get a profile by ID.
   */
  get(id: string): CalibrationProfile | undefined {
    return this.list().find(p => p.id === id);
  }

  /**
   * Find profiles matching a window name.
   */
  findByWindowName(name: string): CalibrationProfile[] {
    return this.list().filter(p =>
      p.windowName.toLowerCase().includes(name.toLowerCase())
    );
  }

  /**
   * Save a new calibration profile.
   */
  save(profile: Omit<CalibrationProfile, 'id' | 'createdAt'>): CalibrationProfile {
    const id = `cal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const full: CalibrationProfile = {
      ...profile,
      id,
      createdAt: Date.now(),
    };

    const profiles = this.list();
    profiles.push(full);
    this.store.set('profiles', profiles);

    console.log(`[CalibrationStore] Saved profile: ${full.name} (${id})`);
    return full;
  }

  /**
   * Update an existing profile's alignment.
   */
  updateAlignment(id: string, alignment: AlignmentState): boolean {
    const profiles = this.list();
    const idx = profiles.findIndex(p => p.id === id);
    if (idx === -1) return false;

    profiles[idx].alignment = alignment;
    this.store.set('profiles', profiles);
    return true;
  }

  /**
   * Update reference screenshot for a profile.
   */
  updateScreenshot(id: string, screenshot: string): boolean {
    const profiles = this.list();
    const idx = profiles.findIndex(p => p.id === id);
    if (idx === -1) return false;

    profiles[idx].referenceScreenshot = screenshot;
    this.store.set('profiles', profiles);
    return true;
  }

  /**
   * Delete a profile.
   */
  delete(id: string): boolean {
    const profiles = this.list();
    const filtered = profiles.filter(p => p.id !== id);
    if (filtered.length === profiles.length) return false;

    this.store.set('profiles', filtered);
    console.log(`[CalibrationStore] Deleted profile: ${id}`);
    return true;
  }

  /**
   * Clear all profiles.
   */
  clear(): void {
    this.store.set('profiles', []);
  }
}
