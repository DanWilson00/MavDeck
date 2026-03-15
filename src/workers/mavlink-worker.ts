/**
 * MAVLink Web Worker.
 *
 * Runs the entire MAVLink pipeline off the main thread:
 * ByteSource -> FrameParser -> Decoder -> Tracker -> TimeSeriesManager.
 *
 * Communicates with the main thread via postMessage.
 */

/// <reference lib="webworker" />

import { MavlinkMetadataRegistry } from '../mavlink/registry';
import {
  SpoofByteSource,
  ExternalByteSource,
  GenericMessageTracker,
  TimeSeriesDataManager,
  MavlinkService,
} from '../services';
import { WorkerSerialByteSource } from '../services/worker-serial-byte-source';
import { SerialProbeService } from '../services/serial-probe-service';
import type { SerialPortIdentity } from '../services/serial-probe-service';
import type { BaudRate } from '../services/baud-rates';
import type { WorkerCommand, WorkerEvent } from './worker-protocol';
import {
  INITIAL_LOG_STATE,
  appendPacketToLog,
  flushPendingLogChunk,
  resetLogState,
  startLogSession,
  stopLogSession,
  type LogState,
} from './mavlink-worker-log';
import {
  batchProcessPackets,
  clearMainThreadTelemetryState,
  forwardStatusText,
  postUpdateFromManager,
  serializeStats,
} from './mavlink-worker-pipeline-helpers';

declare const self: DedicatedWorkerGlobalScope;

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

interface ThroughputState {
  bytes: number;
  timer: ReturnType<typeof setInterval> | null;
  unsub: (() => void) | null;
}

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

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Registry is initialized once via 'init' and persists across connections. */
let registry: MavlinkMetadataRegistry | null = null;

interface SerialState {
  serialSource: WorkerSerialByteSource | null;
  probeService: SerialProbeService | null;
  autoConnectConfig: { autoBaud: boolean; manualBaudRate: BaudRate; lastPortIdentity: SerialPortIdentity | null; lastBaudRate: BaudRate | null } | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  logGraceTimer: ReturnType<typeof setTimeout> | null;
}

const pipeline: PipelineState = { ...INITIAL_PIPELINE_STATE, interestedFields: new Set() };
const log: LogState = { ...INITIAL_LOG_STATE, chunkParts: [] };
const serial: SerialState = { serialSource: null, probeService: null, autoConnectConfig: null, reconnectTimer: null, logGraceTimer: null };
const throughput: ThroughputState = { bytes: 0, timer: null, unsub: null };

const LOG_FLUSH_INTERVAL_MS = 1000;
const LOG_FLUSH_BYTES = 256 * 1024;
const LOG_GRACE_PERIOD_MS = 30_000;

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

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

function startThroughputCounter(source: SpoofByteSource | ExternalByteSource | WorkerSerialByteSource): void {
  stopThroughputCounter();
  throughput.bytes = 0;
  throughput.unsub = source.onData(data => { throughput.bytes += data.byteLength; });
  throughput.timer = setInterval(() => {
    postEvent({ type: 'throughput', bytesPerSec: throughput.bytes });
    throughput.bytes = 0;
  }, 1000);
}

function stopThroughputCounter(): void {
  throughput.unsub?.();
  throughput.unsub = null;
  if (throughput.timer !== null) {
    clearInterval(throughput.timer);
    throughput.timer = null;
  }
  throughput.bytes = 0;
  postEvent({ type: 'throughput', bytesPerSec: 0 });
}

async function cleanupService(): Promise<void> {
  stopThroughputCounter();
  await disconnectPipeline();
  pipeline.statsUnsub?.();
  pipeline.updateUnsub?.();
  pipeline.statustextUnsub?.();
  pipeline.packetUnsub?.();
  resetPipelineConnection();
}

async function disconnectPipeline(): Promise<void> {
  if (pipeline.service) {
    await pipeline.service.disconnect();
  }
  pipeline.tracker = null;
  pipeline.timeseriesManager?.dispose();
  pipeline.timeseriesManager = null;
}

// ---------------------------------------------------------------------------
// Serial lifecycle helpers
// ---------------------------------------------------------------------------

