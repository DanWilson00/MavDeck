import type { Accessor, Setter } from 'solid-js';
import { batch } from 'solid-js';
import { appState, setAppState } from '../store';
import { logDebugInfo, logDebugWarn } from './debug-console';
import type { MavDeckSettings } from './settings-service';
import type { SerialSessionController } from './serial-session-controller';

export function bindSessionState(
  controller: SerialSessionController,
  loadedSettings: Accessor<MavDeckSettings>,
  setLoadedSettings: Setter<MavDeckSettings>,
): () => void {
  let lastLoggedStatus = appState.connectionStatus;
  const unsubStatus = controller.onStatusChange(status => {
    if (status !== lastLoggedStatus) {
      if (status === 'connected') {
        logDebugInfo('serial', 'Live connection established');
      } else if (status === 'disconnected' && lastLoggedStatus !== 'disconnected') {
        logDebugInfo('serial', 'Live connection disconnected');
      } else if (status === 'no_data') {
        logDebugWarn('serial', 'Connection is open but no live telemetry is arriving');
      }
      lastLoggedStatus = status;
    }
    batch(() => {
      setAppState('connectionStatus', status);
      if (status === 'disconnected') {
        setAppState('isPaused', false);
        setAppState('probeStatus', null);
        setAppState('throughputBytesPerSec', 0);
      }
    });
  });

  const unsubProbe = controller.onProbeStatus(status => {
    setAppState('probeStatus', status);
  });

  const unsubWebUsbAvailability = controller.onWebUsbAvailabilityChange(state => {
    setAppState('webusbAvailability', state);
  });

  const unsubSession = controller.onSessionStateChange(state => {
    batch(() => {
      setAppState('connectionSourceType', state.sourceType);
      setAppState('pendingConnectionSourceType', state.pendingSourceType);
      setAppState('connectedBaudRate', state.sourceType === null ? null : state.connectedBaudRate);
    });
  });

  const unsubSerial = controller.onSerialConnected(info => {
    logDebugInfo('serial', 'Serial link configured', {
      baudRate: info.baudRate,
      usbVendorId: info.portIdentity?.usbVendorId ?? null,
      usbProductId: info.portIdentity?.usbProductId ?? null,
    });
    batch(() => {
      setAppState('lastPortVendorId', info.portIdentity?.usbVendorId ?? null);
      setAppState('lastPortProductId', info.portIdentity?.usbProductId ?? null);
      setAppState('lastPortSerialNumber', info.portIdentity?.usbSerialNumber ?? null);
      setAppState('lastSuccessfulBaudRate', info.baudRate);
    });
    controller.persistSerialSettings(
      info,
      loadedSettings,
      setLoadedSettings,
      appState.autoConnect,
      appState.autoDetectBaud,
    );
  });

  return () => {
    unsubStatus();
    unsubProbe();
    unsubWebUsbAvailability();
    unsubSession();
    unsubSerial();
  };
}
