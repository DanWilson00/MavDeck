/**
 * MAVLink Web Worker.
 *
 * Runs the entire MAVLink pipeline off the main thread:
 * ByteSource → FrameParser → Decoder → Tracker → TimeSeriesManager.
 *
 * Communicates with the main thread via postMessage.
 */

import { MavlinkMetadataRegistry } from '../mavlink/registry';
import { SpoofByteSource } from '../services/spoof-byte-source';
import { ExternalByteSource } from '../services/external-byte-source';
import { GenericMessageTracker } from '../services/message-tracker';
import { TimeSeriesDataManager } from '../services/timeseries-manager';
import { MavlinkService } from '../services/mavlink-service';
import { MavlinkFrameParser } from '../mavlink/frame-parser';
import { MavlinkMessageDecoder } from '../mavlink/decoder';
import type { MessageStats } from '../services/message-tracker';
import { encodeTlogRecord } from '../services/tlog-codec';
import type { WorkerCommand, WorkerEvent } from './worker-protocol';

/** Type-safe wrapper around self.postMessage for worker events. */
function postEvent(event: WorkerEvent, transfer?: Transferable[]): void {
  if (transfer) {
    self.postMessage(event, transfer);
  } else {
    self.postMessage(event);
  }
}

const DEFAULT_BUFFER_CAPACITY = 2000;

let registry: MavlinkMetadataRegistry | null = null;
let service: MavlinkService | null = null;
let spoofSource: SpoofByteSource | null = null;
let externalSource: ExternalByteSource | null = null;
let tracker: GenericMessageTracker | null = null;
let timeseriesManager: TimeSeriesDataManager | null = null;
let bufferCapacity = DEFAULT_BUFFER_CAPACITY;

let statsUnsubscribe: (() => void) | null = null;
let updateUnsubscribe: (() => void) | null = null;
let statustextUnsubscribe: (() => void) | null = null;
let packetUnsubscribe: (() => void) | null = null;
let interestedFields: Set<string> = new Set();
let lastAvailableFieldsSignature = '';

let activeLogSessionId: string | null = null;
let activeLogStartedAtMs = 0;
let activeLogFirstPacketUs: number | undefined;
let activeLogLastPacketUs: number | undefined;
let activeLogPacketCount = 0;
let activeLogSeq = 0;
let logChunkParts: Uint8Array[] = [];
let logChunkBytes = 0;
let logChunkPacketCount = 0;
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

const LOG_FLUSH_INTERVAL_MS = 1000;
const LOG_FLUSH_BYTES = 256 * 1024;

/** Serialize MessageStats map for transfer (Map can't be cloned). */
function serializeStats(stats: Map<string, MessageStats>): Record<string, MessageStats> {
  const result: Record<string, MessageStats> = {};
  for (const [key, value] of stats) {
    result[key] = value;
  }
  return result;
}

function cleanupService(): void {
  disconnectPipeline();
  statsUnsubscribe?.();
  updateUnsubscribe?.();
  statustextUnsubscribe?.();
  packetUnsubscribe?.();
  service = null;
  spoofSource = null;
  externalSource = null;
  tracker = null;
  timeseriesManager?.dispose();
  timeseriesManager = null;
  statsUnsubscribe = null;
  updateUnsubscribe = null;
  statustextUnsubscribe = null;
  packetUnsubscribe = null;
  lastAvailableFieldsSignature = '';
}

function disconnectPipeline(): void {
  service?.disconnect();
  tracker = null;
  timeseriesManager?.dispose();
  timeseriesManager = null;
}

function scheduleLogFlush(): void {
  if (logFlushTimer !== null) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    flushLogChunk();
  }, LOG_FLUSH_INTERVAL_MS);
}

