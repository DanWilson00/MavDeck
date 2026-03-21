import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThroughputMonitor, type DataSource } from '../throughput-monitor';

function createMockSource(): DataSource & { emit: (data: Uint8Array) => void } {
  const listeners = new Set<(data: Uint8Array) => void>();
  return {
    onData(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit(data: Uint8Array) {
      for (const cb of listeners) cb(data);
    },
  };
}

describe('ThroughputMonitor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits 0 when stopped without ever starting', () => {
    const onThroughput = vi.fn();
    const monitor = new ThroughputMonitor(onThroughput);
    monitor.stop();
    expect(onThroughput).toHaveBeenCalledWith(0);
  });

  it('accumulates bytes and emits total each second', () => {
    const onThroughput = vi.fn();
    const monitor = new ThroughputMonitor(onThroughput);
    const source = createMockSource();

    monitor.start(source);
    source.emit(new Uint8Array(100));
    source.emit(new Uint8Array(50));

    vi.advanceTimersByTime(1000);
    expect(onThroughput).toHaveBeenCalledWith(150);

    // Next second with no data
    vi.advanceTimersByTime(1000);
    expect(onThroughput).toHaveBeenCalledWith(0);

    monitor.stop();
  });

  it('resets accumulator after each interval tick', () => {
    const onThroughput = vi.fn();
    const monitor = new ThroughputMonitor(onThroughput);
    const source = createMockSource();

    monitor.start(source);
    source.emit(new Uint8Array(200));
    vi.advanceTimersByTime(1000);

    source.emit(new Uint8Array(75));
    vi.advanceTimersByTime(1000);

    const calls = onThroughput.mock.calls.map(c => c[0]);
    // First tick: 200, second tick: 75
    expect(calls).toContain(200);
    expect(calls).toContain(75);

    monitor.stop();
  });

  it('stop clears interval and emits 0', () => {
    const onThroughput = vi.fn();
    const monitor = new ThroughputMonitor(onThroughput);
    const source = createMockSource();

    monitor.start(source);
    source.emit(new Uint8Array(100));
    monitor.stop();

    // The stop call should have emitted 0
    expect(onThroughput).toHaveBeenLastCalledWith(0);

    // No more ticks after stop
    onThroughput.mockClear();
    vi.advanceTimersByTime(5000);
    expect(onThroughput).not.toHaveBeenCalled();
  });

  it('unsubscribes from data source on stop', () => {
    const onThroughput = vi.fn();
    const monitor = new ThroughputMonitor(onThroughput);
    const source = createMockSource();

    monitor.start(source);
    monitor.stop();

    // Data after stop should not accumulate
    onThroughput.mockClear();
    source.emit(new Uint8Array(500));
    vi.advanceTimersByTime(1000);
    // No interval running, no callback
    expect(onThroughput).not.toHaveBeenCalled();
  });

  it('restart clears previous subscription', () => {
    const onThroughput = vi.fn();
    const monitor = new ThroughputMonitor(onThroughput);
    const source1 = createMockSource();
    const source2 = createMockSource();

    monitor.start(source1);
    monitor.start(source2);

    // Data from source1 should not accumulate (unsubscribed)
    source1.emit(new Uint8Array(999));
    source2.emit(new Uint8Array(42));
    vi.advanceTimersByTime(1000);

    // The last throughput tick should only reflect source2
    const lastTickCall = onThroughput.mock.calls[onThroughput.mock.calls.length - 1];
    expect(lastTickCall[0]).toBe(42);

    monitor.stop();
  });

  it('isRunning reflects active state', () => {
    const monitor = new ThroughputMonitor(vi.fn());
    const source = createMockSource();

    expect(monitor.isRunning).toBe(false);
    monitor.start(source);
    expect(monitor.isRunning).toBe(true);
    monitor.stop();
    expect(monitor.isRunning).toBe(false);
  });
});
