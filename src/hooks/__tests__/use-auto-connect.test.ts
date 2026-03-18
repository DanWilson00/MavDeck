import { createRoot, createSignal } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let backend: 'native' | 'webusb' = 'native';

const serialController = {
  syncAutoConnect: vi.fn(),
  stopAutoConnect: vi.fn(),
  syncAutoConnectWebUsb: vi.fn(),
  stopAutoConnectWebUsb: vi.fn(),
  onProbeStatus: vi.fn(() => () => {}),
  onSerialConnected: vi.fn(() => () => {}),
  persistSerialSettings: vi.fn(),
  hasSuspendedLiveSession: false,
};

vi.mock('../../services', async () => {
  const actual = await vi.importActual<typeof import('../../services')>('../../services');
  return {
    ...actual,
    useSerialSessionController: () => serialController,
    getSerialBackend: () => backend,
  };
});

import { setAppState } from '../../store';
import { DEFAULT_SETTINGS, type MavDeckSettings } from '../../services';
import { useAutoConnect } from '../use-auto-connect';

describe('useAutoConnect', () => {
  beforeEach(() => {
    serialController.syncAutoConnect.mockClear();
    serialController.stopAutoConnect.mockClear();
    serialController.syncAutoConnectWebUsb.mockClear();
    serialController.stopAutoConnectWebUsb.mockClear();
    serialController.onProbeStatus.mockClear();
    serialController.onSerialConnected.mockClear();
    serialController.persistSerialSettings.mockClear();
    serialController.hasSuspendedLiveSession = false;
    backend = 'native';

    setAppState('isReady', true);
    setAppState('autoConnect', true);
    setAppState('autoDetectBaud', true);
    setAppState('baudRate', 115200);
    setAppState('lastPortVendorId', 11);
    setAppState('lastPortProductId', 22);
    setAppState('lastPortSerialNumber', null);
    setAppState('lastSuccessfulBaudRate', 57600);
    setAppState('logViewerState', {
      isActive: false,
      sourceName: '',
      durationSec: 0,
      recordCount: 0,
    });
  });

  it('suspends auto-connect while a log is active and resumes it on unload', async () => {
    await createRoot(async dispose => {
      const [settingsReady] = createSignal(true);
      const [loadedSettings, setLoadedSettings] = createSignal<MavDeckSettings>({
        ...DEFAULT_SETTINGS,
        autoConnect: true,
        autoDetectBaud: true,
        lastPortVendorId: 11,
        lastPortProductId: 22,
        lastPortSerialNumber: null,
        lastSuccessfulBaudRate: 57600 as const,
      });

      useAutoConnect(settingsReady, loadedSettings, setLoadedSettings);
      await Promise.resolve();

      expect(serialController.syncAutoConnect).toHaveBeenCalledWith({
        enabled: true,
        autoBaud: true,
        manualBaudRate: 115200,
        lastPortIdentity: { usbVendorId: 11, usbProductId: 22 },
        lastBaudRate: 57600,
      });

      serialController.syncAutoConnect.mockClear();
      setLoadedSettings({
        ...loadedSettings(),
        lastPortVendorId: 33,
        lastPortProductId: 44,
        lastPortSerialNumber: null,
        lastSuccessfulBaudRate: 921600 as const,
      });
      await Promise.resolve();
      expect(serialController.syncAutoConnect).not.toHaveBeenCalled();

      setAppState('lastPortVendorId', 11);
      setAppState('lastPortProductId', 22);
      setAppState('lastPortSerialNumber', null);
      setAppState('lastSuccessfulBaudRate', 57600);

      setAppState('logViewerState', {
        isActive: true,
        sourceName: 'flight.tlog',
        durationSec: 10,
        recordCount: 20,
      });
      await Promise.resolve();
      expect(serialController.stopAutoConnect).toHaveBeenCalled();

      serialController.stopAutoConnect.mockClear();

      setAppState('logViewerState', {
        isActive: false,
        sourceName: '',
        durationSec: 0,
        recordCount: 0,
      });
      await Promise.resolve();
      expect(serialController.syncAutoConnect).toHaveBeenCalledWith({
        enabled: true,
        autoBaud: true,
        manualBaudRate: 115200,
        lastPortIdentity: { usbVendorId: 11, usbProductId: 22 },
        lastBaudRate: 57600,
      });

      dispose();
    });
  });

  it('uses the WebUSB controller path on Android while preserving auto-connect settings', async () => {
    backend = 'webusb';

    await createRoot(async dispose => {
      const [settingsReady] = createSignal(true);
      const [loadedSettings, setLoadedSettings] = createSignal<MavDeckSettings>({
        ...DEFAULT_SETTINGS,
        autoConnect: true,
        autoDetectBaud: true,
        lastPortVendorId: 11,
        lastPortProductId: 22,
        lastPortSerialNumber: null,
        lastSuccessfulBaudRate: 57600 as const,
      });

      useAutoConnect(settingsReady, loadedSettings, setLoadedSettings);
      await Promise.resolve();

      expect(serialController.syncAutoConnectWebUsb).toHaveBeenCalledWith({
        enabled: true,
        autoBaud: true,
        manualBaudRate: 115200,
        lastPortIdentity: { usbVendorId: 11, usbProductId: 22 },
        lastBaudRate: 57600,
      });

      setAppState('logViewerState', {
        isActive: true,
        sourceName: 'flight.tlog',
        durationSec: 10,
        recordCount: 20,
      });
      await Promise.resolve();

      expect(serialController.stopAutoConnectWebUsb).toHaveBeenCalled();

      dispose();
    });
  });

  it('does not restart probing while a suspended live session is being restored after log unload', async () => {
    await createRoot(async dispose => {
      const [settingsReady] = createSignal(true);
      const [loadedSettings, setLoadedSettings] = createSignal<MavDeckSettings>({
        ...DEFAULT_SETTINGS,
        autoConnect: true,
        autoDetectBaud: true,
        lastPortVendorId: 11,
        lastPortProductId: 22,
        lastPortSerialNumber: null,
        lastSuccessfulBaudRate: 57600 as const,
      });

      useAutoConnect(settingsReady, loadedSettings, setLoadedSettings);
      await Promise.resolve();

      serialController.syncAutoConnect.mockClear();
      serialController.hasSuspendedLiveSession = true;

      setAppState('logViewerState', {
        isActive: false,
        sourceName: '',
        durationSec: 0,
        recordCount: 0,
      });
      await Promise.resolve();

      expect(serialController.syncAutoConnect).not.toHaveBeenCalled();

      dispose();
    });
  });

  it('passes the persisted USB serial number through to the WebUSB controller', async () => {
    backend = 'webusb';
    setAppState('lastPortSerialNumber', 'ftdi-123');

    await createRoot(async dispose => {
      const [settingsReady] = createSignal(true);
      const [loadedSettings, setLoadedSettings] = createSignal<MavDeckSettings>({
        ...DEFAULT_SETTINGS,
        autoConnect: true,
        autoDetectBaud: true,
        lastPortVendorId: 11,
        lastPortProductId: 22,
        lastPortSerialNumber: 'ftdi-123',
        lastSuccessfulBaudRate: 57600 as const,
      });

      useAutoConnect(settingsReady, loadedSettings, setLoadedSettings);
      await Promise.resolve();

      expect(serialController.syncAutoConnectWebUsb).toHaveBeenCalledWith({
        enabled: true,
        autoBaud: true,
        manualBaudRate: 115200,
        lastPortIdentity: { usbVendorId: 11, usbProductId: 22, usbSerialNumber: 'ftdi-123' },
        lastBaudRate: 57600,
      });

      dispose();
    });
  });
});