function appendPacketToLog(packet: Uint8Array, timestampUs: number): void {
  if (!activeLogSessionId) return;
  if (activeLogFirstPacketUs == null) {
    activeLogFirstPacketUs = timestampUs;
  }
  activeLogLastPacketUs = timestampUs;
  activeLogPacketCount++;

  const record = encodeTlogRecord(timestampUs, packet);
  logChunkParts.push(record);
  logChunkBytes += record.byteLength;
  logChunkPacketCount++;
  if (logChunkBytes >= LOG_FLUSH_BYTES) {
    flushLogChunk();
    return;
  }
  scheduleLogFlush();
}

function flushLogChunk(): void {
  if (!activeLogSessionId || logChunkBytes === 0 || logChunkParts.length === 0) return;

  const out = new Uint8Array(logChunkBytes);
  let offset = 0;
  for (const part of logChunkParts) {
    out.set(part, offset);
    offset += part.byteLength;
  }

  const chunkStartUs = activeLogFirstPacketUs ?? 0;
  const chunkEndUs = activeLogLastPacketUs ?? chunkStartUs;
  postEvent({
    type: 'logChunk',
    sessionId: activeLogSessionId,
    seq: activeLogSeq++,
    startUs: chunkStartUs,
    endUs: chunkEndUs,
    packetCount: activeLogPacketCount,
    chunkPacketCount: logChunkPacketCount,
    bytes: out.buffer,
  }, [out.buffer]);

  logChunkParts = [];
  logChunkBytes = 0;
  logChunkPacketCount = 0;
}

function startLogSession(): void {
  if (activeLogSessionId) stopLogSession();
  activeLogSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeLogStartedAtMs = Date.now();
  activeLogFirstPacketUs = undefined;
  activeLogLastPacketUs = undefined;
  activeLogPacketCount = 0;
  activeLogSeq = 0;
  logChunkParts = [];
  logChunkBytes = 0;
  logChunkPacketCount = 0;
  if (logFlushTimer !== null) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  postEvent({
    type: 'logSessionStarted',
    sessionId: activeLogSessionId,
    startedAtMs: activeLogStartedAtMs,
  });
}

function stopLogSession(): void {
  if (!activeLogSessionId) return;
  if (logFlushTimer !== null) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  flushLogChunk();
  postEvent({
    type: 'logSessionEnded',
    sessionId: activeLogSessionId,
    endedAtMs: Date.now(),
    firstPacketUs: activeLogFirstPacketUs,
    lastPacketUs: activeLogLastPacketUs,
    packetCount: activeLogPacketCount,
  });
  activeLogSessionId = null;
}

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

  if (signature !== lastAvailableFieldsSignature) {
    lastAvailableFieldsSignature = signature;
    postEvent({ type: 'availableFields', fields: availableFields });
  }

  const streamedFields = interestedFields.size > 0
    ? availableFields.filter(f => interestedFields.has(f))
    : [];
  const buffers = buildBuffersRecord(manager, streamedFields);

  const transferables: ArrayBuffer[] = [];
  for (const buf of Object.values(buffers)) {
    transferables.push(buf.timestamps.buffer);
    transferables.push(buf.values.buffer);
  }

  postEvent({ type: 'update', buffers }, transferables);
}

function setupService(source: SpoofByteSource | ExternalByteSource): void {
  tracker = new GenericMessageTracker();
  timeseriesManager = new TimeSeriesDataManager({ bufferCapacity });
  service = new MavlinkService(registry!, source, tracker, timeseriesManager);

  statsUnsubscribe = tracker.onStats(stats => {
    postEvent({
      type: 'stats',
      stats: serializeStats(stats),
    });
  });

  updateUnsubscribe = timeseriesManager.onUpdate(() => {
    postUpdateFromManager(timeseriesManager!);
  });

  statustextUnsubscribe = service.onMessage(msg => {
    if (msg.name === 'STATUSTEXT') {
      postEvent({
        type: 'statustext',
        severity: msg.values['severity'] as number,
        text: msg.values['text'] as string,
        timestamp: Date.now(),
      });
    }
  });

  packetUnsubscribe = service.onPacket((packet, timestampUs) => {
    appendPacketToLog(packet, timestampUs);
  });
}

