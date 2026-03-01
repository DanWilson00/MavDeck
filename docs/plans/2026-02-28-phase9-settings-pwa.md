# Phase 9: Settings & PWA Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent application settings via IndexedDB and finalize PWA configuration with icons and workbox caching.

**Architecture:** A `settings-service.ts` module provides `loadSettings()` / `saveSettings()` with 2-second debounce. ThemeProvider is migrated to use the unified settings service instead of its own key. PWA config gets proper icons and workbox glob patterns. Settings are loaded in App.tsx before UI renders, merged with defaults for forward-compatibility.

**Tech Stack:** idb-keyval (already installed), vite-plugin-pwa (already installed), canvas-generated placeholder icons.

---

## Task 1: Create Settings Service with Tests

The settings service owns app preferences (theme, baudRate, bufferCapacity, etc). Grid layout positions remain in `mavdeck-layout-v1` (owned by TelemetryView).

**Files:**
- Create: `src/services/settings-service.ts`
- Create: `src/services/__tests__/settings-service.test.ts`

**Step 1: Write tests**

```typescript
// src/services/__tests__/settings-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock idb-keyval before importing the module
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    _store: store,
  };
});

import { loadSettings, saveSettings, DEFAULT_SETTINGS, type MavDeckSettings } from '../settings-service';
import { get, set } from 'idb-keyval';

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (await import('idb-keyval') as any)._store.clear();
});

describe('settings-service', () => {
  describe('loadSettings', () => {
    it('returns defaults when no saved settings exist', async () => {
      const settings = await loadSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it('returns saved settings when they exist', async () => {
      const custom: MavDeckSettings = {
        ...DEFAULT_SETTINGS,
        theme: 'light',
        baudRate: 57600,
      };
      vi.mocked(get).mockResolvedValueOnce(custom);

      const settings = await loadSettings();
      expect(settings.theme).toBe('light');
      expect(settings.baudRate).toBe(57600);
    });

    it('merges defaults for missing keys (forward-compatible)', async () => {
      // Simulate a saved settings object from an older version that lacks some keys
      const partial = { theme: 'light' };
      vi.mocked(get).mockResolvedValueOnce(partial);

      const settings = await loadSettings();
      expect(settings.theme).toBe('light');
      expect(settings.baudRate).toBe(DEFAULT_SETTINGS.baudRate);
      expect(settings.bufferCapacity).toBe(DEFAULT_SETTINGS.bufferCapacity);
    });
  });

  describe('saveSettings', () => {
    it('persists settings to IndexedDB', async () => {
      const custom: MavDeckSettings = {
        ...DEFAULT_SETTINGS,
        theme: 'light',
      };
      await saveSettings(custom);
      expect(set).toHaveBeenCalledWith('mavdeck-settings-v1', custom);
    });
  });
});
```

**Step 2: Implement settings service**

```typescript
// src/services/settings-service.ts
/**
 * Settings service — persists app preferences to IndexedDB.
 *
 * Owns: theme, baudRate, bufferCapacity, dataRetentionMinutes, updateIntervalMs.
 * Does NOT own: grid layout positions (owned by TelemetryView via mavdeck-layout-v1).
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

/** Load settings, merging with defaults for forward-compatibility. */
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

/** Save settings with 2-second debounce. */
export function saveSettingsDebounced(settings: MavDeckSettings): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    saveSettings(settings);
    debounceTimer = null;
  }, 2000);
}
```

**Step 3: Run tests**

Run: `npx vitest run src/services/__tests__/settings-service.test.ts`
Expected: All tests pass.

Note: The `beforeEach` with async import may need adjustment. A simpler approach is to reset mocks without clearing the store. Adjust as needed during implementation.

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All 139+ tests pass.

**Step 5: Commit**

```
Phase 9.1: Add settings service with IndexedDB persistence and tests
```

---

## Task 2: Integrate Settings into App Startup and ThemeProvider

Load settings on app startup, apply them to the store, and migrate ThemeProvider from its own `mavdeck-theme` key to the unified settings service.

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/ThemeProvider.tsx`
- Modify: `src/store/app-store.ts`

**Step 1: Update App.tsx to load settings on startup**

In `src/App.tsx`, at the beginning of the `onMount` callback (before dialect loading), load settings and apply to store:

```typescript
import { loadSettings, saveSettingsDebounced } from './services/settings-service';
import type { MavDeckSettings } from './services/settings-service';

