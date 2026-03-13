/**
 * MAVLink Web Worker.
 *
 * Runs the entire MAVLink pipeline off the main thread:
 * ByteSource -> FrameParser -> Decoder -> Tracker -> TimeSeriesManager.
 *
 * Communicates with the main thread via postMessage.
 */

import { MavlinkMetadataRegistry } from '../mavlink/registry';
import {
  SpoofByteSource,
  ExternalByteSource,
  GenericMessageTracker,
  TimeSeriesDataManager,
  MavlinkService,
  encodeTlogRecord,
  type MessageStats,
} from '../services';
import { MavlinkFrameParser } from '../mavlink/frame-parser';
import { MavlinkMessageDecoder, type MavlinkMessage } from '../mavlink/decoder';
import type { WorkerCommand, WorkerEvent } from './worker-protocol';

/** Type-safe wrapper around self.postMessage for worker events. */
function postEvent(event: WorkerEvent, transfer?: Transferable[]): void {
  if (transfer) {
    self.postMessage(event, transfer);
  } else {
    self.postMessage(event);
  }
}

// ---------------------------------------------------------------------------
// State interfaces
// ---------------------------------------------------------------------------

interface PipelineState {
  service: MavlinkService | null;
  spoofSource: SpoofByteSource | null;
  externalSource: ExternalByteSource | null;
  tracker: GenericMessageTracker | null;
  timeseriesManager: TimeSeriesDataManager | null;
  bufferCapacity: number;
  interestedFields: Set<string>;
  lastAvailableFieldsSignature: string;
  statsUnsub: (() => void) | null;
  updateUnsub: (() => void) | null;
  statustextUnsub: (() => void) | null;
  packetUnsub: (() => void) | null;
}

