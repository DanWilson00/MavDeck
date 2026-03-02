/**
 * Connection manager — main-thread facade for the UI.
 *
 * Delegates all MAVLink work to the Web Worker via MavlinkWorkerBridge.
 * Tracks connection status locally.
 */

import { EventEmitter } from '../core/event-emitter';
import type { MavlinkWorkerBridge, ConnectionConfig, ConnectionStatus } from './worker-bridge';
import { WebSerialByteSource } from './webserial-byte-source';

type StatusCallback = (status: ConnectionStatus) => void;

export class ConnectionManager {
  private readonly bridge: MavlinkWorkerBridge;
  private readonly statusChange = new EventEmitter<StatusCallback>();
  private serialSource: WebSerialByteSource | null = null;
  private _status: ConnectionStatus = 'disconnected';
  private unsubBridgeStatus: (() => void) | null = null;

  constructor(bridge: MavlinkWorkerBridge) {
    this.bridge = bridge;

    // Forward status changes from worker
    this.unsubBridgeStatus = this.bridge.onStatusChange(status => {
      this._status = status;
      this.statusChange.emit(status);
    });
  }

  /** Current connection status. */
  get status(): ConnectionStatus {
    return this._status;
  }

  /** Connect with the given configuration. Disconnects first if already connected. */
  connect(config: ConnectionConfig): void {
    if (this._status === 'connected' || this._status === 'connecting') {
      this.disconnect();
    }

    if (config.type === 'webserial') {
      // Web Serial reads on main thread, forwards bytes to worker
      this.serialSource = new WebSerialByteSource(config.baudRate, (data) => {
        this.bridge.sendBytes(data);
      });

      // Open serial port first (triggers browser dialog), then set up worker pipeline.
      // This order prevents a false "connected" flash if the user cancels the dialog.
      this.serialSource.connect().then(() => {
        this.bridge.connect(config);
      }).catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotFoundError') {
          // User cancelled port picker — expected, no action needed
        } else {
          console.error('[ConnectionManager] Serial connect failed:', err);
        }
        this.serialSource = null;
      });
    } else {
      this.bridge.connect(config);
    }
  }

  /** Disconnect and clean up. Serial port cleanup is fire-and-forget (async). */
  disconnect(): void {
    // Serial cleanup is async but fire-and-forget is safe here:
    // WebSerialByteSource.disconnect() has internal try/catch for all async ops.
    this.serialSource?.disconnect();
    this.serialSource = null;
    this.bridge.disconnect();
  }

  /** Pause message processing. */
  pause(): void {
    this.bridge.pause();
  }

  /** Resume message processing. */
  resume(): void {
    this.bridge.resume();
  }

  /** Subscribe to status changes. Returns unsubscribe function. */
  onStatusChange(callback: StatusCallback): () => void {
    return this.statusChange.on(callback);
  }

  /** Clean up subscriptions. */
  dispose(): void {
    this.unsubBridgeStatus?.();
    this.unsubBridgeStatus = null;
    this.statusChange.clear();
  }
}
