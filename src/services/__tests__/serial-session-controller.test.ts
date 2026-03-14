import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SerialSessionController } from '../serial-session-controller';
import type { ConnectionManager } from '../connection-manager';
import type { LogViewerService } from '../log-viewer-service';
import type { MavlinkWorkerBridge } from '../worker-bridge';

describe('serial-session-controller', () => {
  const port = {
    getInfo: () => ({ usbVendorId: 11, usbProductId: 22 }),
    forget: vi.fn(async () => {}),
  } as unknown as SerialPort;

  let connectionManager: Pick<ConnectionManager, 'connect' | 'disconnect' | 'startAutoConnect' | 'stopAutoConnect' | 'onStatusChange' | 'status' | 'pause' | 'resume'>;
  let workerBridge: Pick<MavlinkWorkerBridge, 'notifyPortsChanged' | 'onProbeStatus' | 'onSerialConnected'>;
  let logViewerService: Pick<LogViewerService, 'unload'>;

  beforeEach(() => {
    connectionManager = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      startAutoConnect: vi.fn(),
      stopAutoConnect: vi.fn(),
      onStatusChange: vi.fn(() => () => {}),
      status: 'disconnected',
      pause: vi.fn(),
      resume: vi.fn(),
    };
    workerBridge = {
      notifyPortsChanged: vi.fn(),
      onProbeStatus: vi.fn(() => () => {}),
      onSerialConnected: vi.fn(() => () => {}),
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
    controller.syncAutoConnect({
      enabled: false,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: null,
      lastBaudRate: 57600,
    });

    expect(connectionManager.startAutoConnect).toHaveBeenCalledOnce();
    expect(connectionManager.stopAutoConnect).toHaveBeenCalledOnce();
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
});
