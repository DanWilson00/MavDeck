/**
 * Settings service — persists app preferences to IndexedDB using idb-keyval.
 *
 * Owns preferences like theme, baudRate, bufferCapacity, etc.
 * Grid layout positions remain in a separate key owned by TelemetryView.
 */

import { get, set } from 'idb-keyval';
import type { BaudRate } from './webserial-byte-source';
import { DEFAULT_BAUD_RATE } from './webserial-byte-source';

const SETTINGS_KEY = 'mavdeck-settings-v1';

export interface MavDeckSettings {
  theme: 'dark' | 'light';
  baudRate: BaudRate;
  bufferCapacity: number;
  dataRetentionMinutes: number;
  updateIntervalMs: number;
}

export const DEFAULT_SETTINGS: MavDeckSettings = {
  theme: 'dark',
  baudRate: DEFAULT_BAUD_RATE,
  bufferCapacity: 2000,
  dataRetentionMinutes: 10,
  updateIntervalMs: 16,
};

/**
 * Load settings from IndexedDB. Merges with defaults for forward-compatibility:
 * any new keys added in future versions will get their default values.
 */
export async function loadSettings(): Promise<MavDeckSettings> {
  const saved = await get<Partial<MavDeckSettings>>(SETTINGS_KEY);
  if (!saved) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...saved };
}

/** Save settings to IndexedDB. */
export async function saveSettings(settings: MavDeckSettings): Promise<void> {
  await set(SETTINGS_KEY, settings);
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Save settings with a 2-second debounce to avoid thrashing IndexedDB. */
export function saveSettingsDebounced(settings: MavDeckSettings): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    saveSettings(settings);
    debounceTimer = null;
  }, 2000);
}
