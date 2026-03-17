import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { appState, setAppState } from '../store';
import packageJson from '../../package.json';
import {
  BAUD_RATES, UNIT_PROFILES, saveDialect, clearDialect, loadBundledDialect,
  initDialect, detectMissingIncludes, detectMainDialect, useRegistry,
  useSerialSessionController, useWorkerBridge, isSerialSupported, isWebSerialSupported,
  getSerialBackend, diagnoseFtdiUsb,
} from '../services';
import type { BaudRate, UnitProfile, UsbDiagnostic } from '../services';
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

type SettingsTab = 'general' | 'serial' | 'advanced';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'serial', label: 'Serial' },
  { id: 'advanced', label: 'Advanced' },
];

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal(props: SettingsModalProps) {
  const registry = useRegistry();
  const serialSessionController = useSerialSessionController();
  const workerBridge = useWorkerBridge();
  const [activeTab, setActiveTab] = createSignal<SettingsTab>('general');
  const [importError, setImportError] = createSignal<string | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);
  const [usbDiag, setUsbDiag] = createSignal<UsbDiagnostic | null>(null);
  const [diagRunning, setDiagRunning] = createSignal(false);
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

  function disconnectIfActive() {
    if (appState.connectionStatus === 'connected' || appState.connectionStatus === 'connecting' || appState.connectionStatus === 'no_data') {
      serialSessionController.disconnectLiveSession();
    }
  }

  async function handleFileSelected(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    setImportError(null);

    // Auto-disconnect before re-initializing with a new dialect
    disconnectIfActive();

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
      await initDialect(workerBridge, registry, jsonString);
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

    disconnectIfActive();

    try {
      // Clear any custom dialect, re-parse bundled XML (no caching)
      await clearDialect();

      const jsonString = await loadBundledDialect();
      await initDialect(workerBridge, registry, jsonString);
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
        class="w-[440px] max-w-[92vw] max-h-[88vh] flex flex-col rounded-lg border shadow-xl"
        style={{
          'background-color': 'var(--bg-panel)',
          'border-color': 'var(--border)',
        }}
      >
        {/* Header */}
        <div class="flex items-center justify-between px-4 py-3 border-b" style={{ 'border-color': 'var(--border)' }}>
          <h2 class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Settings</h2>
          <div class="flex items-center gap-1">
            <button
              class="rounded p-1.5 interactive-hover"
              style={{ color: 'var(--text-secondary)' }}
              onClick={() => {
                props.onClose();
                setAppState('isHelpOpen', true);
              }}
              aria-label="Help"
            >
              <HelpIcon />
            </button>
            <button
              class="rounded p-1.5 interactive-hover"
              style={{ color: 'var(--text-secondary)' }}
              onClick={props.onClose}
              aria-label="Close settings"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div
          class="flex gap-1 px-4 pt-2 pb-0 border-b"
          style={{ 'border-color': 'var(--border)' }}
          role="tablist"
        >
          {TABS.map(tab => (
            <button
              role="tab"
              aria-selected={activeTab() === tab.id}
              class="px-3 py-1.5 text-xs font-medium rounded-t transition-colors"
              style={{
                color: activeTab() === tab.id ? 'var(--accent)' : 'var(--text-secondary)',
                'border-bottom': activeTab() === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
                'margin-bottom': '-1px',
              }}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          {/* General tab */}
          <Show when={activeTab() === 'general'}>
            <div role="tabpanel" class="space-y-4">
              <SectionLabel>Theme</SectionLabel>
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

              <SectionLabel>Display</SectionLabel>
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
              <div>
                <label class="text-xs font-medium" style={{ color: 'var(--text-secondary)' }} for="unit-profile-select">
                  Unit Profile
                </label>
                <select
                  id="unit-profile-select"
                  class="w-full mt-1 rounded px-2 py-1.5 text-sm"
                  style={{
                    'background-color': 'var(--bg-hover)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                  }}
                  value={appState.unitProfile}
                  onChange={(e) => setAppState('unitProfile', e.currentTarget.value as UnitProfile)}
                >
                  {UNIT_PROFILES.map(profile => (
                    <option value={profile}>
                      {profile[0].toUpperCase() + profile.slice(1)}
                    </option>
                  ))}
                </select>
              </div>

              <SectionLabel>Map</SectionLabel>
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
            </div>
          </Show>

          {/* Serial tab */}
          <Show when={activeTab() === 'serial'}>
            <div role="tabpanel" class="space-y-4">
              <Show
                when={isSerialSupported()}
                fallback={
                  <p class="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Serial/USB connections are not supported in this browser.
                  </p>
                }
              >
                <Show when={isWebSerialSupported()}>
                  <ToggleSwitch
                    id="auto-connect-toggle"
                    label="Auto-connect serial"
                    description="Automatically connect to a MAVLink device when one is detected."
                    checked={appState.autoConnect}
                    onChange={(v) => setAppState('autoConnect', v)}
                  />
                </Show>
                <ToggleSwitch
                  id="auto-baud-toggle"
                  label="Auto-detect baud rate"
                  description="Try different baud rates to find the correct one."
                  checked={appState.autoDetectBaud}
                  onChange={(v) => setAppState('autoDetectBaud', v)}
                />
                <div style={{ opacity: appState.autoDetectBaud ? 0.5 : 1 }}>
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

                <Divider />

                <button
                  class="px-3 py-1.5 text-sm rounded border interactive-hover"
                  style={{ 'border-color': 'var(--border)', color: 'var(--text-primary)' }}
                  onClick={async () => {
                    await serialSessionController.forgetAllPorts();
                  }}
                >
                  Forget All Ports
                </button>

                <Show when={getSerialBackend() === 'webusb'}>
                  <Divider />
                  <SectionLabel>USB Diagnostics</SectionLabel>
                  <button
                    class="px-3 py-1.5 text-sm rounded border interactive-hover"
                    style={{ 'border-color': 'var(--border)', color: 'var(--text-primary)' }}
                    disabled={diagRunning()}
                    onClick={async () => {
                      setDiagRunning(true);
                      try {
                        setUsbDiag(await diagnoseFtdiUsb());
                      } finally {
                        setDiagRunning(false);
                      }
                    }}
                  >
                    {diagRunning() ? 'Testing...' : 'Test USB Connection'}
                  </button>

                  <Show when={usbDiag()}>
                    {(diag) => (
                      <div class="space-y-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <div class="flex items-center gap-2">
                          <span
                            class="inline-block w-2 h-2 rounded-full"
                            style={{ 'background-color': diag().webUsbAvailable ? '#22c55e' : '#ef4444' }}
                          />
                          <span>WebUSB: {diag().webUsbAvailable ? 'Available' : 'Not available'}</span>
                        </div>
                        <div>Granted devices: {diag().grantedDevices}</div>
                        <div>FTDI devices: {diag().ftdiDevices}</div>

                        <Show when={diag().allDeviceInfo.length > 0}>
                          <div class="mt-1 space-y-1">
                            {diag().allDeviceInfo.map(d => (
                              <div
                                class="px-2 py-1 rounded text-xs font-mono"
                                style={{ 'background-color': 'var(--bg-hover)' }}
                              >
                                VID:0x{d.vendorId.toString(16).padStart(4, '0')} PID:0x{d.productId.toString(16).padStart(4, '0')}
                                {d.productName ? ` — ${d.productName}` : ''}
                              </div>
                            ))}
                          </div>
                        </Show>

                        <Show when={diag().grantedDevices === 0}>
                          <div
                            class="mt-2 p-2 rounded text-xs"
                            style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-primary)' }}
                          >
                            <p class="font-medium mb-1">No USB devices detected. Try:</p>
                            <ul class="list-disc pl-4 space-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                              <li>Check USB OTG is enabled in Android settings</li>
                              <li>Try a different OTG adapter or cable</li>
                              <li>Test with a USB flash drive or mouse first</li>
                              <li>Try a powered USB hub between OTG and FTDI</li>
                              <li>Verify Android 9+ and Chrome 61+</li>
                            </ul>
                          </div>
                        </Show>

                        <Show when={diag().grantedDevices > 0 && diag().ftdiDevices === 0}>
                          <p style={{ color: '#f59e0b' }}>
                            USB devices found but no FTDI adapter — check the adapter connection.
                          </p>
                        </Show>
                      </div>
                    )}
                  </Show>
                </Show>
              </Show>
            </div>
          </Show>

          {/* Advanced tab */}
          <Show when={activeTab() === 'advanced'}>
            <div role="tabpanel" class="space-y-4">
              <SectionLabel>Data</SectionLabel>
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

              <Divider />

              <SectionLabel>Dialect</SectionLabel>
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

              <Divider />

              <SectionLabel>Simulator</SectionLabel>
              <button
                class="px-3 py-1.5 text-sm rounded border interactive-hover"
                style={{ 'border-color': 'var(--border)', color: 'var(--text-primary)' }}
                onClick={() => {
                  if ((appState.connectionStatus === 'connected' || appState.connectionStatus === 'no_data') && appState.connectionSourceType === 'spoof') {
                    serialSessionController.disconnectLiveSession();
                  } else {
                    serialSessionController.connectSpoof({ unloadLog: appState.logViewerState.isActive });
                  }
                }}
              >
                {(appState.connectionStatus === 'connected' || appState.connectionStatus === 'no_data') && appState.connectionSourceType === 'spoof'
                  ? 'Disconnect Simulator'
                  : 'Connect Simulator'}
              </button>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <div
          class="flex items-center justify-between px-4 py-2 border-t text-xs"
          style={{ 'border-color': 'var(--border)', color: 'var(--text-secondary)' }}
        >
          <span>MavDeck v{packageJson.version}</span>
          <span class="flex items-center gap-1.5">
            <span
              class="inline-block w-2 h-2 rounded-full"
              style={{
                'background-color':
                  appState.offlineStatus === 'ready'
                    ? '#22c55e'
                    : appState.offlineStatus === 'error'
                      ? '#ef4444'
                      : appState.offlineStatus === 'unsupported'
                        ? 'var(--text-secondary)'
                        : '#f59e0b',
              }}
            />
            {appState.offlineStatus === 'ready'
              ? 'Offline ready'
              : appState.offlineStatus === 'error'
                ? 'Offline error'
                : appState.offlineStatus === 'unsupported'
                  ? 'Offline N/A'
                  : 'Caching...'}
          </span>
        </div>
      </div>
    </div>
  );
}

function SectionLabel(props: { children: string }) {
  return (
    <h3 class="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
      {props.children}
    </h3>
  );
}

function Divider() {
  return <hr class="border-0 border-t" style={{ 'border-color': 'var(--border)' }} />;
}

function ToggleSwitch(props: { id: string; label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div class="flex items-start gap-3">
      <button
        id={props.id}
        role="switch"
        aria-checked={props.checked}
        class="mt-0.5 relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors"
        style={{
          'background-color': props.checked ? 'var(--accent)' : 'var(--bg-hover)',
          border: '1px solid var(--border)',
        }}
        onClick={() => props.onChange(!props.checked)}
      >
        <span
          class="inline-block h-3.5 w-3.5 rounded-full transition-transform mt-[2px]"
          style={{
            'background-color': props.checked ? '#000' : 'var(--text-secondary)',
            transform: props.checked ? 'translateX(17px)' : 'translateX(2px)',
          }}
        />
      </button>
      <div>
        <label class="text-xs font-medium cursor-pointer" style={{ color: 'var(--text-primary)' }} for={props.id}>
          {props.label}
        </label>
        <p class="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{props.description}</p>
      </div>
    </div>
  );
}

function HelpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
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
