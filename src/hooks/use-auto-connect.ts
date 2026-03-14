/**
 * Reactive hook that manages the auto-connect lifecycle.
 *
 * Watches `appState.autoConnect` and `appState.isReady`. When both are true,
 * delegates serial probing to the worker via connectionManager/workerBridge.
 * Subscribes to worker events for probe status and serial connected info.
 */

import { createEffect, onCleanup, untrack } from 'solid-js';
import { appState, setAppState, connectionManager, workerBridge } from '../store';
import { saveSettingsDebounced, type MavDeckSettings } from '../services';
import type { Accessor, Setter } from 'solid-js';

export function useAutoConnect(
  settingsReady: Accessor<boolean>,
  loadedSettings: Accessor<MavDeckSettings>,
  setLoadedSettings: Setter<MavDeckSettings>,
): void {
  createEffect(() => {
    if (!appState.isReady || !settingsReady()) return;

    const autoConnect = appState.autoConnect;

    if (autoConnect) {
      // Don't start probing if already connected.
      // Use untrack() to avoid making connectionStatus a reactive dependency —
      // otherwise status changes re-trigger this effect, aborting probes immediately.
      if (untrack(() => appState.connectionStatus) === 'connected' ||
          untrack(() => appState.connectionStatus) === 'connecting') {
        return;
      }

      const settings = loadedSettings();
      const lastPortIdentity = settings.lastPortVendorId != null && settings.lastPortProductId != null
        ? { usbVendorId: settings.lastPortVendorId, usbProductId: settings.lastPortProductId }
        : null;

      connectionManager.startAutoConnect({
        autoBaud: appState.autoDetectBaud,
        manualBaudRate: appState.baudRate,
        lastPortIdentity,
        lastBaudRate: settings.lastSuccessfulBaudRate,
      });
    } else {
      connectionManager.stopAutoConnect();
      setAppState('probeStatus', null);
    }

    onCleanup(() => {
      connectionManager.stopAutoConnect();
      setAppState('probeStatus', null);
    });
  });

  // Subscribe to worker events for probe status and serial connected
  createEffect(() => {
    if (!appState.isReady) return;

    const unsubProbe = workerBridge.onProbeStatus(status => {
      setAppState('probeStatus', status);
    });

    const unsubConnected = workerBridge.onSerialConnected(info => {
      setAppState('connectionSourceType', 'serial');
      setAppState('connectedBaudRate', info.baudRate);
      setAppState('lastSuccessfulBaudRate', info.baudRate);
      const updatedSettings: MavDeckSettings = {
        ...loadedSettings(),
        autoConnect: appState.autoConnect,
        autoDetectBaud: appState.autoDetectBaud,
        lastPortVendorId: info.portIdentity?.usbVendorId ?? null,
        lastPortProductId: info.portIdentity?.usbProductId ?? null,
        lastSuccessfulBaudRate: info.baudRate,
      };
      saveSettingsDebounced(updatedSettings);
      setLoadedSettings(updatedSettings);
    });

    onCleanup(() => {
      unsubProbe();
      unsubConnected();
    });
  });
}
