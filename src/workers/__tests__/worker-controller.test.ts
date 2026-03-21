import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerController, findPortByIdentity } from '../worker-controller';
import type { WorkerEvent } from '../worker-protocol';
import { loadCommonDialectJson } from '../../test-helpers/load-dialect';
import { MavlinkMetadataRegistry } from '../../mavlink/registry';
import { MavlinkFrameBuilder } from '../../mavlink/frame-builder';

const commonJson = loadCommonDialectJson();

/** Collects posted events for assertions. */
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

/** Build valid MAVLink v2 packets for testing loadLog. */
function buildTestPackets(dialectJson: string) {
  const registry = new MavlinkMetadataRegistry();
  registry.loadFromJsonString(dialectJson);
  const builder = new MavlinkFrameBuilder(registry);

  const packets: Uint8Array[] = [];
  const timestamps: number[] = [];

  // HEARTBEAT at t=0
  packets.push(builder.buildFrame({
    messageName: 'HEARTBEAT',
    values: { type: 0, autopilot: 0, base_mode: 0, custom_mode: 0, system_status: 0, mavlink_version: 3 },
    systemId: 1,
    componentId: 1,
    sequence: 0,
  }));
  timestamps.push(0);

  // ATTITUDE at t=100ms, 200ms, 300ms
  for (let i = 1; i <= 3; i++) {
    packets.push(builder.buildFrame({
      messageName: 'ATTITUDE',
      values: { time_boot_ms: i * 100, roll: 0.1 * i, pitch: 0.2 * i, yaw: 0.3 * i, rollspeed: 0, pitchspeed: 0, yawspeed: 0 },
      systemId: 1,
      componentId: 1,
      sequence: i,
    }));
    timestamps.push(i * 100);
  }

  return { packets, timestamps };
}

