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
import { MavlinkFrameBuilder } from '../mavlink/frame-builder';
import {
  SpoofByteSource,
  ExternalByteSource,
  GenericMessageTracker,
  TimeSeriesDataManager,
  MavlinkService,
} from '../services';
import { ParameterManager } from '../services/parameter-manager';
import { MetadataFtpDownloader } from '../services/metadata-ftp-downloader';
import { WorkerSerialByteSource } from '../services/worker-serial-byte-source';
import { SerialProbeService } from '../services/serial-probe-service';
import type { SerialPortIdentity } from '../services/serial-probe-service';
import type { BaudRate } from '../services/baud-rates';
import { getSerialPortIdentity, matchesSerialPortIdentity } from '../services/serial-port-identity';
import type { WorkerCommand, WorkerEvent } from './worker-protocol';
import { PROBE_TIMEOUT_MS } from '../services/baud-rates';
import {
  INITIAL_LOG_STATE,
  appendPacketToLog,
  flushPendingLogChunk,
  resetLogState,
  stopLogSession,
  type LogState,
} from './mavlink-worker-log';
import {
  batchProcessPackets,
  clearMainThreadTelemetryState,
  clearStatusTextAssembly,
  forwardStatusText,
  postUpdateFromManager,
  serializeStats,
  type StatusTextAssemblyState,
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

interface DataActivityState {
  noDataTimer: ReturnType<typeof setTimeout> | null;
  noDataActive: boolean;
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
  vehicleTrackUnsub: (() => void) | null;
  paramMessageUnsub: (() => void) | null;
  ftpMessageUnsub: (() => void) | null;
  statusTextAssembly: StatusTextAssemblyState;
}

interface ResetPipelineOptions {
  disconnectSource?: boolean;
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
  vehicleTrackUnsub: null,
  paramMessageUnsub: null,
  ftpMessageUnsub: null,
  statusTextAssembly: { partials: new Map() },
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Registry is initialized once via 'init' and persists across connections. */
let registry: MavlinkMetadataRegistry | null = null;

/** Frame builder for outbound messages, initialized alongside registry. */
let frameBuilder: MavlinkFrameBuilder | null = null;

/** Parameter manager for the MAVLink parameter protocol. */
let paramManager: ParameterManager | null = null;

/** Metadata FTP downloader for component metadata protocol. */
let metadataDownloader: MetadataFtpDownloader | null = null;

/** Sequence number for outbound GCS messages. */
let sendSequence = 0;

/** GCS system ID per MAVLink convention. */
const GCS_SYSTEM_ID = 255;

/** GCS component ID (MAV_COMP_ID_MISSIONPLANNER). */
const GCS_COMPONENT_ID = 190;

/**
 * Build and send a MAVLink message through the active byte source.
 * Silently returns if no source or frame builder is available.
 */
function sendMavlinkMessage(
  messageName: string,
  values: Record<string, number | string | number[]>,
): void {
  const source = serial.serialSource ?? pipeline.externalSource ?? pipeline.spoofSource;
  if (!source || !frameBuilder) return;
  const frame = frameBuilder.buildFrame({
    messageName,
    values,
    systemId: GCS_SYSTEM_ID,
    componentId: GCS_COMPONENT_ID,
    sequence: sendSequence++ & 0xFF,
  });
  void source.write(frame);
}

interface SerialState {
  serialSource: WorkerSerialByteSource | null;
  probeService: SerialProbeService | null;
  autoConnectConfig: { autoBaud: boolean; manualBaudRate: BaudRate; lastPortIdentity: SerialPortIdentity | null; lastBaudRate: BaudRate | null } | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  logGraceTimer: ReturnType<typeof setTimeout> | null;
  suspendedForLog: boolean;
  suspendedStatus: 'connected' | 'no_data' | null;
}

const pipeline: PipelineState = { ...INITIAL_PIPELINE_STATE, interestedFields: new Set() };
const log: LogState = { ...INITIAL_LOG_STATE, chunkParts: [] };
const serial: SerialState = {
  serialSource: null,
  probeService: null,
  autoConnectConfig: null,
  reconnectTimer: null,
  logGraceTimer: null,
  suspendedForLog: false,
  suspendedStatus: null,
};
const throughput: ThroughputState = { bytes: 0, timer: null, unsub: null };
const dataActivity: DataActivityState = { noDataTimer: null, noDataActive: false };

interface VehicleIdentity {
  systemId: number;
  componentId: number;
  lastHeartbeatMs: number;
}

let activeVehicle: VehicleIdentity | null = null;

const DEFAULT_VEHICLE_SYSTEM_ID = 1;
const DEFAULT_VEHICLE_COMPONENT_ID = 1;

function getVehicleTarget(): { systemId: number; componentId: number } {
  if (activeVehicle) {
    return { systemId: activeVehicle.systemId, componentId: activeVehicle.componentId };
  }
  return { systemId: DEFAULT_VEHICLE_SYSTEM_ID, componentId: DEFAULT_VEHICLE_COMPONENT_ID };
}

function postFtpMetadataProgress(progress: import('./worker-protocol').FtpMetadataProgressEvent): void {
  postEvent({ type: 'ftpMetadataProgress', progress });
}

const LOG_FLUSH_INTERVAL_MS = 1000;
const LOG_FLUSH_BYTES = 256 * 1024;
const LOG_GRACE_PERIOD_MS = 30_000;
const NO_DATA_TIMEOUT_MS = 30_000;

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
  pipeline.vehicleTrackUnsub = null;
  pipeline.paramMessageUnsub = null;
  pipeline.ftpMessageUnsub = null;
  paramManager?.dispose();
  paramManager = null;
  metadataDownloader?.dispose();
  metadataDownloader = null;
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

function clearNoDataTimer(): void {
  if (dataActivity.noDataTimer !== null) {
    clearTimeout(dataActivity.noDataTimer);
    dataActivity.noDataTimer = null;
  }
}

function handleNoDataTimeout(): void {
  dataActivity.noDataTimer = null;
  if (!serial.serialSource?.isConnected) {
    dataActivity.noDataActive = false;
    return;
  }

  dataActivity.noDataActive = true;
  stopThroughputCounter();
  stopLogSession(log, postEvent);
  postEvent({ type: 'statusChange', status: 'no_data' });
}

function resetNoDataTimer(): void {
  if (!serial.serialSource?.isConnected) return;
  clearNoDataTimer();
  dataActivity.noDataTimer = setTimeout(() => {
    handleNoDataTimeout();
  }, NO_DATA_TIMEOUT_MS);
}

function recordPacketActivity(): void {
  if (!serial.serialSource) return;
  resetNoDataTimer();
  if (dataActivity.noDataActive) {
    dataActivity.noDataActive = false;
    postEvent({ type: 'statusChange', status: 'connected' });
  }
}

async function cleanupService(): Promise<void> {
  clearNoDataTimer();
  dataActivity.noDataActive = false;
  stopThroughputCounter();
  await resetPipeline({ disconnectSource: true });
}

function releasePipelineSubscriptions(): void {
  pipeline.statsUnsub?.();
  pipeline.updateUnsub?.();
  pipeline.statustextUnsub?.();
  pipeline.packetUnsub?.();
  pipeline.vehicleTrackUnsub?.();
  pipeline.paramMessageUnsub?.();
  pipeline.ftpMessageUnsub?.();
  pipeline.statsUnsub = null;
  pipeline.updateUnsub = null;
  pipeline.statustextUnsub = null;
  pipeline.packetUnsub = null;
  pipeline.vehicleTrackUnsub = null;
  pipeline.paramMessageUnsub = null;
  pipeline.ftpMessageUnsub = null;
}

async function resetPipeline(options: ResetPipelineOptions = {}): Promise<void> {
  const timeseriesManager = pipeline.timeseriesManager;

  if (pipeline.service) {
    if (options.disconnectSource) {
      await pipeline.service.disconnect();
    } else {
      pipeline.service.detach();
    }
  }

  releasePipelineSubscriptions();
  resetPipelineConnection();
  timeseriesManager?.dispose();
}

// ---------------------------------------------------------------------------
// Serial lifecycle helpers
// ---------------------------------------------------------------------------

/** Find a previously-granted serial port by its USB identity. */
function findPortByIdentity(ports: SerialPort[], identity: SerialPortIdentity | null): SerialPort | null {
  if (ports.length === 0) return null;
  if (!identity) return ports[0];
  for (const port of ports) {
    if (matchesSerialPortIdentity(port, identity)) {
      return port;
    }
  }
  return null;
}

/** Full serial cleanup — disconnect source, stop probe, clear reconnect timer, reset state. */
async function cleanupSerial(options?: { preserveAutoConnect?: boolean }): Promise<void> {
  await serial.serialSource?.disconnect();
  serial.serialSource = null;
  stopActiveProbe();
  clearNoDataTimer();
  dataActivity.noDataActive = false;
  serial.suspendedForLog = false;
  serial.suspendedStatus = null;
  if (!options?.preserveAutoConnect) {
    serial.autoConnectConfig = null;
  }
  if (serial.reconnectTimer !== null) {
    clearTimeout(serial.reconnectTimer);
    serial.reconnectTimer = null;
  }
  if (serial.logGraceTimer !== null) {
    clearTimeout(serial.logGraceTimer);
    serial.logGraceTimer = null;
  }
}

async function resetForSerialConnect(): Promise<void> {
  cancelLogGraceTimer();
  await cleanupService();
  await cleanupSerial();
}

function stopActiveProbe(): void {
  serial.probeService?.stopProbing();
  serial.probeService = null;
}

async function suspendLiveSerialForLog(): Promise<void> {
  if (!serial.serialSource || !pipeline.service) {
    return;
  }

  serial.suspendedForLog = true;
  serial.suspendedStatus = dataActivity.noDataActive ? 'no_data' : 'connected';
  clearNoDataTimer();
  dataActivity.noDataActive = false;
  stopThroughputCounter();
  pipeline.service.detach();
  await serial.serialSource.suspend();
  releasePipelineSubscriptions();
  resetPipelineConnection();
  clearMainThreadTelemetryState(pipeline, postEvent);
}

async function resumeSuspendedLiveSerial(): Promise<void> {
  if (!registry || !serial.serialSource || !serial.suspendedForLog) {
    return;
  }

  await cleanupService();
  clearMainThreadTelemetryState(pipeline, postEvent);

  serial.suspendedForLog = false;
  dataActivity.noDataActive = serial.suspendedStatus === 'no_data';
  const resumeStatus = serial.suspendedStatus ?? 'connected';
  serial.suspendedStatus = null;

  setupService(serial.serialSource);
  serial.serialSource.resumeAttached();
  pipeline.service!.attach();
  startThroughputCounter(serial.serialSource);

  if (resumeStatus === 'connected') {
    resetNoDataTimer();
  } else {
    clearNoDataTimer();
  }

  postEvent({ type: 'statusChange', status: resumeStatus });
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

async function failSerialConnect(status: 'disconnected' | 'error', err?: unknown): Promise<void> {
  cancelLogGraceTimer();
  await cleanupService();
  await cleanupSerial();
  if (err) {
    postEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
  postEvent({ type: 'probeStatus', status: null });
  postEvent({ type: 'statusChange', status });
}

async function completeSerialConnect(
  port: SerialPort,
  baudRate: BaudRate,
  options?: { clearProbeStatus?: boolean },
): Promise<void> {
  stopActiveProbe();
  clearNoDataTimer();
  dataActivity.noDataActive = false;
  serial.serialSource = new WorkerSerialByteSource(port, baudRate, handleSerialDisconnect);
  setupService(serial.serialSource);
  await pipeline.service!.connect();
  startThroughputCounter(serial.serialSource);
  await waitForFirstDecodedMessage();
  resetNoDataTimer();
  postEvent({ type: 'statusChange', status: 'connected' });
  postEvent({ type: 'serialConnected', baudRate, portIdentity: getSerialPortIdentity(port) });
  if (options?.clearProbeStatus) {
    postEvent({ type: 'probeStatus', status: null });
  }
}

function waitForFirstDecodedMessage(timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!pipeline.service) {
      reject(new Error('MAVLink service not initialized'));
      return;
    }

    const timeout = setTimeout(() => {
      unsub();
      reject(new Error('No decoded MAVLink packet received on the live serial connection'));
    }, timeoutMs);

    const unsub = pipeline.service.onMessage(() => {
      clearTimeout(timeout);
      unsub();
      resolve();
    });
  });
}

/** Start (or restart) auto-connect probing. */
function doStartAutoConnect(): void {
  if (!registry) return;
  if (serial.serialSource) return;

  if (serial.reconnectTimer !== null) {
    clearTimeout(serial.reconnectTimer);
    serial.reconnectTimer = null;
  }

  // Stop existing probe if any
  stopActiveProbe();

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
      if (serial.logGraceTimer !== null) {
        clearTimeout(serial.logGraceTimer);
        serial.logGraceTimer = null;
      }
      void completeSerialConnect(result.port, result.baudRate, { clearProbeStatus: true }).catch(err => {
        void (async () => {
          cancelLogGraceTimer();
          await cleanupService();
          await cleanupSerial({ preserveAutoConnect: true });
          postEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          postEvent({ type: 'statusChange', status: 'error' });
        })();
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
  clearStatusTextAssembly(pipeline.statusTextAssembly);

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
    forwardStatusText(pipeline.statusTextAssembly, msg, Date.now(), postEvent);
  });

  pipeline.vehicleTrackUnsub = pipeline.service.onMessage(msg => {
    if (msg.name === 'HEARTBEAT') {
      activeVehicle = {
        systemId: msg.systemId,
        componentId: msg.componentId,
        lastHeartbeatMs: Date.now(),
      };
    }
  });

  pipeline.packetUnsub = pipeline.service.onPacket((packet, timestampUs) => {
    recordPacketActivity();
    appendPacketToLog(log, packet, timestampUs, LOG_FLUSH_BYTES, LOG_FLUSH_INTERVAL_MS, postEvent);
  });

  paramManager = new ParameterManager(sendMavlinkMessage, getVehicleTarget);
  pipeline.paramMessageUnsub = pipeline.service.onMessage(msg => {
    paramManager?.handleMessage(msg);
  });
  paramManager.onStateChange(state => {
    postEvent({ type: 'paramState', state });
  });
  paramManager.onSetResult(result => {
    postEvent({ type: 'paramSetResult', result });
  });

  metadataDownloader = new MetadataFtpDownloader(sendMavlinkMessage, getVehicleTarget, progress => {
    postEvent({ type: 'ftpMetadataProgress', progress });
  });
  pipeline.ftpMessageUnsub = pipeline.service.onMessage(msg => {
    if (msg.name === 'FILE_TRANSFER_PROTOCOL') {
      metadataDownloader?.handleMessage(msg);
    }
  });
}

async function reconnectWithCurrentSource(): Promise<void> {
  if (!registry) return;
  const source = pipeline.spoofSource ?? pipeline.externalSource ?? serial.serialSource;
  if (!source) return;

  clearNoDataTimer();
  stopThroughputCounter();
  await resetPipeline({ disconnectSource: false });
  clearMainThreadTelemetryState(pipeline, postEvent);

  setupService(source);

  try {
    if (source === serial.serialSource) {
      pipeline.service?.attach();
      startThroughputCounter(source);
      if (!dataActivity.noDataActive) {
        resetNoDataTimer();
      }
      postEvent({ type: 'statusChange', status: dataActivity.noDataActive ? 'no_data' : 'connected' });
    } else {
      if (source.isConnected) {
        pipeline.service?.attach();
        startThroughputCounter(source);
      } else {
        await pipeline.service?.connect();
        startThroughputCounter(source);
      }
    }
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
      frameBuilder = new MavlinkFrameBuilder(registry);
      void reconnectWithCurrentSource();
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

      let source: SpoofByteSource | ExternalByteSource;
      if (config.type === 'spoof') {
        // Load bundled metadata for spoof FTP responder (best-effort)
        let metadataJson = '';
        try {
          const resp = await fetch('/params.json');
          if (resp.ok) metadataJson = await resp.text();
        } catch { /* spoof FTP will serve empty metadata */ }
        source = pipeline.spoofSource = new SpoofByteSource(registry, 1, 1, metadataJson);
      } else {
        source = pipeline.externalSource = new ExternalByteSource((data) => {
          postEvent({ type: 'writeBytes', data });
        });
      }

      setupService(source);

      postEvent({ type: 'statusChange', status: 'connecting' });
      pipeline.service!.connect().then(() => {
        startThroughputCounter(source);
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
      activeVehicle = null;
      await cleanupService();
      await cleanupSerial();
      clearMainThreadTelemetryState(pipeline, postEvent);
      postEvent({ type: 'statusChange', status: 'disconnected' });
      break;
    }

    case 'suspendLiveForLog': {
      cancelLogGraceTimer();
      await suspendLiveSerialForLog();
      break;
    }

    case 'resumeSuspendedLive': {
      cancelLogGraceTimer();
      await resumeSuspendedLiveSerial();
      break;
    }

    case 'unloadLog': {
      cancelLogGraceTimer();
      await cleanupService();
      clearMainThreadTelemetryState(pipeline, postEvent);
      if (!serial.suspendedForLog) {
        postEvent({ type: 'statusChange', status: 'disconnected' });
      }
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
      if (!serial.suspendedForLog) {
        await cleanupSerial();
      }
      clearMainThreadTelemetryState(pipeline, postEvent);
      if (!serial.suspendedForLog) {
        postEvent({ type: 'statusChange', status: 'disconnected' });
      }

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

      await resetForSerialConnect();

      const { baudRate: serialBaudRate, autoDetectBaud, portIdentity, lastBaudRate: serialLastBaud } = msg;

      navigator.serial.getPorts().then(async (ports) => {
        const port = findPortByIdentity(ports, portIdentity);
        if (!port) {
          postEvent({ type: 'statusChange', status: 'disconnected' });
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
              await completeSerialConnect(result.port, result.baudRate, { clearProbeStatus: true });
            } else {
              postEvent({ type: 'probeStatus', status: null });
              postEvent({ type: 'statusChange', status: 'disconnected' });
            }
          } catch (err) {
            await failSerialConnect('disconnected', err);
          }
        } else {
          try {
            await completeSerialConnect(port, serialBaudRate);
          } catch (err) {
            await failSerialConnect('error', err);
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
      stopActiveProbe();
      serial.autoConnectConfig = null;
      if (wasProbing) {
        postEvent({ type: 'statusChange', status: 'disconnected' });
      }
      break;
    }

    case 'portsChanged': {
      if (serial.autoConnectConfig && !serial.serialSource) {
        stopActiveProbe();
        doStartAutoConnect();
      }
      break;
    }

    case 'paramRequestAll': {
      paramManager?.requestAll();
      break;
    }

    case 'paramSet': {
      paramManager?.setValue(msg.paramId, msg.value);
      break;
    }

    case 'ftpDownloadMetadata': {
      if (!metadataDownloader) {
        postFtpMetadataProgress({
          level: 'error',
          stage: 'download:not-connected',
          message: 'Metadata download requested while no metadata downloader is available',
        });
        postEvent({ type: 'ftpMetadataError', error: 'Not connected' });
        break;
      }
      postFtpMetadataProgress({
        level: 'info',
        stage: 'download:requested',
        message: 'Metadata download requested from main thread',
      });
      metadataDownloader.download()
        .then(result => postEvent({ type: 'ftpMetadataResult', json: result.json, crcValid: result.crcValid }))
        .catch(err => {
          postFtpMetadataProgress({
            level: 'error',
            stage: 'download:error',
            message: err instanceof Error ? err.message : String(err),
          });
          postEvent({ type: 'ftpMetadataError', error: err instanceof Error ? err.message : String(err) });
        });
      break;
    }
  }
};
