/**
 * Connection manager — main-thread facade for the UI.
 *
 * Delegates all MAVLink work to the Web Worker via MavlinkWorkerBridge.
 * Tracks connection status locally.
 */

import type { MavlinkWorkerBridge, ConnectionConfig, ConnectionStatus } from './worker-bridge';
import { WebSerialByteSource } from './webserial-byte-source';

type StatusCallback = (status: ConnectionStatus) => void;

export class ConnectionManager {
  private readonly bridge: MavlinkWorkerBridge;
  private readonly callbacks = new Set<StatusCallback>();
  private serialSource: WebSerialByteSource | null = null;
  private _status: ConnectionStatus = 'disconnected';
  private unsubBridgeStatus: (() => void) | null = null;

  constructor(bridge: MavlinkWorkerBridge) {
    this.bridge = bridge;

    // Forward status changes from worker
    this.unsubBridgeStatus = this.bridge.onStatusChange(status => {
      this._status = status;
      for (const cb of this.callbacks) {
        cb(status);
      }
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

      // Tell worker to set up ExternalByteSource pipeline
      this.bridge.connect(config);

      // Open serial port (triggers browser dialog)
      this.serialSource.connect().catch(() => {
        // User cancelled dialog or port error — disconnect
        this.bridge.disconnect();
        this.serialSource = null;
      });
    } else {
      this.bridge.connect(config);
    }
  }

  /** Disconnect and clean up. */
  disconnect(): void {
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
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /** Clean up subscriptions. */
  dispose(): void {
    this.unsubBridgeStatus?.();
    this.unsubBridgeStatus = null;
    this.callbacks.clear();
  }
}
