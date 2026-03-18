import { createEffect, Show } from 'solid-js';
import ThemeProvider from './components/ThemeProvider';
import Toolbar from './components/Toolbar';
import TelemetryView from './components/TelemetryView';
import MapView from './components/MapView';
import ParametersView from './components/ParametersView';
import StatusBar from './components/StatusBar';
import HelpOverlay from './components/HelpOverlay';
import DebugConsole from './components/DebugConsole';
import { appState, setAppState } from './store';
import {
  useBootstrap,
  useSettingsSync,
  useAutoConnect,
  useInterestedFields,
  useLogSession,
  useKeyboardShortcuts,
} from './hooks';
import { RuntimeServicesProvider, saveSettings } from './services';
import type { MavDeckSettings } from './services';

interface AppContentProps {
  settingsReady: () => boolean;
  loadedSettings: ReturnType<typeof useBootstrap>['loadedSettings'];
  setLoadedSettings: ReturnType<typeof useBootstrap>['setLoadedSettings'];
}

function AppContent(props: AppContentProps) {
  useSettingsSync(props.settingsReady, props.loadedSettings, props.setLoadedSettings);
  useAutoConnect(props.settingsReady, props.loadedSettings, props.setLoadedSettings);
  useInterestedFields();
  useLogSession();
  useKeyboardShortcuts();

  function handleSelectTab(tabId: 'telemetry' | 'map' | 'parameters') {
    if (appState.activeTab === tabId) return;
    setAppState('activeTab', tabId);
    const nextSettings: MavDeckSettings = {
      ...props.loadedSettings(),
      activeTab: tabId,
    };
    props.setLoadedSettings(nextSettings);
    void saveSettings(nextSettings);
  }

  // Migrate away from removed "logs" tab
  createEffect(() => {
    if (appState.activeTab === 'logs') setAppState('activeTab', 'telemetry');
  });

  return (
    <div class="flex flex-col h-screen" style={{ 'background-color': 'var(--bg-primary)' }}>
      <Toolbar onSelectTab={handleSelectTab} />
      <main class="flex-1 overflow-hidden">
        <Show when={appState.activeTab === 'telemetry'}>
          <TelemetryView />
        </Show>
        <Show when={appState.activeTab === 'map'}>
          <MapView />
        </Show>
        <Show when={appState.activeTab === 'parameters'}>
          <ParametersView />
        </Show>
      </main>
      <DebugConsole />
      <StatusBar />
      <HelpOverlay />
    </div>
  );
}

export default function App() {
  const { loading, settingsReady, loadedSettings, setLoadedSettings, runtimeServices } = useBootstrap();

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
        <RuntimeServicesProvider services={runtimeServices()!}>
          <AppContent
            settingsReady={settingsReady}
            loadedSettings={loadedSettings}
            setLoadedSettings={setLoadedSettings}
          />
        </RuntimeServicesProvider>
      </Show>
    </ThemeProvider>
  );
}
