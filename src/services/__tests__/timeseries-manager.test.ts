import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimeSeriesDataManager } from '../timeseries-manager';
import type { MavlinkMessage } from '../../mavlink/decoder';

function makeMessage(
  name: string,
  values: Record<string, number | string | number[]>,
  overrides?: Partial<MavlinkMessage>,
): MavlinkMessage {
  return {
    id: 0,
    name,
    values,
    systemId: 1,
    componentId: 1,
    sequence: 0,
    ...overrides,
  };
}

describe('TimeSeriesDataManager', () => {
  let manager: TimeSeriesDataManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TimeSeriesDataManager();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it('creates ring buffers for numeric fields from ATTITUDE message', () => {
    const msg = makeMessage('ATTITUDE', {
      time_boot_ms: 12345,
      roll: 0.1,
      pitch: -0.2,
      yaw: 1.5,
      rollspeed: 0.01,
      pitchspeed: -0.02,
      yawspeed: 0.03,
    });

    manager.processMessage(msg);

    expect(manager.getBuffer('ATTITUDE.roll')).toBeDefined();
    expect(manager.getBuffer('ATTITUDE.pitch')).toBeDefined();
    expect(manager.getBuffer('ATTITUDE.yaw')).toBeDefined();
    expect(manager.getBuffer('ATTITUDE.rollspeed')).toBeDefined();
    expect(manager.getBuffer('ATTITUDE.pitchspeed')).toBeDefined();
    expect(manager.getBuffer('ATTITUDE.yawspeed')).toBeDefined();
    expect(manager.getBuffer('ATTITUDE.time_boot_ms')).toBeDefined();
  });

  it('stores correct values in ring buffers', () => {
    const msg = makeMessage('ATTITUDE', { roll: 0.1, pitch: -0.2 });

    manager.processMessage(msg);

    const rollBuf = manager.getBuffer('ATTITUDE.roll')!;
    expect(rollBuf.length).toBe(1);
    expect(rollBuf.getLatestValue()).toBe(0.1);

    const pitchBuf = manager.getBuffer('ATTITUDE.pitch')!;
    expect(pitchBuf.length).toBe(1);
    expect(pitchBuf.getLatestValue()).toBe(-0.2);
  });

  it('accumulates 100 ATTITUDE messages into ring buffers of length 100', () => {
    for (let i = 0; i < 100; i++) {
      const msg = makeMessage('ATTITUDE', {
        roll: i * 0.01,
        pitch: -i * 0.01,
        yaw: i * 0.1,
      });
      manager.processMessage(msg);
    }

    const rollBuf = manager.getBuffer('ATTITUDE.roll')!;
    expect(rollBuf.length).toBe(100);

    const pitchBuf = manager.getBuffer('ATTITUDE.pitch')!;
    expect(pitchBuf.length).toBe(100);

    const yawBuf = manager.getBuffer('ATTITUDE.yaw')!;
    expect(yawBuf.length).toBe(100);

    // Latest value should be the last one pushed
    expect(rollBuf.getLatestValue()).toBeCloseTo(99 * 0.01);
    expect(pitchBuf.getLatestValue()).toBeCloseTo(-99 * 0.01);
  });

  it('getAvailableFields() returns all created field keys sorted', () => {
    manager.processMessage(makeMessage('ATTITUDE', { roll: 0.1, pitch: -0.2 }));
    manager.processMessage(makeMessage('HEARTBEAT', { type: 6, autopilot: 3 }));

    const fields = manager.getAvailableFields();
    expect(fields).toEqual([
      'ATTITUDE.pitch',
      'ATTITUDE.roll',
      'HEARTBEAT.autopilot',
      'HEARTBEAT.type',
    ]);
  });

  it('skips string fields — STATUSTEXT.text does NOT create a ring buffer', () => {
    const msg = makeMessage('STATUSTEXT', {
      severity: 4,
      text: 'PreArm: Compass not calibrated',
    });

    manager.processMessage(msg);

    expect(manager.getBuffer('STATUSTEXT.severity')).toBeDefined();
    expect(manager.getBuffer('STATUSTEXT.text')).toBeUndefined();
  });

  it('expands number[] array fields into indexed sub-keys', () => {
    const msg = makeMessage('SERVO_OUTPUT_RAW', {
      time_usec: 1000000,
      servo1_raw: 1500,
      servo_values: [1100, 1200, 1300, 1400],
    });

    manager.processMessage(msg);

    expect(manager.getBuffer('SERVO_OUTPUT_RAW.servo_values[0]')).toBeDefined();
    expect(manager.getBuffer('SERVO_OUTPUT_RAW.servo_values[1]')).toBeDefined();
    expect(manager.getBuffer('SERVO_OUTPUT_RAW.servo_values[2]')).toBeDefined();
    expect(manager.getBuffer('SERVO_OUTPUT_RAW.servo_values[3]')).toBeDefined();

    expect(manager.getBuffer('SERVO_OUTPUT_RAW.servo_values[0]')!.getLatestValue()).toBe(1100);
    expect(manager.getBuffer('SERVO_OUTPUT_RAW.servo_values[3]')!.getLatestValue()).toBe(1400);

    // The array itself should NOT be a buffer key
    expect(manager.getBuffer('SERVO_OUTPUT_RAW.servo_values')).toBeUndefined();
  });

  it('onUpdate callback fires after processMessage (throttled)', () => {
    let callCount = 0;
    manager.onUpdate(() => {
      callCount++;
    });

    manager.processMessage(makeMessage('ATTITUDE', { roll: 0.1 }));

    // Callback should not fire synchronously
    expect(callCount).toBe(0);

    // Advance past the throttle interval (16ms)
    vi.advanceTimersByTime(16);
    expect(callCount).toBe(1);
  });

  it('onUpdate called at most 60 times/second under rapid input', () => {
    let callCount = 0;
    manager.onUpdate(() => {
      callCount++;
    });

    // Fire 1000 messages in rapid succession over 1 second
    for (let i = 0; i < 1000; i++) {
      manager.processMessage(makeMessage('ATTITUDE', { roll: i * 0.001 }));
      vi.advanceTimersByTime(1); // 1ms per message
    }

    // Over 1000ms at 16ms throttle, expect at most ceil(1000/16) = 63 callbacks
    // The exact count depends on timer coalescing, but must be <=63
    expect(callCount).toBeLessThanOrEqual(63);
    expect(callCount).toBeGreaterThan(0);
  });

  it('onUpdate unsubscribe stops callback invocations', () => {
    let callCount = 0;
    const unsub = manager.onUpdate(() => {
      callCount++;
    });

    manager.processMessage(makeMessage('ATTITUDE', { roll: 0.1 }));
    vi.advanceTimersByTime(16);
    expect(callCount).toBe(1);

    unsub();

    manager.processMessage(makeMessage('ATTITUDE', { roll: 0.2 }));
    vi.advanceTimersByTime(16);
    expect(callCount).toBe(1); // should not increase
  });

  it('dispose clears pending timers and callbacks', () => {
    let callCount = 0;
    manager.onUpdate(() => {
      callCount++;
    });

    manager.processMessage(makeMessage('ATTITUDE', { roll: 0.1 }));

    // Dispose before the throttle fires
    manager.dispose();

    vi.advanceTimersByTime(100);
    expect(callCount).toBe(0);
  });

  it('enforces maxFields limit — stops creating new buffers after limit', () => {
    const smallManager = new TimeSeriesDataManager({ maxFields: 3 });

    smallManager.processMessage(makeMessage('MSG', {
      field_a: 1,
      field_b: 2,
      field_c: 3,
      field_d: 4,
    }));

    // Only the first 3 fields should have buffers
    expect(smallManager.getAvailableFields().length).toBe(3);

    // The 4th field should be silently dropped
    const allFields = smallManager.getAvailableFields();
    expect(allFields.length).toBe(3);

    smallManager.dispose();
  });

  it('respects custom bufferCapacity', () => {
    const smallManager = new TimeSeriesDataManager({ bufferCapacity: 10 });

    for (let i = 0; i < 20; i++) {
      smallManager.processMessage(makeMessage('ATTITUDE', { roll: i }));
    }

    const buf = smallManager.getBuffer('ATTITUDE.roll')!;
    // Buffer should wrap at capacity 10
    expect(buf.length).toBe(10);
    // Latest value should be the last pushed
    expect(buf.getLatestValue()).toBe(19);

    smallManager.dispose();
  });

  it('returns undefined for unknown field keys', () => {
    expect(manager.getBuffer('NONEXISTENT.field')).toBeUndefined();
  });

  it('getAvailableFields returns empty array when no messages processed', () => {
    expect(manager.getAvailableFields()).toEqual([]);
  });

  it('multiple onUpdate subscribers all receive notifications', () => {
    let count1 = 0;
    let count2 = 0;
    manager.onUpdate(() => { count1++; });
    manager.onUpdate(() => { count2++; });

    manager.processMessage(makeMessage('ATTITUDE', { roll: 0.1 }));
    vi.advanceTimersByTime(16);

    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });

  it('handles messages from different message types independently', () => {
    manager.processMessage(makeMessage('ATTITUDE', { roll: 0.1 }));
    manager.processMessage(makeMessage('GPS_RAW_INT', { lat: 473977400, lon: 85455100 }));

    expect(manager.getBuffer('ATTITUDE.roll')).toBeDefined();
    expect(manager.getBuffer('GPS_RAW_INT.lat')).toBeDefined();
    expect(manager.getBuffer('GPS_RAW_INT.lon')).toBeDefined();

    // Keys should not collide
    expect(manager.getBuffer('ATTITUDE.lat')).toBeUndefined();
    expect(manager.getBuffer('GPS_RAW_INT.roll')).toBeUndefined();
  });
});