// Inside onMount, BEFORE dialect loading:
const settings = await loadSettings();
batch(() => {
  setAppState('theme', settings.theme);
  setAppState('baudRate', settings.baudRate);
});
```

**Step 2: Update ThemeProvider to use settings service for saves**

Replace ThemeProvider's direct `idb-keyval` usage with `saveSettingsDebounced`. It should still apply the CSS class, but delegate persistence to the settings service.

```typescript
// src/components/ThemeProvider.tsx
import { createEffect, type ParentProps } from 'solid-js';
import { appState } from '../store/app-store';
import { saveSettingsDebounced } from '../services/settings-service';

export default function ThemeProvider(props: ParentProps) {
  // Apply theme class to <html> and persist via settings service
  createEffect(() => {
    const theme = appState.theme;
    document.documentElement.classList.toggle('light', theme === 'light');
    // Persist through unified settings (debounced)
    saveSettingsDebounced({
      theme,
      baudRate: appState.baudRate,
      bufferCapacity: 2000,
      dataRetentionMinutes: 10,
      updateIntervalMs: 16,
    });
  });

  return <>{props.children}</>;
}

export function toggleTheme(): void {
  const { setAppState } = await import('../store/app-store');
  setAppState('theme', appState.theme === 'dark' ? 'light' : 'dark');
}
```

Wait — `toggleTheme` is a plain function, not async. Keep it as-is with the direct import. The key change is: remove `onMount` (settings are now loaded in App.tsx), remove the direct `idb-keyval` import, and save via settings service.

Actually, a cleaner approach: ThemeProvider only applies the CSS class. Persistence is handled by a `createEffect` in App.tsx that watches relevant settings and debounce-saves. This keeps ThemeProvider simple.

**Revised ThemeProvider:**

```typescript
// src/components/ThemeProvider.tsx
import { createEffect, type ParentProps } from 'solid-js';
import { appState } from '../store/app-store';

export default function ThemeProvider(props: ParentProps) {
  createEffect(() => {
    document.documentElement.classList.toggle('light', appState.theme === 'light');
  });

  return <>{props.children}</>;
}

export function toggleTheme(): void {
  // Import inline to avoid circular deps — this is a module-level function
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setAppState, appState: state } = require('../store/app-store');
  setAppState('theme', state.theme === 'dark' ? 'light' : 'dark');
}
```

Actually, the current `toggleTheme` uses a static import and that works fine. Keep it:

```typescript
// src/components/ThemeProvider.tsx
import { createEffect, type ParentProps } from 'solid-js';
import { appState, setAppState } from '../store/app-store';

export default function ThemeProvider(props: ParentProps) {
  // Apply theme CSS class reactively
  createEffect(() => {
    document.documentElement.classList.toggle('light', appState.theme === 'light');
  });

  return <>{props.children}</>;
}

export function toggleTheme(): void {
  setAppState('theme', appState.theme === 'dark' ? 'light' : 'dark');
}
```

**Step 3: Add settings persistence effect in App.tsx**

After loading settings and initializing the store, add a `createEffect` that watches theme and baudRate and debounce-saves:

```typescript
import { createEffect } from 'solid-js';
import { saveSettingsDebounced, DEFAULT_SETTINGS } from './services/settings-service';

// After onMount, at component top level:
createEffect(() => {
  saveSettingsDebounced({
    theme: appState.theme,
    baudRate: appState.baudRate,
    bufferCapacity: DEFAULT_SETTINGS.bufferCapacity,
    dataRetentionMinutes: DEFAULT_SETTINGS.dataRetentionMinutes,
    updateIntervalMs: DEFAULT_SETTINGS.updateIntervalMs,
  });
});
```

This watches `appState.theme` and `appState.baudRate` reactively. When either changes, it debounce-saves the full settings object.

**Step 4: Verify build and tests**

Run: `npm run build`
Run: `npx vitest run`
Expected: All pass.

**Step 5: Commit**

```
Phase 9.2: Integrate settings into app startup, migrate ThemeProvider
```

---

## Task 3: PWA Icons and Workbox Configuration

Add placeholder icons and finalize the PWA manifest/workbox config.

**Files:**
- Modify: `vite.config.ts`
- Create: `public/icon-192.png` (placeholder)
- Create: `public/icon-512.png` (placeholder)

**Step 1: Generate placeholder PWA icons**

Use a simple script to create minimal placeholder icons. These are SVG-based PNGs with the MavDeck logo text:

```bash
# Create a simple 192x192 SVG and convert via canvas, or just use a solid color placeholder
# For now, create minimal valid PNGs using Node.js
node -e "
const { createCanvas } = require('canvas');
// If canvas is not installed, create a minimal 1x1 PNG and resize
"
```

Actually — generating PNGs without `canvas` dependency is complex. The simplest approach: create SVG icons and reference them in the manifest. Vite PWA supports SVG icons.

**Alternative: Use SVG icons directly.**

Create `public/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="64" fill="#111217"/>
  <text x="256" y="300" text-anchor="middle" font-family="system-ui" font-weight="bold" font-size="160" fill="#00d4ff">M</text>
