import { onMount, onCleanup, createEffect, batch, Show } from 'solid-js';
import ThemeProvider from './components/ThemeProvider';
import Toolbar from './components/Toolbar';
import TabBar from './components/TabBar';
import TelemetryView from './components/TelemetryView';
import MapView from './components/MapView';
import { appState, setAppState, setWorkerBridge, setConnectionManager, setRegistry, connectionManager } from './store/app-store';
import { MavlinkWorkerBridge } from './services/worker-bridge';
import { ConnectionManager } from './services/connection-manager';
import { MavlinkMetadataRegistry } from './mavlink/registry';
import { loadSettings, saveSettingsDebounced, DEFAULT_SETTINGS } from './services/settings-service';

export default function App() {
  let bridge: MavlinkWorkerBridge | undefined;
  let connMgr: ConnectionManager | undefined;

  // Persist settings reactively when theme or baudRate changes
  createEffect(() => {
    saveSettingsDebounced({
      theme: appState.theme,
      baudRate: appState.baudRate,
      bufferCapacity: DEFAULT_SETTINGS.bufferCapacity,
      dataRetentionMinutes: DEFAULT_SETTINGS.dataRetentionMinutes,
      updateIntervalMs: DEFAULT_SETTINGS.updateIntervalMs,
    });
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
          if (appState.isPaused) {
            connectionManager.resume();
            setAppState('isPaused', false);
          } else {
            connectionManager.pause();
            setAppState('isPaused', true);
          }
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
      batch(() => {
        setAppState('theme', settings.theme);
        setAppState('baudRate', settings.baudRate);
      });

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
    } catch (err) {
      console.error('MavDeck initialization failed:', err);
      setAppState('connectionStatus', 'error');
    }
  });

  onCleanup(() => {
    connMgr?.disconnect();
    connMgr?.dispose();
    bridge?.dispose();
  });

  return (
    <ThemeProvider>
      <div class="flex flex-col h-screen" style={{ 'background-color': 'var(--bg-primary)' }}>
        <Toolbar />
        <TabBar />
        <main class="flex-1 overflow-hidden">
          <Show when={appState.activeTab === 'telemetry'}>
            <TelemetryView />
          </Show>
          <Show when={appState.activeTab === 'map'}>
            <MapView />
          </Show>
        </main>
      </div>
    </ThemeProvider>
  );
}