function reconnectWithCurrentSource(): void {
  if (!registry) return;
  const source = spoofSource ?? externalSource;
  if (!source || !service) return;

  disconnectPipeline();
  statsUnsubscribe?.();
  updateUnsubscribe?.();
  statustextUnsubscribe?.();
  packetUnsubscribe?.();
  statsUnsubscribe = null;
  updateUnsubscribe = null;
  statustextUnsubscribe = null;
  packetUnsubscribe = null;
  lastAvailableFieldsSignature = '';

  setupService(source);

  service?.connect().catch((err: Error) => {
    postEvent({ type: 'error', message: err.message });
    postEvent({ type: 'statusChange', status: 'error' });
  });
}

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

      if (config.type === 'spoof') {
        spoofSource = new SpoofByteSource(registry);
        setupService(spoofSource);
        startLogSession();

        postEvent({ type: 'statusChange', status: 'connecting' });
        service!.connect().then(() => {
          postEvent({ type: 'statusChange', status: 'connected' });
        }).catch((err: Error) => {
          postEvent({ type: 'error', message: err.message });
          postEvent({ type: 'statusChange', status: 'error' });
        });
      } else if (config.type === 'webserial') {
        externalSource = new ExternalByteSource();
        setupService(externalSource);
        startLogSession();

        postEvent({ type: 'statusChange', status: 'connecting' });
        service!.connect().then(() => {
          postEvent({ type: 'statusChange', status: 'connected' });
        }).catch((err: Error) => {
          postEvent({ type: 'error', message: err.message });
          postEvent({ type: 'statusChange', status: 'error' });
        });
      }
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
      externalSource?.emitBytes(msg.data);
      break;
    }

    case 'setInterestedFields': {
      interestedFields = new Set(msg.fields);
      break;
    }

    case 'setBufferCapacity': {
      const nextCapacity = msg.bufferCapacity;
      const normalizedCapacity = Number.isFinite(nextCapacity)
        ? Math.max(1, Math.floor(nextCapacity))
        : DEFAULT_BUFFER_CAPACITY;
      if (normalizedCapacity === bufferCapacity) break;
      bufferCapacity = normalizedCapacity;
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
      bufferCapacity = logCapacity;

      // Create standalone pipeline components (bypass setupService/MavlinkService)
      tracker = new GenericMessageTracker();
      timeseriesManager = new TimeSeriesDataManager({ bufferCapacity });
      const parser = new MavlinkFrameParser(registry);
      const decoder = new MavlinkMessageDecoder(registry);

      // Parse → decode → track → timeseries with tlog timestamps
      parser.onFrame(frame => {
        const decoded = decoder.decode(frame);
        if (!decoded) return;
        tracker!.trackMessage(decoded);
        // currentTimestampMs is set per-packet in the loop below
        timeseriesManager!.processMessageWithTimestamp(decoded, currentTimestampMs);

        // Forward STATUSTEXT messages to UI
        if (decoded.name === 'STATUSTEXT') {
          postEvent({
            type: 'statustext',
            severity: decoded.values['severity'] as number,
            text: decoded.values['text'] as string,
            timestamp: currentTimestampMs,
          });
        }
      });

      let currentTimestampMs = 0;
      for (let i = 0; i < packets.length; i++) {
        currentTimestampMs = timestamps[i];
        parser.parse(packets[i]);
      }

      // Do NOT start tracker timer — stats are static for loaded logs
      // (stopTracking is a no-op since we never called startTracking)

      // Compute log duration from timeseries data
      let durationSec = 0;
      const allFields = timeseriesManager.getAvailableFields();
      let minTs = Infinity;
      let maxTs = -Infinity;
      for (const field of allFields) {
        const buf = timeseriesManager.getBuffer(field);
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
      interestedFields = new Set(allFields);
      postUpdateFromManager(timeseriesManager);

      // Override real-time frequency with log-based frequency
      // Important: call getStats() once and mutate+serialize the same map
      const statsMap = tracker.getStats();
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
