import type { Accessor, Setter } from 'solid-js';
import { EventEmitter } from '../core';
import type { ConnectionManager } from './connection-manager';
import type { LogViewerService } from './log-viewer-service';
import { saveSettingsDebounced, type MavDeckSettings } from './settings-service';
import type { MavlinkWorkerBridge } from './worker-bridge';
import type { BaudRate } from './baud-rates';
import type { SerialPortIdentity } from './serial-probe-service';
import { getSerialPortIdentity } from './serial-port-identity';
import { getSerialBackend, requestPort, type SerialBackend } from './serial-backend';
import { WebSerialByteSource } from './webserial-byte-source';

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

interface SuspendedLiveSessionSnapshot {
  phase: SessionPhase;
  sessionState: SessionStateSnapshot;
  pendingLiveSourceType: 'serial' | 'spoof' | null;
}

export type SessionPhase =
  | 'idle'
  | 'probing'
  | 'connecting_serial'
  | 'connected_serial'
  | 'connected_serial_idle'
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
  private isSuspendedForLogPlayback = false;
  private suspendedLiveSession: SuspendedLiveSessionSnapshot | null = null;
  private phase: SessionPhase = 'idle';
  private sessionState: SessionStateSnapshot = {
    sourceType: null,
    connectedBaudRate: null,
  };
  /** Polyfill byte source running on main thread (Android path). */
  private mainThreadSource: WebSerialByteSource | null = null;

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

  /** Which serial backend is available, or null if neither. */
  get backend(): SerialBackend | null {
    return getSerialBackend();
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

  get hasSuspendedLiveSession(): boolean {
    return this.suspendedLiveSession !== null;
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
    this.isSuspendedForLogPlayback = false;
    this.suspendedLiveSession = null;
    this.setPhase('idle');
    this.disconnectMainThreadSource();
    this.connectionManager.disconnect();
  }

  enterLogMode(): void {
    this.isSuspendedForLogPlayback = false;
    this.suspendedLiveSession = null;
    this.pendingLiveSourceType = null;
    this.setPhase('idle');
    this.connectionManager.disconnect();
    this.connectionManager.stopAutoConnect();
  }

  suspendForLogPlayback(): boolean {
    if (this.sessionState.sourceType !== 'serial') {
      this.enterLogMode();
      return false;
    }

    this.suspendedLiveSession = {
      phase: this.phase,
      sessionState: { ...this.sessionState },
      pendingLiveSourceType: this.pendingLiveSourceType,
    };
    this.isSuspendedForLogPlayback = true;
    this.workerBridge.suspendLiveForLog();
    return true;
  }

  resumeAfterLogPlayback(): void {
    if (!this.suspendedLiveSession) {
      return;
    }

    this.pendingLiveSourceType = this.suspendedLiveSession.pendingLiveSourceType;
    this.setSessionState(this.suspendedLiveSession.sessionState);
    this.setPhase(this.suspendedLiveSession.phase);
    this.isSuspendedForLogPlayback = true;
    this.workerBridge.resumeSuspendedLive();
  }

  async grantAccess(): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    try {
      await requestPort(backend);
      if (backend === 'native') {
        this.workerBridge.notifyPortsChanged();
      }
    } catch (e: unknown) {
      if (backend === 'webusb' && e instanceof DOMException && e.name === 'NotFoundError') {
        this.probeStatusEmitter.emit('No USB device selected — check Settings > USB Diagnostics');
      }
    }
  }

  async connectManual(options: ManualConnectOptions): Promise<void> {
    const backend = this.backend;
    if (!backend) return;

    this.prepareForLiveConnection(options.unloadLog === true);

    if (backend === 'native') {
      // Desktop: worker-side serial — request port, then tell the worker to open it
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
    } else {
      // Android polyfill: main-thread serial → forward bytes to worker's ExternalByteSource
      let port;
      try {
        port = await requestPort(backend);
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === 'NotFoundError') {
          this.probeStatusEmitter.emit('No USB device selected — check Settings > USB Diagnostics');
        }
        return;
      }

      this.pendingLiveSourceType = 'serial';
      this.setPhase('connecting_serial');

      const baudRate = options.autoDetectBaud
        ? (options.lastBaudRate ?? options.baudRate)
        : options.baudRate;

      const source = new WebSerialByteSource(baudRate, (data) => {
        this.workerBridge.sendBytes(data);
      }, () => {
        this.disconnectMainThreadSource();
        this.connectionManager.disconnect();
      });

      try {
        await source.connect(port);
      } catch {
        this.setPhase('error');
        return;
      }

      this.mainThreadSource = source;
      const portIdentity = getSerialPortIdentity(port);

      // Tell the worker to create an ExternalByteSource and start processing
      this.connectionManager.connect({ type: 'webserial', baudRate });
      // Emit serialConnected so the session controller picks up baud/identity
      this.setSessionState({ sourceType: 'serial', connectedBaudRate: baudRate as BaudRate });
      this.setPhase('connected_serial');
      this.serialConnectedEmitter.emit({ baudRate: baudRate as BaudRate, portIdentity });
    }
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
    if (this.isSuspendedForLogPlayback) {
      return;
    }
    if (this.phase === 'probing') {
      this.setPhase('idle');
    }
    this.connectionManager.stopAutoConnect();
  }

  async forgetAllPorts(): Promise<void> {
    this.pendingLiveSourceType = null;
    this.isSuspendedForLogPlayback = false;
    this.suspendedLiveSession = null;
    this.setPhase('idle');
    this.disconnectMainThreadSource();
    this.connectionManager.disconnect();
    this.connectionManager.stopAutoConnect();

    const backend = this.backend;
    if (backend === 'native') {
      const ports = await navigator.serial.getPorts();
      await Promise.all(ports.map(port => port.forget()));
    } else if (backend === 'webusb') {
      const devices = await navigator.usb.getDevices();
      await Promise.all(devices.map(device => device.forget()));
    }
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
    this.disconnectMainThreadSource();
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

  private disconnectMainThreadSource(): void {
    if (this.mainThreadSource) {
      this.mainThreadSource.disconnect().catch(() => {});
      this.mainThreadSource = null;
    }
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
      if (this.pendingLiveSourceType === 'serial' && this.sessionState.sourceType === 'serial') {
        this.setPhase('connected_serial');
      }
      if (this.pendingLiveSourceType === 'spoof') {
        this.setPhase('connected_spoof');
        this.setSessionState({ sourceType: 'spoof', connectedBaudRate: null });
      }
      if (this.sessionState.sourceType === 'serial') {
        this.isSuspendedForLogPlayback = false;
        this.suspendedLiveSession = null;
      }
      return;
    }

    if (status === 'no_data') {
      if (this.sessionState.sourceType === 'serial') {
        this.setPhase('connected_serial_idle');
        this.isSuspendedForLogPlayback = false;
        this.suspendedLiveSession = null;
      }
      return;
    }

    if (status === 'error') {
      this.isSuspendedForLogPlayback = false;
      this.suspendedLiveSession = null;
      this.pendingLiveSourceType = null;
      this.setPhase('error');
      this.setSessionState({ sourceType: null, connectedBaudRate: null });
      return;
    }

    if (status === 'disconnected') {
      this.isSuspendedForLogPlayback = false;
      this.suspendedLiveSession = null;
      this.pendingLiveSourceType = null;
      this.setPhase('idle');
      this.setSessionState({ sourceType: null, connectedBaudRate: null });
    }
  }
}
