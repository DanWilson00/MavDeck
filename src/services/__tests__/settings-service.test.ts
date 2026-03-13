import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock idb-keyval with an in-memory Map
const mockStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => mockStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    mockStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

import { loadSettings, saveSettings, saveSettingsDebounced, DEFAULT_SETTINGS, saveDialect, loadDialect, clearDialect } from '../settings-service';
import type { MavDeckSettings, PersistedDialect } from '../settings-service';

describe('settings-service', () => {
  beforeEach(() => {
    mockStore.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns defaults when no saved settings exist', async () => {
    const settings = await loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('returns a new object (not the same reference as DEFAULT_SETTINGS)', async () => {
    const settings = await loadSettings();
    expect(settings).not.toBe(DEFAULT_SETTINGS);
  });

  it('returns saved settings when they exist', async () => {
    const saved: MavDeckSettings = {
      theme: 'light',
      uiScale: 1.1,
      unitProfile: 'raw',
      baudRate: 57600,
      bufferCapacity: 5000,
      dataRetentionMinutes: 30,
      updateIntervalMs: 32,
      mapShowPath: false,
      mapTrailLength: 200,
      mapLayer: 'satellite',
      mapZoom: 12,
      mapAutoCenter: false,
      sidebarCollapsed: true,
      sidebarWidth: 400,
    };
    mockStore.set('mavdeck-settings-v1', saved);

    const settings = await loadSettings();
    expect(settings).toEqual(saved);
  });

  it('merges defaults for missing keys (forward-compatible)', async () => {
    // Simulate an older saved settings object missing new keys
    const partial = {
      theme: 'light' as const,
      baudRate: 57600 as const,
    };
    mockStore.set('mavdeck-settings-v1', partial);

    const settings = await loadSettings();

    // Saved values are preserved
    expect(settings.theme).toBe('light');
    expect(settings.baudRate).toBe(57600);
    expect(settings.uiScale).toBe(DEFAULT_SETTINGS.uiScale);

    // Missing keys get defaults
    expect(settings.bufferCapacity).toBe(DEFAULT_SETTINGS.bufferCapacity);
    expect(settings.dataRetentionMinutes).toBe(DEFAULT_SETTINGS.dataRetentionMinutes);
    expect(settings.updateIntervalMs).toBe(DEFAULT_SETTINGS.updateIntervalMs);
  });

  it('saveSettings persists to IndexedDB', async () => {
    const settings: MavDeckSettings = {
      theme: 'light',
      uiScale: 0.95,
      unitProfile: 'metric',
      baudRate: 230400,
      bufferCapacity: 4000,
      dataRetentionMinutes: 20,
      updateIntervalMs: 32,
      mapShowPath: true,
      mapTrailLength: 500,
      mapLayer: 'street',
      mapZoom: 15,
      mapAutoCenter: true,
      sidebarCollapsed: false,
      sidebarWidth: 350,
    };

    await saveSettings(settings);

    const stored = mockStore.get('mavdeck-settings-v1') as MavDeckSettings;
    expect(stored).toEqual(settings);
  });

  it('saveSettings round-trips through loadSettings', async () => {
    const settings: MavDeckSettings = {
      theme: 'light',
      uiScale: 1.2,
      unitProfile: 'aviation',
      baudRate: 921600,
      bufferCapacity: 10000,
      dataRetentionMinutes: 60,
      updateIntervalMs: 50,
      mapShowPath: false,
      mapTrailLength: 1000,
      mapLayer: 'satellite',
      mapZoom: 18,
      mapAutoCenter: false,
      sidebarCollapsed: true,
      sidebarWidth: 500,
    };

    await saveSettings(settings);
    const loaded = await loadSettings();
    expect(loaded).toEqual(settings);
  });

  it('saveSettingsDebounced saves after 2 seconds', async () => {
    const settings: MavDeckSettings = {
      ...DEFAULT_SETTINGS,
      theme: 'light',
    };

    saveSettingsDebounced(settings);

    // Not saved yet
    expect(mockStore.has('mavdeck-settings-v1')).toBe(false);

    // Advance past debounce period
    await vi.advanceTimersByTimeAsync(2000);

    const stored = mockStore.get('mavdeck-settings-v1') as MavDeckSettings;
    expect(stored).toEqual(settings);
  });

  it('saveSettingsDebounced resets timer on rapid calls', async () => {
    const settings1: MavDeckSettings = { ...DEFAULT_SETTINGS, theme: 'light' };
    const settings2: MavDeckSettings = { ...DEFAULT_SETTINGS, bufferCapacity: 5000 };

    saveSettingsDebounced(settings1);
    await vi.advanceTimersByTimeAsync(1000); // 1s — not yet fired

    // Call again, should reset timer
    saveSettingsDebounced(settings2);
    await vi.advanceTimersByTimeAsync(1000); // 1s more — still within debounce of second call

    // First call's settings should NOT have been saved
    expect(mockStore.has('mavdeck-settings-v1')).toBe(false);

    // Advance to complete the second debounce
    await vi.advanceTimersByTimeAsync(1000);

    const stored = mockStore.get('mavdeck-settings-v1') as MavDeckSettings;
    expect(stored).toEqual(settings2);
  });

  it('DEFAULT_SETTINGS has expected default values', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('dark');
    expect(DEFAULT_SETTINGS.uiScale).toBe(1);
    expect(DEFAULT_SETTINGS.unitProfile).toBe('raw');
    expect(DEFAULT_SETTINGS.baudRate).toBe(115200);
    expect(DEFAULT_SETTINGS.bufferCapacity).toBe(2000);
    expect(DEFAULT_SETTINGS.dataRetentionMinutes).toBe(10);
    expect(DEFAULT_SETTINGS.updateIntervalMs).toBe(16);
  });

  describe('dialect persistence', () => {
    it('loadDialect returns undefined when no dialect is cached', async () => {
      const result = await loadDialect();
      expect(result).toBeUndefined();
    });

    it('saveDialect + loadDialect round-trip', async () => {
      const json = '{"messages":[],"enums":[]}';
      await saveDialect('ardupilotmega', json);

      const loaded = await loadDialect();
      expect(loaded).toBeDefined();
      expect(loaded!.name).toBe('ardupilotmega');
      expect(loaded!.json).toBe(json);
    });

    it('clearDialect removes the cached dialect', async () => {
      await saveDialect('common', '{"messages":[]}');
      expect(await loadDialect()).toBeDefined();

      await clearDialect();
      expect(await loadDialect()).toBeUndefined();
    });

    it('saveDialect overwrites previous dialect', async () => {
      await saveDialect('common', '{"v":1}');
      await saveDialect('ardupilotmega', '{"v":2}');

      const loaded = await loadDialect();
      expect(loaded!.name).toBe('ardupilotmega');
      expect(loaded!.json).toBe('{"v":2}');
    });
  });
});