/** Find a previously-granted serial port by its USB identity. */
function findPortByIdentity(ports: SerialPort[], identity: SerialPortIdentity | null): SerialPort | null {
  if (ports.length === 0) return null;
  if (!identity) return ports[0];
  for (const port of ports) {
    const info = port.getInfo();
    if (info.usbVendorId === identity.usbVendorId && info.usbProductId === identity.usbProductId) {
      return port;
    }
  }
  return null;
}

/** Full serial cleanup — disconnect source, stop probe, clear reconnect timer, reset state. */
async function cleanupSerial(): Promise<void> {
  await serial.serialSource?.disconnect();
  serial.serialSource = null;
  serial.probeService?.stopProbing();
  serial.probeService = null;
  serial.autoConnectConfig = null;
  if (serial.reconnectTimer !== null) {
    clearTimeout(serial.reconnectTimer);
    serial.reconnectTimer = null;
  }
  if (serial.logGraceTimer !== null) {
    clearTimeout(serial.logGraceTimer);
    serial.logGraceTimer = null;
  }
}

/** Called when WorkerSerialByteSource detects an unexpected disconnect. */
async function handleSerialDisconnect(): Promise<void> {
  // Grab and null the source first to prevent double-disconnect
  const source = serial.serialSource;
  serial.serialSource = null;

  // Await port close so it's fully released before reconnect probe
  if (source) {
    await source.disconnect();
  }

  // Clear any prior grace timer (defensive)
  if (serial.logGraceTimer !== null) {
    clearTimeout(serial.logGraceTimer);
    serial.logGraceTimer = null;
  }

  if (serial.autoConnectConfig && log.sessionId) {
    // Flush buffered data (crash-safe), but don't finalize
    flushPendingLogChunk(log, postEvent);
    serial.logGraceTimer = setTimeout(() => {
      serial.logGraceTimer = null;
      stopLogSession(log, postEvent);
    }, LOG_GRACE_PERIOD_MS);
  } else {
    stopLogSession(log, postEvent);
  }

  await cleanupService();

  postEvent({ type: 'statusChange', status: 'disconnected' });
  postEvent({ type: 'stats', stats: {} });

  // If auto-connect is configured, schedule reconnect
  if (serial.autoConnectConfig) {
    serial.reconnectTimer = setTimeout(() => {
      serial.reconnectTimer = null;
      doStartAutoConnect();
    }, 2000);
  }
}

/** Start (or restart) auto-connect probing. */
function doStartAutoConnect(): void {
  if (!registry) return;

  if (serial.reconnectTimer !== null) {
    clearTimeout(serial.reconnectTimer);
    serial.reconnectTimer = null;
  }

  // Stop existing probe if any
  serial.probeService?.stopProbing();

  serial.probeService = new SerialProbeService(registry);

  postEvent({ type: 'statusChange', status: 'probing' });

  const config = serial.autoConnectConfig;
  if (!config) return;

  serial.probeService.startProbing({
    autoBaud: config.autoBaud,
    manualBaudRate: config.manualBaudRate,
    lastPortIdentity: config.lastPortIdentity,
    lastBaudRate: config.lastBaudRate,
    onResult: (result) => {
      serial.serialSource = new WorkerSerialByteSource(result.port, result.baudRate, handleSerialDisconnect);
      setupService(serial.serialSource);
      pipeline.service!.connect().then(() => {
        startThroughputCounter(serial.serialSource!);
        if (serial.logGraceTimer !== null) {
          clearTimeout(serial.logGraceTimer);
          serial.logGraceTimer = null;
          // Session continues — log.sessionId still set
        } else {
          startLogSession(log, postEvent);
        }
        postEvent({ type: 'probeStatus', status: null });
        postEvent({ type: 'statusChange', status: 'connected' });
        postEvent({ type: 'serialConnected', baudRate: result.baudRate, portIdentity: result.portIdentity });
      }).catch((err: Error) => {
        void (async () => {
          cancelLogGraceTimer();
          await cleanupService();
          await cleanupSerial();
        })();
        postEvent({ type: 'error', message: err.message });
        postEvent({ type: 'statusChange', status: 'error' });
      });
    },
    onStatus: (status) => {
      postEvent({ type: 'probeStatus', status });
    },
  });
}

