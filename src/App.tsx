import { onMount, onCleanup, Show } from 'solid-js';
import ThemeProvider from './components/ThemeProvider';
import Toolbar from './components/Toolbar';
import TabBar from './components/TabBar';
import MessageMonitor from './components/MessageMonitor';
import { appState, setAppState, setWorkerBridge, setConnectionManager, setRegistry } from './store/app-store';
import { MavlinkWorkerBridge } from './services/worker-bridge';
import { ConnectionManager } from './services/connection-manager';
import { MavlinkMetadataRegistry } from './mavlink/registry';

export default function App() {
  let bridge: MavlinkWorkerBridge | undefined;
  let connMgr: ConnectionManager | undefined;

  onMount(async () => {
    try {
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
            <div class="flex h-full">
              <MessageMonitor />
              <div class="flex-1 flex items-center justify-center" style={{ color: 'var(--text-secondary)' }}>
                Plot area — Phase 5
              </div>
            </div>
          </Show>
          <Show when={appState.activeTab === 'map'}>
            <div class="flex items-center justify-center h-full" style={{ color: 'var(--text-secondary)' }}>
              Map view — Phase 7
            </div>
          </Show>
        </main>
      </div>
    </ThemeProvider>
  );
}
