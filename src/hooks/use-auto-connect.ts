/**
 * Reactive hook that manages the auto-connect lifecycle.
 *
 * Watches `appState.autoConnect` and `appState.isReady`. When both are true,
 * delegates serial probing to the worker via connectionManager/workerBridge.
 * Subscribes to worker events for probe status and serial connected info.
 */

import { createEffect, onCleanup } from 'solid-js';
import { appState, setAppState } from '../store';
import { getSerialSessionController, type MavDeckSettings } from '../services';
import type { Accessor, Setter } from 'solid-js';

export function useAutoConnect(
  settingsReady: Accessor<boolean>,
  loadedSettings: Accessor<MavDeckSettings>,
  setLoadedSettings: Setter<MavDeckSettings>,
): void {
  createEffect(() => {
    if (!appState.isReady || !settingsReady()) return;
    const isLogActive = appState.logViewerState.isActive;

    const settings = loadedSettings();
    const lastPortIdentity = settings.lastPortVendorId != null && settings.lastPortProductId != null
      ? { usbVendorId: settings.lastPortVendorId, usbProductId: settings.lastPortProductId }
      : null;

    if (isLogActive) {
      getSerialSessionController().stopAutoConnect();
      setAppState('probeStatus', null);
    } else {
      getSerialSessionController().syncAutoConnect({
        enabled: appState.autoConnect,
        autoBaud: appState.autoDetectBaud,
        manualBaudRate: appState.baudRate,
        lastPortIdentity,
        lastBaudRate: settings.lastSuccessfulBaudRate,
      });
    }

    if (!appState.autoConnect || isLogActive) {
      setAppState('probeStatus', null);
    }

    onCleanup(() => {
      getSerialSessionController().stopAutoConnect();
      setAppState('probeStatus', null);
    });
  });

  // Subscribe to worker events for probe status and serial connected
  createEffect(() => {
    if (!appState.isReady) return;

    const serialController = getSerialSessionController();
    const unsubProbe = serialController.onProbeStatus(status => {
      setAppState('probeStatus', status);
    });

    const unsubConnected = serialController.onSerialConnected(info => {
      setAppState('connectionSourceType', 'serial');
      setAppState('connectedBaudRate', info.baudRate);
      setAppState('lastSuccessfulBaudRate', info.baudRate);
      serialController.persistSerialSettings(
        info,
        loadedSettings,
        setLoadedSettings,
        appState.autoConnect,
        appState.autoDetectBaud,
      );
    });

    onCleanup(() => {
      unsubProbe();
      unsubConnected();
    });
  });
}
