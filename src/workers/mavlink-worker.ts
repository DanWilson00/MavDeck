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
import type { MessageStats } from '../services/message-tracker';

let registry: MavlinkMetadataRegistry | null = null;
let service: MavlinkService | null = null;
let spoofSource: SpoofByteSource | null = null;
let externalSource: ExternalByteSource | null = null;
let tracker: GenericMessageTracker | null = null;
let timeseriesManager: TimeSeriesDataManager | null = null;

let statsUnsubscribe: (() => void) | null = null;
let updateUnsubscribe: (() => void) | null = null;
let statustextUnsubscribe: (() => void) | null = null;
let interestedFields: Set<string> = new Set();
let lastAvailableFieldsSignature = '';

/** Serialize MessageStats map for transfer (Map can't be cloned). */
function serializeStats(stats: Map<string, MessageStats>): Record<string, MessageStats> {
  const result: Record<string, MessageStats> = {};
  for (const [key, value] of stats) {
    result[key] = value;
  }
  return result;
}

function cleanupService(): void {
  service?.disconnect();
  statsUnsubscribe?.();
  updateUnsubscribe?.();
  statustextUnsubscribe?.();
  service = null;
  spoofSource = null;
  externalSource = null;
  tracker = null;
  timeseriesManager?.dispose();
  timeseriesManager = null;
  statsUnsubscribe = null;
  updateUnsubscribe = null;
  statustextUnsubscribe = null;
  lastAvailableFieldsSignature = '';
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
    self.postMessage({ type: 'availableFields', fields: availableFields });
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

  self.postMessage({ type: 'update', buffers }, transferables);
}

function setupService(source: SpoofByteSource | ExternalByteSource): void {
  tracker = new GenericMessageTracker();
  timeseriesManager = new TimeSeriesDataManager();
  service = new MavlinkService(registry!, source, tracker, timeseriesManager);

  statsUnsubscribe = tracker.onStats(stats => {
    self.postMessage({
      type: 'stats',
      stats: serializeStats(stats),
    });
  });

  updateUnsubscribe = timeseriesManager.onUpdate(() => {
    postUpdateFromManager(timeseriesManager!);
  });

  statustextUnsubscribe = service.onMessage(msg => {
    if (msg.name === 'STATUSTEXT') {
      self.postMessage({
        type: 'statustext',
        severity: msg.values['severity'] as number,
        text: msg.values['text'] as string,
        timestamp: Date.now(),
      });
    }
  });
}

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;

  switch (type) {
    case 'init': {
      const { dialectJson } = e.data as { type: string; dialectJson: string };
      registry = new MavlinkMetadataRegistry();
      registry.loadFromJsonString(dialectJson);
      self.postMessage({ type: 'initComplete' });
      break;
    }

    case 'connect': {
      if (!registry) {
        self.postMessage({ type: 'error', message: 'Registry not initialized' });
        return;
      }

      // Clean up any existing connection
      cleanupService();

      const { config } = e.data as { type: string; config: { type: string } };

      if (config.type === 'spoof') {
        spoofSource = new SpoofByteSource(registry);
        setupService(spoofSource);

        self.postMessage({ type: 'statusChange', status: 'connecting' });
        service.connect().then(() => {
          self.postMessage({ type: 'statusChange', status: 'connected' });
        }).catch((err: Error) => {
          self.postMessage({ type: 'error', message: err.message });
          self.postMessage({ type: 'statusChange', status: 'error' });
        });
      } else if (config.type === 'webserial') {
        externalSource = new ExternalByteSource();
        setupService(externalSource);

        self.postMessage({ type: 'statusChange', status: 'connecting' });
        service.connect().then(() => {
          self.postMessage({ type: 'statusChange', status: 'connected' });
        }).catch((err: Error) => {
          self.postMessage({ type: 'error', message: err.message });
          self.postMessage({ type: 'statusChange', status: 'error' });
        });
      }
      break;
    }

    case 'disconnect': {
      cleanupService();
      self.postMessage({ type: 'statusChange', status: 'disconnected' });
      break;
    }

    case 'pause': {
      service?.pause();
      break;
    }

    case 'resume': {
      service?.resume();
      break;
    }

    case 'bytes': {
      const { data } = e.data as { type: string; data: Uint8Array };
      externalSource?.emitBytes(data);
      break;
    }

    case 'setInterestedFields': {
      const { fields } = e.data as { type: string; fields: string[] };
      interestedFields = new Set(fields);
      break;
    }
  }
};
