import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SerialSessionController } from '../serial-session-controller';
import type { ConnectionManager } from '../connection-manager';
import type { LogViewerService } from '../log-viewer-service';
import type { MavlinkWorkerBridge } from '../worker-bridge';
import type { ConnectionStatus } from '../worker-bridge';
import { MavlinkMetadataRegistry } from '../../mavlink/registry';
import { MavlinkFrameBuilder } from '../../mavlink/frame-builder';
import { loadCommonDialectJson } from '../../test-helpers/load-dialect';
import { PROBE_TIMEOUT_MS } from '../baud-rates';

describe('serial-session-controller', () => {
  const commonJson = loadCommonDialectJson();
  const port = {
    getInfo: () => ({ usbVendorId: 11, usbProductId: 22 }),
    forget: vi.fn(async () => {}),
  } as unknown as SerialPort;

  let statusListener: ((status: ConnectionStatus) => void) | null;
  let probeStatusListener: ((status: string | null) => void) | null;
  let serialConnectedListener: ((info: {
    baudRate: number;
    portIdentity: { usbVendorId: number; usbProductId: number; usbSerialNumber?: string } | null;
  }) => void) | null;
  let connectionManager: Pick<ConnectionManager, 'connect' | 'disconnect' | 'startAutoConnect' | 'stopAutoConnect' | 'onStatusChange' | 'status' | 'pause' | 'resume'>;
  let workerBridge: Pick<MavlinkWorkerBridge, 'notifyPortsChanged' | 'onProbeStatus' | 'onSerialConnected' | 'suspendLiveForLog' | 'resumeSuspendedLive' | 'sendBytes'>;
  let logViewerService: Pick<LogViewerService, 'unload'>;
  let registry: MavlinkMetadataRegistry;

  function createController(): SerialSessionController {
    return new SerialSessionController({
      connectionManager: connectionManager as ConnectionManager,
      workerBridge: workerBridge as MavlinkWorkerBridge,
      registry,
      logViewerService: logViewerService as LogViewerService,
    });
  }

  function createStructuredGarbageFrame(payloadLength = 9): Uint8Array {
    return new Uint8Array(12 + payloadLength);
  }

  function createMockProbePort(chunksByBaud: Record<number, Uint8Array[]>) {
    let pendingResolve: ((value: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
    const queue: ReadableStreamReadResult<Uint8Array>[] = [];
    const offsets = new Map<number, number>();

    const push = (value: ReadableStreamReadResult<Uint8Array>) => {
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(value);
        return;
      }
      queue.push(value);
    };

    const emitForBaud = (baudRate: number) => {
      const chunks = chunksByBaud[baudRate] ?? [];
      const offset = offsets.get(baudRate) ?? 0;
      for (let i = offset; i < chunks.length; i += 1) {
        push({ done: false, value: chunks[i] });
      }
      offsets.set(baudRate, chunks.length);
    };

    const open = vi.fn(async ({ baudRate }: { baudRate: number }) => {
      emitForBaud(baudRate);
    });
    const setBaudRate = vi.fn(async (baudRate: number) => {
      emitForBaud(baudRate);
    });
    const close = vi.fn(async () => {
      push({ done: true, value: undefined });
    });
    const cancel = vi.fn(async () => {
      push({ done: true, value: undefined });
    });
    const releaseLock = vi.fn();

    return {
      port: {
        open,
        close,
        setBaudRate,
        getInfo: () => ({ usbVendorId: 11, usbProductId: 22 }),
        forget: async () => {},
        writable: null,
        readable: {
          getReader: () => ({
            read: () => {
              if (queue.length > 0) {
                return Promise.resolve(queue.shift()!);
              }
              return new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => {
                pendingResolve = resolve;
              });
            },
            cancel,
            releaseLock,
          }),
        },
      },
      open,
      close,
      setBaudRate,
    };
  }

  beforeEach(() => {
    vi.useRealTimers();
    statusListener = null;
    probeStatusListener = null;
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
      onProbeStatus: vi.fn((callback) => {
        probeStatusListener = callback;
        return () => {
          probeStatusListener = null;
        };
      }),
      onSerialConnected: vi.fn((callback) => {
        serialConnectedListener = callback;
        return () => {
          serialConnectedListener = null;
        };
      }),
      suspendLiveForLog: vi.fn(),
      resumeSuspendedLive: vi.fn(),
      sendBytes: vi.fn(),
    };
    logViewerService = {
      unload: vi.fn(),
    };
    registry = new MavlinkMetadataRegistry();
    registry.loadFromJsonString(commonJson);
    vi.stubGlobal('navigator', {
      serial: {
        requestPort: vi.fn(async () => port),
        getPorts: vi.fn(async () => [port]),
      },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    });
  });

  it('connectManual unloads logs, stops auto-connect, and connects with selected port identity', async () => {
    const controller = createController();

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
    const controller = createController();

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
    const controller = createController();

    controller.enterLogMode();

    expect(connectionManager.disconnect).toHaveBeenCalledOnce();
    expect(connectionManager.stopAutoConnect).toHaveBeenCalledOnce();
  });

  it('suspendForLogPlayback preserves live serial and skips disconnect', () => {
    const controller = createController();

    serialConnectedListener?.({ baudRate: 57600, portIdentity: { usbVendorId: 11, usbProductId: 22 } });

    expect(controller.suspendForLogPlayback()).toBe(true);
    expect(workerBridge.suspendLiveForLog).toHaveBeenCalledOnce();
    expect(connectionManager.disconnect).not.toHaveBeenCalled();
  });

  it('keeps the suspended live snapshot until serial status is restored after log playback', () => {
    const controller = createController();

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
    const controller = createController();

    controller.connectSpoof({ unloadLog: true });

    expect(logViewerService.unload).toHaveBeenCalledOnce();
    expect(connectionManager.stopAutoConnect).toHaveBeenCalledOnce();
    expect(connectionManager.connect).toHaveBeenCalledWith({ type: 'spoof' });
  });

  it('tracks session state from spoof and serial connection events', () => {
    const controller = createController();
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
    const controller = createController();

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
    const controller = createController();

    serialConnectedListener?.({ baudRate: 57600, portIdentity: { usbVendorId: 11, usbProductId: 22 } });
    statusListener?.('no_data');

    expect(controller.currentPhase).toBe('connected_serial_idle');
    expect(controller.currentSessionState).toEqual({
      sourceType: 'serial',
      connectedBaudRate: 57600,
    });
  });

  it('clears a suspended live snapshot on a real disconnect', () => {
    const controller = createController();

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

    const controller = createController();

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
        lastPortIdentity: { usbVendorId: number; usbProductId: number; usbSerialNumber?: string } | null;
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

  it('marks Android WebUSB as waiting for a device when a serial-numbered granted port is absent', async () => {
    vi.stubGlobal('navigator', {
      usb: {
        getDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
    });

    const controller = createController();
    const states: string[] = [];
    controller.onWebUsbAvailabilityChange(state => {
      states.push(state);
    });

    controller.syncAutoConnectWebUsb({
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: { usbVendorId: 11, usbProductId: 22, usbSerialNumber: 'ftdi-123' },
      lastBaudRate: 57600,
    });

    await vi.waitFor(() => {
      expect(states).toContain('waiting_for_device');
    });
  });

  it('marks Android WebUSB as needing re-grant when the remembered device has no serial number', async () => {
    vi.stubGlobal('navigator', {
      usb: {
        getDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
    });

    const controller = createController();
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
      expect(states).toContain('needs_regrant_android');
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

    const controller = createController();
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

    const controller = createController();

    const restartSpy = vi.fn();
    (controller as unknown as { startAutoConnectWebUsbLoop: () => void }).startAutoConnectWebUsbLoop = restartSpy;
    (controller as unknown as {
      webusbAutoConnectOptions: {
        enabled: boolean;
        autoBaud: boolean;
        manualBaudRate: number;
        lastPortIdentity: { usbVendorId: number; usbProductId: number; usbSerialNumber?: string } | null;
        lastBaudRate: number | null;
      };
      mainThreadSource: { disconnect: () => Promise<void> };
      phase: 'idle';
    }).webusbAutoConnectOptions = {
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: { usbVendorId: 11, usbProductId: 22, usbSerialNumber: 'ftdi-123' },
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

  it('returns to re-grant state after unexpected disconnect when the WebUSB device has no serial number', () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {
      usb: {
        getDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
    });

    const controller = createController();
    const states: string[] = [];
    controller.onWebUsbAvailabilityChange(state => {
      states.push(state);
    });

    const restartSpy = vi.fn();
    (controller as unknown as { startAutoConnectWebUsbLoop: () => void }).startAutoConnectWebUsbLoop = restartSpy;
    (controller as unknown as {
      webusbAutoConnectOptions: {
        enabled: boolean;
        autoBaud: boolean;
        manualBaudRate: number;
        lastPortIdentity: { usbVendorId: number; usbProductId: number; usbSerialNumber?: string } | null;
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

    (controller as unknown as { handleWebUsbTransportDisconnect: () => void }).handleWebUsbTransportDisconnect();
    vi.advanceTimersByTime(1000);

    expect(restartSpy).not.toHaveBeenCalled();
    expect(states).toContain('needs_regrant_android');
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

    const controller = createController();

    const restartSpy = vi.fn();
    (controller as unknown as { startAutoConnectWebUsbLoop: () => void }).startAutoConnectWebUsbLoop = restartSpy;
    (controller as unknown as {
      webusbAutoConnectOptions: {
        enabled: boolean;
        autoBaud: boolean;
        manualBaudRate: number;
        lastPortIdentity: { usbVendorId: number; usbProductId: number; usbSerialNumber?: string } | null;
        lastBaudRate: number | null;
      };
      mainThreadSource: { disconnect: () => Promise<void> };
    }).webusbAutoConnectOptions = {
      enabled: true,
      autoBaud: true,
      manualBaudRate: 115200,
      lastPortIdentity: { usbVendorId: 11, usbProductId: 22, usbSerialNumber: 'ftdi-123' },
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

  it('dedupes probe status emitted from the worker path', () => {
    const controller = createController();
    const statuses: Array<string | null> = [];
    controller.onProbeStatus(status => {
      statuses.push(status);
    });

    probeStatusListener?.('Trying 115200 baud...');
    probeStatusListener?.('Trying 115200 baud...');
    probeStatusListener?.(null);
    probeStatusListener?.(null);

    expect(statuses).toEqual(['Trying 115200 baud...', null]);
  });

  it('WebUSB probing ignores structured garbage at 921600 and waits for a decoded packet at 500000', async () => {
    vi.useFakeTimers();
    const controller = createController();
    const builder = new MavlinkFrameBuilder(registry);
    const heartbeat = builder.buildFrame({
      messageName: 'HEARTBEAT',
      values: {
        type: 2,
        autopilot: 3,
        base_mode: 0x81,
        custom_mode: 0,
        system_status: 4,
        mavlink_version: 3,
      },
    });
    const { port: probePort } = createMockProbePort({
      921600: [createStructuredGarbageFrame(), createStructuredGarbageFrame()],
      500000: [heartbeat],
    });
    const connectSpy = vi.fn(async () => {});
    (controller as unknown as {
      connectWebUsbAtBaud: (port: unknown, baudRate: number) => Promise<void>;
    }).connectWebUsbAtBaud = connectSpy;

    const probePromise = (controller as unknown as {
      probeAndConnectWebUsb: (port: unknown, baudRates: number[], signal: AbortSignal) => Promise<boolean>;
    }).probeAndConnectWebUsb(probePort, [921600, 500000], new AbortController().signal);

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 10);

    await expect(probePromise).resolves.toBe(true);
    expect(connectSpy).toHaveBeenCalledWith(probePort, 500000);
  });
});
