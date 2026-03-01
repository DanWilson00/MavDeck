import { onMount, onCleanup, Show } from 'solid-js';
import ThemeProvider from './components/ThemeProvider';
import Toolbar from './components/Toolbar';
import TabBar from './components/TabBar';
import { appState, setWorkerBridge, setConnectionManager, setRegistry } from './store/app-store';
import { MavlinkWorkerBridge } from './services/worker-bridge';
import { ConnectionManager } from './services/connection-manager';
import { MavlinkMetadataRegistry } from './mavlink/registry';

export default function App() {
  let bridge: MavlinkWorkerBridge | undefined;
  let connMgr: ConnectionManager | undefined;

  onMount(async () => {
    // Load dialect
    const response = await fetch(`${import.meta.env.BASE_URL}dialects/common.json`);
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
  });

  onCleanup(() => {
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
            <div class="flex items-center justify-center h-full" style={{ color: 'var(--text-secondary)' }}>
              Telemetry view — Phase 4+
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
