/**
 * WorkerController — encapsulates all MAVLink worker state and logic.
 *
 * Extracted from mavlink-worker.ts so the entire command dispatch,
 * pipeline lifecycle, and serial management can be tested without
 * a real Web Worker environment.
 *
 * The worker file is reduced to a thin shell:
 *   const controller = new WorkerController(postEvent);
 *   self.onmessage = (e) => void controller.handleCommand(e.data);
 */

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
import type { WorkerCommand, WorkerEvent, FtpMetadataProgressEvent } from './worker-protocol';
import { PROBE_TIMEOUT_MS } from '../services/baud-rates';
import {
  INITIAL_LOG_STATE,
  appendPacketToLog,
  flushPendingLogChunk,
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
import { ThroughputMonitor } from './throughput-monitor';
import { DataActivityMonitor } from './data-activity-monitor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PostEventFn = (event: WorkerEvent, transfer?: Transferable[]) => void;

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

interface SerialState {
  serialSource: WorkerSerialByteSource | null;
  probeService: SerialProbeService | null;
  autoConnectConfig: { autoBaud: boolean; manualBaudRate: BaudRate; lastPortIdentity: SerialPortIdentity | null; lastBaudRate: BaudRate | null } | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  logGraceTimer: ReturnType<typeof setTimeout> | null;
  suspendedForLog: boolean;
  suspendedStatus: 'connected' | 'no_data' | null;
}

interface VehicleIdentity {
  systemId: number;
  componentId: number;
  lastHeartbeatMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BUFFER_CAPACITY = 2000;
const NO_DATA_TIMEOUT_MS = 30_000;
const GCS_SYSTEM_ID = 255;
const GCS_COMPONENT_ID = 190;
const LOG_FLUSH_INTERVAL_MS = 1000;
const LOG_FLUSH_BYTES = 256 * 1024;
const LOG_GRACE_PERIOD_MS = 30_000;
const DEFAULT_VEHICLE_SYSTEM_ID = 1;
const DEFAULT_VEHICLE_COMPONENT_ID = 1;

// ---------------------------------------------------------------------------
// Pure utility
// ---------------------------------------------------------------------------

/** Find a previously-granted serial port by its USB identity. */
export function findPortByIdentity(ports: SerialPort[], identity: SerialPortIdentity | null): SerialPort | null {
  if (ports.length === 0) return null;
  if (!identity) return ports[0];
  for (const port of ports) {
    if (matchesSerialPortIdentity(port, identity)) {
      return port;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// WorkerController
// ---------------------------------------------------------------------------

export class WorkerController {
  private readonly postEvent: PostEventFn;

  // Persistent state (survives connections)
  private registry: MavlinkMetadataRegistry | null = null;
  private frameBuilder: MavlinkFrameBuilder | null = null;

  // Connection state
  private paramManager: ParameterManager | null = null;
  private metadataDownloader: MetadataFtpDownloader | null = null;
  private sendSequence = 0;
  private activeVehicle: VehicleIdentity | null = null;

  // Sub-states
  private readonly pipeline: PipelineState = {
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

  private readonly log: LogState = { ...INITIAL_LOG_STATE, chunkParts: [] };

  private readonly serial: SerialState = {
    serialSource: null,
    probeService: null,
    autoConnectConfig: null,
    reconnectTimer: null,
    logGraceTimer: null,
    suspendedForLog: false,
    suspendedStatus: null,
  };

  private readonly throughputMonitor: ThroughputMonitor;
  private readonly dataActivityMonitor: DataActivityMonitor;

  constructor(postEvent: PostEventFn) {
    this.postEvent = postEvent;

    this.throughputMonitor = new ThroughputMonitor(bytesPerSec => {
      this.postEvent({ type: 'throughput', bytesPerSec });
    });

    this.dataActivityMonitor = new DataActivityMonitor(NO_DATA_TIMEOUT_MS, {
      onNoData: () => {
        if (!this.serial.serialSource?.isConnected) return;
        this.throughputMonitor.stop();
        stopLogSession(this.log, this.postEvent);
        this.postEvent({ type: 'statusChange', status: 'no_data' });
      },
      onDataResumed: () => {
        this.postEvent({ type: 'statusChange', status: 'connected' });
      },
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async handleCommand(msg: WorkerCommand): Promise<void> {
    switch (msg.type) {
      case 'init': {
        this.registry = new MavlinkMetadataRegistry();
        this.registry.loadFromJsonString(msg.dialectJson);
        this.frameBuilder = new MavlinkFrameBuilder(this.registry);
        void this.reconnectWithCurrentSource();
        this.postEvent({ type: 'initComplete' });
        break;
      }

      case 'connect': {
        if (!this.registry) {
          this.postEvent({ type: 'error', message: 'Registry not initialized' });
          return;
        }

        this.cancelLogGraceTimer();
        await this.cleanupService();

        const { config } = msg;

        let source: SpoofByteSource | ExternalByteSource;
        if (config.type === 'spoof') {
          let metadataJson = '';
          try {
            const resp = await fetch('/params.json');
            if (resp.ok) metadataJson = await resp.text();
          } catch { /* spoof FTP will serve empty metadata */ }
          source = this.pipeline.spoofSource = new SpoofByteSource(this.registry, 1, 1, metadataJson);
        } else {
          source = this.pipeline.externalSource = new ExternalByteSource((data) => {
            this.postEvent({ type: 'writeBytes', data });
          });
        }

        this.setupService(source);

        this.postEvent({ type: 'statusChange', status: 'connecting' });
        this.pipeline.service!.connect().then(() => {
          this.throughputMonitor.start(source);
          this.postEvent({ type: 'statusChange', status: 'connected' });
        }).catch((err: Error) => {
          void this.cleanupService();
          this.postEvent({ type: 'error', message: err.message });
          this.postEvent({ type: 'statusChange', status: 'error' });
        });
        break;
      }

      case 'disconnect': {
        this.cancelLogGraceTimer();
        this.activeVehicle = null;
        await this.cleanupService();
        await this.cleanupSerial();
        clearMainThreadTelemetryState(this.pipeline, this.postEvent);
        this.postEvent({ type: 'statusChange', status: 'disconnected' });
        break;
      }

      case 'suspendLiveForLog': {
        this.cancelLogGraceTimer();
        await this.suspendLiveSerialForLog();
        break;
      }

      case 'resumeSuspendedLive': {
        this.cancelLogGraceTimer();
        await this.resumeSuspendedLiveSerial();
        break;
      }

      case 'unloadLog': {
        this.cancelLogGraceTimer();
        await this.cleanupService();
        clearMainThreadTelemetryState(this.pipeline, this.postEvent);
        if (!this.serial.suspendedForLog) {
          this.postEvent({ type: 'statusChange', status: 'disconnected' });
        }
        break;
      }

      case 'pause':
      case 'resume':
        break;

      case 'bytes': {
        this.pipeline.externalSource?.emitBytes(msg.data);
        break;
      }

      case 'setInterestedFields': {
        this.pipeline.interestedFields = new Set(msg.fields);
        break;
      }

      case 'setBufferCapacity': {
        const nextCapacity = msg.bufferCapacity;
        const normalizedCapacity = Number.isFinite(nextCapacity)
          ? Math.max(1, Math.floor(nextCapacity))
          : DEFAULT_BUFFER_CAPACITY;
        if (normalizedCapacity === this.pipeline.bufferCapacity) break;
        this.pipeline.bufferCapacity = normalizedCapacity;
        void this.reconnectWithCurrentSource();
        break;
      }

      case 'loadLog': {
        if (!this.registry) {
          this.postEvent({ type: 'error', message: 'Registry not initialized' });
          return;
        }

        const { packets, timestamps, bufferCapacity: logCapacity } = msg;

        this.cancelLogGraceTimer();
        await this.cleanupService();
        if (!this.serial.suspendedForLog) {
          await this.cleanupSerial();
        }
        clearMainThreadTelemetryState(this.pipeline, this.postEvent);
        if (!this.serial.suspendedForLog) {
          this.postEvent({ type: 'statusChange', status: 'disconnected' });
        }

        this.pipeline.bufferCapacity = logCapacity;

        this.pipeline.tracker = new GenericMessageTracker();
        this.pipeline.timeseriesManager = new TimeSeriesDataManager({ bufferCapacity: this.pipeline.bufferCapacity });
        batchProcessPackets(this.registry, this.pipeline.tracker, this.pipeline.timeseriesManager, packets, timestamps, this.postEvent);

        let durationSec = 0;
        const allFields = this.pipeline.timeseriesManager.getAvailableFields();
        let minTs = Infinity;
        let maxTs = -Infinity;
        for (const field of allFields) {
          const buf = this.pipeline.timeseriesManager.getBuffer(field);
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

        this.pipeline.interestedFields = new Set(allFields);
        postUpdateFromManager(this.pipeline, this.pipeline.timeseriesManager, this.postEvent);

        const statsMap = this.pipeline.tracker.getStats();
        // Override real-time frequency with log-based frequency.
        // Build a new map to avoid mutating the tracker's cached snapshot.
        const overriddenStats = new Map(statsMap);
        if (durationSec > 0) {
          for (const [name, stat] of overriddenStats) {
            overriddenStats.set(name, { ...stat, frequency: stat.count / durationSec });
          }
        }

        const stats = serializeStats(overriddenStats);
        this.postEvent({ type: 'stats', stats });
        this.postEvent({ type: 'loadComplete', stats, durationSec });
        break;
      }

      case 'connectSerial': {
        if (!this.registry) {
          this.postEvent({ type: 'error', message: 'Registry not initialized' });
          return;
        }

        await this.resetForSerialConnect();

        const { baudRate: serialBaudRate, autoDetectBaud, portIdentity, lastBaudRate: serialLastBaud } = msg;

        navigator.serial.getPorts().then(async (ports) => {
          const port = findPortByIdentity(ports, portIdentity);
          if (!port) {
            this.postEvent({ type: 'statusChange', status: 'disconnected' });
            return;
          }

          if (autoDetectBaud) {
            const probeService = new SerialProbeService(this.registry!);
            this.serial.probeService = probeService;

            this.postEvent({ type: 'statusChange', status: 'probing' });

            try {
              const result = await probeService.probeSinglePort(port, {
                autoBaud: true,
                manualBaudRate: serialBaudRate,
                lastBaudRate: serialLastBaud,
                onStatus: (s) => this.postEvent({ type: 'probeStatus', status: s }),
              }, new AbortController().signal);

              if (result) {
                await this.completeSerialConnect(result.port, result.baudRate, { clearProbeStatus: true });
              } else {
                this.postEvent({ type: 'probeStatus', status: null });
                this.postEvent({ type: 'statusChange', status: 'disconnected' });
              }
            } catch (err) {
              await this.failSerialConnect('disconnected', err);
            }
          } else {
            try {
              await this.completeSerialConnect(port, serialBaudRate);
            } catch (err) {
              await this.failSerialConnect('error', err);
            }
          }
        }).catch((err) => {
          this.postEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          this.postEvent({ type: 'statusChange', status: 'error' });
        });
        break;
      }

      case 'startAutoConnect': {
        this.serial.autoConnectConfig = {
          autoBaud: msg.autoBaud,
          manualBaudRate: msg.manualBaudRate,
          lastPortIdentity: msg.lastPortIdentity,
          lastBaudRate: msg.lastBaudRate,
        };
        this.doStartAutoConnect();
        break;
      }

      case 'stopAutoConnect': {
        this.cancelLogGraceTimer();
        if (this.serial.reconnectTimer !== null) {
          clearTimeout(this.serial.reconnectTimer);
          this.serial.reconnectTimer = null;
        }
        const wasProbing = this.serial.probeService?.isProbing ?? false;
        this.stopActiveProbe();
        this.serial.autoConnectConfig = null;
        if (wasProbing) {
          this.postEvent({ type: 'statusChange', status: 'disconnected' });
        }
        break;
      }

      case 'portsChanged': {
        if (this.serial.autoConnectConfig && !this.serial.serialSource) {
          this.stopActiveProbe();
          this.doStartAutoConnect();
        }
        break;
      }

      case 'paramRequestAll': {
        this.paramManager?.requestAll();
        break;
      }

      case 'paramSet': {
        this.paramManager?.setValue(msg.paramId, msg.value);
        break;
      }

      case 'ftpDownloadMetadata': {
        if (!this.metadataDownloader) {
          this.postFtpMetadataProgress({
            level: 'error',
            stage: 'download:not-connected',
            message: 'Metadata download requested while no metadata downloader is available',
          });
          this.postEvent({ type: 'ftpMetadataError', error: 'Not connected' });
          break;
        }
        this.postFtpMetadataProgress({
          level: 'info',
          stage: 'download:requested',
          message: 'Metadata download requested from main thread',
        });
        this.metadataDownloader.download()
          .then(result => this.postEvent({ type: 'ftpMetadataResult', json: result.json, crcValid: result.crcValid }))
          .catch(err => {
            this.postFtpMetadataProgress({
              level: 'error',
              stage: 'download:error',
              message: err instanceof Error ? err.message : String(err),
            });
            this.postEvent({ type: 'ftpMetadataError', error: err instanceof Error ? err.message : String(err) });
          });
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline lifecycle
  // -------------------------------------------------------------------------

  private setupService(source: SpoofByteSource | ExternalByteSource | WorkerSerialByteSource): void {
    this.pipeline.tracker = new GenericMessageTracker();
    this.pipeline.timeseriesManager = new TimeSeriesDataManager({ bufferCapacity: this.pipeline.bufferCapacity });
    this.pipeline.service = new MavlinkService(this.registry!, source, this.pipeline.tracker, this.pipeline.timeseriesManager);
    clearStatusTextAssembly(this.pipeline.statusTextAssembly);

    this.pipeline.statsUnsub = this.pipeline.tracker.onStats(stats => {
      this.postEvent({ type: 'stats', stats: serializeStats(stats) });
    });

    this.pipeline.updateUnsub = this.pipeline.timeseriesManager.onUpdate(() => {
      postUpdateFromManager(this.pipeline, this.pipeline.timeseriesManager!, this.postEvent);
    });

    this.pipeline.statustextUnsub = this.pipeline.service.onMessage(msg => {
      forwardStatusText(this.pipeline.statusTextAssembly, msg, Date.now(), this.postEvent);
    });

    this.pipeline.vehicleTrackUnsub = this.pipeline.service.onMessage(msg => {
      if (msg.name === 'HEARTBEAT') {
        this.activeVehicle = {
          systemId: msg.systemId,
          componentId: msg.componentId,
          lastHeartbeatMs: Date.now(),
        };
      }
    });

    this.pipeline.packetUnsub = this.pipeline.service.onPacket((packet, timestampUs) => {
      if (this.serial.serialSource) this.dataActivityMonitor.recordActivity();
      appendPacketToLog(this.log, packet, timestampUs, LOG_FLUSH_BYTES, LOG_FLUSH_INTERVAL_MS, this.postEvent);
    });

    this.paramManager = new ParameterManager(
      (name, values) => this.sendMavlinkMessage(name, values),
      () => this.getVehicleTarget(),
    );
    this.pipeline.paramMessageUnsub = this.pipeline.service.onMessage(msg => {
      this.paramManager?.handleMessage(msg);
    });
    this.paramManager.onStateChange(state => {
      this.postEvent({ type: 'paramState', state });
    });
    this.paramManager.onSetResult(result => {
      this.postEvent({ type: 'paramSetResult', result });
    });

    this.metadataDownloader = new MetadataFtpDownloader(
      (name, values) => this.sendMavlinkMessage(name, values),
      () => this.getVehicleTarget(),
      progress => { this.postEvent({ type: 'ftpMetadataProgress', progress }); },
    );
    this.pipeline.ftpMessageUnsub = this.pipeline.service.onMessage(msg => {
      if (msg.name === 'FILE_TRANSFER_PROTOCOL') {
        this.metadataDownloader?.handleMessage(msg);
      }
    });
  }

  private resetPipelineConnection(): void {
    this.pipeline.service = null;
    this.pipeline.spoofSource = null;
    this.pipeline.externalSource = null;
    this.pipeline.tracker = null;
    this.pipeline.timeseriesManager = null;
    this.pipeline.lastAvailableFieldsSignature = '';
    this.pipeline.statsUnsub = null;
    this.pipeline.updateUnsub = null;
    this.pipeline.statustextUnsub = null;
    this.pipeline.packetUnsub = null;
    this.pipeline.vehicleTrackUnsub = null;
    this.pipeline.paramMessageUnsub = null;
    this.pipeline.ftpMessageUnsub = null;
    this.paramManager?.dispose();
    this.paramManager = null;
    this.metadataDownloader?.dispose();
    this.metadataDownloader = null;
  }

  private releasePipelineSubscriptions(): void {
    this.pipeline.statsUnsub?.();
    this.pipeline.updateUnsub?.();
    this.pipeline.statustextUnsub?.();
    this.pipeline.packetUnsub?.();
    this.pipeline.vehicleTrackUnsub?.();
    this.pipeline.paramMessageUnsub?.();
    this.pipeline.ftpMessageUnsub?.();
    this.pipeline.statsUnsub = null;
    this.pipeline.updateUnsub = null;
    this.pipeline.statustextUnsub = null;
    this.pipeline.packetUnsub = null;
    this.pipeline.vehicleTrackUnsub = null;
    this.pipeline.paramMessageUnsub = null;
    this.pipeline.ftpMessageUnsub = null;
  }

  private async resetPipeline(options: { disconnectSource?: boolean } = {}): Promise<void> {
    const timeseriesManager = this.pipeline.timeseriesManager;

    if (this.pipeline.service) {
      if (options.disconnectSource) {
        await this.pipeline.service.disconnect();
      } else {
        this.pipeline.service.detach();
      }
    }

    this.releasePipelineSubscriptions();
    this.resetPipelineConnection();
    timeseriesManager?.dispose();
  }

  private async cleanupService(): Promise<void> {
    this.dataActivityMonitor.reset();
    this.throughputMonitor.stop();
    await this.resetPipeline({ disconnectSource: true });
  }

  private async reconnectWithCurrentSource(): Promise<void> {
    if (!this.registry) return;
    const source = this.pipeline.spoofSource ?? this.pipeline.externalSource ?? this.serial.serialSource;
    if (!source) return;

    this.dataActivityMonitor.clearTimer();
    this.throughputMonitor.stop();
    await this.resetPipeline({ disconnectSource: false });
    clearMainThreadTelemetryState(this.pipeline, this.postEvent);

    this.setupService(source);

    try {
      if (source === this.serial.serialSource) {
        this.pipeline.service?.attach();
        this.throughputMonitor.start(source);
        if (!this.dataActivityMonitor.isIdle) {
          this.dataActivityMonitor.resetTimer();
        }
        this.postEvent({ type: 'statusChange', status: this.dataActivityMonitor.isIdle ? 'no_data' : 'connected' });
      } else {
        if (source.isConnected) {
          this.pipeline.service?.attach();
          this.throughputMonitor.start(source);
        } else {
          await this.pipeline.service?.connect();
          this.throughputMonitor.start(source);
        }
      }
    } catch (err) {
      await this.cleanupService();
      this.postEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      this.postEvent({ type: 'statusChange', status: 'error' });
    }
  }

  // -------------------------------------------------------------------------
  // Serial lifecycle
  // -------------------------------------------------------------------------

  private async cleanupSerial(options?: { preserveAutoConnect?: boolean }): Promise<void> {
    await this.serial.serialSource?.disconnect();
    this.serial.serialSource = null;
    this.stopActiveProbe();
    this.dataActivityMonitor.reset();
    this.serial.suspendedForLog = false;
    this.serial.suspendedStatus = null;
    if (!options?.preserveAutoConnect) {
      this.serial.autoConnectConfig = null;
    }
    if (this.serial.reconnectTimer !== null) {
      clearTimeout(this.serial.reconnectTimer);
      this.serial.reconnectTimer = null;
    }
    if (this.serial.logGraceTimer !== null) {
      clearTimeout(this.serial.logGraceTimer);
      this.serial.logGraceTimer = null;
    }
  }

  private async resetForSerialConnect(): Promise<void> {
    this.cancelLogGraceTimer();
    await this.cleanupService();
    await this.cleanupSerial();
  }

  private stopActiveProbe(): void {
    this.serial.probeService?.stopProbing();
    this.serial.probeService = null;
  }

  private async suspendLiveSerialForLog(): Promise<void> {
    if (!this.serial.serialSource || !this.pipeline.service) return;

    this.serial.suspendedForLog = true;
    this.serial.suspendedStatus = this.dataActivityMonitor.isIdle ? 'no_data' : 'connected';
    this.dataActivityMonitor.reset();
    this.throughputMonitor.stop();
    this.pipeline.service.detach();
    await this.serial.serialSource.suspend();
    this.releasePipelineSubscriptions();
    this.resetPipelineConnection();
    clearMainThreadTelemetryState(this.pipeline, this.postEvent);
  }

  private async resumeSuspendedLiveSerial(): Promise<void> {
    if (!this.registry || !this.serial.serialSource || !this.serial.suspendedForLog) return;

    await this.cleanupService();
    clearMainThreadTelemetryState(this.pipeline, this.postEvent);

    this.serial.suspendedForLog = false;
    this.dataActivityMonitor.idle = this.serial.suspendedStatus === 'no_data';
    const resumeStatus = this.serial.suspendedStatus ?? 'connected';
    this.serial.suspendedStatus = null;

    this.setupService(this.serial.serialSource);
    this.serial.serialSource.resumeAttached();
    this.pipeline.service!.attach();
    this.throughputMonitor.start(this.serial.serialSource);

    if (resumeStatus === 'connected') {
      this.dataActivityMonitor.resetTimer();
    } else {
      this.dataActivityMonitor.clearTimer();
    }

    this.postEvent({ type: 'statusChange', status: resumeStatus });
  }

  private async handleSerialDisconnect(): Promise<void> {
    const source = this.serial.serialSource;
    this.serial.serialSource = null;

    if (source) {
      await source.disconnect();
    }

    if (this.serial.logGraceTimer !== null) {
      clearTimeout(this.serial.logGraceTimer);
      this.serial.logGraceTimer = null;
    }

    if (this.serial.autoConnectConfig && this.log.sessionId) {
      flushPendingLogChunk(this.log, this.postEvent);
      this.serial.logGraceTimer = setTimeout(() => {
        this.serial.logGraceTimer = null;
        stopLogSession(this.log, this.postEvent);
      }, LOG_GRACE_PERIOD_MS);
    } else {
      stopLogSession(this.log, this.postEvent);
    }

    await this.cleanupService();

    this.postEvent({ type: 'statusChange', status: 'disconnected' });
    this.postEvent({ type: 'stats', stats: {} });

    if (this.serial.autoConnectConfig) {
      this.serial.reconnectTimer = setTimeout(() => {
        this.serial.reconnectTimer = null;
        this.doStartAutoConnect();
      }, 2000);
    }
  }

  private async failSerialConnect(status: 'disconnected' | 'error', err?: unknown): Promise<void> {
    this.cancelLogGraceTimer();
    await this.cleanupService();
    await this.cleanupSerial();
    if (err) {
      this.postEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    this.postEvent({ type: 'probeStatus', status: null });
    this.postEvent({ type: 'statusChange', status });
  }

  private async completeSerialConnect(
    port: SerialPort,
    baudRate: BaudRate,
    options?: { clearProbeStatus?: boolean },
  ): Promise<void> {
    this.stopActiveProbe();
    this.dataActivityMonitor.reset();
    this.serial.serialSource = new WorkerSerialByteSource(port, baudRate, () => void this.handleSerialDisconnect());
    this.setupService(this.serial.serialSource);
    await this.pipeline.service!.connect();
    this.throughputMonitor.start(this.serial.serialSource);
    await this.waitForFirstDecodedMessage();
    this.dataActivityMonitor.resetTimer();
    this.postEvent({ type: 'statusChange', status: 'connected' });
    this.postEvent({ type: 'serialConnected', baudRate, portIdentity: getSerialPortIdentity(port) });
    if (options?.clearProbeStatus) {
      this.postEvent({ type: 'probeStatus', status: null });
    }
  }

  private waitForFirstDecodedMessage(timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.pipeline.service) {
        reject(new Error('MAVLink service not initialized'));
        return;
      }

      const timeout = setTimeout(() => {
        unsub();
        reject(new Error('No decoded MAVLink packet received on the live serial connection'));
      }, timeoutMs);

      const unsub = this.pipeline.service.onMessage(() => {
        clearTimeout(timeout);
        unsub();
        resolve();
      });
    });
  }

  private doStartAutoConnect(): void {
    if (!this.registry) return;
    if (this.serial.serialSource) return;

    if (this.serial.reconnectTimer !== null) {
      clearTimeout(this.serial.reconnectTimer);
      this.serial.reconnectTimer = null;
    }

    this.stopActiveProbe();

    this.serial.probeService = new SerialProbeService(this.registry);

    this.postEvent({ type: 'statusChange', status: 'probing' });

    const config = this.serial.autoConnectConfig;
    if (!config) return;

    this.serial.probeService.startProbing({
      autoBaud: config.autoBaud,
      manualBaudRate: config.manualBaudRate,
      lastPortIdentity: config.lastPortIdentity,
      lastBaudRate: config.lastBaudRate,
      onResult: (result) => {
        if (this.serial.logGraceTimer !== null) {
          clearTimeout(this.serial.logGraceTimer);
          this.serial.logGraceTimer = null;
        }
        void this.completeSerialConnect(result.port, result.baudRate, { clearProbeStatus: true }).catch(err => {
          void (async () => {
            this.cancelLogGraceTimer();
            await this.cleanupService();
            await this.cleanupSerial({ preserveAutoConnect: true });
            this.postEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
            this.postEvent({ type: 'statusChange', status: 'error' });
          })();
        });
      },
      onStatus: (status) => {
        this.postEvent({ type: 'probeStatus', status });
      },
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private cancelLogGraceTimer(): void {
    if (this.serial.logGraceTimer !== null) {
      clearTimeout(this.serial.logGraceTimer);
      this.serial.logGraceTimer = null;
    }
    stopLogSession(this.log, this.postEvent);
  }

  private sendMavlinkMessage(
    messageName: string,
    values: Record<string, number | string | number[]>,
  ): void {
    const source = this.serial.serialSource ?? this.pipeline.externalSource ?? this.pipeline.spoofSource;
    if (!source || !this.frameBuilder) return;
    const frame = this.frameBuilder.buildFrame({
      messageName,
      values,
      systemId: GCS_SYSTEM_ID,
      componentId: GCS_COMPONENT_ID,
      sequence: this.sendSequence++ & 0xFF,
    });
    void source.write(frame);
  }

  private getVehicleTarget(): { systemId: number; componentId: number } {
    if (this.activeVehicle) {
      return { systemId: this.activeVehicle.systemId, componentId: this.activeVehicle.componentId };
    }
    console.warn('[worker] No HEARTBEAT received yet — using default vehicle target (sysid=1, compid=1)');
    return { systemId: DEFAULT_VEHICLE_SYSTEM_ID, componentId: DEFAULT_VEHICLE_COMPONENT_ID };
  }

  private postFtpMetadataProgress(progress: FtpMetadataProgressEvent): void {
    this.postEvent({ type: 'ftpMetadataProgress', progress });
  }
}