</svg>
```

**Step 2: Update vite.config.ts**

```typescript
VitePWA({
  registerType: 'autoUpdate',
  workbox: {
    globPatterns: ['**/*.{js,css,html,json,svg,png}'],
  },
  manifest: {
    name: 'MavDeck',
    short_name: 'MavDeck',
    description: 'Real-time MAVLink telemetry visualization',
    theme_color: '#111217',
    background_color: '#111217',
    display: 'standalone',
    icons: [
      {
        src: 'icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  },
}),
```

Key changes from current config:
- Add `workbox.globPatterns` to cache all app assets
- Fix `theme_color` from `#111827` to `#111217` (matches `--bg-primary` in global.css)
- Add SVG icon with `sizes: 'any'`

**Step 3: Verify build generates service worker**

Run: `npm run build`
Expected output includes:
```
PWA v1.2.0
mode      generateSW
precache  N entries
files generated
  dist/sw.js
  dist/workbox-*.js
```

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 5: Commit**

```
Phase 9.3: Add PWA icon and workbox caching configuration
```

---

## Task 4: Playwright Visual Verification

Verify settings persistence and PWA configuration using the running dev server.

**Files:** None (verification only)

**Step 1: Start dev server**

Run: `npm run dev` (background)

**Step 2: Verify settings persist across reload**

```
browser_navigate → http://localhost:5173
browser_snapshot → verify dark theme (default)
browser_click → theme toggle (light mode)
browser_snapshot → verify light theme applied
browser_navigate → http://localhost:5173 (full reload)
browser_wait_for → time=1
browser_snapshot → verify light theme persisted
browser_click → theme toggle (back to dark)
```

**Step 3: Verify baud rate persists**

```
browser_snapshot → verify baud rate dropdown shows 115200
browser_click → baud rate dropdown
browser_click → select 57600
browser_navigate → http://localhost:5173 (reload)
browser_wait_for → time=1
browser_snapshot → verify baud rate shows 57600
```

**Step 4: Verify PWA manifest**

```
browser_navigate → http://localhost:5173/manifest.webmanifest
browser_snapshot → verify manifest JSON with name, icons, theme_color
```

**Step 5: Check console for errors**

```
browser_console_messages(level="error") → no JS errors (except favicon 404)
```

**Step 6: Verify production build**

```bash
npm run build
# Verify sw.js exists
ls dist/sw.js
# Verify manifest exists
cat dist/manifest.webmanifest
```

**Acceptance criteria checklist:**

| Criterion | Verification method |
|-----------|-------------------|
| Settings save to IndexedDB | Theme persists across reload |
| Settings load on app start | Theme restored after reload |
| Missing keys use defaults | Unit test covers this |
| Theme persists across reload | Playwright verify |
| Baud rate persists across reload | Playwright verify |
| Service worker generated | `npm run build` output |
| Manifest serves correctly | Navigate to manifest URL |
| Debounced save (2s) | Unit test / code review |

---

## Notes

- **Ownership boundary**: Settings service owns app preferences. Grid layout is owned by TelemetryView (`mavdeck-layout-v1` key). Don't duplicate.
- **Forward-compatibility**: `loadSettings()` spreads saved over defaults, so new keys added later get default values automatically.
- **Debounce**: `saveSettingsDebounced` prevents rapid writes to IndexedDB when the user is changing settings quickly.
- **SVG icon**: Modern PWA manifests accept SVG icons with `sizes: "any"`. No need for bitmap PNGs.
- **`autoConnect` from PLAN.md**: Skipped per YAGNI — no auto-connect UI exists yet. Can add when needed.
- **`plotTabs` in settings**: Skipped — plots are already persisted in `mavdeck-layout-v1`. Adding them to settings would create dual ownership.
