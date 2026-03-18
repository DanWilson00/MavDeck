import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SerialSessionController } from '../serial-session-controller';
import type { ConnectionManager } from '../connection-manager';
import type { LogViewerService } from '../log-viewer-service';
import type { MavlinkWorkerBridge } from '../worker-bridge';
import type { ConnectionStatus } from '../worker-bridge';

describe('serial-session-controller', () => {
  const port = {
    getInfo: () => ({ usbVendorId: 11, usbProductId: 22 }),
    forget: vi.fn(async () => {}),
  } as unknown as SerialPort;

  let statusListener: ((status: ConnectionStatus) => void) | null;
  let serialConnectedListener: ((info: { baudRate: number; portIdentity: { usbVendorId: number; usbProductId: number } | null }) => void) | null;
  let connectionManager: Pick<ConnectionManager, 'connect' | 'disconnect' | 'startAutoConnect' | 'stopAutoConnect' | 'onStatusChange' | 'status' | 'pause' | 'resume'>;
  let workerBridge: Pick<MavlinkWorkerBridge, 'notifyPortsChanged' | 'onProbeStatus' | 'onSerialConnected' | 'suspendLiveForLog' | 'resumeSuspendedLive'>;
  let logViewerService: Pick<LogViewerService, 'unload'>;

  beforeEach(() => {
    vi.useRealTimers();
    statusListener = null;
    serialConnectedListener = null;
    connectionManager = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      startAutoConnect: vi.fn(),
      stopAutoConnect: vi.fn(),
      onStatusChange: vi.fn((callback) => {
        statusListener = callback;
        return () => {
          statusListener = null;
        };
      }),
      status: 'disconnected',
      pause: vi.fn(),
      resume: vi.fn(),
    };
    workerBridge = {
      notifyPortsChanged: vi.fn(),
      onProbeStatus: vi.fn(() => () => {}),
      onSerialConnected: vi.fn((callback) => {
        serialConnectedListener = callback;
        return () => {
          serialConnectedListener = null;
        };
      }),
      suspendLiveForLog: vi.fn(),
      resumeSuspendedLive: vi.fn(),
    };
    logViewerService = {
      unload: vi.fn(),
    };
    vi.stubGlobal('navigator', {
      serial: {
        requestPort: vi.fn(async () => port),
        getPorts: vi.fn(async () => [port]),
      },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    });
  });

  it('connectManual unloads logs, stops auto-connect, and connects with selected port identity', async () => {
    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    await controller.connectManual({
      baudRate: 115200,
      autoDetectBaud: true,
      lastBaudRate: 57600,
      unloadLog: true,
    });

    expect(logViewerService.unload).toHaveBeenCalledOnce();
    expect(connectionManager.stopAutoConnect).toHaveBeenCalledOnce();
    expect(connectionManager.connect).toHaveBeenCalledWith({
      type: 'webserial',
      baudRate: 115200,
      autoDetectBaud: true,
      portIdentity: { usbVendorId: 11, usbProductId: 22 },
      lastBaudRate: 57600,
    });
  });

  it('syncAutoConnect starts probing only when enabled and disconnected', () => {
    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    controller.syncAutoConnect({
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: null,
      lastBaudRate: 57600,
    });
    statusListener?.('probing');
    controller.syncAutoConnect({
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: null,
      lastBaudRate: 57600,
    });
    controller.syncAutoConnect({
      enabled: false,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: null,
      lastBaudRate: 57600,
    });

    expect(connectionManager.startAutoConnect).toHaveBeenCalledOnce();
    expect(connectionManager.stopAutoConnect).toHaveBeenCalledOnce();
    expect(controller.currentPhase).toBe('idle');
  });

  it('enterLogMode disconnects live transport and stops probing', () => {
    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    controller.enterLogMode();

    expect(connectionManager.disconnect).toHaveBeenCalledOnce();
    expect(connectionManager.stopAutoConnect).toHaveBeenCalledOnce();
  });

  it('suspendForLogPlayback preserves live serial and skips disconnect', () => {
    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    serialConnectedListener?.({ baudRate: 57600, portIdentity: { usbVendorId: 11, usbProductId: 22 } });

    expect(controller.suspendForLogPlayback()).toBe(true);
    expect(workerBridge.suspendLiveForLog).toHaveBeenCalledOnce();
    expect(connectionManager.disconnect).not.toHaveBeenCalled();
  });

  it('keeps the suspended live snapshot until serial status is restored after log playback', () => {
    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    serialConnectedListener?.({ baudRate: 57600, portIdentity: { usbVendorId: 11, usbProductId: 22 } });
    expect(controller.suspendForLogPlayback()).toBe(true);

    controller.resumeAfterLogPlayback();

    expect(controller.hasSuspendedLiveSession).toBe(true);
    expect(workerBridge.resumeSuspendedLive).toHaveBeenCalledOnce();

    statusListener?.('connected');

    expect(controller.hasSuspendedLiveSession).toBe(false);
    expect(controller.currentPhase).toBe('connected_serial');
    expect(controller.currentSessionState).toEqual({
      sourceType: 'serial',
      connectedBaudRate: 57600,
    });
  });

  it('connectSpoof unloads logs and starts spoof through the connection manager', () => {
    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    controller.connectSpoof({ unloadLog: true });

    expect(logViewerService.unload).toHaveBeenCalledOnce();
    expect(connectionManager.stopAutoConnect).toHaveBeenCalledOnce();
    expect(connectionManager.connect).toHaveBeenCalledWith({ type: 'spoof' });
  });

  it('tracks session state from spoof and serial connection events', () => {
    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });
    const states: Array<{ sourceType: 'serial' | 'spoof' | null; connectedBaudRate: number | null }> = [];
    controller.onSessionStateChange(state => {
      states.push(state);
    });

    controller.connectSpoof();
    statusListener?.('connected');
    serialConnectedListener?.({ baudRate: 57600, portIdentity: { usbVendorId: 11, usbProductId: 22 } });
    statusListener?.('disconnected');

    expect(states).toEqual([
      { sourceType: null, connectedBaudRate: null },
      { sourceType: 'spoof', connectedBaudRate: null },
      { sourceType: 'serial', connectedBaudRate: 57600 },
      { sourceType: null, connectedBaudRate: null },
    ]);
  });

  it('keeps serial phase stable when connected arrives before serialConnected', () => {
    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    controller.syncAutoConnect({
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: null,
      lastBaudRate: 57600,
    });
    statusListener?.('connected');
    expect(controller.currentPhase).toBe('probing');

    serialConnectedListener?.({ baudRate: 57600, portIdentity: { usbVendorId: 11, usbProductId: 22 } });
    expect(controller.currentPhase).toBe('connected_serial');
  });

  it('treats no_data as an idle live serial phase without clearing session state', () => {
    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    serialConnectedListener?.({ baudRate: 57600, portIdentity: { usbVendorId: 11, usbProductId: 22 } });
    statusListener?.('no_data');

    expect(controller.currentPhase).toBe('connected_serial_idle');
    expect(controller.currentSessionState).toEqual({
      sourceType: 'serial',
      connectedBaudRate: 57600,
    });
  });

  it('clears a suspended live snapshot on a real disconnect', () => {
    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    serialConnectedListener?.({ baudRate: 57600, portIdentity: { usbVendorId: 11, usbProductId: 22 } });
    expect(controller.suspendForLogPlayback()).toBe(true);

    statusListener?.('disconnected');

    expect(controller.hasSuspendedLiveSession).toBe(false);
    expect(controller.currentPhase).toBe('idle');
    expect(controller.currentSessionState).toEqual({
      sourceType: null,
      connectedBaudRate: null,
    });
  });

  it('starts Android WebUSB auto-connect with the persisted settings', async () => {
    vi.stubGlobal('navigator', {
      usb: {
        getDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
    });

    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    controller.syncAutoConnectWebUsb({
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: { usbVendorId: 11, usbProductId: 22 },
      lastBaudRate: 57600,
    });

    await Promise.resolve();

    expect(controller.currentPhase).toBe('probing');
    expect((controller as unknown as {
      webusbAutoConnectOptions: {
        enabled: boolean;
        autoBaud: boolean;
        manualBaudRate: number;
        lastPortIdentity: { usbVendorId: number; usbProductId: number } | null;
        lastBaudRate: number | null;
      };
    }).webusbAutoConnectOptions).toEqual({
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: { usbVendorId: 11, usbProductId: 22 },
      lastBaudRate: 57600,
    });
  });

  it('marks Android WebUSB as waiting for a device when a previously granted port is absent', async () => {
    vi.stubGlobal('navigator', {
      usb: {
        getDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
    });

    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });
    const states: string[] = [];
    controller.onWebUsbAvailabilityChange(state => {
      states.push(state);
    });

    controller.syncAutoConnectWebUsb({
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: { usbVendorId: 11, usbProductId: 22 },
      lastBaudRate: 57600,
    });

    await vi.waitFor(() => {
      expect(states).toContain('waiting_for_device');
    });
  });

  it('marks Android WebUSB as needing grant when no prior granted device is known', async () => {
    vi.stubGlobal('navigator', {
      usb: {
        getDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
    });

    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });
    const states: string[] = [];
    controller.onWebUsbAvailabilityChange(state => {
      states.push(state);
    });

    controller.syncAutoConnectWebUsb({
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: null,
      lastBaudRate: 57600,
    });

    await vi.waitFor(() => {
      expect(states).toContain('needs_grant');
    });
  });

  it('restarts Android WebUSB auto-connect after an unexpected transport disconnect', () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {
      usb: {
        getDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
    });

    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    const restartSpy = vi.fn();
    (controller as unknown as { startAutoConnectWebUsbLoop: () => void }).startAutoConnectWebUsbLoop = restartSpy;
    (controller as unknown as {
      webusbAutoConnectOptions: {
        enabled: boolean;
        autoBaud: boolean;
        manualBaudRate: number;
        lastPortIdentity: { usbVendorId: number; usbProductId: number } | null;
        lastBaudRate: number | null;
      };
      mainThreadSource: { disconnect: () => Promise<void> };
      phase: 'idle';
    }).webusbAutoConnectOptions = {
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: { usbVendorId: 11, usbProductId: 22 },
      lastBaudRate: 57600,
    };
    (controller as unknown as {
      mainThreadSource: { disconnect: () => Promise<void> };
    }).mainThreadSource = {
      disconnect: vi.fn(async () => {}),
    };

    (controller as unknown as { handleWebUsbTransportDisconnect: () => void }).handleWebUsbTransportDisconnect();
    vi.advanceTimersByTime(1000);

    expect(connectionManager.disconnect).toHaveBeenCalledOnce();
    expect(restartSpy).toHaveBeenCalledOnce();
  });

  it('does not restart Android WebUSB auto-connect after an intentional disconnect', () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {
      usb: {
        getDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
    });

    const controller = new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      logViewerService: logViewerService as LogViewerService,
    });

    const restartSpy = vi.fn();
    (controller as unknown as { startAutoConnectWebUsbLoop: () => void }).startAutoConnectWebUsbLoop = restartSpy;
    (controller as unknown as {
      webusbAutoConnectOptions: {
        enabled: boolean;
        autoBaud: boolean;
        manualBaudRate: number;
        lastPortIdentity: { usbVendorId: number; usbProductId: number } | null;
        lastBaudRate: number | null;
      };
      mainThreadSource: { disconnect: () => Promise<void> };
    }).webusbAutoConnectOptions = {
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: { usbVendorId: 11, usbProductId: 22 },
      lastBaudRate: 57600,
    };
    (controller as unknown as {
      mainThreadSource: { disconnect: () => Promise<void> };
    }).mainThreadSource = {
      disconnect: vi.fn(async () => {}),
    };

    controller.disconnectLiveSession();
    vi.advanceTimersByTime(1000);

    expect(restartSpy).not.toHaveBeenCalled();
  });
});
