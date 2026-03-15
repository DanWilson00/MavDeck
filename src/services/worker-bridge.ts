/**
 * Main-thread bridge to the MAVLink Web Worker.
 *
 * Provides a clean API for the UI to interact with the worker.
 * Translates postMessage calls into typed callbacks.
 */

import { EventEmitter } from '../core';
import type { MessageStats } from './message-tracker';
import type { LogSessionChunk, LogSessionEnd, LogSessionStart } from './tlog-service';
import type { WorkerCommand, WorkerEvent, ConnectionConfig, ConnectionStatus } from '../workers/worker-protocol';
import type { SerialPortIdentity } from './serial-probe-service';
import type { BaudRate } from './baud-rates';

// Re-export protocol types so existing consumers don't need to change imports.
export type { ConnectionConfig, ConnectionStatus } from '../workers/worker-protocol';

export interface StatusTextEntry {
  severity: number;
  text: string;
  timestamp: number;
}

type StatsCallback = (stats: Map<string, MessageStats>) => void;
type UpdateCallback = (buffers: Map<string, { timestamps: Float64Array; values: Float64Array }>) => void;
type AvailableFieldsCallback = (fields: string[]) => void;
type StatusCallback = (status: ConnectionStatus) => void;
type StatusTextCallback = (entry: StatusTextEntry) => void;
type LogSessionStartCallback = (meta: LogSessionStart) => void;
type LogChunkCallback = (chunk: LogSessionChunk) => void;
type LogSessionEndCallback = (meta: LogSessionEnd) => void;
type LoadCompleteCallback = (data: { stats: Map<string, MessageStats>; durationSec: number }) => void;

export class MavlinkWorkerBridge {
  private worker: Worker;
  private readonly statsEmitter = new EventEmitter<StatsCallback>();
  private readonly updateEmitter = new EventEmitter<UpdateCallback>();
  private readonly availableFieldsEmitter = new EventEmitter<AvailableFieldsCallback>();
  private readonly statusEmitter = new EventEmitter<StatusCallback>();
  private readonly statustextEmitter = new EventEmitter<StatusTextCallback>();
  private readonly logSessionStartEmitter = new EventEmitter<LogSessionStartCallback>();
  private readonly logChunkEmitter = new EventEmitter<LogChunkCallback>();
  private readonly logSessionEndEmitter = new EventEmitter<LogSessionEndCallback>();
  private readonly loadCompleteEmitter = new EventEmitter<LoadCompleteCallback>();
  private readonly probeStatusEmitter = new EventEmitter<(status: string | null) => void>();
  private readonly serialConnectedEmitter = new EventEmitter<(info: { baudRate: BaudRate; portIdentity: SerialPortIdentity | null }) => void>();
  private readonly needPermissionEmitter = new EventEmitter<() => void>();
  private readonly throughputEmitter = new EventEmitter<(bytesPerSec: number) => void>();
  private initResolve: (() => void) | null = null;
  private lastUpdate: Map<string, { timestamps: Float64Array; values: Float64Array }> | null = null;

