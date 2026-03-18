import { createEffect, type Accessor } from 'solid-js';
import { appState, mergeAppStateIntoSettings } from '../store';
import {
  flushSettings,
  saveSettingsDebounced,
  useConnectionManager,
  useSerialSessionController,
  useWorkerBridge,
  type MavDeckSettings,
} from '../services';
import type { Setter } from 'solid-js';

function settingsEqual(a: MavDeckSettings, b: MavDeckSettings): boolean {
  return Object.keys(a).every((key) => a[key as keyof MavDeckSettings] === b[key as keyof MavDeckSettings]);
}

export function useSettingsSync(
  settingsReady: Accessor<boolean>,
  loadedSettings: Accessor<MavDeckSettings>,
  setLoadedSettings: Setter<MavDeckSettings>,
): void {
  const workerBridge = useWorkerBridge();
  const connectionManager = useConnectionManager();
  const serialSessionController = useSerialSessionController();

  // Persist settings reactively when display/connection preferences change.
  createEffect(() => {
    if (!settingsReady()) return;
    const nextSettings = mergeAppStateIntoSettings(loadedSettings());
    if (!settingsEqual(loadedSettings(), nextSettings)) {
      setLoadedSettings(nextSettings);
    }
    saveSettingsDebounced(nextSettings);
  });

  createEffect((prev: { baudRate: number; autoDetectBaud: boolean } | undefined) => {
    if (!settingsReady() || !appState.isReady) {
      return {
        baudRate: appState.baudRate,
        autoDetectBaud: appState.autoDetectBaud,
      };
    }

    const current = {
      baudRate: appState.baudRate,
      autoDetectBaud: appState.autoDetectBaud,
    };

    if (!prev) {
      return current;
    }

    const baudChanged = prev.baudRate !== current.baudRate;
    const activeManualSerial =
      appState.connectionSourceType === 'serial'
      && (appState.connectionStatus === 'connected' || appState.connectionStatus === 'no_data')
      && !appState.autoDetectBaud;

    if (baudChanged && activeManualSerial) {
      const lastPortIdentity = appState.lastPortVendorId != null && appState.lastPortProductId != null
        ? {
            usbVendorId: appState.lastPortVendorId,
            usbProductId: appState.lastPortProductId,
            ...(appState.lastPortSerialNumber ? { usbSerialNumber: appState.lastPortSerialNumber } : {}),
          }
        : null;

      void serialSessionController.reconnectLiveSerial({
        baudRate: appState.baudRate,
        autoDetectBaud: appState.autoDetectBaud,
        lastBaudRate: appState.lastSuccessfulBaudRate,
        lastPortIdentity,
      });
    }

    return current;
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
