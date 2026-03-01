import { onMount, onCleanup, createEffect, createSignal, batch, Show } from 'solid-js';
import ThemeProvider from './components/ThemeProvider';
import Toolbar from './components/Toolbar';
import TelemetryView from './components/TelemetryView';
import MapView from './components/MapView';
import { appState, setAppState, setWorkerBridge, setConnectionManager, setRegistry } from './store/app-store';
import { MavlinkWorkerBridge } from './services/worker-bridge';
import { ConnectionManager } from './services/connection-manager';
import { MavlinkMetadataRegistry } from './mavlink/registry';
import { loadSettings, saveSettingsDebounced, DEFAULT_SETTINGS } from './services/settings-service';

const MAP_REQUIRED_FIELDS = [
  'GLOBAL_POSITION_INT.lat',
  'GLOBAL_POSITION_INT.lon',
  'GLOBAL_POSITION_INT.alt',
  'GLOBAL_POSITION_INT.hdg',
];

export default function App() {
  const [loading, setLoading] = createSignal(true);
  const [settingsLoaded, setSettingsLoaded] = createSignal(false);
  let bridge: MavlinkWorkerBridge | undefined;
  let connMgr: ConnectionManager | undefined;
  let loadedSettings = { ...DEFAULT_SETTINGS };

  // Persist settings reactively when display/connection preferences change.
  createEffect(() => {
    if (!settingsLoaded()) return;
    saveSettingsDebounced({
      ...loadedSettings,
      theme: appState.theme,
      uiScale: appState.uiScale,
      baudRate: appState.baudRate,
      bufferCapacity: appState.bufferCapacity,
      mapShowPath: appState.mapShowPath,
      mapTrailLength: appState.mapTrailLength,
      mapLayer: appState.mapLayer,
      mapZoom: appState.mapZoom,
      mapAutoCenter: appState.mapAutoCenter,
    });
  });

  // Apply telemetry buffer-capacity changes immediately in worker.
  createEffect(() => {
    if (!appState.isReady || !bridge) return;
    bridge.setBufferCapacity(appState.bufferCapacity);
  });

  // Stream only fields needed by active views.
  createEffect(() => {
    if (!appState.isReady || !bridge) return;

    const interested = new Set<string>(MAP_REQUIRED_FIELDS);
    const activeTab = appState.plotTabs.find(t => t.id === appState.activeSubTab);
    for (const plot of activeTab?.plots ?? []) {
      for (const signal of plot.signals) {
        if (signal.visible) {
          interested.add(signal.fieldKey);
        }
      }
    }

    bridge.setInterestedFields([...interested]);
  });

  // Global keyboard shortcuts
  onMount(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't handle shortcuts when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key) {
        case ' ': {
          e.preventDefault();
          if (appState.connectionStatus !== 'connected') return;
          setAppState('isPaused', !appState.isPaused);
          break;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
  });

  onMount(async () => {
    try {
      // Load persisted settings and apply to store
      const settings = await loadSettings();
      loadedSettings = settings;
      batch(() => {
        setAppState('theme', settings.theme);
        setAppState('uiScale', settings.uiScale);
        setAppState('baudRate', settings.baudRate);
        setAppState('bufferCapacity', settings.bufferCapacity);
        setAppState('mapShowPath', settings.mapShowPath);
        setAppState('mapTrailLength', settings.mapTrailLength);
        setAppState('mapLayer', settings.mapLayer);
        setAppState('mapZoom', settings.mapZoom);
        setAppState('mapAutoCenter', settings.mapAutoCenter);
      });
      setSettingsLoaded(true);

      // Load dialect
      const response = await fetch(`${import.meta.env.BASE_URL}dialects/common.json`);
      if (!response.ok) {
        throw new Error(`Failed to load dialect: ${response.status} ${response.statusText}`);
      }
      const json = await response.text();

      // Initialize registry
      const reg = new MavlinkMetadataRegistry();
      reg.loadFromJsonString(json);
      setRegistry(reg);

      // Initialize worker bridge
      bridge = new MavlinkWorkerBridge();
      await bridge.init(json);
      setWorkerBridge(bridge);

      // Initialize connection manager
      connMgr = new ConnectionManager(bridge);
      setConnectionManager(connMgr);

      setAppState('isReady', true);
      setLoading(false);
    } catch (err) {
      console.error('MavDeck initialization failed:', err);
      setAppState('connectionStatus', 'error');
      setLoading(false);
    }
  });

  onCleanup(() => {
    connMgr?.disconnect();
    connMgr?.dispose();
    bridge?.dispose();
  });

  return (
    <ThemeProvider>
      <Show when={!loading()} fallback={
        <div class="flex items-center justify-center h-screen" style={{ 'background-color': 'var(--bg-primary)' }}>
          <div class="text-center">
            <div class="text-lg font-medium" style={{ color: 'var(--text-primary)' }}>MavDeck</div>
            <div class="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>Loading dialect...</div>
          </div>
        </div>
      }>
        <div class="flex flex-col h-screen" style={{ 'background-color': 'var(--bg-primary)' }}>
          <Toolbar />
          <main class="flex-1 overflow-hidden">
            <Show when={appState.activeTab === 'telemetry'}>
              <TelemetryView />
            </Show>
            <Show when={appState.activeTab === 'map'}>
              <MapView />
            </Show>
          </main>
        </div>
      </Show>
    </ThemeProvider>
  );
}
