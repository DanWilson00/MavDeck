import { createSignal, onMount, onCleanup } from 'solid-js';
import { appState, setAppState, workerBridge, registry, connectionManager } from '../store';
import { BAUD_RATES, saveDialect, clearDialect, loadBundledDialect } from '../services';
import type { BaudRate } from '../services';
import { parseFromFileMap } from '../mavlink/xml-parser';

const UI_SCALE_MIN = 0.6;
const UI_SCALE_MAX = 1.8;
const UI_SCALE_STEP = 0.05;
const BUFFER_CAPACITY_MIN = 100;
const BUFFER_CAPACITY_MAX = 20000;
const BUFFER_CAPACITY_STEP = 100;
const TRAIL_LENGTH_MIN = 50;
const TRAIL_LENGTH_MAX = 5000;
const TRAIL_LENGTH_STEP = 50;

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal(props: SettingsModalProps) {
  const [importError, setImportError] = createSignal<string | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);
  let fileInputRef: HTMLInputElement | undefined;

  onMount(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
  });

  function setUiScale(value: number) {
    const rounded = Math.round(value * 100) / 100;
    const clamped = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, rounded));
    setAppState('uiScale', clamped);
  }

  function setBufferCapacity(value: number) {
    const rounded = Math.round(value / BUFFER_CAPACITY_STEP) * BUFFER_CAPACITY_STEP;
    const clamped = Math.max(BUFFER_CAPACITY_MIN, Math.min(BUFFER_CAPACITY_MAX, rounded));
    setAppState('bufferCapacity', clamped);
  }

  function setTrailLength(value: number) {
    const rounded = Math.round(value / TRAIL_LENGTH_STEP) * TRAIL_LENGTH_STEP;
    const clamped = Math.max(TRAIL_LENGTH_MIN, Math.min(TRAIL_LENGTH_MAX, rounded));
    setAppState('mapTrailLength', clamped);
  }

  async function handleFileSelected(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    setImportError(null);

    // Auto-disconnect before re-initializing with a new dialect
    if (appState.connectionStatus === 'connected' || appState.connectionStatus === 'connecting') {
      connectionManager.disconnect();
    }

    try {
      // Read all files into a map
      const fileMap = new Map<string, string>();
      for (const file of files) {
        const text = await file.text();
        fileMap.set(file.name, text);
      }
      input.value = '';

      // Transitively resolve all missing includes from bundled dialects
      let missing = detectMissingIncludes(fileMap);
      while (missing.length > 0) {
        for (const name of missing) {
          const resp = await fetch(`${import.meta.env.BASE_URL}dialects/${name}`);
          if (!resp.ok) {
            throw new Error(`Missing dialect file: ${name}. Select all required XML files together.`);
          }
          fileMap.set(name, await resp.text());
        }
        missing = detectMissingIncludes(fileMap);
      }

      // Auto-detect main file: the one not included by any other file
      const mainFile = detectMainDialect(fileMap);

      const jsonString = parseFromFileMap(fileMap, mainFile);
      await workerBridge.init(jsonString);
      registry.loadFromJsonString(jsonString);
      setAppState('dialectName', mainFile.replace(/\.xml$/i, ''));
      await saveDialect(mainFile.replace(/\.xml$/i, ''), jsonString);
    } catch (err) {
      console.error('[SettingsModal] Dialect import failed:', err);
      setImportError(err instanceof Error ? err.message : 'Failed to import dialect file.');
    }
  }

  async function handleRefreshDialect() {
    setImportError(null);
    setRefreshing(true);

    if (appState.connectionStatus === 'connected' || appState.connectionStatus === 'connecting') {
      connectionManager.disconnect();
    }

    try {
      // Clear any custom dialect, re-parse bundled XML (no caching)
      await clearDialect();

      const jsonString = await loadBundledDialect();
      await workerBridge.init(jsonString);
      registry.loadFromJsonString(jsonString);
      setAppState('dialectName', 'common');
    } catch (err) {
      console.error('[SettingsModal] Dialect refresh failed:', err);
      setImportError(err instanceof Error ? err.message : 'Failed to refresh dialect.');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div
      class="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ 'background-color': 'rgba(0,0,0,0.45)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          props.onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div
        class="w-[440px] max-w-[92vw] max-h-[88vh] overflow-y-auto rounded-lg border shadow-xl"
        style={{
          'background-color': 'var(--bg-panel)',
          'border-color': 'var(--border)',
        }}
      >
        <div class="flex items-center justify-between px-4 py-3 border-b" style={{ 'border-color': 'var(--border)' }}>
          <h2 class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Settings</h2>
          <button
            class="rounded p-1.5 interactive-hover"
            style={{ color: 'var(--text-secondary)' }}
            onClick={props.onClose}
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        </div>

        <div class="p-4 space-y-5">
          <section class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              Appearance
            </h3>
            <div class="flex items-center gap-2">
              <button
                class="px-3 py-1.5 text-sm rounded border interactive-hover"
                style={{
                  'border-color': appState.theme === 'dark' ? 'var(--accent)' : 'var(--border)',
                  color: appState.theme === 'dark' ? 'var(--accent)' : 'var(--text-primary)',
                }}
                onClick={() => setAppState('theme', 'dark')}
              >
                Dark
              </button>
              <button
                class="px-3 py-1.5 text-sm rounded border interactive-hover"
                style={{
                  'border-color': appState.theme === 'light' ? 'var(--accent)' : 'var(--border)',
                  color: appState.theme === 'light' ? 'var(--accent)' : 'var(--text-primary)',
                }}
                onClick={() => setAppState('theme', 'light')}
              >
                Light
              </button>
            </div>
            <div>
              <label class="text-xs font-medium" style={{ color: 'var(--text-secondary)' }} for="ui-scale-range">
                UI Zoom ({Math.round(appState.uiScale * 100)}%)
              </label>
              <div class="flex items-center gap-3 mt-1.5">
                <input
                  id="ui-scale-range"
                  type="range"
                  min={UI_SCALE_MIN}
                  max={UI_SCALE_MAX}
                  step={UI_SCALE_STEP}
                  value={appState.uiScale}
                  onInput={(e) => setUiScale(Number(e.currentTarget.value))}
                  class="w-full"
                />
                <button
                  class="px-2 py-1 text-xs rounded border interactive-hover"
                  style={{ 'border-color': 'var(--border)', color: 'var(--text-primary)' }}
                  onClick={() => setUiScale(1)}
                >
                  Reset
                </button>
              </div>
            </div>
          </section>

          <section class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              Connection
            </h3>
            <div>
              <label class="text-xs font-medium" style={{ color: 'var(--text-secondary)' }} for="baud-rate-select">
                Serial Baud Rate
              </label>
              <select
                id="baud-rate-select"
                class="w-full mt-1 rounded px-2 py-1.5 text-sm"
                style={{
                  'background-color': 'var(--bg-hover)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
                value={appState.baudRate}
                onChange={(e) => setAppState('baudRate', Number(e.currentTarget.value) as BaudRate)}
              >
                {BAUD_RATES.map(rate => <option value={rate}>{rate}</option>)}
              </select>
            </div>
            <div>
              <label class="text-xs font-medium" style={{ color: 'var(--text-secondary)' }} for="buffer-capacity-input">
                Telemetry Buffer Capacity (samples per field)
              </label>
              <input
                id="buffer-capacity-input"
                type="number"
                min={BUFFER_CAPACITY_MIN}
                max={BUFFER_CAPACITY_MAX}
                step={BUFFER_CAPACITY_STEP}
                value={appState.bufferCapacity}
                class="w-full mt-1 rounded px-2 py-1.5 text-sm"
                style={{
                  'background-color': 'var(--bg-hover)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
                onInput={(e) => setBufferCapacity(Number(e.currentTarget.value))}
                onBlur={(e) => setBufferCapacity(Number(e.currentTarget.value))}
              />
            </div>
          </section>

          <section class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              Map
            </h3>
            <div>
              <label class="text-xs font-medium" style={{ color: 'var(--text-secondary)' }} for="trail-length-input">
                Trail Length (data points)
              </label>
              <input
                id="trail-length-input"
                type="number"
                min={TRAIL_LENGTH_MIN}
                max={TRAIL_LENGTH_MAX}
                step={TRAIL_LENGTH_STEP}
                value={appState.mapTrailLength}
                class="w-full mt-1 rounded px-2 py-1.5 text-sm"
                style={{
                  'background-color': 'var(--bg-hover)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
                onInput={(e) => setTrailLength(Number(e.currentTarget.value))}
                onBlur={(e) => setTrailLength(Number(e.currentTarget.value))}
              />
            </div>
          </section>

          <section class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              Dialect
            </h3>
            <p class="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Current: {appState.dialectName}
            </p>
            <div class="flex items-center gap-2">
              <button
                class="px-3 py-1.5 text-sm rounded border interactive-hover"
                style={{ 'border-color': 'var(--border)', color: 'var(--text-primary)' }}
                onClick={() => fileInputRef?.click()}
                disabled={!appState.isReady}
              >
                Import Dialect XML
              </button>
              <button
                class="px-3 py-1.5 text-sm rounded border interactive-hover"
                style={{ 'border-color': 'var(--border)', color: 'var(--text-primary)' }}
                onClick={handleRefreshDialect}
                disabled={!appState.isReady || refreshing()}
              >
                {refreshing() ? 'Refreshing...' : 'Reset to Default'}
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xml"
              multiple
              class="hidden"
              onChange={handleFileSelected}
            />
            {importError() && (
              <p class="text-xs" style={{ color: '#ef4444' }}>
                {importError()}
              </p>
            )}
          </section>

          <section class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              Offline
            </h3>
            <p
              class="text-xs"
              style={{
                color:
                  appState.offlineStatus === 'ready'
                    ? '#22c55e'
                    : appState.offlineStatus === 'error'
                      ? '#ef4444'
                      : 'var(--text-secondary)',
              }}
            >
              {appState.offlineStatus === 'ready'
                ? 'Offline ready: app shell is cached for reopen without internet.'
                : appState.offlineStatus === 'error'
                  ? `Offline cache setup failed: ${appState.offlineError ?? 'unknown error'}`
                  : appState.offlineStatus === 'unsupported'
                    ? 'Offline cache is not supported in this browser.'
                    : 'Preparing offline cache. Open once online to finish setup.'}
            </p>
          </section>

          <section class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
              About
            </h3>
            <p class="text-xs" style={{ color: 'var(--text-secondary)' }}>
              MavDeck v0.0.1
            </p>
            <p class="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Built by Dan Wilson
            </p>
            <button
              class="px-3 py-1.5 text-sm rounded border interactive-hover"
              style={{ 'border-color': 'var(--border)', color: 'var(--text-primary)' }}
              onClick={() => {
                props.onClose();
                setAppState('isHelpOpen', true);
              }}
            >
              View Help
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

function detectMissingIncludes(fileMap: Map<string, string>): string[] {
  const parser = new DOMParser();
  const missing: string[] = [];
  for (const [, content] of fileMap) {
    const doc = parser.parseFromString(content, 'text/xml');
    for (const el of doc.querySelectorAll('include')) {
      const inc = el.textContent?.trim() ?? '';
      const normalized = inc.split('/').pop()!.split('\\').pop()!;
      if (normalized && !fileMap.has(normalized)) {
        missing.push(normalized);
      }
    }
  }
  return [...new Set(missing)];
}

function detectMainDialect(fileMap: Map<string, string>): string {
  const filenames = [...fileMap.keys()];
  console.log('[detectMainDialect] files:', filenames);
  if (filenames.length === 1) return filenames[0];

  // Collect all included filenames across all files
  const included = new Set<string>();
  const parser = new DOMParser();
  for (const [name, content] of fileMap) {
    const doc = parser.parseFromString(content, 'text/xml');
    const els = doc.querySelectorAll('include');
    for (const el of els) {
      const inc = el.textContent?.trim() ?? '';
      // Normalize: extract just the filename (includes may have paths)
      const normalized = inc.split('/').pop()!.split('\\').pop()!;
      included.add(normalized);
    }
    console.log('[detectMainDialect]', name, '→ includes:', [...els].map(e => e.textContent?.trim()));
  }

  // Main file = not referenced by any include
  const roots = filenames.filter(f => !included.has(f));
  console.log('[detectMainDialect] included set:', [...included], 'roots:', roots);
  if (roots.length === 1) return roots[0];
  if (roots.length > 1) {
    throw new Error(
      `Multiple root dialects found: ${roots.join(', ')}. Select only the main dialect and its dependencies.`
    );
  }
  throw new Error(
    `Cannot auto-detect main dialect. Files: ${filenames.join(', ')}. All appear in include chains: ${[...included].join(', ')}.`
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
