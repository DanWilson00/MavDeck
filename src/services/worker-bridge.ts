/**
 * Main-thread bridge to the MAVLink Web Worker.
 *
 * Provides a clean API for the UI to interact with the worker.
 * Translates postMessage calls into typed callbacks.
 */

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
  private readonly statsCallbacks = new Set<StatsCallback>();
  private readonly updateCallbacks = new Set<UpdateCallback>();
  private readonly availableFieldsCallbacks = new Set<AvailableFieldsCallback>();
  private readonly statusCallbacks = new Set<StatusCallback>();
  private readonly statustextCallbacks = new Set<StatusTextCallback>();
  private readonly logSessionStartCallbacks = new Set<LogSessionStartCallback>();
  private readonly logChunkCallbacks = new Set<LogChunkCallback>();
  private readonly logSessionEndCallbacks = new Set<LogSessionEndCallback>();
  private readonly loadCompleteCallbacks = new Set<LoadCompleteCallback>();
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
    this.statsCallbacks.add(callback);
    return () => this.statsCallbacks.delete(callback);
  }

  /** Subscribe to ring buffer data updates. New subscribers get the last cached update immediately. */
  onUpdate(callback: UpdateCallback): () => void {
    this.updateCallbacks.add(callback);
    if (this.lastUpdate) {
      callback(this.lastUpdate);
    }
    return () => this.updateCallbacks.delete(callback);
  }

  /** Subscribe to known field key updates. */
  onAvailableFields(callback: AvailableFieldsCallback): () => void {
    this.availableFieldsCallbacks.add(callback);
    return () => this.availableFieldsCallbacks.delete(callback);
  }

  /** Subscribe to connection status changes. */
  onStatusChange(callback: StatusCallback): () => void {
    this.statusCallbacks.add(callback);
    return () => this.statusCallbacks.delete(callback);
  }

  /** Subscribe to STATUSTEXT message events. */
  onStatusText(callback: StatusTextCallback): () => void {
    this.statustextCallbacks.add(callback);
    return () => this.statustextCallbacks.delete(callback);
  }

  onLogSessionStart(callback: LogSessionStartCallback): () => void {
    this.logSessionStartCallbacks.add(callback);
    return () => this.logSessionStartCallbacks.delete(callback);
  }

  onLogChunk(callback: LogChunkCallback): () => void {
    this.logChunkCallbacks.add(callback);
    return () => this.logChunkCallbacks.delete(callback);
  }

  onLogSessionEnd(callback: LogSessionEndCallback): () => void {
    this.logSessionEndCallbacks.add(callback);
    return () => this.logSessionEndCallbacks.delete(callback);
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
    this.loadCompleteCallbacks.add(callback);
    return () => this.loadCompleteCallbacks.delete(callback);
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
        for (const cb of this.statsCallbacks) {
          cb(statsMap);
        }
        break;
      }

      case 'update': {
        const buffersRecord = e.data.buffers as Record<string, { timestamps: Float64Array; values: Float64Array }>;
        const buffersMap = new Map(Object.entries(buffersRecord));
        this.lastUpdate = buffersMap;
        for (const cb of this.updateCallbacks) {
          cb(buffersMap);
        }
        break;
      }

      case 'availableFields': {
        const fields = e.data.fields as string[];
        for (const cb of this.availableFieldsCallbacks) {
          cb(fields);
        }
        break;
      }

      case 'statusChange': {
        const status = e.data.status as ConnectionStatus;
        if (status === 'disconnected') {
          this.lastUpdate = null;
        }
        for (const cb of this.statusCallbacks) {
          cb(status);
        }
        break;
      }

      case 'statustext': {
        const entry: StatusTextEntry = {
          severity: e.data.severity as number,
          text: e.data.text as string,
          timestamp: e.data.timestamp as number,
        };
        for (const cb of this.statustextCallbacks) {
          cb(entry);
        }
        break;
      }

      case 'logSessionStarted': {
        const meta: LogSessionStart = {
          sessionId: e.data.sessionId as string,
          startedAtMs: e.data.startedAtMs as number,
        };
        for (const cb of this.logSessionStartCallbacks) {
          cb(meta);
        }
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
        for (const cb of this.logChunkCallbacks) {
          cb(chunk);
        }
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
        for (const cb of this.logSessionEndCallbacks) {
          cb(meta);
        }
        break;
      }

      case 'loadComplete': {
        const statsRecord = e.data.stats as Record<string, MessageStats>;
        const statsMap = new Map<string, MessageStats>(Object.entries(statsRecord));
        const durationSec = e.data.durationSec as number;
        for (const cb of this.loadCompleteCallbacks) {
          cb({ stats: statsMap, durationSec });
        }
        break;
      }

      case 'error': {
        console.error('[MavlinkWorker]', e.data.message);
        break;
      }
    }
  }
}
