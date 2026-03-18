import { createRoot, createSignal } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerBridge = {
  setBufferCapacity: vi.fn(),
};

const connectionManager = {
  pause: vi.fn(),
  resume: vi.fn(),
};

const serialController = {
  reconnectLiveSerial: vi.fn(),
};

vi.mock('../../services', async () => {
  const actual = await vi.importActual<typeof import('../../services')>('../../services');
  return {
    ...actual,
    useWorkerBridge: () => workerBridge,
    useConnectionManager: () => connectionManager,
    useSerialSessionController: () => serialController,
  };
});

import { setAppState } from '../../store';
import { DEFAULT_SETTINGS, type MavDeckSettings } from '../../services';
import { useSettingsSync } from '../use-settings-sync';

describe('useSettingsSync', () => {
  beforeEach(() => {
    workerBridge.setBufferCapacity.mockClear();
    connectionManager.pause.mockClear();
    connectionManager.resume.mockClear();
    serialController.reconnectLiveSerial.mockClear();

    setAppState('isReady', true);
    setAppState('connectionSourceType', null);
    setAppState('connectionStatus', 'disconnected');
    setAppState('autoDetectBaud', false);
    setAppState('baudRate', 500000);
    setAppState('lastPortVendorId', 11);
    setAppState('lastPortProductId', 22);
    setAppState('lastPortSerialNumber', null);
    setAppState('lastSuccessfulBaudRate', 921600);
    setAppState('bufferCapacity', 2000);
    setAppState('logViewerState', {
      isActive: false,
      sourceName: '',
      durationSec: 0,
      recordCount: 0,
    });
  });

  it('reconnects active manual serial when baud changes', async () => {
    await createRoot(async dispose => {
      const [settingsReady] = createSignal(true);
      const [loadedSettings, setLoadedSettings] = createSignal<MavDeckSettings>({
        ...DEFAULT_SETTINGS,
      });

      setAppState('connectionSourceType', 'serial');
      setAppState('connectionStatus', 'connected');

      useSettingsSync(settingsReady, loadedSettings, setLoadedSettings);
      await Promise.resolve();

      serialController.reconnectLiveSerial.mockClear();
      setAppState('baudRate', 230400);
      await Promise.resolve();

      expect(serialController.reconnectLiveSerial).toHaveBeenCalledWith({
        baudRate: 230400,
        autoDetectBaud: false,
        lastBaudRate: 921600,
        lastPortIdentity: { usbVendorId: 11, usbProductId: 22 },
      });

      dispose();
    });
  });

  it('does not reconnect when auto-baud is enabled', async () => {
    await createRoot(async dispose => {
      const [settingsReady] = createSignal(true);
      const [loadedSettings, setLoadedSettings] = createSignal<MavDeckSettings>({
        ...DEFAULT_SETTINGS,
      });

      setAppState('connectionSourceType', 'serial');
      setAppState('connectionStatus', 'connected');
      setAppState('autoDetectBaud', true);

      useSettingsSync(settingsReady, loadedSettings, setLoadedSettings);
      await Promise.resolve();

      serialController.reconnectLiveSerial.mockClear();
      setAppState('baudRate', 230400);
      await Promise.resolve();

      expect(serialController.reconnectLiveSerial).not.toHaveBeenCalled();

      dispose();
    });
  });
});
