import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendPacketToLog,
  flushPendingLogChunk,
  INITIAL_LOG_STATE,
  resetLogState,
  stopLogSession,
  type LogState,
} from '../mavlink-worker-log';
import type { WorkerEvent } from '../worker-protocol';

function createLogState(): LogState {
  return { ...INITIAL_LOG_STATE, chunkParts: [] };
}

describe('mavlink-worker-log', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe('appendPacketToLog', () => {
    it('auto-starts a session on first packet', () => {
      const log = createLogState();
      const events: WorkerEvent[] = [];

      appendPacketToLog(log, new Uint8Array([0xFD, 1, 2]), 1_000_000, 64 * 1024, 1000, e => events.push(e));

      expect(log.sessionId).toBeTruthy();
      expect(log.packetCount).toBe(1);
      expect(log.firstPacketUs).toBe(1_000_000);
      expect(log.lastPacketUs).toBe(1_000_000);

      const startEvent = events.find(e => e.type === 'logSessionStarted');
      expect(startEvent).toBeDefined();
    });

    it('accumulates multiple packets in a chunk', () => {
      const log = createLogState();
      const events: WorkerEvent[] = [];
      const postEvent = (e: WorkerEvent) => events.push(e);

      appendPacketToLog(log, new Uint8Array([1, 2, 3]), 1000, 64 * 1024, 1000, postEvent);
      appendPacketToLog(log, new Uint8Array([4, 5]), 2000, 64 * 1024, 1000, postEvent);

      expect(log.packetCount).toBe(2);
      expect(log.chunkParts.length).toBe(2);
      expect(log.chunkPacketCount).toBe(2);
      expect(log.firstPacketUs).toBe(1000);
      expect(log.lastPacketUs).toBe(2000);
    });

    it('flushes chunk when byte threshold exceeded', () => {
      const log = createLogState();
      const events: WorkerEvent[] = [];
      const postEvent = (e: WorkerEvent) => events.push(e);

      // Set a low flush threshold
      const smallFlushBytes = 10;
      appendPacketToLog(log, new Uint8Array(20), 1000, smallFlushBytes, 1000, postEvent);

      const chunkEvent = events.find(e => e.type === 'logChunk');
      expect(chunkEvent).toBeDefined();
      expect(log.chunkParts.length).toBe(0); // reset after flush
      expect(log.chunkBytes).toBe(0);
    });

    it('schedules timer-based flush when under byte threshold', () => {
      const log = createLogState();
      const events: WorkerEvent[] = [];
      const postEvent = (e: WorkerEvent) => events.push(e);

      appendPacketToLog(log, new Uint8Array([1]), 1000, 64 * 1024, 500, postEvent);
      expect(log.flushTimer).not.toBeNull();

      // No chunk event yet
      const chunksBefore = events.filter(e => e.type === 'logChunk');
      expect(chunksBefore.length).toBe(0);

      // Advance past flush interval
      vi.advanceTimersByTime(500);
      const chunksAfter = events.filter(e => e.type === 'logChunk');
      expect(chunksAfter.length).toBe(1);
    });
  });

  describe('stopLogSession', () => {
    it('flushes remaining data and emits session ended', () => {
      const log = createLogState();
      const events: WorkerEvent[] = [];
      const postEvent = (e: WorkerEvent) => events.push(e);

      // Start a session and add a packet
      appendPacketToLog(log, new Uint8Array([1, 2, 3]), 1000, 64 * 1024, 1000, postEvent);
      events.length = 0; // clear start events

      stopLogSession(log, postEvent);

      const chunkEvent = events.find(e => e.type === 'logChunk');
      const endEvent = events.find(e => e.type === 'logSessionEnded');
      expect(chunkEvent).toBeDefined();
      expect(endEvent).toBeDefined();
      expect(endEvent!.type).toBe('logSessionEnded');
      expect((endEvent as Extract<WorkerEvent, { type: 'logSessionEnded' }>).packetCount).toBe(1);
      expect(log.sessionId).toBeNull();
    });

    it('is a no-op when no session is active', () => {
      const log = createLogState();
      const events: WorkerEvent[] = [];

      stopLogSession(log, e => events.push(e));
      expect(events).toHaveLength(0);
    });

    it('clears pending flush timer', () => {
      const log = createLogState();
      const events: WorkerEvent[] = [];
      const postEvent = (e: WorkerEvent) => events.push(e);

      appendPacketToLog(log, new Uint8Array([1]), 1000, 64 * 1024, 1000, postEvent);
      expect(log.flushTimer).not.toBeNull();

      stopLogSession(log, postEvent);
      expect(log.flushTimer).toBeNull();
    });
  });

  describe('flushPendingLogChunk', () => {
    it('flushes buffered data without ending session', () => {
      const log = createLogState();
      const events: WorkerEvent[] = [];
      const postEvent = (e: WorkerEvent) => events.push(e);

      appendPacketToLog(log, new Uint8Array([0xFD, 1, 2]), 1000, 64 * 1024, 1000, postEvent);
      events.length = 0;

      flushPendingLogChunk(log, postEvent);

      const chunkEvent = events.find(e => e.type === 'logChunk');
      expect(chunkEvent).toBeDefined();
      expect(log.sessionId).toBeTruthy(); // session still active
      expect(log.chunkParts.length).toBe(0); // chunk data flushed
    });

    it('is a no-op when no data buffered', () => {
      const log = createLogState();
      log.sessionId = 'test';
      const events: WorkerEvent[] = [];

      flushPendingLogChunk(log, e => events.push(e));
      expect(events).toHaveLength(0);
    });
  });

  describe('resetLogState', () => {
    it('resets all fields to initial values', () => {
      const log = createLogState();
      log.sessionId = 'test';
      log.packetCount = 42;
      log.seq = 5;
      log.chunkParts = [new Uint8Array(10)];
      log.chunkBytes = 10;

      resetLogState(log);

      expect(log.sessionId).toBeNull();
      expect(log.packetCount).toBe(0);
      expect(log.seq).toBe(0);
      expect(log.chunkParts).toEqual([]);
      expect(log.chunkBytes).toBe(0);
      expect(log.firstPacketUs).toBeUndefined();
      expect(log.lastPacketUs).toBeUndefined();
    });
  });

  describe('chunk sequencing', () => {
    it('increments seq for each flushed chunk', () => {
      const log = createLogState();
      const events: WorkerEvent[] = [];
      const postEvent = (e: WorkerEvent) => events.push(e);

      // Use tiny flush threshold to force flush on each packet
      appendPacketToLog(log, new Uint8Array(20), 1000, 10, 1000, postEvent);
      appendPacketToLog(log, new Uint8Array(20), 2000, 10, 1000, postEvent);

      const chunks = events.filter((e): e is Extract<WorkerEvent, { type: 'logChunk' }> => e.type === 'logChunk');
      expect(chunks.length).toBe(2);
      expect(chunks[0].seq).toBe(0);
      expect(chunks[1].seq).toBe(1);
    });

    it('tracks session-wide packet count across chunks', () => {
      const log = createLogState();
      const events: WorkerEvent[] = [];
      const postEvent = (e: WorkerEvent) => events.push(e);

      appendPacketToLog(log, new Uint8Array(20), 1000, 10, 1000, postEvent);
      appendPacketToLog(log, new Uint8Array(20), 2000, 10, 1000, postEvent);
      appendPacketToLog(log, new Uint8Array(20), 3000, 10, 1000, postEvent);

      const chunks = events.filter((e): e is Extract<WorkerEvent, { type: 'logChunk' }> => e.type === 'logChunk');
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[chunks.length - 1].sessionPacketCount).toBe(3);
    });
  });
});
