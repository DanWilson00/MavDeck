/**
 * Reactive hook that manages the auto-connect lifecycle.
 *
 * Watches `appState.autoConnect` and `appState.isReady`. When both are true,
 * delegates serial probing to the session controller and suspends it while
 * log playback is active.
 */

import { createEffect, onCleanup } from 'solid-js';
import { appState } from '../store';
import { useSerialSessionController, getSerialBackend, type MavDeckSettings } from '../services';
import type { Accessor, Setter } from 'solid-js';

export function useAutoConnect(
  settingsReady: Accessor<boolean>,
  _loadedSettings: Accessor<MavDeckSettings>,
  _setLoadedSettings: Setter<MavDeckSettings>,
): void {
  const serialController = useSerialSessionController();

  createEffect(() => {
    if (!appState.isReady || !settingsReady()) return;
    if (getSerialBackend() !== 'native') return;
    const isLogActive = appState.logViewerState.isActive;
    const lastPortIdentity = appState.lastPortVendorId != null && appState.lastPortProductId != null
      ? { usbVendorId: appState.lastPortVendorId, usbProductId: appState.lastPortProductId }
      : null;

    if (isLogActive) {
      if (!serialController.hasSuspendedLiveSession) {
        serialController.stopAutoConnect();
      }
    } else {
      if (serialController.hasSuspendedLiveSession) {
        return;
      }
      serialController.syncAutoConnect({
        enabled: appState.autoConnect,
        autoBaud: appState.autoDetectBaud,
        manualBaudRate: appState.baudRate,
        lastPortIdentity,
        lastBaudRate: appState.lastSuccessfulBaudRate,
      });
    }

    onCleanup(() => {
      serialController.stopAutoConnect();
    });
  });
}
