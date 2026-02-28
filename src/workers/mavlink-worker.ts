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
import { GenericMessageTracker } from '../services/message-tracker';
import { TimeSeriesDataManager } from '../services/timeseries-manager';
import { MavlinkService } from '../services/mavlink-service';
import type { MessageStats } from '../services/message-tracker';

let registry: MavlinkMetadataRegistry | null = null;
let service: MavlinkService | null = null;
let spoofSource: SpoofByteSource | null = null;
let tracker: GenericMessageTracker | null = null;
let timeseriesManager: TimeSeriesDataManager | null = null;

let statsUnsubscribe: (() => void) | null = null;
let updateUnsubscribe: (() => void) | null = null;

/** Serialize MessageStats map for transfer (Map can't be cloned). */
function serializeStats(stats: Map<string, MessageStats>): Record<string, MessageStats> {
  const result: Record<string, MessageStats> = {};
  for (const [key, value] of stats) {
    result[key] = value;
  }
  return result;
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
      if (service) {
        service.disconnect();
        statsUnsubscribe?.();
        updateUnsubscribe?.();
      }

      const { config } = e.data as { type: string; config: { type: string } };

      if (config.type === 'spoof') {
        spoofSource = new SpoofByteSource(registry);
        tracker = new GenericMessageTracker();
        timeseriesManager = new TimeSeriesDataManager();
        service = new MavlinkService(registry, spoofSource, tracker, timeseriesManager);

        // Forward stats to main thread every 100ms
        statsUnsubscribe = tracker.onStats(stats => {
          self.postMessage({
            type: 'stats',
            stats: serializeStats(stats),
          });
        });

        // Forward buffer updates to main thread
        updateUnsubscribe = timeseriesManager.onUpdate(() => {
          const fields = timeseriesManager!.getAvailableFields();
          const buffers: Record<string, { timestamps: Float64Array; values: Float64Array }> = {};

          for (const key of fields) {
            const buffer = timeseriesManager!.getBuffer(key);
            if (buffer && buffer.length > 0) {
              const [timestamps, values] = buffer.toUplotData();
              // Copy into transferable ArrayBuffers
              const tsBuf = new Float64Array(timestamps.length);
              tsBuf.set(timestamps);
              const valBuf = new Float64Array(values.length);
              valBuf.set(values);
              buffers[key] = { timestamps: tsBuf, values: valBuf };
            }
          }

          const transferables: ArrayBuffer[] = [];
          for (const buf of Object.values(buffers)) {
            transferables.push(buf.timestamps.buffer);
            transferables.push(buf.values.buffer);
          }

          self.postMessage({ type: 'update', buffers }, transferables);
        });

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
      service?.disconnect();
      statsUnsubscribe?.();
      updateUnsubscribe?.();
      service = null;
      spoofSource = null;
      tracker = null;
      timeseriesManager?.dispose();
      timeseriesManager = null;
      statsUnsubscribe = null;
      updateUnsubscribe = null;
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
      // For Web Serial: main thread reads serial bytes and posts them here
      // The worker would need a custom byte source that accepts external bytes
      // This will be implemented in Phase 8 (Web Serial)
      break;
    }
  }
};
