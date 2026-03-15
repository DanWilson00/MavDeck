import { encodeTlogRecord } from '../services';
import type { WorkerEvent } from './worker-protocol';

export interface LogState {
  sessionId: string | null;
  startedAtMs: number;
  firstPacketUs: number | undefined;
  lastPacketUs: number | undefined;
  packetCount: number;
  chunkStartUs: number | undefined;
  chunkEndUs: number | undefined;
  seq: number;
  chunkParts: Uint8Array[];
  chunkBytes: number;
  chunkPacketCount: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

export const INITIAL_LOG_STATE: LogState = {
  sessionId: null,
  startedAtMs: 0,
  firstPacketUs: undefined,
  lastPacketUs: undefined,
  packetCount: 0,
  chunkStartUs: undefined,
  chunkEndUs: undefined,
  seq: 0,
  chunkParts: [],
  chunkBytes: 0,
  chunkPacketCount: 0,
  flushTimer: null,
};

type PostEvent = (event: WorkerEvent, transfer?: Transferable[]) => void;

export function resetLogState(log: LogState): void {
  log.sessionId = null;
  log.startedAtMs = 0;
  log.firstPacketUs = undefined;
  log.lastPacketUs = undefined;
  log.packetCount = 0;
  log.chunkStartUs = undefined;
  log.chunkEndUs = undefined;
  log.seq = 0;
  log.chunkParts = [];
  log.chunkBytes = 0;
  log.chunkPacketCount = 0;
  log.flushTimer = null;
}

function resetLogChunk(log: LogState): void {
  log.chunkParts = [];
  log.chunkBytes = 0;
  log.chunkPacketCount = 0;
  log.chunkStartUs = undefined;
  log.chunkEndUs = undefined;
}

function flushLogChunk(log: LogState, postEvent: PostEvent): void {
  if (!log.sessionId || log.chunkBytes === 0 || log.chunkParts.length === 0) return;

  const out = new Uint8Array(log.chunkBytes);
  let offset = 0;
  for (const part of log.chunkParts) {
    out.set(part, offset);
    offset += part.byteLength;
  }

  const chunkStartUs = log.chunkStartUs ?? 0;
  const chunkEndUs = log.chunkEndUs ?? chunkStartUs;
  postEvent({
    type: 'logChunk',
    sessionId: log.sessionId,
    seq: log.seq++,
    startUs: chunkStartUs,
    endUs: chunkEndUs,
    packetCount: log.chunkPacketCount,
    sessionPacketCount: log.packetCount,
    bytes: out.buffer,
  }, [out.buffer]);

  resetLogChunk(log);
}

export function flushPendingLogChunk(log: LogState, postEvent: PostEvent): void {
  flushLogChunk(log, postEvent);
}

function scheduleLogFlush(
  log: LogState,
  flushIntervalMs: number,
  postEvent: PostEvent,
): void {
  if (log.flushTimer !== null) return;
  log.flushTimer = setTimeout(() => {
    log.flushTimer = null;
    flushLogChunk(log, postEvent);
  }, flushIntervalMs);
}

export function appendPacketToLog(
  log: LogState,
  packet: Uint8Array,
  timestampUs: number,
  flushBytes: number,
  flushIntervalMs: number,
  postEvent: PostEvent,
): void {
  if (!log.sessionId) {
    startLogSession(log, postEvent);
  }
  if (log.firstPacketUs == null) {
    log.firstPacketUs = timestampUs;
  }
  log.lastPacketUs = timestampUs;
  if (log.chunkStartUs == null) {
    log.chunkStartUs = timestampUs;
  }
  log.chunkEndUs = timestampUs;
  log.packetCount++;

  const record = encodeTlogRecord(timestampUs, packet);
  log.chunkParts.push(record);
  log.chunkBytes += record.byteLength;
  log.chunkPacketCount++;
  if (log.chunkBytes >= flushBytes) {
    flushLogChunk(log, postEvent);
    return;
  }
  scheduleLogFlush(log, flushIntervalMs, postEvent);
}

function startLogSession(log: LogState, postEvent: PostEvent): void {
  if (log.sessionId) stopLogSession(log, postEvent);
  if (log.flushTimer !== null) {
    clearTimeout(log.flushTimer);
  }
  resetLogState(log);
  log.sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  log.startedAtMs = Date.now();
  console.debug('[Tlog] Session started:', log.sessionId);
  postEvent({
    type: 'logSessionStarted',
    sessionId: log.sessionId,
    startedAtMs: log.startedAtMs,
  });
}

export function stopLogSession(log: LogState, postEvent: PostEvent): void {
  if (!log.sessionId) return;
  console.debug('[Tlog] Session ended:', log.sessionId, log.packetCount, 'packets');
  if (log.flushTimer !== null) {
    clearTimeout(log.flushTimer);
    log.flushTimer = null;
  }
  flushLogChunk(log, postEvent);
  postEvent({
    type: 'logSessionEnded',
    sessionId: log.sessionId,
    endedAtMs: Date.now(),
    firstPacketUs: log.firstPacketUs,
    lastPacketUs: log.lastPacketUs,
    packetCount: log.packetCount,
  });
  log.sessionId = null;
}