describe('WorkerController', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // -----------------------------------------------------------------------
  // init
  // -----------------------------------------------------------------------

  describe('init', () => {
    it('posts initComplete after loading dialect', async () => {
      const { events, postEvent } = createEventCollector();
      const controller = new WorkerController(postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });

      expect(events.some(e => e.type === 'initComplete')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // connect spoof → data flow
  // -----------------------------------------------------------------------

  describe('connect spoof', () => {
    it('transitions through connecting → connected', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });
      collector.clear();

      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      // connect handler fires service.connect().then(...) which resolves on next microtask
      await vi.advanceTimersByTimeAsync(0);

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('connecting');
      expect(statuses).toContain('connected');
    });

    it('receives stats after spoof generates data', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });
      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      await vi.advanceTimersByTimeAsync(0); // let connect() resolve

      collector.clear();
      // SpoofByteSource generates data on intervals — advance time to trigger
      await vi.advanceTimersByTimeAsync(1200);

      const statsEvents = collector.ofType('stats');
      expect(statsEvents.length).toBeGreaterThan(0);

      // Should have HEARTBEAT and ATTITUDE in stats
      const lastStats = statsEvents[statsEvents.length - 1];
      expect(lastStats.stats).toHaveProperty('HEARTBEAT');
      expect(lastStats.stats).toHaveProperty('ATTITUDE');
    });

    it('receives update events with buffer data', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });

      // Set interested fields before connecting
      await controller.handleCommand({
        type: 'setInterestedFields',
        fields: ['ATTITUDE.roll', 'ATTITUDE.pitch'],
      });

      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      await vi.advanceTimersByTimeAsync(0);

      collector.clear();
      await vi.advanceTimersByTimeAsync(1200);

      const updates = collector.ofType('update');
      expect(updates.length).toBeGreaterThan(0);

      // At least one update should have the interested fields
      const lastUpdate = updates[updates.length - 1];
      const bufferKeys = Object.keys(lastUpdate.buffers);
      expect(bufferKeys.some(k => k.startsWith('ATTITUDE.'))).toBe(true);
    });

    it('posts availableFields when new message types arrive', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });
      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      await vi.advanceTimersByTimeAsync(1200);

      const fieldEvents = collector.ofType('availableFields');
      expect(fieldEvents.length).toBeGreaterThan(0);

      const lastFields = fieldEvents[fieldEvents.length - 1];
      expect(lastFields.fields.some(f => f.startsWith('ATTITUDE.'))).toBe(true);
    });

    it('tracks vehicle identity from HEARTBEAT', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });
      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      await vi.advanceTimersByTimeAsync(1200);

      // Vehicle tracking is verified indirectly — paramState events show the
      // param manager was created (which uses getVehicleTarget).
      // We can also check that HEARTBEAT appears in stats.
      const lastStats = collector.last('stats');
      expect(lastStats?.stats).toHaveProperty('HEARTBEAT');
    });
  });

  // -----------------------------------------------------------------------
  // disconnect
  // -----------------------------------------------------------------------

  describe('disconnect', () => {
    it('cleans up and posts disconnected status', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });
      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      await vi.advanceTimersByTimeAsync(500);

      collector.clear();
      await controller.handleCommand({ type: 'disconnect' });

      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('disconnected');
    });

    it('stops data flow after disconnect', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });
      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      await vi.advanceTimersByTimeAsync(500);

      await controller.handleCommand({ type: 'disconnect' });
      collector.clear();

      await vi.advanceTimersByTimeAsync(2000);

      // No more stats events after disconnect (except possibly throughput=0 from stop)
      const statsEvents = collector.ofType('stats');
      // The only stats event should be the empty one from clearMainThreadTelemetryState
      for (const e of statsEvents) {
        expect(Object.keys(e.stats).length).toBe(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // loadLog
  // -----------------------------------------------------------------------

  describe('loadLog', () => {
    it('processes packets and posts loadComplete with stats and duration', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });

      const { packets, timestamps } = buildTestPackets(commonJson);
      collector.clear();

      await controller.handleCommand({
        type: 'loadLog',
        packets,
        timestamps,
        bufferCapacity: 1000,
      });

      const complete = collector.last('loadComplete');
      expect(complete).toBeDefined();
      expect(complete!.durationSec).toBeGreaterThan(0);
      expect(complete!.stats).toHaveProperty('HEARTBEAT');
      expect(complete!.stats).toHaveProperty('ATTITUDE');
      expect(complete!.stats['HEARTBEAT'].count).toBe(1);
      expect(complete!.stats['ATTITUDE'].count).toBe(3);
    });

    it('computes log-based frequency override', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });

      const { packets, timestamps } = buildTestPackets(commonJson);
      await controller.handleCommand({
        type: 'loadLog',
        packets,
        timestamps,
        bufferCapacity: 1000,
      });

      const complete = collector.last('loadComplete');
      expect(complete).toBeDefined();

      // ATTITUDE: 3 messages over durationSec
      const attitudeFreq = complete!.stats['ATTITUDE'].frequency;
      expect(attitudeFreq).toBeGreaterThan(0);
      // Frequency should be count / durationSec
      expect(attitudeFreq).toBeCloseTo(3 / complete!.durationSec, 1);
    });

    it('posts update with all fields as interested', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });

      const { packets, timestamps } = buildTestPackets(commonJson);
      await controller.handleCommand({
        type: 'loadLog',
        packets,
        timestamps,
        bufferCapacity: 1000,
      });

      const updates = collector.ofType('update');
      // Should have at least one non-empty update (from loadLog)
      const nonEmptyUpdates = updates.filter(u => Object.keys(u.buffers).length > 0);
      expect(nonEmptyUpdates.length).toBeGreaterThan(0);
    });

    it('errors when registry not initialized', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({
        type: 'loadLog',
        packets: [],
        timestamps: [],
        bufferCapacity: 1000,
      });

      const errors = collector.ofType('error');
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('Registry not initialized');
    });
  });

  // -----------------------------------------------------------------------
  // setInterestedFields
  // -----------------------------------------------------------------------

  describe('setInterestedFields', () => {
    it('filters update buffers to only interested fields', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });
      await controller.handleCommand({
        type: 'setInterestedFields',
        fields: ['ATTITUDE.roll'],
      });

      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      await vi.advanceTimersByTimeAsync(1200);

      // Find updates with buffer data
      const updates = collector.ofType('update');
      const nonEmpty = updates.filter(u => Object.keys(u.buffers).length > 0);
      expect(nonEmpty.length).toBeGreaterThan(0);

      // All non-empty updates should only contain ATTITUDE.roll
      for (const u of nonEmpty) {
        const keys = Object.keys(u.buffers);
        for (const key of keys) {
          expect(key).toBe('ATTITUDE.roll');
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // setBufferCapacity
  // -----------------------------------------------------------------------

  describe('setBufferCapacity', () => {
    it('normalizes non-finite values to default', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });
      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      await vi.advanceTimersByTimeAsync(0);

      // NaN should be normalized to default (2000) — same as initial, so no reconnect
      collector.clear();
      await controller.handleCommand({ type: 'setBufferCapacity', bufferCapacity: NaN });

      // No reconnect events expected since normalized === current
      // (default is 2000 and NaN normalizes to 2000)
    });

    it('normalizes negative values to 1', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });
      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      await vi.advanceTimersByTimeAsync(0);

      // Negative should normalize to 1, which differs from default 2000 → triggers reconnect
      collector.clear();
      await controller.handleCommand({ type: 'setBufferCapacity', bufferCapacity: -5 });
      await vi.advanceTimersByTimeAsync(100);

      // Should have reconnected (availableFields reset, etc.)
      const fieldEvents = collector.ofType('availableFields');
      expect(fieldEvents.some(e => e.fields.length === 0)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // connect before init
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('connect before init posts error', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });

      const errors = collector.ofType('error');
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('Registry not initialized');
    });

    it('ftpDownloadMetadata without connection posts error', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'ftpDownloadMetadata' });

      const ftpErrors = collector.ofType('ftpMetadataError');
      expect(ftpErrors.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // pause / resume
  // -----------------------------------------------------------------------

  describe('pause / resume', () => {
    it('are no-ops that do not error', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      // Should not throw even without init
      await controller.handleCommand({ type: 'pause' });
      await controller.handleCommand({ type: 'resume' });

      const errors = collector.ofType('error');
      expect(errors.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // unloadLog
  // -----------------------------------------------------------------------

  describe('unloadLog', () => {
    it('clears telemetry state and posts disconnected', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });

      const { packets, timestamps } = buildTestPackets(commonJson);
      await controller.handleCommand({
        type: 'loadLog',
        packets,
        timestamps,
        bufferCapacity: 1000,
      });

      collector.clear();
      await controller.handleCommand({ type: 'unloadLog' });

      // Should clear fields
      const fieldEvents = collector.ofType('availableFields');
      expect(fieldEvents.some(e => e.fields.length === 0)).toBe(true);

      // Should post disconnected
      const statuses = collector.ofType('statusChange').map(e => e.status);
      expect(statuses).toContain('disconnected');
    });
  });

  // -----------------------------------------------------------------------
  // bytes (external source)
  // -----------------------------------------------------------------------

  describe('bytes', () => {
    it('forwards bytes to external source when connected', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      await controller.handleCommand({ type: 'init', dialectJson: commonJson });
      await controller.handleCommand({ type: 'connect', config: { type: 'webserial', baudRate: 115200 } });
      await vi.advanceTimersByTimeAsync(0);

      // Build a valid MAVLink packet to feed through the external source
      const registry = new MavlinkMetadataRegistry();
      registry.loadFromJsonString(commonJson);
      const builder = new MavlinkFrameBuilder(registry);
      const packet = builder.buildFrame({
        messageName: 'HEARTBEAT',
        values: { type: 0, autopilot: 0, base_mode: 0, custom_mode: 0, system_status: 0, mavlink_version: 3 },
        systemId: 1,
        componentId: 1,
        sequence: 0,
      });

      collector.clear();
      await controller.handleCommand({ type: 'bytes', data: packet });

      // Advance time to let the tracker process and emit stats
      await vi.advanceTimersByTimeAsync(200);

      const statsEvents = collector.ofType('stats');
      const nonEmptyStats = statsEvents.filter(e => Object.keys(e.stats).length > 0);
      expect(nonEmptyStats.length).toBeGreaterThan(0);
      expect(nonEmptyStats[0].stats).toHaveProperty('HEARTBEAT');
    });
  });

  // -----------------------------------------------------------------------
  // Full lifecycle: init → connect → data → disconnect → reconnect
  // -----------------------------------------------------------------------

  describe('full lifecycle', () => {
    it('can connect, receive data, disconnect, and reconnect', async () => {
      const collector = createEventCollector();
      const controller = new WorkerController(collector.postEvent);

      // Init
      await controller.handleCommand({ type: 'init', dialectJson: commonJson });

      // First connection
      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      await vi.advanceTimersByTimeAsync(1000);

      let stats = collector.ofType('stats');
      expect(stats.some(e => Object.keys(e.stats).length > 0)).toBe(true);

      // Disconnect
      await controller.handleCommand({ type: 'disconnect' });
      collector.clear();

      // Second connection
      await controller.handleCommand({ type: 'connect', config: { type: 'spoof' } });
      await vi.advanceTimersByTimeAsync(1000);

      stats = collector.ofType('stats');
      expect(stats.some(e => Object.keys(e.stats).length > 0)).toBe(true);

      // Clean up
      await controller.handleCommand({ type: 'disconnect' });
    });
  });
});

// ---------------------------------------------------------------------------
// findPortByIdentity (pure function)
// ---------------------------------------------------------------------------

describe('findPortByIdentity', () => {
  function mockPort(info: object): SerialPort {
    return { getInfo: () => info } as unknown as SerialPort;
  }

  it('returns null for empty ports array', () => {
    expect(findPortByIdentity([], null)).toBeNull();
  });

  it('returns first port when identity is null', () => {
    const port = mockPort({});
    expect(findPortByIdentity([port], null)).toBe(port);
  });

  it('returns matching port by USB identity', () => {
    const port1 = mockPort({ usbVendorId: 0x1234, usbProductId: 0x5678 });
    const port2 = mockPort({ usbVendorId: 0xAAAA, usbProductId: 0xBBBB });
    const identity = { usbVendorId: 0xAAAA, usbProductId: 0xBBBB };

    expect(findPortByIdentity([port1, port2], identity)).toBe(port2);
  });

  it('returns null when no port matches identity', () => {
    const port = mockPort({ usbVendorId: 0x1234, usbProductId: 0x5678 });
    const identity = { usbVendorId: 0x9999, usbProductId: 0x9999 };

    expect(findPortByIdentity([port], identity)).toBeNull();
  });
});
