import { createEffect, type Accessor } from 'solid-js';
import { appState, mergeAppStateIntoSettings } from '../store';
import { flushSettings, saveSettingsDebounced, useConnectionManager, useWorkerBridge, type MavDeckSettings } from '../services';

export function useSettingsSync(
  settingsReady: Accessor<boolean>,
  loadedSettings: Accessor<MavDeckSettings>,
): void {
  const workerBridge = useWorkerBridge();
  const connectionManager = useConnectionManager();

  // Persist settings reactively when display/connection preferences change.
  createEffect(() => {
    if (!settingsReady()) return;
    saveSettingsDebounced(mergeAppStateIntoSettings(loadedSettings()));
  });

  // Apply telemetry buffer-capacity changes immediately in worker.
  createEffect(() => {
    if (!appState.isReady) return;
    workerBridge.setBufferCapacity(appState.bufferCapacity);
  });

  // Keep worker pause state in sync with UI/replay mode.
  createEffect(() => {
    if (!appState.isReady) return;
    if (appState.connectionStatus !== 'connected') return;
    if (appState.logViewerState.isActive) return;
    if (appState.isPaused) {
      connectionManager.pause();
    } else {
      connectionManager.resume();
    }
  });

  createEffect(() => {
    if (!settingsReady()) return;

    const flush = () => { void flushSettings(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);

    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  });
}
