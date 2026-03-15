import type { Accessor, Setter } from 'solid-js';
import { EventEmitter } from '../core';
import type { ConnectionManager } from './connection-manager';
import type { LogViewerService } from './log-viewer-service';
import { saveSettingsDebounced, type MavDeckSettings } from './settings-service';
import type { MavlinkWorkerBridge } from './worker-bridge';
import type { BaudRate } from './baud-rates';
import type { SerialPortIdentity } from './serial-probe-service';
import { getSerialPortIdentity } from './serial-port-identity';

export interface SerialSessionControllerConfig {
  connectionManager: ConnectionManager;
  workerBridge: MavlinkWorkerBridge;
  logViewerService?: LogViewerService;
}

export interface ManualConnectOptions {
  baudRate: BaudRate;
  autoDetectBaud: boolean;
  lastBaudRate: BaudRate | null;
  unloadLog?: boolean;
}

export interface AutoConnectOptions {
  enabled: boolean;
  autoBaud: boolean;
  manualBaudRate: BaudRate;
  lastPortIdentity: SerialPortIdentity | null;
  lastBaudRate: BaudRate | null;
}

export interface SessionStateSnapshot {
  sourceType: 'serial' | 'spoof' | null;
  connectedBaudRate: BaudRate | null;
}

export type SessionPhase =
  | 'idle'
  | 'probing'
  | 'connecting_serial'
  | 'connected_serial'
  | 'connected_spoof'
  | 'error';

type StatusCallback = Parameters<ConnectionManager['onStatusChange']>[0];
type ProbeStatusCallback = Parameters<MavlinkWorkerBridge['onProbeStatus']>[0];
type SerialConnectedCallback = Parameters<MavlinkWorkerBridge['onSerialConnected']>[0];
type SessionStateCallback = (state: SessionStateSnapshot) => void;
type PhaseCallback = (phase: SessionPhase) => void;

export class SerialSessionController {
  private readonly connectionManager: ConnectionManager;
  private readonly workerBridge: MavlinkWorkerBridge;
  private logViewerService: LogViewerService | null;
  private readonly statusEmitter = new EventEmitter<StatusCallback>();
  private readonly probeStatusEmitter = new EventEmitter<ProbeStatusCallback>();
  private readonly serialConnectedEmitter = new EventEmitter<SerialConnectedCallback>();
  private readonly sessionStateEmitter = new EventEmitter<SessionStateCallback>();
  private readonly phaseEmitter = new EventEmitter<PhaseCallback>();
  private unsubBridgeStatus: (() => void) | null = null;
  private unsubProbeStatus: (() => void) | null = null;
  private unsubSerialConnected: (() => void) | null = null;
  private pendingLiveSourceType: 'serial' | 'spoof' | null = null;
  private phase: SessionPhase = 'idle';
  private sessionState: SessionStateSnapshot = {
    sourceType: null,
    connectedBaudRate: null,
  };

  constructor(config: SerialSessionControllerConfig) {
    this.connectionManager = config.connectionManager;
    this.workerBridge = config.workerBridge;
    this.logViewerService = config.logViewerService ?? null;

    this.unsubBridgeStatus = this.connectionManager.onStatusChange(status => {
      this.handleStatusChange(status);

      this.statusEmitter.emit(status);
    });

    this.unsubProbeStatus = this.workerBridge.onProbeStatus(status => {
      this.probeStatusEmitter.emit(status);
    });

    this.unsubSerialConnected = this.workerBridge.onSerialConnected(info => {
      this.pendingLiveSourceType = 'serial';
      this.setPhase('connected_serial');
      this.setSessionState({ sourceType: 'serial', connectedBaudRate: info.baudRate });
      this.serialConnectedEmitter.emit(info);
    });
  }

  setLogViewerService(logViewerService: LogViewerService): void {
    this.logViewerService = logViewerService;
  }

  get status(): ConnectionManager['status'] {
    return this.connectionManager.status;
  }

  get currentSessionState(): SessionStateSnapshot {
    return this.sessionState;
  }

  get currentPhase(): SessionPhase {
    return this.phase;
  }

  onStatusChange(callback: StatusCallback): () => void {
    return this.statusEmitter.on(callback);
  }

  onProbeStatus(callback: ProbeStatusCallback): () => void {
    return this.probeStatusEmitter.on(callback);
  }

  onSerialConnected(callback: SerialConnectedCallback): () => void {
    return this.serialConnectedEmitter.on(callback);
  }

  onSessionStateChange(callback: SessionStateCallback): () => void {
    const unsub = this.sessionStateEmitter.on(callback);
    callback(this.sessionState);
    return unsub;
  }

  onPhaseChange(callback: PhaseCallback): () => void {
    const unsub = this.phaseEmitter.on(callback);
    callback(this.phase);
    return unsub;
  }

  disconnectLiveSession(): void {
    this.pendingLiveSourceType = null;
    this.setPhase('idle');
    this.connectionManager.disconnect();
  }