  constructor() {
    this.worker = new Worker(
      new URL('../workers/mavlink-worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.worker.onmessage = this.handleMessage.bind(this);
  }

  /** Type-safe wrapper for sending commands to the worker. */
  private postCommand(command: WorkerCommand): void {
    this.worker.postMessage(command);
  }

  /** Initialize worker with dialect JSON. */
  init(dialectJson: string): Promise<void> {
    return new Promise<void>(resolve => {
      this.initResolve = resolve;
      this.postCommand({ type: 'init', dialectJson });
    });
  }

  /** Connect with given configuration. */
  connect(config: ConnectionConfig): void {
    this.postCommand({ type: 'connect', config });
  }

  /** Disconnect and clean up. */
  disconnect(): void {
    this.postCommand({ type: 'disconnect' });
  }

  /** Clear log playback data without changing future reconnect eligibility. */
  unloadLog(): void {
    this.postCommand({ type: 'unloadLog' });
  }

  suspendLiveForLog(): void {
    this.postCommand({ type: 'suspendLiveForLog' });
  }

  resumeSuspendedLive(): void {
    this.postCommand({ type: 'resumeSuspendedLive' });
  }

  /** Pause message processing. */
  pause(): void {
    this.postCommand({ type: 'pause' });
  }

  /** Resume message processing. */
  resume(): void {
    this.postCommand({ type: 'resume' });
  }

  /** Send raw bytes to the worker (for Web Serial). */
  sendBytes(data: Uint8Array): void {
    this.postCommand({ type: 'bytes', data });
  }

  /** Subscribe to message stats updates. */
  onStats(callback: StatsCallback): () => void {
    return this.statsEmitter.on(callback);
  }

  /** Subscribe to ring buffer data updates. New subscribers get the last cached update immediately. */
  onUpdate(callback: UpdateCallback): () => void {
    const unsub = this.updateEmitter.on(callback);
    if (this.lastUpdate) {
      callback(this.lastUpdate);
    }
    return unsub;
  }

  /** Subscribe to known field key updates. */
  onAvailableFields(callback: AvailableFieldsCallback): () => void {
    return this.availableFieldsEmitter.on(callback);
  }

  /** Subscribe to connection status changes. */
  onStatusChange(callback: StatusCallback): () => void {
    return this.statusEmitter.on(callback);
  }

  /** Subscribe to STATUSTEXT message events. */
  onStatusText(callback: StatusTextCallback): () => void {
    return this.statustextEmitter.on(callback);
  }

  onLogSessionStart(callback: LogSessionStartCallback): () => void {
    return this.logSessionStartEmitter.on(callback);
  }

  onLogChunk(callback: LogChunkCallback): () => void {
    return this.logChunkEmitter.on(callback);
  }

  onLogSessionEnd(callback: LogSessionEndCallback): () => void {
    return this.logSessionEndEmitter.on(callback);
  }

  /** Set the field keys that should be streamed to the main thread. */
  setInterestedFields(fields: string[]): void {
    this.postCommand({ type: 'setInterestedFields', fields });
  }

  /** Set ring-buffer capacity (samples per numeric field). */
  setBufferCapacity(bufferCapacity: number): void {
    this.postCommand({ type: 'setBufferCapacity', bufferCapacity });
  }

  /** Bulk-load tlog packets into the worker pipeline with their original timestamps. */
  loadLog(packets: Uint8Array[], timestamps: number[], bufferCapacity: number): void {
    this.postCommand({ type: 'loadLog', packets, timestamps, bufferCapacity });
  }

  /** Connect to a serial port in the worker. */
  connectSerial(config: { baudRate: BaudRate; autoDetectBaud: boolean; portIdentity: SerialPortIdentity | null; lastBaudRate: BaudRate | null }): void {
    this.postCommand({ type: 'connectSerial', ...config });
  }

  /** Start auto-connect probing in the worker. */
  startAutoConnect(config: { autoBaud: boolean; manualBaudRate: BaudRate; lastPortIdentity: SerialPortIdentity | null; lastBaudRate: BaudRate | null }): void {
    this.postCommand({ type: 'startAutoConnect', ...config });
  }

  /** Stop auto-connect probing. */
  stopAutoConnect(): void {
    this.postCommand({ type: 'stopAutoConnect' });
  }

  /** Notify the worker that available serial ports have changed. */
  notifyPortsChanged(): void {
    this.postCommand({ type: 'portsChanged' });
  }

  /** Subscribe to probe status updates. */
  onProbeStatus(callback: (status: string | null) => void): () => void {
    return this.probeStatusEmitter.on(callback);
  }

  /** Subscribe to serial connected events. */
  onSerialConnected(callback: (info: { baudRate: BaudRate; portIdentity: SerialPortIdentity | null }) => void): () => void {
    return this.serialConnectedEmitter.on(callback);
  }

  /** Subscribe to permission-needed events. */
  onNeedPermission(callback: () => void): () => void {
    return this.needPermissionEmitter.on(callback);
  }

  /** Subscribe to throughput updates (bytes per second). */
  onThroughput(callback: (bytesPerSec: number) => void): () => void {
    return this.throughputEmitter.on(callback);
  }

  /** Subscribe to log load completion events. */
  onLoadComplete(callback: LoadCompleteCallback): () => void {
    return this.loadCompleteEmitter.on(callback);
  }

  /** Terminate the worker. */
  dispose(): void {
    this.worker.terminate();
  }

  private handleMessage(e: MessageEvent<WorkerEvent>): void {
    const msg = e.data;

    switch (msg.type) {
      case 'initComplete': {
        this.initResolve?.();
        this.initResolve = null;
        break;
      }

      case 'stats': {
        const statsMap = new Map<string, MessageStats>(Object.entries(msg.stats));
        this.statsEmitter.emit(statsMap);
        break;
      }

      case 'update': {
        const buffersMap = new Map(Object.entries(msg.buffers));
        this.lastUpdate = buffersMap;
        this.updateEmitter.emit(buffersMap);
        break;
      }

      case 'availableFields': {
        this.availableFieldsEmitter.emit(msg.fields);
        break;
      }

      case 'statusChange': {
        this.statusEmitter.emit(msg.status);
        break;
      }

      case 'statustext': {
        const entry: StatusTextEntry = {
          severity: msg.severity,
          text: msg.text,
          timestamp: msg.timestamp,
        };
        this.statustextEmitter.emit(entry);
        break;
      }

      case 'logSessionStarted': {
        const meta: LogSessionStart = {
          sessionId: msg.sessionId,
          startedAtMs: msg.startedAtMs,
        };
        this.logSessionStartEmitter.emit(meta);
        break;
      }

      case 'logChunk': {
        const chunk: LogSessionChunk = {
          sessionId: msg.sessionId,
          seq: msg.seq,
          startUs: msg.startUs,
          endUs: msg.endUs,
          packetCount: msg.packetCount,
          bytes: msg.bytes,
        };
        this.logChunkEmitter.emit(chunk);
        break;
      }

      case 'logSessionEnded': {
        const meta: LogSessionEnd = {
          sessionId: msg.sessionId,
          endedAtMs: msg.endedAtMs,
          firstPacketUs: msg.firstPacketUs,
          lastPacketUs: msg.lastPacketUs,
          packetCount: msg.packetCount,
        };
        this.logSessionEndEmitter.emit(meta);
        break;
      }

      case 'loadComplete': {
        const statsMap = new Map<string, MessageStats>(Object.entries(msg.stats));
        this.loadCompleteEmitter.emit({ stats: statsMap, durationSec: msg.durationSec });
        break;
      }

      case 'probeStatus': {
        this.probeStatusEmitter.emit(msg.status);
        break;
      }

      case 'serialConnected': {
        this.serialConnectedEmitter.emit({ baudRate: msg.baudRate, portIdentity: msg.portIdentity });
        break;
      }

      case 'needPermission': {
        this.needPermissionEmitter.emit();
        break;
      }

      case 'throughput': {
        this.throughputEmitter.emit(msg.bytesPerSec);
        break;
      }

      case 'error': {
        console.error('[MavlinkWorker]', msg.message);
        break;
      }
    }
  }
}