interface LogState {
  sessionId: string | null;
  startedAtMs: number;
  firstPacketUs: number | undefined;
  lastPacketUs: number | undefined;
  packetCount: number;
  seq: number;
  chunkParts: Uint8Array[];
  chunkBytes: number;
  chunkPacketCount: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Initial state constants
// ---------------------------------------------------------------------------

const DEFAULT_BUFFER_CAPACITY = 2000;

const INITIAL_PIPELINE_STATE: PipelineState = {
  service: null,
  spoofSource: null,
  externalSource: null,
  tracker: null,
  timeseriesManager: null,
  bufferCapacity: DEFAULT_BUFFER_CAPACITY,
  interestedFields: new Set(),
  lastAvailableFieldsSignature: '',
  statsUnsub: null,
  updateUnsub: null,
  statustextUnsub: null,
  packetUnsub: null,
};

const INITIAL_LOG_STATE: LogState = {
  sessionId: null,
  startedAtMs: 0,
  firstPacketUs: undefined,
  lastPacketUs: undefined,
  packetCount: 0,
  seq: 0,
  chunkParts: [],
  chunkBytes: 0,
  chunkPacketCount: 0,
  flushTimer: null,
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Registry is initialized once via 'init' and persists across connections. */
let registry: MavlinkMetadataRegistry | null = null;

const pipeline: PipelineState = { ...INITIAL_PIPELINE_STATE, interestedFields: new Set() };
const log: LogState = { ...INITIAL_LOG_STATE, chunkParts: [] };

const LOG_FLUSH_INTERVAL_MS = 1000;
const LOG_FLUSH_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset pipeline connection state, preserving bufferCapacity and interestedFields. */
function resetPipelineConnection(): void {
  pipeline.service = null;
  pipeline.spoofSource = null;
  pipeline.externalSource = null;
  pipeline.tracker = null;
  pipeline.timeseriesManager = null;
  pipeline.lastAvailableFieldsSignature = '';
  pipeline.statsUnsub = null;
  pipeline.updateUnsub = null;
  pipeline.statustextUnsub = null;
  pipeline.packetUnsub = null;
}

/** Reset all log state. Caller is responsible for clearing flushTimer first. */
function resetLogState(): void {
  log.sessionId = null;
  log.startedAtMs = 0;
  log.firstPacketUs = undefined;
  log.lastPacketUs = undefined;
  log.packetCount = 0;
  log.seq = 0;
  log.chunkParts = [];
  log.chunkBytes = 0;
  log.chunkPacketCount = 0;
  log.flushTimer = null;
}

/** Reset only the chunk-level accumulation within a log session. */
function resetLogChunk(): void {
  log.chunkParts = [];
  log.chunkBytes = 0;
  log.chunkPacketCount = 0;
}

/** Serialize MessageStats map for transfer (Map can't be cloned). */
function serializeStats(stats: Map<string, MessageStats>): Record<string, MessageStats> {
  const result: Record<string, MessageStats> = {};
  for (const [key, value] of stats) {
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

function cleanupService(): void {
  disconnectPipeline();
  pipeline.statsUnsub?.();
  pipeline.updateUnsub?.();
  pipeline.statustextUnsub?.();
  pipeline.packetUnsub?.();
  pipeline.timeseriesManager?.dispose();
  resetPipelineConnection();
}

function disconnectPipeline(): void {
  pipeline.service?.disconnect();
  pipeline.tracker = null;
  pipeline.timeseriesManager?.dispose();
  pipeline.timeseriesManager = null;
}

// ---------------------------------------------------------------------------
// Log session management
// ---------------------------------------------------------------------------

function scheduleLogFlush(): void {
  if (log.flushTimer !== null) return;
  log.flushTimer = setTimeout(() => {
    log.flushTimer = null;
    flushLogChunk();
  }, LOG_FLUSH_INTERVAL_MS);
}

function appendPacketToLog(packet: Uint8Array, timestampUs: number): void {
  if (!log.sessionId) return;
  if (log.firstPacketUs == null) {
    log.firstPacketUs = timestampUs;
  }
  log.lastPacketUs = timestampUs;
  log.packetCount++;

  const record = encodeTlogRecord(timestampUs, packet);
  log.chunkParts.push(record);
  log.chunkBytes += record.byteLength;
  log.chunkPacketCount++;
  if (log.chunkBytes >= LOG_FLUSH_BYTES) {
    flushLogChunk();
    return;
  }
  scheduleLogFlush();
}

function flushLogChunk(): void {
  if (!log.sessionId || log.chunkBytes === 0 || log.chunkParts.length === 0) return;

  const out = new Uint8Array(log.chunkBytes);
  let offset = 0;
  for (const part of log.chunkParts) {
    out.set(part, offset);
    offset += part.byteLength;
  }

  const chunkStartUs = log.firstPacketUs ?? 0;
  const chunkEndUs = log.lastPacketUs ?? chunkStartUs;
  postEvent({
    type: 'logChunk',
    sessionId: log.sessionId,
    seq: log.seq++,
    startUs: chunkStartUs,
    endUs: chunkEndUs,
    packetCount: log.packetCount,
    chunkPacketCount: log.chunkPacketCount,
    bytes: out.buffer,
  }, [out.buffer]);

  resetLogChunk();
}

function startLogSession(): void {
  if (log.sessionId) stopLogSession();
  if (log.flushTimer !== null) {
    clearTimeout(log.flushTimer);
  }
  resetLogState();
  log.sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  log.startedAtMs = Date.now();
  postEvent({
    type: 'logSessionStarted',
    sessionId: log.sessionId,
    startedAtMs: log.startedAtMs,
  });
}

function stopLogSession(): void {
  if (!log.sessionId) return;
  if (log.flushTimer !== null) {
    clearTimeout(log.flushTimer);
    log.flushTimer = null;
  }
  flushLogChunk();
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

// ---------------------------------------------------------------------------
// Data transfer helpers
// ---------------------------------------------------------------------------

function buildBuffersRecord(
  manager: TimeSeriesDataManager,
  fieldKeys: string[],
): Record<string, { timestamps: Float64Array; values: Float64Array }> {
  const buffers: Record<string, { timestamps: Float64Array; values: Float64Array }> = {};

  for (const key of fieldKeys) {
    const buffer = manager.getBuffer(key);
    if (!buffer || buffer.length === 0) continue;

    const [timestamps, values] = buffer.toUplotData();
    const tsBuf = new Float64Array(timestamps.length);
    tsBuf.set(timestamps);
    const valBuf = new Float64Array(values.length);
    valBuf.set(values);
    buffers[key] = { timestamps: tsBuf, values: valBuf };
  }

  return buffers;
}

function postUpdateFromManager(manager: TimeSeriesDataManager): void {
  const availableFields = manager.getAvailableFields();
  const signature = availableFields.join('|');

  if (signature !== pipeline.lastAvailableFieldsSignature) {
    pipeline.lastAvailableFieldsSignature = signature;
    postEvent({ type: 'availableFields', fields: availableFields });
  }

  const streamedFields = pipeline.interestedFields.size > 0
    ? availableFields.filter(f => pipeline.interestedFields.has(f))
    : [];
  const buffers = buildBuffersRecord(manager, streamedFields);

  const transferables: ArrayBuffer[] = [];
  for (const buf of Object.values(buffers)) {
    transferables.push(buf.timestamps.buffer);
    transferables.push(buf.values.buffer);
  }

  postEvent({ type: 'update', buffers }, transferables);
}

/** Forward STATUSTEXT messages to the main thread. */
function forwardStatusText(msg: MavlinkMessage, timestampMs: number): void {
  if (msg.name !== 'STATUSTEXT') return;
  postEvent({
    type: 'statustext',
    severity: msg.values['severity'] as number,
    text: msg.values['text'] as string,
    timestamp: timestampMs,
  });
}

/** Run a batch of raw packets through parse→decode→track→timeseries→STATUSTEXT. */
function batchProcessPackets(
  reg: MavlinkMetadataRegistry,
  tracker: GenericMessageTracker,
  tsManager: TimeSeriesDataManager,
  packets: Uint8Array[],
  timestamps: number[],
): void {
  const parser = new MavlinkFrameParser(reg);
  const decoder = new MavlinkMessageDecoder(reg);
  let currentTimestampMs = 0;

  parser.onFrame(frame => {
    const decoded = decoder.decode(frame);
    if (!decoded) return;
    tracker.trackMessage(decoded);
    tsManager.processMessageWithTimestamp(decoded, currentTimestampMs);
    forwardStatusText(decoded, currentTimestampMs);
  });

  for (let i = 0; i < packets.length; i++) {
    currentTimestampMs = timestamps[i];
    parser.parse(packets[i]);
  }
}

// ---------------------------------------------------------------------------
// Pipeline setup
// ---------------------------------------------------------------------------

function setupService(source: SpoofByteSource | ExternalByteSource): void {
  pipeline.tracker = new GenericMessageTracker();
  pipeline.timeseriesManager = new TimeSeriesDataManager({ bufferCapacity: pipeline.bufferCapacity });
  pipeline.service = new MavlinkService(registry!, source, pipeline.tracker, pipeline.timeseriesManager);

  pipeline.statsUnsub = pipeline.tracker.onStats(stats => {
    postEvent({
      type: 'stats',
      stats: serializeStats(stats),
    });
  });

  pipeline.updateUnsub = pipeline.timeseriesManager.onUpdate(() => {
    postUpdateFromManager(pipeline.timeseriesManager!);
  });

  pipeline.statustextUnsub = pipeline.service.onMessage(msg => {
    forwardStatusText(msg, Date.now());
  });

  pipeline.packetUnsub = pipeline.service.onPacket((packet, timestampUs) => {
    appendPacketToLog(packet, timestampUs);
  });
}

function reconnectWithCurrentSource(): void {
  if (!registry) return;
  const source = pipeline.spoofSource ?? pipeline.externalSource;
  if (!source || !pipeline.service) return;

  disconnectPipeline();
  pipeline.statsUnsub?.();
  pipeline.updateUnsub?.();
  pipeline.statustextUnsub?.();
  pipeline.packetUnsub?.();
  pipeline.statsUnsub = null;
  pipeline.updateUnsub = null;
  pipeline.statustextUnsub = null;
  pipeline.packetUnsub = null;
  pipeline.lastAvailableFieldsSignature = '';

  setupService(source);

  pipeline.service?.connect().catch((err: Error) => {
    postEvent({ type: 'error', message: err.message });
    postEvent({ type: 'statusChange', status: 'error' });
  });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      registry = new MavlinkMetadataRegistry();
      registry.loadFromJsonString(msg.dialectJson);
      postEvent({ type: 'initComplete' });
      break;
    }

    case 'connect': {
      if (!registry) {
        postEvent({ type: 'error', message: 'Registry not initialized' });
        return;
      }

      // Clean up any existing connection
      stopLogSession();
      cleanupService();

      const { config } = msg;

      const source = config.type === 'spoof'
        ? (pipeline.spoofSource = new SpoofByteSource(registry))
        : (pipeline.externalSource = new ExternalByteSource());

      setupService(source);
      startLogSession();

      postEvent({ type: 'statusChange', status: 'connecting' });
      pipeline.service!.connect().then(() => {
        postEvent({ type: 'statusChange', status: 'connected' });
      }).catch((err: Error) => {
        postEvent({ type: 'error', message: err.message });
        postEvent({ type: 'statusChange', status: 'error' });
      });
      break;
    }

    case 'disconnect': {
      stopLogSession();
      cleanupService();
      postEvent({ type: 'stats', stats: {} });
      postEvent({ type: 'statusChange', status: 'disconnected' });
      break;
    }

    case 'pause':
    case 'resume':
      // No-op: data always flows into ring buffers; pause freezes chart display only
      break;

    case 'bytes': {
      console.log('[Worker] Received', msg.data.byteLength, 'bytes');
      pipeline.externalSource?.emitBytes(msg.data);
      break;
    }

    case 'setInterestedFields': {
      pipeline.interestedFields = new Set(msg.fields);
      break;
    }

    case 'setBufferCapacity': {
      const nextCapacity = msg.bufferCapacity;
      const normalizedCapacity = Number.isFinite(nextCapacity)
        ? Math.max(1, Math.floor(nextCapacity))
        : DEFAULT_BUFFER_CAPACITY;
      if (normalizedCapacity === pipeline.bufferCapacity) break;
      pipeline.bufferCapacity = normalizedCapacity;
      reconnectWithCurrentSource();
      break;
    }

    case 'loadLog': {
      if (!registry) {
        postEvent({ type: 'error', message: 'Registry not initialized' });
        return;
      }

      const { packets, timestamps, bufferCapacity: logCapacity } = msg;

      // Stop any active log session and clean up existing service
      stopLogSession();
      cleanupService();

      // Set buffer capacity for this log
      pipeline.bufferCapacity = logCapacity;

      // Create pipeline components and process all packets
      pipeline.tracker = new GenericMessageTracker();
      pipeline.timeseriesManager = new TimeSeriesDataManager({ bufferCapacity: pipeline.bufferCapacity });
      batchProcessPackets(registry, pipeline.tracker, pipeline.timeseriesManager, packets, timestamps);

      // Do NOT start tracker timer -- stats are static for loaded logs
      // (stopTracking is a no-op since we never called startTracking)

      // Compute log duration from timeseries data
      let durationSec = 0;
      const allFields = pipeline.timeseriesManager.getAvailableFields();
      let minTs = Infinity;
      let maxTs = -Infinity;
      for (const field of allFields) {
        const buf = pipeline.timeseriesManager.getBuffer(field);
        if (!buf || buf.length === 0) continue;
        const [ts] = buf.toUplotData();
        if (ts.length > 0) {
          if (ts[0] < minTs) minTs = ts[0];
          if (ts[ts.length - 1] > maxTs) maxTs = ts[ts.length - 1];
        }
      }
      if (minTs < Infinity && maxTs > -Infinity) {
        durationSec = maxTs - minTs;
      }

      // Send all fields so the full dataset is available
      pipeline.interestedFields = new Set(allFields);
      postUpdateFromManager(pipeline.timeseriesManager);

      // Override real-time frequency with log-based frequency
      // Important: call getStats() once and mutate+serialize the same map
      const statsMap = pipeline.tracker.getStats();
      if (durationSec > 0) {
        for (const [, stat] of statsMap) {
          stat.frequency = stat.count / durationSec;
        }
      }

      // Post stats via the normal channel so MessageMonitor sees them
      const stats = serializeStats(statsMap);
      postEvent({ type: 'stats', stats });

      // Post completion signal
      postEvent({
        type: 'loadComplete',
        stats,
        durationSec,
      });

      postEvent({ type: 'statusChange', status: 'connected' });
      break;
    }
  }
};
