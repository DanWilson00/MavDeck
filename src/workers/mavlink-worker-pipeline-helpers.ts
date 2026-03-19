import { MavlinkFrameParser } from '../mavlink/frame-parser';
import { MavlinkMessageDecoder, type MavlinkMessage } from '../mavlink/decoder';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { MessageStats } from '../services';
import type { GenericMessageTracker } from '../services/message-tracker';
import type { TimeSeriesDataManager } from '../services/timeseries-manager';
import type { WorkerEvent } from './worker-protocol';

type PostEvent = (event: WorkerEvent, transfer?: Transferable[]) => void;

interface PartialStatusText {
  text: string;
  severity: number;
  timestamp: number;
  nextChunkSeq: number;
}

export interface PipelineFieldState {
  interestedFields: Set<string>;
  lastAvailableFieldsSignature: string;
}

export interface StatusTextAssemblyState {
  partials: Map<string, PartialStatusText>;
}

export function serializeStats(stats: Map<string, MessageStats>): Record<string, MessageStats> {
  const result: Record<string, MessageStats> = {};
  for (const [key, value] of stats) {
    result[key] = value;
  }
  return result;
}

export function postUpdateFromManager(
  state: PipelineFieldState,
  manager: TimeSeriesDataManager,
  postEvent: PostEvent,
): void {
  const availableFields = manager.getAvailableFields();
  const signature = availableFields.join('|');

  if (signature !== state.lastAvailableFieldsSignature) {
    state.lastAvailableFieldsSignature = signature;
    postEvent({ type: 'availableFields', fields: availableFields });
  }

  const streamedFields = state.interestedFields.size > 0
    ? availableFields.filter(field => state.interestedFields.has(field))
    : [];
  const buffers: Record<string, { timestamps: Float64Array; values: Float64Array }> = {};

  for (const key of streamedFields) {
    const buffer = manager.getBuffer(key);
    if (!buffer || buffer.length === 0) continue;

    const [timestamps, values] = buffer.toUplotData();
    const tsBuf = new Float64Array(timestamps.length);
    tsBuf.set(timestamps);
    const valBuf = new Float64Array(values.length);
    valBuf.set(values);
    buffers[key] = { timestamps: tsBuf, values: valBuf };
  }

  const transferables: ArrayBuffer[] = [];
  for (const buffer of Object.values(buffers)) {
    transferables.push(buffer.timestamps.buffer as ArrayBuffer);
    transferables.push(buffer.values.buffer as ArrayBuffer);
  }

  postEvent({ type: 'update', buffers }, transferables);
}

export function clearMainThreadTelemetryState(
  state: PipelineFieldState,
  postEvent: PostEvent,
): void {
  state.lastAvailableFieldsSignature = '';
  postEvent({ type: 'availableFields', fields: [] });
  postEvent({ type: 'update', buffers: {} });
  postEvent({ type: 'stats', stats: {} });
}

export function clearStatusTextAssembly(state: StatusTextAssemblyState): void {
  state.partials.clear();
}

export function forwardStatusText(
  state: StatusTextAssemblyState,
  msg: MavlinkMessage,
  timestampMs: number,
  postEvent: PostEvent,
): void {
  if (msg.name !== 'STATUSTEXT') return;
  const severity = msg.values['severity'] as number;
  const text = msg.values['text'] as string;
  const messageId = typeof msg.values['id'] === 'number' ? msg.values['id'] as number : 0;
  const chunkSeq = typeof msg.values['chunk_seq'] === 'number' ? msg.values['chunk_seq'] as number : 0;

  if (!text) return;

  if (messageId === 0) {
    postEvent({
      type: 'statustext',
      severity,
      text,
      timestamp: timestampMs,
    });
    return;
  }

  const key = `${msg.systemId}:${msg.componentId}:${messageId}`;
  const isFinalChunk = text.length < 50;

  if (chunkSeq === 0) {
    if (isFinalChunk) {
      postEvent({
        type: 'statustext',
        severity,
        text,
        timestamp: timestampMs,
      });
      state.partials.delete(key);
      return;
    }

    state.partials.set(key, {
      text,
      severity,
      timestamp: timestampMs,
      nextChunkSeq: 1,
    });
    return;
  }

  const partial = state.partials.get(key);
  if (!partial || partial.nextChunkSeq !== chunkSeq) {
    return;
  }

  partial.text += text;
  partial.timestamp = timestampMs;
  partial.nextChunkSeq += 1;

  if (isFinalChunk) {
    postEvent({
      type: 'statustext',
      severity: partial.severity,
      text: partial.text,
      timestamp: partial.timestamp,
    });
    state.partials.delete(key);
  }
}

export function batchProcessPackets(
  registry: MavlinkMetadataRegistry,
  tracker: GenericMessageTracker,
  tsManager: TimeSeriesDataManager,
  packets: Uint8Array[],
  timestamps: number[],
  postEvent: PostEvent,
): void {
  const statusTextState: StatusTextAssemblyState = { partials: new Map() };
  const parser = new MavlinkFrameParser(registry);
  const decoder = new MavlinkMessageDecoder(registry);
  let currentTimestampMs = 0;

  parser.onFrame(frame => {
    const decoded = decoder.decode(frame);
    if (!decoded) return;
    tracker.trackMessage(decoded);
    tsManager.processMessageWithTimestamp(decoded, currentTimestampMs);
    forwardStatusText(statusTextState, decoded, currentTimestampMs, postEvent);
  });

  for (let i = 0; i < packets.length; i += 1) {
    currentTimestampMs = timestamps[i];
    parser.parse(packets[i]);
  }
}
