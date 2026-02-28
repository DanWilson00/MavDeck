import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SpoofByteSource } from '../spoof-byte-source';
import { MavlinkMetadataRegistry } from '../../mavlink/registry';
import { MavlinkFrameParser } from '../../mavlink/frame-parser';
import { MavlinkMessageDecoder, type MavlinkMessage } from '../../mavlink/decoder';

const commonJson = readFileSync(
  resolve(__dirname, '../../../public/dialects/common.json'),
  'utf-8',
);

describe('SpoofByteSource', () => {
  let registry: MavlinkMetadataRegistry;
  let source: SpoofByteSource;
  let parser: MavlinkFrameParser;
  let decoder: MavlinkMessageDecoder;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new MavlinkMetadataRegistry();
    registry.loadFromJsonString(commonJson);
    source = new SpoofByteSource(registry);
    parser = new MavlinkFrameParser(registry);
    decoder = new MavlinkMessageDecoder(registry);
  });

  afterEach(() => {
    source.disconnect();
    vi.useRealTimers();
  });

  /** Helper: connect spoof source and pipe through parser + decoder, collecting decoded messages. */
  function collectMessages(): MavlinkMessage[] {
    const messages: MavlinkMessage[] = [];

    source.onData((data) => {
      parser.parse(data);
    });

    parser.onFrame((frame) => {
      const msg = decoder.decode(frame);
      if (msg) messages.push(msg);
    });

    return messages;
  }

  describe('IByteSource interface', () => {
    it('isConnected is false before connect', () => {
      expect(source.isConnected).toBe(false);
    });

    it('isConnected is true after connect', async () => {
      await source.connect();
      expect(source.isConnected).toBe(true);
    });

    it('isConnected is false after disconnect', async () => {
      await source.connect();
      source.disconnect();
      expect(source.isConnected).toBe(false);
    });

    it('onData returns an unsubscribe function', () => {
      const unsub = source.onData(() => {});
      expect(typeof unsub).toBe('function');
    });

    it('unsubscribe stops receiving data', async () => {
      let callCount = 0;
      const unsub = source.onData(() => {
        callCount++;
      });

      await source.connect();
      vi.advanceTimersByTime(100);
      const countBefore = callCount;
      expect(countBefore).toBeGreaterThan(0);

      unsub();
      vi.advanceTimersByTime(100);
      expect(callCount).toBe(countBefore);
    });
  });

  describe('connect and disconnect', () => {
    it('connect starts emitting bytes at expected intervals', async () => {
      const messages = collectMessages();
      await source.connect();

      // After 100ms: fast telemetry should have fired once
      vi.advanceTimersByTime(100);

      const names = new Set(messages.map((m) => m.name));
      expect(names.has('ATTITUDE')).toBe(true);
      expect(names.has('GLOBAL_POSITION_INT')).toBe(true);
      expect(names.has('VFR_HUD')).toBe(true);
    });

    it('heartbeat and SYS_STATUS arrive after 1 second', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(1000);

      const names = new Set(messages.map((m) => m.name));
      expect(names.has('HEARTBEAT')).toBe(true);
      expect(names.has('SYS_STATUS')).toBe(true);
    });

    it('disconnect stops emission', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(200);
      const countBefore = messages.length;
      expect(countBefore).toBeGreaterThan(0);

      source.disconnect();

      vi.advanceTimersByTime(1000);
      expect(messages.length).toBe(countBefore);
    });

    it('reconnect resumes emission', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(200);
      source.disconnect();

      const countAfterDisconnect = messages.length;

      await source.connect();
      vi.advanceTimersByTime(200);

      expect(messages.length).toBeGreaterThan(countAfterDisconnect);
    });
  });

  describe('frame parsing pipeline', () => {
    it('emitted bytes parse correctly through FrameParser + Decoder', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(1000);

      // Should have many messages after 1 second (10Hz * 3 types + 1Hz * 2 types)
      expect(messages.length).toBeGreaterThanOrEqual(30);
      // All messages should have parsed correctly (no CRC errors)
      expect(parser.crcErrors).toBe(0);
    });

    it('sequence numbers auto-increment', async () => {
      const frames: number[] = [];

      source.onData((data) => {
        parser.parse(data);
      });

      parser.onFrame((frame) => {
        frames.push(frame.sequence);
      });

      await source.connect();
      vi.advanceTimersByTime(100);

      // After one 100ms tick: 3 fast telemetry messages (GLOBAL_POSITION_INT, ATTITUDE, VFR_HUD)
      expect(frames.length).toBeGreaterThanOrEqual(3);

      // Sequences should be consecutive 0, 1, 2, ...
      for (let i = 0; i < frames.length; i++) {
        expect(frames[i]).toBe(i);
      }
    });
  });

  describe('HEARTBEAT decoding', () => {
    it('decoded HEARTBEAT has type=2, autopilot=3, mavlink_version=3', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(1000);

      const heartbeat = messages.find((m) => m.name === 'HEARTBEAT');
      expect(heartbeat).toBeDefined();
      expect(heartbeat!.values['type']).toBe(2);
      expect(heartbeat!.values['autopilot']).toBe(3);
      expect(heartbeat!.values['base_mode']).toBe(0x81);
      expect(heartbeat!.values['system_status']).toBe(4);
      expect(heartbeat!.values['mavlink_version']).toBe(3);
    });
  });

  describe('ATTITUDE decoding', () => {
    it('decoded ATTITUDE has roll, pitch, yaw as numbers in radian range', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(100);

      const attitude = messages.find((m) => m.name === 'ATTITUDE');
      expect(attitude).toBeDefined();

      const roll = attitude!.values['roll'] as number;
      const pitch = attitude!.values['pitch'] as number;
      const yaw = attitude!.values['yaw'] as number;

      expect(typeof roll).toBe('number');
      expect(typeof pitch).toBe('number');
      expect(typeof yaw).toBe('number');

      // Roll bounded to [-20deg, 20deg] in radians ≈ [-0.349, 0.349]
      expect(roll).toBeGreaterThanOrEqual(-0.36);
      expect(roll).toBeLessThanOrEqual(0.36);

      // Pitch bounded to [-15deg, 15deg] in radians ≈ [-0.262, 0.262]
      expect(pitch).toBeGreaterThanOrEqual(-0.27);
      expect(pitch).toBeLessThanOrEqual(0.27);

      // Yaw is heading in radians [0, 2*PI]
      expect(yaw).toBeGreaterThanOrEqual(0);
      expect(yaw).toBeLessThanOrEqual(2 * Math.PI);
    });
  });

  describe('GLOBAL_POSITION_INT decoding', () => {
    it('decoded lat is approximately 340522000 (34.0522 * 1e7)', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(100);

      const gpi = messages.find((m) => m.name === 'GLOBAL_POSITION_INT');
      expect(gpi).toBeDefined();

      const lat = gpi!.values['lat'] as number;
      const lon = gpi!.values['lon'] as number;
      const alt = gpi!.values['alt'] as number;
      const hdg = gpi!.values['hdg'] as number;

      // Initial lat = 34.0522, so lat ≈ 340522000 (within a small delta for first tick movement)
      expect(lat).toBeGreaterThan(340000000);
      expect(lat).toBeLessThan(341000000);

      // Initial lon = -118.2437, so lon ≈ -1182437000
      expect(lon).toBeGreaterThan(-1183000000);
      expect(lon).toBeLessThan(-1182000000);

      // Altitude in mm, bounded [50000, 100000]
      expect(alt).toBeGreaterThanOrEqual(50000);
      expect(alt).toBeLessThanOrEqual(100000);

      // Heading in centidegrees [0, 36000)
      expect(hdg).toBeGreaterThanOrEqual(0);
      expect(hdg).toBeLessThan(36000);
    });
  });

  describe('STATUSTEXT decoding', () => {
    it('decoded STATUSTEXT has non-empty text and severity 0-7', async () => {
      const messages = collectMessages();
      await source.connect();

      // Advance enough for at least one STATUSTEXT (3-8 seconds)
      vi.advanceTimersByTime(9000);

      const statusText = messages.find((m) => m.name === 'STATUSTEXT');
      expect(statusText).toBeDefined();

      const text = statusText!.values['text'] as string;
      const severity = statusText!.values['severity'] as number;

      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(severity).toBeGreaterThanOrEqual(0);
      expect(severity).toBeLessThanOrEqual(7);
    });
  });

  describe('VFR_HUD decoding', () => {
    it('decoded VFR_HUD has valid airspeed and groundspeed', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(100);

      const vfrHud = messages.find((m) => m.name === 'VFR_HUD');
      expect(vfrHud).toBeDefined();

      const airspeed = vfrHud!.values['airspeed'] as number;
      const groundspeed = vfrHud!.values['groundspeed'] as number;
      const heading = vfrHud!.values['heading'] as number;

      expect(typeof airspeed).toBe('number');
      expect(airspeed).toBeGreaterThanOrEqual(5);
      expect(airspeed).toBeLessThanOrEqual(25);
      expect(groundspeed).toBeGreaterThanOrEqual(5);
      expect(groundspeed).toBeLessThanOrEqual(25);
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(heading).toBeLessThan(360);
    });
  });

  describe('SYS_STATUS decoding', () => {
    it('decoded SYS_STATUS has valid battery voltage', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(1000);

      const sysStatus = messages.find((m) => m.name === 'SYS_STATUS');
      expect(sysStatus).toBeDefined();

      const voltage = sysStatus!.values['voltage_battery'] as number;
      // Voltage in mV, bounded [10000, 13000]
      expect(voltage).toBeGreaterThanOrEqual(10000);
      expect(voltage).toBeLessThanOrEqual(13000);
    });
  });

  describe('message rates', () => {
    it('fast telemetry generates ~30 messages per second (3 types at 10Hz)', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(1000);

      const fastMessages = messages.filter(
        (m) => m.name === 'ATTITUDE' || m.name === 'GLOBAL_POSITION_INT' || m.name === 'VFR_HUD',
      );

      // 10 ticks * 3 messages = 30 expected
      expect(fastMessages.length).toBe(30);
    });

    it('heartbeat generates 1 message per second', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(3000);

      const heartbeats = messages.filter((m) => m.name === 'HEARTBEAT');
      expect(heartbeats.length).toBe(3);
    });

    it('SYS_STATUS generates 1 message per second', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(3000);

      const sysStatus = messages.filter((m) => m.name === 'SYS_STATUS');
      expect(sysStatus.length).toBe(3);
    });
  });

  describe('simulation model', () => {
    it('altitude stays bounded within [50, 100] meters', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(5000);

      const altitudes = messages
        .filter((m) => m.name === 'GLOBAL_POSITION_INT')
        .map((m) => (m.values['alt'] as number) / 1000);  // mm -> m

      for (const alt of altitudes) {
        expect(alt).toBeGreaterThanOrEqual(50);
        expect(alt).toBeLessThanOrEqual(100);
      }
    });

    it('groundspeed stays bounded within [5, 25] m/s', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(5000);

      const speeds = messages
        .filter((m) => m.name === 'VFR_HUD')
        .map((m) => m.values['groundspeed'] as number);

      for (const speed of speeds) {
        expect(speed).toBeGreaterThanOrEqual(5);
        expect(speed).toBeLessThanOrEqual(25);
      }
    });

    it('battery voltage slowly drains', async () => {
      const messages = collectMessages();
      await source.connect();

      vi.advanceTimersByTime(5000);

      const voltages = messages
        .filter((m) => m.name === 'SYS_STATUS')
        .map((m) => (m.values['voltage_battery'] as number) / 1000);  // mV -> V

      // Each tick drains 0.001V, after 5 ticks should be lower than start
      expect(voltages.length).toBeGreaterThanOrEqual(5);

      // Last voltage should be less than or equal to first (monotonic drain)
      const first = voltages[0];
      const last = voltages[voltages.length - 1];
      expect(last).toBeLessThanOrEqual(first);
    });

    it('zero CRC errors across all generated frames', async () => {
      collectMessages();
      await source.connect();

      vi.advanceTimersByTime(5000);

      expect(parser.crcErrors).toBe(0);
      expect(parser.framesReceived).toBeGreaterThan(0);
    });
  });
});
