import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GenericMessageTracker } from '../message-tracker';
import type { MavlinkMessage } from '../../mavlink/decoder';

function makeMessage(name: string, overrides?: Partial<MavlinkMessage>): MavlinkMessage {
  return {
    id: 0,
    name,
    values: {},
    systemId: 1,
    componentId: 1,
    sequence: 0,
    ...overrides,
  };
}

describe('GenericMessageTracker', () => {
  let tracker: GenericMessageTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new GenericMessageTracker();
  });

  afterEach(() => {
    tracker.stopTracking();
    vi.useRealTimers();
  });

  it('tracks 10 messages at 100ms intervals and reports ~10 Hz', () => {
    tracker.startTracking();

    // Send 10 messages at 100ms intervals (simulating 10 Hz)
    for (let i = 0; i < 10; i++) {
      tracker.trackMessage(makeMessage('HEARTBEAT'));
      vi.advanceTimersByTime(100);
    }

    const stats = tracker.getStats();
    const heartbeat = stats.get('HEARTBEAT');
    expect(heartbeat).toBeDefined();
    expect(heartbeat!.count).toBe(10);
    // frequency should be approximately 10 Hz (±1)
    expect(heartbeat!.frequency).toBeGreaterThanOrEqual(9);
    expect(heartbeat!.frequency).toBeLessThanOrEqual(11);
  });

  it('decays frequency to 0 after messages stop', () => {
    tracker.startTracking();

    // Send messages for 1 second at 10 Hz
    for (let i = 0; i < 10; i++) {
      tracker.trackMessage(makeMessage('ATTITUDE'));
      vi.advanceTimersByTime(100);
    }

    // Verify frequency is non-zero before decay
    let stats = tracker.getStats();
    expect(stats.get('ATTITUDE')!.frequency).toBeGreaterThan(0);

    // Advance past the decay period: 2s start + 3s decay = 5s total
    vi.advanceTimersByTime(5000);

    stats = tracker.getStats();
    expect(stats.get('ATTITUDE')!.frequency).toBe(0);
  });

  it('tracks two different message types with independent frequencies', () => {
    tracker.startTracking();

    // HEARTBEAT at 1 Hz (every 1000ms), ATTITUDE at 10 Hz (every 100ms)
    for (let i = 0; i < 10; i++) {
      tracker.trackMessage(makeMessage('ATTITUDE'));
      if (i === 0) {
        tracker.trackMessage(makeMessage('HEARTBEAT'));
      }
      vi.advanceTimersByTime(100);
    }

    // Send another HEARTBEAT at t=1000ms
    tracker.trackMessage(makeMessage('HEARTBEAT'));
    vi.advanceTimersByTime(100);

    const stats = tracker.getStats();

    const attitude = stats.get('ATTITUDE');
    expect(attitude).toBeDefined();
    expect(attitude!.frequency).toBeGreaterThanOrEqual(9);
    expect(attitude!.frequency).toBeLessThanOrEqual(11);

    const heartbeat = stats.get('HEARTBEAT');
    expect(heartbeat).toBeDefined();
    // 2 messages over 1000ms = 1 Hz
    expect(heartbeat!.frequency).toBeGreaterThanOrEqual(0.5);
    expect(heartbeat!.frequency).toBeLessThanOrEqual(1.5);
  });

  it('removes stale entries after 10s of no messages', () => {
    tracker.startTracking();

    tracker.trackMessage(makeMessage('STALE_MSG'));
    vi.advanceTimersByTime(100);

    expect(tracker.getStats().has('STALE_MSG')).toBe(true);

    // Advance past the stale threshold (10 seconds)
    vi.advanceTimersByTime(10000);

    expect(tracker.getStats().has('STALE_MSG')).toBe(false);
  });

  it('getStats returns a snapshot that cannot mutate internal state', () => {
    tracker.trackMessage(makeMessage('HEARTBEAT'));
    tracker.startTracking();
    vi.advanceTimersByTime(100);

    const snapshot1 = tracker.getStats();
    const heartbeat1 = snapshot1.get('HEARTBEAT')!;

    // Send more messages
    tracker.trackMessage(makeMessage('HEARTBEAT'));
    vi.advanceTimersByTime(100);

    const snapshot2 = tracker.getStats();
    const heartbeat2 = snapshot2.get('HEARTBEAT')!;

    // snapshot1 should not have changed
    expect(heartbeat1.count).toBe(1);
    expect(heartbeat2.count).toBe(2);

    // Mutating snapshot should not affect internal state
    snapshot1.delete('HEARTBEAT');
    expect(tracker.getStats().has('HEARTBEAT')).toBe(true);
  });

  it('onStats callback fires on each update interval', () => {
    const received: Map<string, { count: number; frequency: number }>[] = [];

    tracker.onStats((stats) => {
      const simplified = new Map<string, { count: number; frequency: number }>();
      for (const [name, entry] of stats) {
        simplified.set(name, { count: entry.count, frequency: entry.frequency });
      }
      received.push(simplified);
    });

    tracker.trackMessage(makeMessage('HEARTBEAT'));
    tracker.startTracking();

    // Advance 3 intervals (300ms)
    vi.advanceTimersByTime(300);

    expect(received.length).toBe(3);
  });

  it('unsubscribe stops callback invocations', () => {
    let callCount = 0;
    const unsub = tracker.onStats(() => {
      callCount++;
    });

    tracker.trackMessage(makeMessage('HEARTBEAT'));
    tracker.startTracking();

    vi.advanceTimersByTime(200);
    expect(callCount).toBe(2);

    unsub();
    vi.advanceTimersByTime(200);
    expect(callCount).toBe(2); // should not increase
  });

  it('stopTracking halts the timer', () => {
    let callCount = 0;
    tracker.onStats(() => {
      callCount++;
    });

    tracker.trackMessage(makeMessage('HEARTBEAT'));
    tracker.startTracking();

    vi.advanceTimersByTime(200);
    expect(callCount).toBe(2);

    tracker.stopTracking();
    vi.advanceTimersByTime(500);
    expect(callCount).toBe(2); // should not increase
  });

  it('startTracking is idempotent', () => {
    let callCount = 0;
    tracker.onStats(() => {
      callCount++;
    });

    tracker.trackMessage(makeMessage('HEARTBEAT'));

    // Call startTracking multiple times
    tracker.startTracking();
    tracker.startTracking();
    tracker.startTracking();

    vi.advanceTimersByTime(100);
    // Should only fire once (one timer, not three)
    expect(callCount).toBe(1);
  });

  it('frequency is 0 for a single message', () => {
    tracker.startTracking();
    tracker.trackMessage(makeMessage('SINGLE'));
    vi.advanceTimersByTime(100);

    const stats = tracker.getStats();
    expect(stats.get('SINGLE')!.frequency).toBe(0);
  });

  it('lastMessage stores the most recent message', () => {
    const msg1 = makeMessage('HEARTBEAT', { sequence: 1 });
    const msg2 = makeMessage('HEARTBEAT', { sequence: 2 });

    tracker.trackMessage(msg1);
    tracker.trackMessage(msg2);

    const stats = tracker.getStats();
    expect(stats.get('HEARTBEAT')!.lastMessage.sequence).toBe(2);
  });

  it('decay is gradual between 2s and 5s', () => {
    tracker.startTracking();

    // Send messages for 1 second at 10 Hz
    for (let i = 0; i < 10; i++) {
      tracker.trackMessage(makeMessage('TEST'));
      vi.advanceTimersByTime(100);
    }

    // Capture frequency before decay starts
    const preDec = tracker.getStats().get('TEST')!.frequency;
    expect(preDec).toBeGreaterThan(0);

    // At t = 2.5s after last message: decay = 1 - (500/3000) ≈ 0.833
    vi.advanceTimersByTime(2500);
    const midDecay = tracker.getStats().get('TEST')!.frequency;
    expect(midDecay).toBeGreaterThan(0);
    expect(midDecay).toBeLessThan(preDec);

    // At t = 5s after last message: decay = 1 - (3000/3000) = 0 → frequency = 0
    vi.advanceTimersByTime(2500);
    const postDecay = tracker.getStats().get('TEST')!.frequency;
    expect(postDecay).toBe(0);
  });
});