/** Cancel any pending log grace timer and finalize the session. Safe to call at any time. */
function cancelLogGraceTimer(): void {
  if (serial.logGraceTimer !== null) {
    clearTimeout(serial.logGraceTimer);
    serial.logGraceTimer = null;
  }
  stopLogSession(log, postEvent);
}

// ---------------------------------------------------------------------------
// Pipeline setup
// ---------------------------------------------------------------------------

function setupService(source: SpoofByteSource | ExternalByteSource | WorkerSerialByteSource): void {
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
    postUpdateFromManager(pipeline, pipeline.timeseriesManager!, postEvent);
  });

  pipeline.statustextUnsub = pipeline.service.onMessage(msg => {
    forwardStatusText(msg, Date.now(), postEvent);
  });

  pipeline.packetUnsub = pipeline.service.onPacket((packet, timestampUs) => {
    appendPacketToLog(log, packet, timestampUs, LOG_FLUSH_BYTES, LOG_FLUSH_INTERVAL_MS, postEvent);
  });
}

async function reconnectWithCurrentSource(): Promise<void> {
  if (!registry) return;
  const source = pipeline.spoofSource ?? pipeline.externalSource;
  if (!source || !pipeline.service) return;

  await disconnectPipeline();
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

  try {
    await pipeline.service?.connect();
    startThroughputCounter(source);
  } catch (err) {
    await cleanupService();
    postEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    postEvent({ type: 'statusChange', status: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent<WorkerCommand>) => {
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
      cancelLogGraceTimer();
      await cleanupService();

      const { config } = msg;

      const source = config.type === 'spoof'
        ? (pipeline.spoofSource = new SpoofByteSource(registry))
        : (pipeline.externalSource = new ExternalByteSource());

      setupService(source);

      postEvent({ type: 'statusChange', status: 'connecting' });
      pipeline.service!.connect().then(() => {
        startThroughputCounter(source);
        startLogSession(log, postEvent);
        postEvent({ type: 'statusChange', status: 'connected' });
      }).catch((err: Error) => {
        void cleanupService();
        postEvent({ type: 'error', message: err.message });
        postEvent({ type: 'statusChange', status: 'error' });
      });
      break;
    }

    case 'disconnect': {
      cancelLogGraceTimer();
      await cleanupService();
      await cleanupSerial();
      clearMainThreadTelemetryState(pipeline, postEvent);
      postEvent({ type: 'statusChange', status: 'disconnected' });
      break;
    }

    case 'unloadLog': {
      cancelLogGraceTimer();
      await cleanupService();
      clearMainThreadTelemetryState(pipeline, postEvent);
      postEvent({ type: 'statusChange', status: 'disconnected' });
      break;
    }

    case 'pause':
    case 'resume':
      // No-op: data always flows into ring buffers; pause freezes chart display only
      break;

    case 'bytes': {
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
      void reconnectWithCurrentSource();
      break;
    }

    case 'loadLog': {
      if (!registry) {
        postEvent({ type: 'error', message: 'Registry not initialized' });
        return;
      }

      const { packets, timestamps, bufferCapacity: logCapacity } = msg;

      // Stop any active log session and clean up existing service
      cancelLogGraceTimer();
      await cleanupService();
      await cleanupSerial();
      clearMainThreadTelemetryState(pipeline, postEvent);
      postEvent({ type: 'statusChange', status: 'disconnected' });

      // Set buffer capacity for this log
      pipeline.bufferCapacity = logCapacity;

      // Create pipeline components and process all packets
      pipeline.tracker = new GenericMessageTracker();
      pipeline.timeseriesManager = new TimeSeriesDataManager({ bufferCapacity: pipeline.bufferCapacity });
      batchProcessPackets(registry, pipeline.tracker, pipeline.timeseriesManager, packets, timestamps, postEvent);

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
      postUpdateFromManager(pipeline, pipeline.timeseriesManager, postEvent);

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
      break;
    }

    case 'connectSerial': {
      if (!registry) {
        postEvent({ type: 'error', message: 'Registry not initialized' });
        return;
      }

      cancelLogGraceTimer();
      await cleanupService();
      await cleanupSerial();

      const { baudRate: serialBaudRate, autoDetectBaud, portIdentity, lastBaudRate: serialLastBaud } = msg;

      navigator.serial.getPorts().then(async (ports) => {
        const port = findPortByIdentity(ports, portIdentity);
        if (!port) {
          postEvent({ type: 'needPermission' });
          return;
        }

        if (autoDetectBaud) {
          const probeService = new SerialProbeService(registry!);
          const abortController = new AbortController();
          serial.probeService = probeService;

          postEvent({ type: 'statusChange', status: 'probing' });

          try {
            const result = await probeService.probeSinglePort(port, {
              autoBaud: true,
              manualBaudRate: serialBaudRate,
              lastBaudRate: serialLastBaud,
              onStatus: (s) => postEvent({ type: 'probeStatus', status: s }),
            }, abortController.signal);

            if (result) {
              serial.serialSource = new WorkerSerialByteSource(result.port, result.baudRate, handleSerialDisconnect);
              setupService(serial.serialSource);
              await pipeline.service!.connect();
              startThroughputCounter(serial.serialSource);
              startLogSession(log, postEvent);
              postEvent({ type: 'serialConnected', baudRate: result.baudRate, portIdentity: result.portIdentity });
              postEvent({ type: 'statusChange', status: 'connected' });
              postEvent({ type: 'probeStatus', status: null });
            } else {
              postEvent({ type: 'probeStatus', status: null });
              postEvent({ type: 'statusChange', status: 'disconnected' });
            }
          } catch (err) {
            cancelLogGraceTimer();
            await cleanupService();
            await cleanupSerial();
            postEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
            postEvent({ type: 'probeStatus', status: null });
            postEvent({ type: 'statusChange', status: 'disconnected' });
          }
        } else {
          try {
            serial.serialSource = new WorkerSerialByteSource(port, serialBaudRate, handleSerialDisconnect);
            setupService(serial.serialSource);
            await pipeline.service!.connect();
            startThroughputCounter(serial.serialSource);
            startLogSession(log, postEvent);
            const portInfo = port.getInfo();
            const connectedIdentity: SerialPortIdentity | null =
              portInfo.usbVendorId != null && portInfo.usbProductId != null
                ? { usbVendorId: portInfo.usbVendorId, usbProductId: portInfo.usbProductId }
                : null;
            postEvent({ type: 'serialConnected', baudRate: serialBaudRate, portIdentity: connectedIdentity });
            postEvent({ type: 'statusChange', status: 'connected' });
          } catch (err) {
            cancelLogGraceTimer();
            await cleanupService();
            await cleanupSerial();
            postEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
            postEvent({ type: 'statusChange', status: 'error' });
          }
        }
      }).catch((err) => {
        postEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        postEvent({ type: 'statusChange', status: 'error' });
      });
      break;
    }

    case 'startAutoConnect': {
      serial.autoConnectConfig = {
        autoBaud: msg.autoBaud,
        manualBaudRate: msg.manualBaudRate,
        lastPortIdentity: msg.lastPortIdentity,
        lastBaudRate: msg.lastBaudRate,
      };
      doStartAutoConnect();
      break;
    }

    case 'stopAutoConnect': {
      cancelLogGraceTimer();
      if (serial.reconnectTimer !== null) {
        clearTimeout(serial.reconnectTimer);
        serial.reconnectTimer = null;
      }
      const wasProbing = serial.probeService?.isProbing ?? false;
      serial.probeService?.stopProbing();
      serial.probeService = null;
      serial.autoConnectConfig = null;
      if (wasProbing) {
        postEvent({ type: 'statusChange', status: 'disconnected' });
      }
      break;
    }

    case 'portsChanged': {
      if (serial.autoConnectConfig && !serial.serialSource) {
        serial.probeService?.stopProbing();
        doStartAutoConnect();
      }
      break;
    }
  }
};
