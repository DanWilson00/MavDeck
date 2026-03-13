/**
 * Settings service — persists app preferences to IndexedDB using idb-keyval.
 *
 * Owns preferences like theme, baudRate, bufferCapacity, etc.
 * Grid layout positions remain in a separate key owned by TelemetryView.
 */

import { get, set, del } from 'idb-keyval';
import type { BaudRate } from './webserial-byte-source';
import { DEFAULT_BAUD_RATE } from './webserial-byte-source';
import type { UnitProfile } from './unit-display';

const SETTINGS_KEY = 'mavdeck-settings-v1';

export interface MavDeckSettings {
  theme: 'dark' | 'light';
  uiScale: number;
  unitProfile: UnitProfile;
  baudRate: BaudRate;
  bufferCapacity: number;
  dataRetentionMinutes: number;
  updateIntervalMs: number;
  mapShowPath: boolean;
  mapTrailLength: number;
  mapLayer: 'street' | 'satellite';
  mapZoom: number;
  mapAutoCenter: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
}

export const DEFAULT_SETTINGS: MavDeckSettings = {
  theme: 'dark',
  uiScale: 1,
  unitProfile: 'raw',
  baudRate: DEFAULT_BAUD_RATE,
  bufferCapacity: 2000,
  dataRetentionMinutes: 10,
  updateIntervalMs: 16,
  mapShowPath: true,
  mapTrailLength: 500,
  mapLayer: 'street',
  mapZoom: 15,
  mapAutoCenter: true,
  sidebarCollapsed: false,
  sidebarWidth: 350,
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

const DIALECT_KEY = 'mavdeck-dialect-v1';

export interface PersistedDialect {
  name: string;       // e.g. "common" or "ardupilotmega"
  json: string;       // parsed JSON string (registry-compatible)
}

export async function saveDialect(name: string, json: string): Promise<void> {
  await set(DIALECT_KEY, { name, json });
}

export async function loadDialect(): Promise<PersistedDialect | undefined> {
  return get<PersistedDialect>(DIALECT_KEY);
}

export async function clearDialect(): Promise<void> {
  await del(DIALECT_KEY);
}
