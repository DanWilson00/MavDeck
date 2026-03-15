import { createRoot, createSignal } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serialController = {
  syncAutoConnect: vi.fn(),
  stopAutoConnect: vi.fn(),
  onProbeStatus: vi.fn(() => () => {}),
  onSerialConnected: vi.fn(() => () => {}),
  persistSerialSettings: vi.fn(),
};

vi.mock('../../services', async () => {
  const actual = await vi.importActual<typeof import('../../services')>('../../services');
  return {
    ...actual,
    useSerialSessionController: () => serialController,
  };
});

import { setAppState } from '../../store';
import { DEFAULT_SETTINGS, type MavDeckSettings } from '../../services';
import { useAutoConnect } from '../use-auto-connect';

describe('useAutoConnect', () => {
  beforeEach(() => {
    serialController.syncAutoConnect.mockClear();
    serialController.stopAutoConnect.mockClear();
    serialController.onProbeStatus.mockClear();
    serialController.onSerialConnected.mockClear();
    serialController.persistSerialSettings.mockClear();

    setAppState('isReady', true);
    setAppState('autoConnect', true);
    setAppState('autoDetectBaud', true);
    setAppState('baudRate', 115200);
    setAppState('lastPortVendorId', 11);
    setAppState('lastPortProductId', 22);
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
        lastSuccessfulBaudRate: 921600 as const,
      });
      await Promise.resolve();
      expect(serialController.syncAutoConnect).not.toHaveBeenCalled();

      setAppState('lastPortVendorId', 11);
      setAppState('lastPortProductId', 22);
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
});
