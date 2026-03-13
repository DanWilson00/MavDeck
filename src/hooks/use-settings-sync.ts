import { createEffect, type Accessor } from 'solid-js';
import { appState, workerBridge, connectionManager } from '../store';
import { saveSettingsDebounced, type MavDeckSettings } from '../services';

export function useSettingsSync(
  settingsReady: Accessor<boolean>,
  loadedSettings: Accessor<MavDeckSettings>,
): void {
  // Persist settings reactively when display/connection preferences change.
  createEffect(() => {
    if (!settingsReady()) return;
    saveSettingsDebounced({
      ...loadedSettings(),
      theme: appState.theme,
      uiScale: appState.uiScale,
      unitProfile: appState.unitProfile,
      baudRate: appState.baudRate,
      bufferCapacity: appState.bufferCapacity,
      mapShowPath: appState.mapShowPath,
      mapTrailLength: appState.mapTrailLength,
      mapLayer: appState.mapLayer,
      mapZoom: appState.mapZoom,
      mapAutoCenter: appState.mapAutoCenter,
      sidebarCollapsed: appState.sidebarCollapsed,
      sidebarWidth: appState.sidebarWidth,
    });
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
}
