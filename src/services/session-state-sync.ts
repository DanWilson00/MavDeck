import type { Accessor, Setter } from 'solid-js';
import { batch } from 'solid-js';
import { appState, setAppState } from '../store';
import type { MavDeckSettings } from './settings-service';
import type { SerialSessionController } from './serial-session-controller';

export function bindSessionState(
  controller: SerialSessionController,
  loadedSettings: Accessor<MavDeckSettings>,
  setLoadedSettings: Setter<MavDeckSettings>,
): () => void {
  const unsubStatus = controller.onStatusChange(status => {
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

  const unsubSession = controller.onSessionStateChange(state => {
    batch(() => {
      setAppState('connectionSourceType', state.sourceType);
      setAppState('connectedBaudRate', state.sourceType === null ? null : state.connectedBaudRate);
    });
  });

  const unsubSerial = controller.onSerialConnected(info => {
    batch(() => {
      setAppState('lastPortVendorId', info.portIdentity?.usbVendorId ?? null);
      setAppState('lastPortProductId', info.portIdentity?.usbProductId ?? null);
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
    unsubSession();
    unsubSerial();
  };
}
