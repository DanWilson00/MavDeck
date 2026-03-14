/**
 * Connection manager — main-thread facade for the UI.
 *
 * Delegates all MAVLink work to the Web Worker via MavlinkWorkerBridge.
 * Tracks connection status locally.
 */

import { EventEmitter } from '../core';
import type { MavlinkWorkerBridge, ConnectionConfig, ConnectionStatus } from './worker-bridge';
import type { BaudRate } from './baud-rates';
import type { SerialPortIdentity } from './serial-probe-service';

/** Serial connection config for manual connect via user gesture. */
export interface WebSerialConnectConfig {
  type: 'webserial';
  baudRate: BaudRate;
  autoDetectBaud: boolean;
  portIdentity: SerialPortIdentity | null;
  lastBaudRate: BaudRate | null;
}

/** Auto-connect configuration. */
export interface AutoConnectStartConfig {
  autoBaud: boolean;
  manualBaudRate: BaudRate;
  lastPortIdentity: SerialPortIdentity | null;
  lastBaudRate: BaudRate | null;
}

type StatusCallback = (status: ConnectionStatus) => void;

export class ConnectionManager {
  private readonly bridge: MavlinkWorkerBridge;
  private readonly statusChange = new EventEmitter<StatusCallback>();
  private _status: ConnectionStatus = 'disconnected';
  private unsubBridgeStatus: (() => void) | null = null;
  private _autoConnectActive = false;

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
  connect(config: ConnectionConfig | WebSerialConnectConfig): void {
    if (this._status === 'connected' || this._status === 'connecting') {
      this.disconnect();
    }

    if (config.type === 'webserial' && 'autoDetectBaud' in config) {
      // Worker-side serial connect
      this.bridge.connectSerial({
        baudRate: config.baudRate,
        autoDetectBaud: config.autoDetectBaud,
        portIdentity: config.portIdentity,
        lastBaudRate: config.lastBaudRate,
      });
    } else {
      this.bridge.connect(config as ConnectionConfig);
    }
  }

  /** Disconnect and clean up. */
  disconnect(): void {
    this.bridge.stopAutoConnect();
    this._autoConnectActive = false;
    this.bridge.disconnect();
  }

  /** Start auto-connect probing (delegated to worker). */
  startAutoConnect(config: AutoConnectStartConfig): void {
    this._autoConnectActive = true;
    this.bridge.startAutoConnect(config);
  }

  /** Stop auto-connect probing. */
  stopAutoConnect(): void {
    this._autoConnectActive = false;
    this.bridge.stopAutoConnect();

    if (this._status === 'probing') {
      this._status = 'disconnected';
      this.statusChange.emit('disconnected');
    }
  }

  /** Whether auto-connect is active. */
  get isAutoConnectActive(): boolean {
    return this._autoConnectActive;
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
