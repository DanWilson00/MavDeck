import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataActivityMonitor } from '../data-activity-monitor';

describe('DataActivityMonitor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires onNoData after timeout with no activity', () => {
    const onNoData = vi.fn();
    const onDataResumed = vi.fn();
    const monitor = new DataActivityMonitor(5000, { onNoData, onDataResumed });

    monitor.resetTimer();
    vi.advanceTimersByTime(4999);
    expect(onNoData).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onNoData).toHaveBeenCalledOnce();
    expect(monitor.isIdle).toBe(true);
  });

  it('resets timer on recordActivity, preventing idle', () => {
    const onNoData = vi.fn();
    const monitor = new DataActivityMonitor(5000, { onNoData, onDataResumed: vi.fn() });

    monitor.resetTimer();
    vi.advanceTimersByTime(4000);
    monitor.recordActivity(); // resets the 5s countdown

    vi.advanceTimersByTime(4000);
    expect(onNoData).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onNoData).toHaveBeenCalledOnce();
  });

  it('fires onDataResumed when activity resumes after idle', () => {
    const onNoData = vi.fn();
    const onDataResumed = vi.fn();
    const monitor = new DataActivityMonitor(1000, { onNoData, onDataResumed });

    monitor.resetTimer();
    vi.advanceTimersByTime(1000);
    expect(monitor.isIdle).toBe(true);

    monitor.recordActivity();
    expect(onDataResumed).toHaveBeenCalledOnce();
    expect(monitor.isIdle).toBe(false);
  });

  it('does not fire onDataResumed when not idle', () => {
    const onDataResumed = vi.fn();
    const monitor = new DataActivityMonitor(5000, { onNoData: vi.fn(), onDataResumed });

    monitor.resetTimer();
    monitor.recordActivity();
    expect(onDataResumed).not.toHaveBeenCalled();
  });

  it('clearTimer prevents idle without triggering callback', () => {
    const onNoData = vi.fn();
    const monitor = new DataActivityMonitor(1000, { onNoData, onDataResumed: vi.fn() });

    monitor.resetTimer();
    monitor.clearTimer();
    vi.advanceTimersByTime(5000);

    expect(onNoData).not.toHaveBeenCalled();
    expect(monitor.isIdle).toBe(false);
  });

  it('reset clears timer and idle state silently', () => {
    const onNoData = vi.fn();
    const onDataResumed = vi.fn();
    const monitor = new DataActivityMonitor(1000, { onNoData, onDataResumed });

    monitor.resetTimer();
    vi.advanceTimersByTime(1000);
    expect(monitor.isIdle).toBe(true);

    monitor.reset();
    expect(monitor.isIdle).toBe(false);
    expect(onDataResumed).not.toHaveBeenCalled();

    // Timer should be cleared too
    vi.advanceTimersByTime(5000);
    expect(onNoData).toHaveBeenCalledOnce(); // only the first time
  });

  it('multiple resetTimer calls only result in one timeout', () => {
    const onNoData = vi.fn();
    const monitor = new DataActivityMonitor(1000, { onNoData, onDataResumed: vi.fn() });

    monitor.resetTimer();
    monitor.resetTimer();
    monitor.resetTimer();

    vi.advanceTimersByTime(1000);
    expect(onNoData).toHaveBeenCalledOnce();
  });
});
