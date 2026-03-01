/**
 * Main-thread bridge to the MAVLink Web Worker.
 *
 * Provides a clean API for the UI to interact with the worker.
 * Translates postMessage calls into typed callbacks.
 */

import type { MessageStats } from './message-tracker';

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

export class MavlinkWorkerBridge {
  private worker: Worker;
  private readonly statsCallbacks = new Set<StatsCallback>();
  private readonly updateCallbacks = new Set<UpdateCallback>();
  private readonly availableFieldsCallbacks = new Set<AvailableFieldsCallback>();
  private readonly statusCallbacks = new Set<StatusCallback>();
  private readonly statustextCallbacks = new Set<StatusTextCallback>();
  private initResolve: (() => void) | null = null;

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
    this.worker.postMessage({ type: 'bytes', data }, [data.buffer]);
  }

  /** Subscribe to message stats updates. */
  onStats(callback: StatsCallback): () => void {
    this.statsCallbacks.add(callback);
    return () => this.statsCallbacks.delete(callback);
  }

  /** Subscribe to ring buffer data updates. */
  onUpdate(callback: UpdateCallback): () => void {
    this.updateCallbacks.add(callback);
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

  /** Set the field keys that should be streamed to the main thread. */
  setInterestedFields(fields: string[]): void {
    this.worker.postMessage({ type: 'setInterestedFields', fields });
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

      case 'error': {
        console.error('[MavlinkWorker]', e.data.message);
        break;
      }
    }
  }
}
