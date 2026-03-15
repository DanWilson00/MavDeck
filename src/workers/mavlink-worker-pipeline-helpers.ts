import { MavlinkFrameParser } from '../mavlink/frame-parser';
import { MavlinkMessageDecoder, type MavlinkMessage } from '../mavlink/decoder';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { MessageStats } from '../services';
import type { GenericMessageTracker } from '../services/message-tracker';
import type { TimeSeriesDataManager } from '../services/timeseries-manager';
import type { WorkerEvent } from './worker-protocol';

type PostEvent = (event: WorkerEvent, transfer?: Transferable[]) => void;

export interface PipelineFieldState {
  interestedFields: Set<string>;
  lastAvailableFieldsSignature: string;
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

export function forwardStatusText(
  msg: MavlinkMessage,
  timestampMs: number,
  postEvent: PostEvent,
): void {
  if (msg.name !== 'STATUSTEXT') return;
  postEvent({
    type: 'statustext',
    severity: msg.values['severity'] as number,
    text: msg.values['text'] as string,
    timestamp: timestampMs,
  });
}

export function batchProcessPackets(
  registry: MavlinkMetadataRegistry,
  tracker: GenericMessageTracker,
  tsManager: TimeSeriesDataManager,
  packets: Uint8Array[],
  timestamps: number[],
  postEvent: PostEvent,
): void {
  const parser = new MavlinkFrameParser(registry);
  const decoder = new MavlinkMessageDecoder(registry);
  let currentTimestampMs = 0;

  parser.onFrame(frame => {
    const decoded = decoder.decode(frame);
    if (!decoded) return;
    tracker.trackMessage(decoded);
    tsManager.processMessageWithTimestamp(decoded, currentTimestampMs);
    forwardStatusText(decoded, currentTimestampMs, postEvent);
  });

  for (let i = 0; i < packets.length; i += 1) {
    currentTimestampMs = timestamps[i];
    parser.parse(packets[i]);
  }
}
