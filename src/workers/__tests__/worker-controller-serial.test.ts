/**
 * Tests for WorkerController serial-related command handlers.
 *
 * Uses vi.mock() to replace WorkerSerialByteSource and SerialProbeService
 * with controllable fakes, and stubs navigator.serial.getPorts().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerController } from '../worker-controller';
import type { WorkerEvent } from '../worker-protocol';
import { loadCommonDialectJson } from '../../test-helpers/load-dialect';
import { MavlinkMetadataRegistry } from '../../mavlink/registry';
import { MavlinkFrameBuilder } from '../../mavlink/frame-builder';

// ---------------------------------------------------------------------------
// Shared state for mock access
// ---------------------------------------------------------------------------

/** Most recently created mock serial source — set by mock constructor. */
let mockSerialSource: MockSerial | null = null;

interface MockSerial {
  isConnected: boolean;
  pushData(data: Uint8Array): void;
  simulateDisconnect(): void;
  suspend(): Promise<void>;
  resumeAttached(): void;
  disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Module mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

vi.mock('../../services/worker-serial-byte-source', () => {
  return {
    WorkerSerialByteSource: class {
      private dataCallbacks = new Set<(data: Uint8Array) => void>();
      private disconnectCb?: () => void;
      isConnected = false;

      constructor(_port: unknown, public baudRate: number, onDisconnect?: () => void) {
        this.disconnectCb = onDisconnect;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__mockSerialSource = this;
      }

      onData(cb: (data: Uint8Array) => void): () => void {
        this.dataCallbacks.add(cb);
        return () => this.dataCallbacks.delete(cb);
      }

      async connect(): Promise<void> { this.isConnected = true; }
      async disconnect(): Promise<void> { this.isConnected = false; this.dataCallbacks.clear(); }
      async write(): Promise<void> { /* no-op */ }
      detach(): void { this.isConnected = false; }
      async suspend(): Promise<void> { this.isConnected = false; }
      resumeAttached(): void { this.isConnected = true; }

      pushData(data: Uint8Array): void {
        for (const cb of this.dataCallbacks) cb(data);
      }

      simulateDisconnect(): void {
        this.disconnectCb?.();
      }
    },
  };
});

vi.mock('../../services/serial-probe-service', () => {
  return {
    SerialProbeService: class {
      _isProbing = false;
      get isProbing() { return this._isProbing; }
      startProbing(config: { onResult: (r: { port: unknown; baudRate: number }) => void; onStatus: (s: unknown) => void }) {
        this._isProbing = true;
        // Store for test access
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any)._config = config;
      }
      stopProbing() { this._isProbing = false; }
      async probeSinglePort(
        port: unknown,
        opts: { onStatus: (s: unknown) => void },
      ) {
        opts.onStatus({ baudRate: 115200, status: 'trying' });
        return { port, baudRate: 115200 };
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const commonJson = loadCommonDialectJson();

/** Build a valid MAVLink HEARTBEAT frame for injection into fake serial source. */
function buildHeartbeatPacket(): Uint8Array {
  const registry = new MavlinkMetadataRegistry();
  registry.loadFromJsonString(commonJson);
  const builder = new MavlinkFrameBuilder(registry);
  return builder.buildFrame({
    messageName: 'HEARTBEAT',
    values: { type: 0, autopilot: 0, base_mode: 0, custom_mode: 0, system_status: 0, mavlink_version: 3 },
    systemId: 1,
    componentId: 1,
    sequence: 0,
  });
}

function createEventCollector() {
  const events: WorkerEvent[] = [];
  const postEvent = (event: WorkerEvent) => { events.push(event); };
  return {
    events,
    postEvent,
    ofType: <T extends WorkerEvent['type']>(type: T) =>
      events.filter(e => e.type === type) as Extract<WorkerEvent, { type: T }>[],
    last: <T extends WorkerEvent['type']>(type: T) => {
      const matches = events.filter(e => e.type === type) as Extract<WorkerEvent, { type: T }>[];
      return matches[matches.length - 1];
    },
    clear: () => { events.length = 0; },
  };
}

function mockPort(info: Partial<SerialPortInfo> = {}): SerialPort {
  return {
    getInfo: () => ({ usbVendorId: 0x1234, usbProductId: 0x5678, ...info }),
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    readable: null,
    writable: null,
  } as unknown as SerialPort;
}

async function initController(postEvent: (e: WorkerEvent) => void) {
  const controller = new WorkerController(postEvent);
  await controller.handleCommand({ type: 'init', dialectJson: commonJson });
  return controller;
}

/**
 * Connect serial and inject a HEARTBEAT to satisfy waitForFirstDecodedMessage.
 * Returns the mock serial source.
 */
async function connectSerial(
  controller: WorkerController,
  heartbeat: Uint8Array,
): Promise<MockSerial> {
  const connectPromise = controller.handleCommand({
    type: 'connectSerial',
    baudRate: 115200,
    autoDetectBaud: false,
    portIdentity: null,
    lastBaudRate: null,
  });

  // getPorts().then() resolves on next microtask
  await vi.advanceTimersByTimeAsync(0);

  // The mock source should now exist
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const source = (globalThis as any).__mockSerialSource as MockSerial;
  if (source) {
    // Inject a valid frame so waitForFirstDecodedMessage resolves
    source.pushData(heartbeat);
  }

  await vi.advanceTimersByTimeAsync(100);
  await connectPromise;

  return source;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerController serial handlers', () => {
  let heartbeat: Uint8Array;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSerialSource = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__mockSerialSource = null;
    heartbeat = buildHeartbeatPacket();

    // Stub navigator.serial
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serial: {
          getPorts: vi.fn(async () => [mockPort()]),
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // connectSerial — direct baud rate
  // -----------------------------------------------------------------------

  describe('connectSerial (direct baud)', () => {
    it('connects at specified baud rate and posts connected status', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);

      collector.clear();
      await connectSerial(controller, heartbeat);

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('connected');

      const serialEvents = collector.ofType('serialConnected');
      expect(serialEvents.length).toBe(1);
      expect(serialEvents[0].baudRate).toBe(115200);
    });

    it('posts error when registry not initialized', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({
        type: 'connectSerial',
        baudRate: 115200,
        autoDetectBaud: false,
        portIdentity: null,
        lastBaudRate: null,
      });

      expect(collector.ofType('error').length).toBe(1);
      expect(collector.ofType('error')[0].message).toContain('Registry not initialized');
    });

    it('posts disconnected when no ports available', async () => {
      (navigator.serial.getPorts as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);

      collector.clear();
      await controller.handleCommand({
        type: 'connectSerial',
        baudRate: 115200,
        autoDetectBaud: false,
        portIdentity: null,
        lastBaudRate: null,
      });
      await vi.advanceTimersByTimeAsync(100);

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('disconnected');
    });
  });

  // -----------------------------------------------------------------------
  // connectSerial — auto-detect baud
  // -----------------------------------------------------------------------

  describe('connectSerial (auto-detect baud)', () => {
    it('probes baud rates and connects on success', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);

      collector.clear();
      const connectPromise = controller.handleCommand({
        type: 'connectSerial',
        baudRate: 115200,
        autoDetectBaud: true,
        portIdentity: null,
        lastBaudRate: null,
      });
      await vi.advanceTimersByTimeAsync(0);

      // probeSinglePort resolves immediately in our mock with { port, baudRate: 115200 }
      // which triggers completeSerialConnect → need to inject heartbeat
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const source = (globalThis as any).__mockSerialSource as MockSerial | null;
      if (source) source.pushData(heartbeat);

      await vi.advanceTimersByTimeAsync(100);
      await connectPromise;

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('probing');
      expect(statuses).toContain('connected');
    });
  });

  // -----------------------------------------------------------------------
  // startAutoConnect / stopAutoConnect
  // -----------------------------------------------------------------------

  describe('startAutoConnect / stopAutoConnect', () => {
    it('starts probing and posts probing status', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);

      collector.clear();
      await controller.handleCommand({
        type: 'startAutoConnect',
        autoBaud: true,
        manualBaudRate: 115200,
        lastPortIdentity: null,
        lastBaudRate: null,
      });

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('probing');
    });

    it('stopAutoConnect clears probe and posts disconnected if was probing', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);

      await controller.handleCommand({
        type: 'startAutoConnect',
        autoBaud: true,
        manualBaudRate: 115200,
        lastPortIdentity: null,
        lastBaudRate: null,
      });

      collector.clear();
      await controller.handleCommand({ type: 'stopAutoConnect' });

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('disconnected');
    });

    it('stopAutoConnect is silent when not probing', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);

      collector.clear();
      await controller.handleCommand({ type: 'stopAutoConnect' });

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).not.toContain('disconnected');
    });
  });

  // -----------------------------------------------------------------------
  // portsChanged
  // -----------------------------------------------------------------------

  describe('portsChanged', () => {
    it('restarts probe when auto-connect is active', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);

      await controller.handleCommand({
        type: 'startAutoConnect',
        autoBaud: true,
        manualBaudRate: 115200,
        lastPortIdentity: null,
        lastBaudRate: null,
      });

      collector.clear();
      await controller.handleCommand({ type: 'portsChanged' });

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('probing');
    });

    it('is a no-op when auto-connect is not configured', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);

      collector.clear();
      await controller.handleCommand({ type: 'portsChanged' });

      expect(collector.events.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // disconnect after serial connect
  // -----------------------------------------------------------------------

  describe('disconnect after serial', () => {
    it('cleans up serial state', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);
      await connectSerial(controller, heartbeat);

      collector.clear();
      await controller.handleCommand({ type: 'disconnect' });

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('disconnected');
    });
  });

  // -----------------------------------------------------------------------
  // suspendLiveForLog / resumeSuspendedLive
  // -----------------------------------------------------------------------

  describe('suspend / resume for log playback', () => {
    it('suspends live serial and resumes afterward', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);
      await connectSerial(controller, heartbeat);

      // Suspend for log
      collector.clear();
      await controller.handleCommand({ type: 'suspendLiveForLog' });

      const fieldEvents = collector.ofType('availableFields');
      expect(fieldEvents.some(e => e.fields.length === 0)).toBe(true);

      // Resume live
      collector.clear();
      await controller.handleCommand({ type: 'resumeSuspendedLive' });

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('connected');
    });

    it('suspend is a no-op when no serial source exists', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);

      collector.clear();
      await controller.handleCommand({ type: 'suspendLiveForLog' });

      expect(collector.ofType('statusChange').length).toBe(0);
    });

    it('resume is a no-op when not suspended', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);

      collector.clear();
      await controller.handleCommand({ type: 'resumeSuspendedLive' });

      expect(collector.ofType('statusChange').length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // handleSerialDisconnect (unexpected)
  // -----------------------------------------------------------------------

  describe('unexpected serial disconnect', () => {
    it('posts disconnected and cleans up', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const source = await connectSerial(controller, heartbeat);

      collector.clear();
      source.simulateDisconnect();
      await vi.advanceTimersByTimeAsync(100);

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('disconnected');
    });

    it('schedules reconnect when auto-connect is configured', async () => {
      const collector = createEventCollector();
      const controller = await initController(collector.postEvent);

      // Connect serial first
      const source = await connectSerial(controller, heartbeat);

      // Set auto-connect config AFTER connect (simulating the real-world flow
      // where auto-connect probe found a port and connected successfully —
      // the config persists through completeSerialConnect)
      await controller.handleCommand({
        type: 'startAutoConnect',
        autoBaud: false,
        manualBaudRate: 115200,
        lastPortIdentity: null,
        lastBaudRate: null,
      });

      collector.clear();
      source.simulateDisconnect();
      await vi.advanceTimersByTimeAsync(100);

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('disconnected');

      // After 2s reconnect timer, should start probing again
      collector.clear();
      await vi.advanceTimersByTimeAsync(2100);

      const reconnectStatuses = collector.ofType('statusChange').map(e => e.status);
      expect(reconnectStatuses).toContain('probing');
    });
  });
});
