import { createEffect, Show } from 'solid-js';
import ThemeProvider from './components/ThemeProvider';
import Toolbar from './components/Toolbar';
import TelemetryView from './components/TelemetryView';
import MapView from './components/MapView';
import StatusBar from './components/StatusBar';
import HelpOverlay from './components/HelpOverlay';
import { appState, setAppState } from './store';
import {
  useBootstrap,
  useSettingsSync,
  useAutoConnect,
  useInterestedFields,
  useLogSession,
  useKeyboardShortcuts,
} from './hooks';

export default function App() {
  const { loading, settingsReady, loadedSettings, setLoadedSettings } = useBootstrap();
  useSettingsSync(settingsReady, loadedSettings);
  useAutoConnect(settingsReady, loadedSettings, setLoadedSettings);
  useInterestedFields();
  useLogSession();
  useKeyboardShortcuts();

  // Migrate away from removed "logs" tab
  createEffect(() => {
    if (appState.activeTab === 'logs') setAppState('activeTab', 'telemetry');
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
          <StatusBar />
          <HelpOverlay />
        </div>
      </Show>
    </ThemeProvider>
  );
}
