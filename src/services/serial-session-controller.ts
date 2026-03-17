import type { Accessor, Setter } from 'solid-js';
import { EventEmitter } from '../core';
import type { ConnectionManager } from './connection-manager';
import type { LogViewerService } from './log-viewer-service';
import { saveSettingsDebounced, type MavDeckSettings } from './settings-service';
import type { MavlinkWorkerBridge } from './worker-bridge';
import { BAUD_PROBE_ORDER, PROBE_TIMEOUT_MS, type BaudRate } from './baud-rates';
import type { SerialPortIdentity } from './serial-probe-service';
import { getSerialPortIdentity, matchesSerialPortIdentity } from './serial-port-identity';
import { getSerialBackend, getGrantedPorts, requestPort, type PortLike, type SerialBackend } from './serial-backend';
import { WebSerialByteSource } from './webserial-byte-source';
import { MavlinkFrameDetector } from './mavlink-frame-detector';

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
  /** Abort controller for WebUSB auto-connect probing. */
  private webusbAbort: AbortController | null = null;
  /** Cleanup function for USB connect event listener. */
  private usbConnectCleanup: (() => void) | null = null;

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
    this.stopAutoConnectWebUsb();
    this.disconnectMainThreadSource();
    this.connectionManager.disconnect();
  }

  enterLogMode(): void {
    this.isSuspendedForLogPlayback = false;
    this.suspendedLiveSession = null;
    this.pendingLiveSourceType = null;
    this.setPhase('idle');
    this.stopAutoConnectWebUsb();
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
        // User cancelled the picker — no message needed
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
      let port: PortLike;
      try {
        port = await requestPort(backend);
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === 'NotFoundError') {
          // User cancelled the picker — no message needed
        }
        return;
      }

      if (options.autoDetectBaud) {
        // Auto-baud: probe for MAVLink frames at each baud rate
        this.pendingLiveSourceType = 'serial';
        this.setPhase('probing');
        const baudList = this.buildBaudList(options.lastBaudRate);
        const abort = new AbortController();
        this.webusbAbort = abort;
        await this.probeAndConnectWebUsb(port, baudList, abort.signal);
      } else {
        // Fixed baud: connect immediately
        this.pendingLiveSourceType = 'serial';
        this.setPhase('connecting_serial');
        await this.connectWebUsbAtBaud(port, options.baudRate);
      }
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
    this.stopAutoConnectWebUsb();
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
    this.stopAutoConnectWebUsb();
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

  // ── WebUSB auto-connect (Android) ──────────────────────────────────────────

  /**
   * Start auto-connect for WebUSB backend (Android).
   * Looks for granted FTDI ports and probes for MAVLink traffic.
   */
  syncAutoConnectWebUsb(options: AutoConnectOptions): void {
    if (!options.enabled) {
      this.stopAutoConnectWebUsb();
      return;
    }

    if (this.phase !== 'idle' && this.phase !== 'error') {
      return;
    }

    this.setPhase('probing');
    const abort = new AbortController();
    this.webusbAbort = abort;
    const baudList = this.buildBaudList(options.lastBaudRate);

    this.autoConnectWebUsbLoop(options, baudList, abort.signal);
  }

  /** Stop WebUSB auto-connect probing. */
  stopAutoConnectWebUsb(): void {
    this.webusbAbort?.abort();
    this.webusbAbort = null;
    this.usbConnectCleanup?.();
    this.usbConnectCleanup = null;
    if (this.phase === 'probing') {
      this.setPhase('idle');
    }
  }

  private async autoConnectWebUsbLoop(
    options: AutoConnectOptions,
    baudList: BaudRate[],
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      let ports: PortLike[];
      try {
        ports = await getGrantedPorts('webusb');
      } catch {
        ports = [];
      }

      if (signal.aborted) return;

      if (ports.length > 0) {
        // Sort so last-working port is tried first
        if (options.lastPortIdentity) {
          const identity = options.lastPortIdentity;
          ports.sort((a, b) => {
            const aMatch = matchesSerialPortIdentity(a, identity) ? -1 : 0;
            const bMatch = matchesSerialPortIdentity(b, identity) ? -1 : 0;
            return aMatch - bMatch;
          });
        }

        for (const port of ports) {
          if (signal.aborted) return;
          const success = await this.probeAndConnectWebUsb(port, baudList, signal);
          if (success) return; // Connected!
        }
      } else {
        this.probeStatusEmitter.emit('Waiting for USB device...');
      }

      if (signal.aborted) return;

      // Wait for USB reconnect or retry after delay
      const usbConnected = await this.waitForUsbOrTimeout(3000, signal);
      if (signal.aborted) return;
      if (usbConnected) {
        this.probeStatusEmitter.emit('USB device connected, probing...');
      }
    }
  }

  /**
   * Probe a WebUSB port across baud rates using MavlinkFrameDetector.
   * On success, establishes the full connection pipeline. Returns true if connected.
   */
  private async probeAndConnectWebUsb(
    port: PortLike,
    baudRates: BaudRate[],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (baudRates.length === 0) return false;

    const detector = new MavlinkFrameDetector();
    let detected = false;
    let detectedBaud: BaudRate = baudRates[0];

    // Open port at first baud rate
    try {
      await port.open({ baudRate: baudRates[0] });
    } catch (e) {
      console.warn(`[WebUSB probe] Port open failed: ${e instanceof Error ? e.message : e}`);
      return false;
    }

    if (!port.readable) {
      try { await port.close(); } catch { /* */ }
      return false;
    }

    // Read loop — feed bytes to detector
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let readingDone = false;

    const startReading = () => {
      reader = port.readable!.getReader();
      const loop = async () => {
        try {
          while (!readingDone) {
            const { value, done } = await reader!.read();
            if (done || readingDone) break;
            if (value && detector.feed(value)) {
              detected = true;
              readingDone = true;
            }
          }
        } catch {
          // Read error — port disconnected or closed
        }
      };
      loop();
    };

    startReading();

    // Try each baud rate
    for (let i = 0; i < baudRates.length; i++) {
      if (signal.aborted || detected) break;
      const rate = baudRates[i];

      if (i > 0) {
        // Change baud rate without close/reopen
        if (port.setBaudRate) {
          try {
            await port.setBaudRate(rate);
          } catch (e) {
            console.warn(`[WebUSB probe] setBaudRate failed: ${e instanceof Error ? e.message : e}`);
            continue;
          }
        } else {
          // Fallback: close and reopen (shouldn't happen for FTDI)
          break;
        }
        detector.reset();
      }

      const label = `Trying ${rate} baud...`;
      console.log(`[WebUSB probe] ${label}`);
      this.probeStatusEmitter.emit(label);

      // Wait for detection or timeout
      const found = await new Promise<boolean>((resolve) => {
        if (detected) { resolve(true); return; }

        const timer = setTimeout(() => {
          resolve(false);
        }, PROBE_TIMEOUT_MS);

        const checkInterval = setInterval(() => {
          if (detected || signal.aborted) {
            clearTimeout(timer);
            clearInterval(checkInterval);
            resolve(detected);
          }
        }, 50);

        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          clearInterval(checkInterval);
          resolve(false);
        }, { once: true });
      });

      if (found) {
        detectedBaud = rate;
        break;
      }
    }

    // Stop reading
    readingDone = true;
    try {
      if (reader) {
        await reader.cancel();
        reader.releaseLock();
      }
    } catch { /* */ }

    if (!detected || signal.aborted) {
      try { await port.close(); } catch { /* */ }
      if (!signal.aborted) {
        this.probeStatusEmitter.emit('No MAVLink device detected');
      }
      return false;
    }

    // Close and reconnect properly through the standard pipeline
    try { await port.close(); } catch { /* */ }

    console.log(`[WebUSB probe] MAVLink detected at ${detectedBaud} baud`);
    await this.connectWebUsbAtBaud(port, detectedBaud);
    return true;
  }

  /** Open a WebUSB port at a known baud rate and wire up the full pipeline. */
  private async connectWebUsbAtBaud(port: PortLike, baudRate: BaudRate): Promise<void> {
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
    this.setSessionState({ sourceType: 'serial', connectedBaudRate: baudRate });
    this.setPhase('connected_serial');
    this.serialConnectedEmitter.emit({ baudRate, portIdentity });
  }

  /** Build prioritized baud rate list: last successful first, then probe order. */
  private buildBaudList(lastBaudRate: BaudRate | null): BaudRate[] {
    const rates: BaudRate[] = [];
    if (lastBaudRate) {
      rates.push(lastBaudRate);
    }
    for (const rate of BAUD_PROBE_ORDER) {
      if (!rates.includes(rate)) {
        rates.push(rate);
      }
    }
    return rates;
  }

  /** Wait for a USB connect event or a timeout. Returns true if a USB device connected. */
  private waitForUsbOrTimeout(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal.aborted) { resolve(false); return; }

      let settled = false;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const timer = setTimeout(() => settle(false), ms);

      const onConnect = () => settle(true);
      const onAbort = () => settle(false);

      // Only attach if WebUSB is available
      if (typeof navigator !== 'undefined' && 'usb' in navigator) {
        navigator.usb.addEventListener('connect', onConnect, { once: true });
      }
      signal.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timer);
        if (typeof navigator !== 'undefined' && 'usb' in navigator) {
          navigator.usb.removeEventListener('connect', onConnect);
        }
        signal.removeEventListener('abort', onAbort);
      };
    });
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