  enterLogMode(): void {
    this.pendingLiveSourceType = null;
    this.setPhase('idle');
    this.connectionManager.disconnect();
    this.connectionManager.stopAutoConnect();
  }

  async grantAccess(): Promise<void> {
    return navigator.serial.requestPort()
      .then(() => {
        this.workerBridge.notifyPortsChanged();
      })
      .catch(() => {});
  }

  async connectManual(options: ManualConnectOptions): Promise<void> {
    this.prepareForLiveConnection(options.unloadLog === true);

    let port: SerialPort;
    try {
      port = await navigator.serial.requestPort();
    } catch {
      return;
    }

    this.pendingLiveSourceType = 'serial';
    this.setPhase('connecting_serial');
    this.connectionManager.connect({
      type: 'webserial',
      baudRate: options.baudRate,
      autoDetectBaud: options.autoDetectBaud,
      portIdentity: getSerialPortIdentity(port),
      lastBaudRate: options.lastBaudRate,
    });
  }

  connectSpoof(options?: { unloadLog?: boolean }): void {
    this.prepareForLiveConnection(options?.unloadLog === true);
    this.pendingLiveSourceType = 'spoof';
    this.connectionManager.connect({ type: 'spoof' });
  }

  syncAutoConnect(options: AutoConnectOptions): void {
    if (!options.enabled) {
      this.stopAutoConnect();
      return;
    }

    if (this.phase !== 'idle' && this.phase !== 'error') {
      return;
    }

    this.setPhase('probing');
    this.connectionManager.startAutoConnect({
      autoBaud: options.autoBaud,
      manualBaudRate: options.manualBaudRate,
      lastPortIdentity: options.lastPortIdentity,
      lastBaudRate: options.lastBaudRate,
    });
  }

  stopAutoConnect(): void {
    if (this.phase === 'probing') {
      this.setPhase('idle');
    }
    this.connectionManager.stopAutoConnect();
  }

  async forgetAllPorts(): Promise<void> {
    this.pendingLiveSourceType = null;
    this.setPhase('idle');
    this.connectionManager.disconnect();
    this.connectionManager.stopAutoConnect();
    const ports = await navigator.serial.getPorts();
    await Promise.all(ports.map(port => port.forget()));
  }

  persistSerialSettings(
    info: { baudRate: BaudRate; portIdentity: SerialPortIdentity | null },
    loadedSettings: Accessor<MavDeckSettings>,
    setLoadedSettings: Setter<MavDeckSettings>,
    autoConnect: boolean,
    autoDetectBaud: boolean,
  ): void {
    const nextSettings: MavDeckSettings = {
      ...loadedSettings(),
      autoConnect,
      autoDetectBaud,
      lastPortVendorId: info.portIdentity?.usbVendorId ?? null,
      lastPortProductId: info.portIdentity?.usbProductId ?? null,
      lastSuccessfulBaudRate: info.baudRate,
    };
    saveSettingsDebounced(nextSettings);
    setLoadedSettings(nextSettings);
  }

  dispose(): void {
    this.unsubBridgeStatus?.();
    this.unsubProbeStatus?.();
    this.unsubSerialConnected?.();
    this.unsubBridgeStatus = null;
    this.unsubProbeStatus = null;
    this.unsubSerialConnected = null;
    this.statusEmitter.clear();
    this.probeStatusEmitter.clear();
    this.serialConnectedEmitter.clear();
    this.sessionStateEmitter.clear();
    this.phaseEmitter.clear();
  }

  private prepareForLiveConnection(unloadLog: boolean): void {
    if (unloadLog) {
      this.logViewerService?.unload();
    }
    this.connectionManager.stopAutoConnect();
    this.setSessionState({ sourceType: null, connectedBaudRate: null });
  }

  private setSessionState(state: SessionStateSnapshot): void {
    if (this.sessionState.sourceType === state.sourceType && this.sessionState.connectedBaudRate === state.connectedBaudRate) {
      return;
    }
    this.sessionState = state;
    this.sessionStateEmitter.emit(this.sessionState);
  }

  private setPhase(phase: SessionPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseEmitter.emit(phase);
  }

  private handleStatusChange(status: ConnectionManager['status']): void {
    if (status === 'probing') {
      this.setPhase('probing');
      return;
    }

    if (status === 'connected') {
      if (this.pendingLiveSourceType === 'spoof') {
        this.setPhase('connected_spoof');
        this.setSessionState({ sourceType: 'spoof', connectedBaudRate: null });
      }
      return;
    }

    if (status === 'error') {
      this.pendingLiveSourceType = null;
      this.setPhase('error');
      this.setSessionState({ sourceType: null, connectedBaudRate: null });
      return;
    }

    if (status === 'disconnected') {
      this.pendingLiveSourceType = null;
      this.setPhase('idle');
      this.setSessionState({ sourceType: null, connectedBaudRate: null });
    }
  }
}
