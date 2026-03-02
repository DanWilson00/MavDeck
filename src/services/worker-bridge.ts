/**
 * Main-thread bridge to the MAVLink Web Worker.
 *
 * Provides a clean API for the UI to interact with the worker.
 * Translates postMessage calls into typed callbacks.
 */

import { EventEmitter } from '../core/event-emitter';
import type { MessageStats } from './message-tracker';
import type { LogSessionChunk, LogSessionEnd, LogSessionStart } from './tlog-service';

export type ConnectionConfig =
  | { type: 'spoof' }
  | { type: 'webserial'; baudRate: number };

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

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
  private initResolve: (() => void) | null = null;
  private lastUpdate: Map<string, { timestamps: Float64Array; values: Float64Array }> | null = null;

  constructor() {
    this.worker = new Worker(
      new URL('../workers/mavlink-worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.worker.onmessage = this.handleMessage.bind(this);
  }

  /** Initialize worker with dialect JSON. */
  init(dialectJson: string): Promise<void> {
    return new Promise<void>(resolve => {
      this.initResolve = resolve;
      this.worker.postMessage({ type: 'init', dialectJson });
    });
  }

  /** Connect with given configuration. */
  connect(config: ConnectionConfig): void {
    this.worker.postMessage({ type: 'connect', config });
  }

  /** Disconnect and clean up. */
  disconnect(): void {
    this.worker.postMessage({ type: 'disconnect' });
  }

  /** Pause message processing. */
  pause(): void {
    this.worker.postMessage({ type: 'pause' });
  }

  /** Resume message processing. */
  resume(): void {
    this.worker.postMessage({ type: 'resume' });
  }

  /** Send raw bytes to the worker (for Web Serial). */
  sendBytes(data: Uint8Array): void {
    this.worker.postMessage({ type: 'bytes', data });
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
    this.worker.postMessage({ type: 'setInterestedFields', fields });
  }

  /** Set ring-buffer capacity (samples per numeric field). */
  setBufferCapacity(bufferCapacity: number): void {
    this.worker.postMessage({ type: 'setBufferCapacity', bufferCapacity });
  }

  /** Bulk-load tlog packets into the worker pipeline with their original timestamps. */
  loadLog(packets: Uint8Array[], timestamps: number[], bufferCapacity: number): void {
    this.worker.postMessage({ type: 'loadLog', packets, timestamps, bufferCapacity });
  }

  /** Subscribe to log load completion events. */
  onLoadComplete(callback: LoadCompleteCallback): () => void {
    return this.loadCompleteEmitter.on(callback);
  }

  /** Terminate the worker. */
  dispose(): void {
    this.worker.terminate();
  }

  private handleMessage(e: MessageEvent): void {
    const { type } = e.data;

    switch (type) {
      case 'initComplete': {
        this.initResolve?.();
        this.initResolve = null;
        break;
      }

      case 'stats': {
        const statsRecord = e.data.stats as Record<string, MessageStats>;
        const statsMap = new Map<string, MessageStats>(Object.entries(statsRecord));
        this.statsEmitter.emit(statsMap);
        break;
      }

      case 'update': {
        const buffersRecord = e.data.buffers as Record<string, { timestamps: Float64Array; values: Float64Array }>;
        const buffersMap = new Map(Object.entries(buffersRecord));
        this.lastUpdate = buffersMap;
        this.updateEmitter.emit(buffersMap);
        break;
      }

      case 'availableFields': {
        const fields = e.data.fields as string[];
        this.availableFieldsEmitter.emit(fields);
        break;
      }

      case 'statusChange': {
        const status = e.data.status as ConnectionStatus;
        if (status === 'disconnected') {
          this.lastUpdate = null;
        }
        this.statusEmitter.emit(status);
        break;
      }

      case 'statustext': {
        const entry: StatusTextEntry = {
          severity: e.data.severity as number,
          text: e.data.text as string,
          timestamp: e.data.timestamp as number,
        };
        this.statustextEmitter.emit(entry);
        break;
      }

      case 'logSessionStarted': {
        const meta: LogSessionStart = {
          sessionId: e.data.sessionId as string,
          startedAtMs: e.data.startedAtMs as number,
        };
        this.logSessionStartEmitter.emit(meta);
        break;
      }

      case 'logChunk': {
        const chunk: LogSessionChunk = {
          sessionId: e.data.sessionId as string,
          seq: e.data.seq as number,
          startUs: e.data.startUs as number,
          endUs: e.data.endUs as number,
          packetCount: e.data.chunkPacketCount as number,
          bytes: e.data.bytes as ArrayBuffer,
        };
        this.logChunkEmitter.emit(chunk);
        break;
      }

      case 'logSessionEnded': {
        const meta: LogSessionEnd = {
          sessionId: e.data.sessionId as string,
          endedAtMs: e.data.endedAtMs as number,
          firstPacketUs: e.data.firstPacketUs as number | undefined,
          lastPacketUs: e.data.lastPacketUs as number | undefined,
          packetCount: e.data.packetCount as number,
        };
        this.logSessionEndEmitter.emit(meta);
        break;
      }

      case 'loadComplete': {
        const statsRecord = e.data.stats as Record<string, MessageStats>;
        const statsMap = new Map<string, MessageStats>(Object.entries(statsRecord));
        const durationSec = e.data.durationSec as number;
        this.loadCompleteEmitter.emit({ stats: statsMap, durationSec });
        break;
      }

      case 'error': {
        console.error('[MavlinkWorker]', e.data.message);
        break;
      }
    }
  }
}
