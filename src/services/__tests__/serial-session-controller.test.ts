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
  let workerBridge: Pick<MavlinkWorkerBridge, 'notifyPortsChanged' | 'onProbeStatus' | 'onSerialConnected'>;
  let logViewerService: Pick<LogViewerService, 'unload'>;

  beforeEach(() => {
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
    };
    logViewerService = {
      unload: vi.fn(),
    };
    vi.stubGlobal('navigator', {
      serial: {
        requestPort: vi.fn(async () => port),
        getPorts: vi.fn(async () => [port]),
      },
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
});
