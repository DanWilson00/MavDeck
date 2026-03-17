import { Show, For } from 'solid-js';
import { appState, setAppState } from '../store';
import { useLogViewerService, useSerialSessionController, isSerialSupported, isWebSerialSupported } from '../services';
import { STATUS_COLORS, type TimeWindow } from '../models';
import SettingsModal from './SettingsModal';

const TIME_WINDOW_OPTIONS: TimeWindow[] = [5, 10, 30, 60, 120, 300];

interface ToolbarProps {
  onSelectTab: (tabId: 'telemetry' | 'map') => void;
}

export default function Toolbar(props: ToolbarProps) {
  const serialSessionController = useSerialSessionController();
  const logViewerService = useLogViewerService();

  async function handleConnectSerial() {
    if (!appState.isReady) return;
    if (appState.connectionStatus === 'connected' || appState.connectionStatus === 'connecting' || appState.connectionStatus === 'no_data') {
      serialSessionController.disconnectLiveSession();
      return;
    }
    await serialSessionController.connectManual({
      baudRate: appState.baudRate,
      autoDetectBaud: appState.autoDetectBaud,
      lastBaudRate: appState.lastSuccessfulBaudRate,
      unloadLog: appState.logViewerState.isActive,
    });
  }

  function handleDisconnectSerial() {
    if (!appState.isReady) return;
    serialSessionController.disconnectLiveSession();
  }

  async function handleGrantAccess() {
    if (!appState.isReady) return;
    await serialSessionController.grantAccess();
  }

  function handlePause() {
    if (!appState.isReady) return;
    if (appState.logViewerState.isActive) return;
    setAppState('isPaused', !appState.isPaused);
  }

  const isConnected = () => appState.connectionStatus === 'connected' || appState.connectionStatus === 'connecting' || appState.connectionStatus === 'no_data';

  return (
    <header
      class="flex items-center justify-between px-4 h-12 border-b"
      style={{
        'background-color': 'var(--bg-panel)',
        'border-color': 'var(--border)',
      }}
    >
      {/* Left: Tab navigation */}
      <div class="flex items-center gap-1">
        <div
          class="flex rounded-md overflow-hidden"
          style={{ border: '1px solid var(--border)', 'background-color': 'var(--bg-hover)' }}
        >
          <SegmentButton id="telemetry" label="Telemetry" onSelect={props.onSelectTab} />
          <SegmentButton id="map" label="Map" isLast={true} onSelect={props.onSelectTab} />
        </div>
        <ModeToggle />
      </div>

      {/* Right: Controls */}
      <div class="flex items-center gap-3">
        {/* Serial connection */}
        <Show when={isSerialSupported() && !appState.logViewerState.isActive}>
          <Show when={!appState.autoConnect} fallback={
            /* Auto-connect mode: only grant access + probe status */
            <>
              <Show when={!isConnected()}>
                <button
                  onClick={handleGrantAccess}
                  class="px-3 py-1 rounded text-sm font-medium transition-colors"
                  style={{
                    'background-color': 'var(--bg-hover)',
                    color: 'var(--text-primary)',
                  }}
                >
                  Grant Serial Access
                </button>
              </Show>
              <Show when={appState.probeStatus && !isConnected()}>
                <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {appState.probeStatus}
                </span>
              </Show>
            </>
          }>
            {/* Manual mode */}
            <Show when={!isConnected()} fallback={
              <button
                onClick={handleDisconnectSerial}
                class="px-3 py-1 rounded text-sm font-medium transition-colors"
                style={{
                  'background-color': 'var(--bg-hover)',
                  color: 'var(--text-primary)',
                }}
              >
                Disconnect
              </button>
            }>
              <button
                onClick={handleConnectSerial}
                class="px-3 py-1 rounded text-sm font-medium transition-colors"
                style={{
                  'background-color': 'var(--bg-hover)',
                  color: 'var(--text-primary)',
                }}
              >
                {isWebSerialSupported() ? 'Connect Serial' : 'Connect USB'}
              </button>
            </Show>
            <Show when={appState.probeStatus}>
              <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {appState.probeStatus}
              </span>
            </Show>
          </Show>
        </Show>

        {/* Status dot */}
        <div
          class="w-2.5 h-2.5 rounded-full transition-colors"
          title={appState.connectionStatus}
          style={{ 'background-color': STATUS_COLORS[appState.connectionStatus] }}
        />

        {/* Pause/Resume — only when connected */}
        <Show when={(appState.connectionStatus === 'connected' || appState.connectionStatus === 'no_data') && !appState.logViewerState.isActive}>
          <button
            onClick={handlePause}
            class="p-1.5 rounded interactive-hover"
            style={{ color: 'var(--text-secondary)' }}
            title={appState.isPaused ? 'Resume' : 'Pause'}
            aria-label={appState.isPaused ? 'Resume' : 'Pause'}
          >
            {appState.isPaused ? <PlayIcon /> : <PauseIcon />}
          </button>
        </Show>

        {/* Unload log button — only when a log is loaded */}
        <Show when={appState.logViewerState.isActive}>
          <button
            class="px-2 py-1 rounded text-xs interactive-hover"
            style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-primary)' }}
            onClick={() => logViewerService.unload()}
          >
            Unload Log
          </button>
        </Show>

        {/* Telemetry controls — only when on telemetry tab and services ready */}
        <Show when={appState.activeTab === 'telemetry' && appState.isReady}>
          <button
            onClick={() => setAppState('addPlotCounter', c => c + 1)}
            class="p-1.5 rounded interactive-hover"
            style={{ color: 'var(--text-secondary)' }}
            title="Add plot"
            aria-label="Add plot"
          >
            <PlusIcon />
          </button>

          <Show when={!appState.logViewerState.isActive}>
            <div class="flex items-center gap-1">
              <select
                class="text-xs rounded px-1 py-0.5"
                style={{
                  'background-color': 'var(--bg-hover)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
                value={appState.timeWindow}
                onChange={(e) => setAppState('timeWindow', Number(e.currentTarget.value) as TimeWindow)}
              >
                <For each={TIME_WINDOW_OPTIONS}>
                  {(tw) => (
                    <option value={tw}>
                      {tw >= 60 ? `${tw / 60}m` : `${tw}s`}
                    </option>
                  )}
                </For>
              </select>
            </div>
          </Show>
        </Show>

        <button
          onClick={() => setAppState('isSettingsOpen', true)}
          class="p-1.5 rounded transition-colors interactive-hover"
          style={{
            'background-color': 'var(--bg-hover)',
            color: 'var(--text-secondary)',
          }}
          title="Open settings"
          aria-label="Open settings"
        >
          <SettingsIcon />
        </button>
      </div>

      <Show when={appState.isSettingsOpen}>
        <SettingsModal onClose={() => setAppState('isSettingsOpen', false)} />
      </Show>
    </header>
  );
}

function SegmentButton(props: { id: 'telemetry' | 'map'; label: string; isLast?: boolean; onSelect: (tabId: 'telemetry' | 'map') => void }) {
  const isActive = () => appState.activeTab === props.id;
  return (
    <button
      onClick={() => props.onSelect(props.id)}
      class="px-3 py-1 text-sm font-medium transition-colors"
      style={{
        'background-color': isActive() ? 'var(--bg-panel)' : 'transparent',
        color: isActive() ? 'var(--accent)' : 'var(--text-secondary)',
        'border-right': props.isLast ? 'none' : '1px solid var(--border)',
      }}
    >
      {props.label}
    </button>
  );
}

function ModeToggle() {
  return (
    <Show when={appState.logViewerState.isActive}>
      <span class="ml-2 px-2 py-0.5 text-xs rounded" style={{ 'background-color': 'var(--accent)', color: '#000' }}>
        Log: {appState.logViewerState.sourceName}
      </span>
    </Show>
  );
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="6,4 20,12 6,20" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.76l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.76-.32 1.6 1.6 0 0 0-.98 1.47V21a2 2 0 1 1-4 0v-.09a1.6 1.6 0 0 0-.98-1.47 1.6 1.6 0 0 0-1.76.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.76 1.6 1.6 0 0 0-1.47-.98H3a2 2 0 1 1 0-4h.09a1.6 1.6 0 0 0 1.47-.98 1.6 1.6 0 0 0-.32-1.76l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.76.32h.02a1.6 1.6 0 0 0 .96-1.47V3a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 .98 1.47 1.6 1.6 0 0 0 1.76-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.76v.02a1.6 1.6 0 0 0 1.47.96H21a2 2 0 1 1 0 4h-.09a1.6 1.6 0 0 0-1.51 1.19z" />
    </svg>
  );
}
