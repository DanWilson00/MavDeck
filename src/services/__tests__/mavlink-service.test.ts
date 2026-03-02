import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MavlinkMetadataRegistry } from '../../mavlink/registry';
import { SpoofByteSource } from '../spoof-byte-source';
import { GenericMessageTracker } from '../message-tracker';
import { TimeSeriesDataManager } from '../timeseries-manager';
import { MavlinkService } from '../mavlink-service';
import type { MavlinkMessage } from '../../mavlink/decoder';

const commonJson = readFileSync(
  resolve(__dirname, '../../../public/dialects/common.json'),
  'utf-8',
);

describe('MavlinkService', () => {
  let registry: MavlinkMetadataRegistry;
  let spoofSource: SpoofByteSource;
  let tracker: GenericMessageTracker;
  let tsManager: TimeSeriesDataManager;
  let service: MavlinkService;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new MavlinkMetadataRegistry();
    registry.loadFromJsonString(commonJson);
    spoofSource = new SpoofByteSource(registry);
    tracker = new GenericMessageTracker();
    tsManager = new TimeSeriesDataManager();
    service = new MavlinkService(registry, spoofSource, tracker, tsManager);
  });

  afterEach(() => {
    service.disconnect();
    tsManager.dispose();
    vi.useRealTimers();
  });

  it('receives decoded messages after connect with SpoofByteSource', async () => {
    const messages: MavlinkMessage[] = [];
    service.onMessage(msg => messages.push(msg));

    await service.connect();
    vi.advanceTimersByTime(1100); // 1.1 seconds — get heartbeat + fast telemetry

    expect(messages.length).toBeGreaterThan(0);
    const names = new Set(messages.map(m => m.name));
    expect(names.has('HEARTBEAT')).toBe(true);
    expect(names.has('ATTITUDE')).toBe(true);
  });

  it('receives HEARTBEAT, ATTITUDE, and GLOBAL_POSITION_INT', async () => {
    const names = new Set<string>();
    service.onMessage(msg => names.add(msg.name));

    await service.connect();
    vi.advanceTimersByTime(1100);

    expect(names.has('HEARTBEAT')).toBe(true);
    expect(names.has('ATTITUDE')).toBe(true);
    expect(names.has('GLOBAL_POSITION_INT')).toBe(true);
  });

  it('data always flows to callbacks and timeseries', async () => {
    const messages: MavlinkMessage[] = [];
    service.onMessage(msg => messages.push(msg));

    await service.connect();
    vi.advanceTimersByTime(500);
    const countAt500 = messages.length;
    expect(countAt500).toBeGreaterThan(0);

    // Data continues flowing
    vi.advanceTimersByTime(500);
    expect(messages.length).toBeGreaterThan(countAt500);

    // Tracker has stats
    const stats = tracker.getStats();
    expect(stats.size).toBeGreaterThan(0);
  });

  it('disconnect stops all callbacks', async () => {
    const messages: MavlinkMessage[] = [];
    service.onMessage(msg => messages.push(msg));

    await service.connect();
    vi.advanceTimersByTime(500);
    const countBeforeDisconnect = messages.length;

    service.disconnect();
    vi.advanceTimersByTime(500);

    expect(messages.length).toBe(countBeforeDisconnect);
  });

  it('timeseries manager receives processed messages', async () => {
    await service.connect();
    vi.advanceTimersByTime(500);

    const fields = tsManager.getAvailableFields();
    expect(fields.length).toBeGreaterThan(0);
    // ATTITUDE fields should be present
    expect(fields.some(f => f.startsWith('ATTITUDE.'))).toBe(true);
  });

  it('unsubscribe stops individual callback', async () => {
    const messages: MavlinkMessage[] = [];
    const unsub = service.onMessage(msg => messages.push(msg));

    await service.connect();
    vi.advanceTimersByTime(200);
    const countBefore = messages.length;

    unsub();
    vi.advanceTimersByTime(200);
    expect(messages.length).toBe(countBefore);
  });
});
