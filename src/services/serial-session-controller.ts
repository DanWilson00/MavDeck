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
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import { MavlinkDecodeVerifier } from './mavlink-decode-verifier';

export interface SerialSessionControllerConfig {
  connectionManager: ConnectionManager;
  workerBridge: MavlinkWorkerBridge;
  registry: MavlinkMetadataRegistry;
  logViewerService?: LogViewerService;
}

export interface ManualConnectOptions {
  baudRate: BaudRate;
  autoDetectBaud: boolean;
  lastBaudRate: BaudRate | null;
  unloadLog?: boolean;
}

export interface LiveReconnectOptions {
  baudRate: BaudRate;
  autoDetectBaud: boolean;
  lastBaudRate: BaudRate | null;
  lastPortIdentity: SerialPortIdentity | null;
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
  pendingSourceType: 'serial' | 'spoof' | null;
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
type WebUsbAvailabilityCallback = (state: WebUsbAvailability) => void;

const WEBUSB_WAITING_FOR_ACCESS_STATUS = 'Waiting for USB access...';
const WEBUSB_WAITING_FOR_DEVICE_STATUS = 'Waiting for USB device...';
const WEBUSB_REGRANT_ANDROID_STATUS = 'USB access must be granted again on Android';
const WEBUSB_RECONNECT_DELAY_MS = 1000;
const WEBUSB_EMPTY_POLLS_BEFORE_REGRANT = 2;

export type WebUsbAvailability = 'unknown' | 'needs_grant' | 'needs_regrant_android' | 'waiting_for_device' | 'granted';

export class SerialSessionController {
  private readonly connectionManager: ConnectionManager;
  private readonly workerBridge: MavlinkWorkerBridge;
  private readonly registry: MavlinkMetadataRegistry;
  private logViewerService: LogViewerService | null;
  private readonly statusEmitter = new EventEmitter<StatusCallback>();
  private readonly probeStatusEmitter = new EventEmitter<ProbeStatusCallback>();
  private readonly serialConnectedEmitter = new EventEmitter<SerialConnectedCallback>();
  private readonly sessionStateEmitter = new EventEmitter<SessionStateCallback>();
  private readonly phaseEmitter = new EventEmitter<PhaseCallback>();
  private readonly webusbAvailabilityEmitter = new EventEmitter<WebUsbAvailabilityCallback>();
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
    pendingSourceType: null,
  };
  /** Polyfill byte source running on main thread (Android path). */
  private mainThreadSource: WebSerialByteSource | null = null;
  /** Abort controller for WebUSB auto-connect probing. */
  private webusbAbort: AbortController | null = null;
  /** Last enabled Android WebUSB auto-connect config. */
  private webusbAutoConnectOptions: AutoConnectOptions | null = null;
  /** True while a disconnect is an intentional teardown and should not restart probing. */
  private suppressWebUsbReconnect = false;
  /** True while a user-initiated serial reconnect/retune is actively replacing the live session. */
  private manualSerialReconnectInProgress = false;
  private webusbAvailability: WebUsbAvailability = 'unknown';
  private lastProbeStatus: string | null = null;

  constructor(config: SerialSessionControllerConfig) {
    this.connectionManager = config.connectionManager;
    this.workerBridge = config.workerBridge;
    this.registry = config.registry;
    this.logViewerService = config.logViewerService ?? null;

    this.unsubBridgeStatus = this.connectionManager.onStatusChange(status => {
      this.handleStatusChange(status);

      this.statusEmitter.emit(status);
    });

    this.unsubProbeStatus = this.workerBridge.onProbeStatus(status => {
      this.setProbeStatus(status);
    });

    this.unsubSerialConnected = this.workerBridge.onSerialConnected(info => {
      this.setPendingLiveSourceType(null);
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

  get isManualSerialReconnectInProgress(): boolean {
    return this.manualSerialReconnectInProgress;
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

  onWebUsbAvailabilityChange(callback: WebUsbAvailabilityCallback): () => void {
    const unsub = this.webusbAvailabilityEmitter.on(callback);
    callback(this.webusbAvailability);
    return unsub;
  }

  disconnectLiveSession(): void {
    this.setPendingLiveSourceType(null);
    this.isSuspendedForLogPlayback = false;
    this.suspendedLiveSession = null;
    this.setPhase('idle');
    this.stopAutoConnectWebUsb();
    this.connectionManager.disconnect();
    void this.disconnectMainThreadSourceSuppressed();
  }

  enterLogMode(): void {
    this.isSuspendedForLogPlayback = false;
    this.suspendedLiveSession = null;
    this.setPendingLiveSourceType(null);
    this.setPhase('idle');
    this.stopAutoConnectWebUsb();
    this.connectionManager.disconnect();
    this.connectionManager.stopAutoConnect();
    void this.disconnectMainThreadSourceSuppressed();
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
    this.syncPendingSourceType();
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
      if (backend === 'webusb') {
        this.setWebUsbAvailability('granted');
        this.setProbeStatus(null);
      }
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

      this.setPendingLiveSourceType('serial');
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
      this.connectionManager.disconnect();
      await this.disconnectMainThreadSourceSuppressed();
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
        this.setPendingLiveSourceType('serial');
        this.setPhase('probing');
        const baudList = this.buildBaudList(options.lastBaudRate);
        const abort = new AbortController();
        this.webusbAbort = abort;
        await this.probeAndConnectWebUsb(port, baudList, abort.signal);
      } else {
        // Fixed baud: connect immediately
        this.setPendingLiveSourceType('serial');
        this.setPhase('connecting_serial');
        this.setProbeStatus(`Verifying live connection at ${options.baudRate} baud...`);
        const connected = await this.connectWebUsbAtBaud(port, options.baudRate, { verifyBeforeConnect: true });
        if (!connected) {
          this.setPhase('error');
          this.setProbeStatus(`No MAVLink traffic verified at ${options.baudRate} baud`);
        }
      }
    }
  }

  async reconnectLiveSerial(options: LiveReconnectOptions): Promise<void> {
    if (this.sessionState.sourceType !== 'serial') {
      return;
    }

    const backend = this.backend;
    if (!backend) return;

    this.prepareForLiveConnection(false);
    this.setPendingLiveSourceType('serial');
    this.manualSerialReconnectInProgress = true;

    try {
      if (backend === 'native') {
        if (!options.lastPortIdentity) {
          this.setPhase('error');
          return;
        }

        this.setPhase(options.autoDetectBaud ? 'probing' : 'connecting_serial');
        this.connectionManager.disconnect();
        this.connectionManager.connect({
          type: 'webserial',
          baudRate: options.baudRate,
          autoDetectBaud: options.autoDetectBaud,
          portIdentity: options.lastPortIdentity,
          lastBaudRate: options.lastBaudRate,
        });
        return;
      }

      if (this.webusbAutoConnectOptions) {
        this.webusbAutoConnectOptions = {
          ...this.webusbAutoConnectOptions,
          autoBaud: options.autoDetectBaud,
          manualBaudRate: options.baudRate,
          lastPortIdentity: options.lastPortIdentity,
          lastBaudRate: options.lastBaudRate,
        };
      }

      this.connectionManager.disconnect();
      await this.disconnectMainThreadSourceSuppressed();

      const ports = await getGrantedPorts('webusb');
      const port = options.lastPortIdentity
        ? ports.find(candidate => matchesSerialPortIdentity(candidate, options.lastPortIdentity!))
        : ports[0];

      if (!port) {
        this.setPhase('error');
        return;
      }

      if (options.autoDetectBaud) {
        this.setPhase('probing');
        const abort = new AbortController();
        this.webusbAbort = abort;
        await this.probeAndConnectWebUsb(port, this.buildBaudList(options.lastBaudRate), abort.signal);
        return;
      }

      this.setPhase('connecting_serial');
      this.setProbeStatus(`Verifying live connection at ${options.baudRate} baud...`);
      const connected = await this.connectWebUsbAtBaud(port, options.baudRate, { verifyBeforeConnect: true });
      if (!connected) {
        this.setPhase('error');
        this.setProbeStatus(`No MAVLink traffic verified at ${options.baudRate} baud`);
      }
    } finally {
      this.manualSerialReconnectInProgress = false;
    }
  }

  connectSpoof(options?: { unloadLog?: boolean }): void {
    this.prepareForLiveConnection(options?.unloadLog === true);
    this.setPendingLiveSourceType('spoof');
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
    this.setPendingLiveSourceType(null);
    this.isSuspendedForLogPlayback = false;
    this.suspendedLiveSession = null;
    this.setPhase('idle');
    this.stopAutoConnectWebUsb();
    this.connectionManager.disconnect();
    this.connectionManager.stopAutoConnect();
    await this.disconnectMainThreadSourceSuppressed();

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
      lastPortSerialNumber: info.portIdentity?.usbSerialNumber ?? null,
      lastSuccessfulBaudRate: info.baudRate,
    };
    saveSettingsDebounced(nextSettings);
    setLoadedSettings(nextSettings);
  }

  dispose(): void {
    this.stopAutoConnectWebUsb();
    void this.disconnectMainThreadSourceSuppressed();
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
      this.webusbAutoConnectOptions = null;
      this.setWebUsbAvailability('unknown');
      this.setProbeStatus(null);
      this.stopAutoConnectWebUsb();
      return;
    }

    this.webusbAutoConnectOptions = { ...options };

    if (this.phase !== 'idle' && this.phase !== 'error') {
      return;
    }

    this.startAutoConnectWebUsbLoop();
  }

  /** Stop WebUSB auto-connect probing. */
  stopAutoConnectWebUsb(): void {
    this.webusbAbort?.abort();
    this.webusbAbort = null;
    if (this.phase === 'probing') {
      this.setPhase('idle');
    }
  }

  private startAutoConnectWebUsbLoop(): void {
    const options = this.webusbAutoConnectOptions;
    if (!options || (this.phase !== 'idle' && this.phase !== 'error')) {
      return;
    }

    this.stopAutoConnectWebUsb();
    this.setPhase('probing');
    const abort = new AbortController();
    this.webusbAbort = abort;
    const baudList = options.autoBaud
      ? this.buildBaudList(options.lastBaudRate)
      : [options.manualBaudRate];

    void this.autoConnectWebUsbLoop(options, baudList, abort.signal);
  }

  private async autoConnectWebUsbLoop(
    options: AutoConnectOptions,
    baudList: BaudRate[],
    signal: AbortSignal,
  ): Promise<void> {
    let emptyPolls = 0;

    while (!signal.aborted) {
      let ports: PortLike[];
      try {
        ports = await getGrantedPorts('webusb');
      } catch {
        ports = [];
      }

      if (signal.aborted) return;

      if (ports.length > 0) {
        emptyPolls = 0;
        this.setWebUsbAvailability('granted');
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
        emptyPolls++;
        const availability = this.getMissingWebUsbAvailability(options, emptyPolls);
        this.emitWebUsbAvailabilityStatus(availability);
      }

      if (signal.aborted) return;

      // Wait for USB reconnect or retry after delay
      const usbConnected = await this.waitForUsbOrTimeout(3000, signal);
      if (signal.aborted) return;
      if (!usbConnected && !this.mainThreadSource) {
        const availability = this.getMissingWebUsbAvailability(options, emptyPolls);
        this.emitWebUsbAvailabilityStatus(availability);
      }
    }
  }

  /**
   * Probe a WebUSB port across baud rates using full MAVLink CRC validation plus decode.
   * On success, establishes the full connection pipeline. Returns true if connected.
   */
  private async probeAndConnectWebUsb(
    port: PortLike,
    baudRates: BaudRate[],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (baudRates.length === 0) return false;

    for (const rate of baudRates) {
      if (signal.aborted) break;
      const label = `Trying ${rate} baud...`;
      console.log(`[WebUSB probe] ${label}`);
      this.setProbeStatus(label);

      const found = await this.probeWebUsbAtBaud(port, rate, signal);
      if (found) {
        console.log(`[WebUSB probe] MAVLink detected at ${rate} baud`);
        this.setProbeStatus(`Verifying live connection at ${rate} baud...`);
        const connected = await this.connectWebUsbAtBaud(port, rate, { verifyBeforeConnect: true });
        if (connected) {
          return true;
        }
      }
    }

    if (!signal.aborted) {
      this.setProbeStatus('No MAVLink device detected');
    }
    return false;
  }

  private async probeWebUsbAtBaud(
    port: PortLike,
    baudRate: BaudRate,
    signal: AbortSignal,
  ): Promise<boolean> {
    const verifier = new MavlinkDecodeVerifier(this.registry);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let settled = false;
    let openSucceeded = false;

    try {
      await port.open({ baudRate });
      openSucceeded = true;
      if (!port.readable) {
        return false;
      }

      reader = port.readable.getReader();

      return await new Promise<boolean>((resolve) => {
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          verifier.dispose();
          resolve(value);
        };

        void (async () => {
          try {
            const verified = verifier.waitForDecodedPacket({
              signal,
              timeoutMs: PROBE_TIMEOUT_MS,
            }).then(finish);

            while (!settled) {
              const { value, done } = await reader!.read();
              if (done || settled) break;
              if (value) {
                verifier.parse(value);
              }
            }
            await verified;
          } catch {
            // Read error — treat as probe failure for this baud
            finish(false);
          }
        })();
      });
    } catch (e) {
      console.warn(`[WebUSB probe] Port open failed at ${baudRate}: ${e instanceof Error ? e.message : e}`);
      return false;
    } finally {
      try {
        if (reader) {
          await reader.cancel();
          reader.releaseLock();
        }
      } catch {
        // Reader may already be closed
      }
      if (openSucceeded) {
        try { await port.close(); } catch { /* */ }
      }
    }
  }

  /** Open a WebUSB port at a known baud rate and wire up the full pipeline. */
  private async connectWebUsbAtBaud(
    port: PortLike,
    baudRate: BaudRate,
    options?: { verifyBeforeConnect?: boolean },
  ): Promise<boolean> {
    let forwardingEnabled = options?.verifyBeforeConnect !== true;
    const verifier = new MavlinkDecodeVerifier(this.registry);
    let verifyResolve: ((value: boolean) => void) | null = null;

    const source = new WebSerialByteSource(baudRate, (data) => {
      if (forwardingEnabled) {
        this.workerBridge.sendBytes(data);
      } else {
        verifier.parse(data);
      }
    }, () => {
      if (forwardingEnabled) {
        this.handleWebUsbTransportDisconnect();
      } else {
        verifyResolve?.(false);
        verifyResolve = null;
      }
    });

    try {
      await source.connect(port);
    } catch (error) {
      verifier.dispose();
      const needsRegrant = this.shouldRequireWebUsbRegrantOnError(error);
      if (needsRegrant) {
        this.emitWebUsbAvailabilityStatus('needs_regrant_android');
      } else {
        this.setWebUsbAvailability('granted');
      }
      this.setPhase('error');
      return false;
    }

    if (options?.verifyBeforeConnect) {
      const verified = await Promise.race([
        verifier.waitForDecodedPacket({ timeoutMs: PROBE_TIMEOUT_MS }).then((matched) => {
          if (matched) {
            forwardingEnabled = true;
          }
          return matched;
        }),
        new Promise<boolean>((resolve) => {
          verifyResolve = resolve;
        }),
      ]);
      verifyResolve = null;

      if (!verified) {
        verifier.dispose();
        await source.disconnect();
        return false;
      }
    }

    verifier.dispose();
    this.mainThreadSource = source;
    const portIdentity = getSerialPortIdentity(port);
    this.setWebUsbAvailability('granted');
    this.setProbeStatus(null);

    // Tell the worker to create an ExternalByteSource and start processing
    this.connectionManager.connect({ type: 'webserial', baudRate });
    this.setSessionState({ sourceType: 'serial', connectedBaudRate: baudRate });
    this.setPhase('connected_serial');
    this.serialConnectedEmitter.emit({ baudRate, portIdentity });
    return true;
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

  private async disconnectMainThreadSource(): Promise<void> {
    if (!this.mainThreadSource) {
      return;
    }

    const source = this.mainThreadSource;
    this.mainThreadSource = null;
    try {
      await source.disconnect();
    } catch {
      // Ignore teardown errors while resetting transport state
    }
  }

  private async disconnectMainThreadSourceSuppressed(): Promise<void> {
    this.suppressWebUsbReconnect = true;
    try {
      await this.disconnectMainThreadSource();
    } finally {
      this.suppressWebUsbReconnect = false;
    }
  }

  private handleWebUsbTransportDisconnect(): void {
    const shouldRestart = this.webusbAutoConnectOptions?.enabled === true && !this.suppressWebUsbReconnect;

    void this.disconnectMainThreadSource();
    this.setPendingLiveSourceType(null);
    this.connectionManager.disconnect();

    if (!shouldRestart) {
      return;
    }

    this.setPhase('idle');
    this.setSessionState({ sourceType: null, connectedBaudRate: null });

    if (!this.canWaitForWebUsbReconnect(this.webusbAutoConnectOptions)) {
      this.emitWebUsbAvailabilityStatus('needs_regrant_android');
      return;
    }

    this.emitWebUsbAvailabilityStatus('waiting_for_device');

    setTimeout(() => {
      if (this.mainThreadSource || this.phase !== 'idle') {
        return;
      }
      this.startAutoConnectWebUsbLoop();
    }, WEBUSB_RECONNECT_DELAY_MS);
  }

  private prepareForLiveConnection(unloadLog: boolean): void {
    if (unloadLog) {
      this.logViewerService?.unload();
    }
    this.stopAutoConnectWebUsb();
    this.connectionManager.stopAutoConnect();
    this.setSessionState({ sourceType: null, connectedBaudRate: null });
  }

  private setSessionState(state: Omit<SessionStateSnapshot, 'pendingSourceType'>): void {
    const nextState: SessionStateSnapshot = {
      ...state,
      pendingSourceType: this.pendingLiveSourceType,
    };
    if (
      this.sessionState.sourceType === nextState.sourceType
      && this.sessionState.connectedBaudRate === nextState.connectedBaudRate
      && this.sessionState.pendingSourceType === nextState.pendingSourceType
    ) {
      return;
    }
    this.sessionState = nextState;
    this.sessionStateEmitter.emit(this.sessionState);
  }

  private setPendingLiveSourceType(type: 'serial' | 'spoof' | null): void {
    if (this.pendingLiveSourceType === type) return;
    this.pendingLiveSourceType = type;
    this.syncPendingSourceType();
  }

  private syncPendingSourceType(): void {
    if (this.sessionState.pendingSourceType === this.pendingLiveSourceType) return;
    this.sessionState = {
      ...this.sessionState,
      pendingSourceType: this.pendingLiveSourceType,
    };
    this.sessionStateEmitter.emit(this.sessionState);
  }

  private setPhase(phase: SessionPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseEmitter.emit(phase);
  }

  private setWebUsbAvailability(state: WebUsbAvailability): void {
    if (this.webusbAvailability === state) return;
    this.webusbAvailability = state;
    this.webusbAvailabilityEmitter.emit(state);
  }

  private canWaitForWebUsbReconnect(options: AutoConnectOptions | null): boolean {
    return options?.lastPortIdentity?.usbSerialNumber != null;
  }

  private shouldRequireWebUsbRegrantOnError(error: unknown): boolean {
    if (!(error instanceof DOMException)) {
      return false;
    }
    return error.name === 'SecurityError'
      || error.name === 'NetworkError'
      || error.name === 'NotFoundError'
      || error.name === 'InvalidStateError';
  }

  private getMissingWebUsbAvailability(
    options: AutoConnectOptions,
    emptyPolls: number,
  ): WebUsbAvailability {
    if (!options.lastPortIdentity) {
      return 'needs_grant';
    }

    if (!this.canWaitForWebUsbReconnect(options)) {
      return 'needs_regrant_android';
    }

    if (emptyPolls >= WEBUSB_EMPTY_POLLS_BEFORE_REGRANT) {
      return 'needs_regrant_android';
    }

    return 'waiting_for_device';
  }

  private emitWebUsbAvailabilityStatus(availability: WebUsbAvailability): void {
    this.setWebUsbAvailability(availability);

    if (availability === 'needs_grant') {
      this.setProbeStatus(WEBUSB_WAITING_FOR_ACCESS_STATUS);
      return;
    }

    if (availability === 'needs_regrant_android') {
      this.setProbeStatus(WEBUSB_REGRANT_ANDROID_STATUS);
      return;
    }

    if (availability === 'waiting_for_device') {
      this.setProbeStatus(WEBUSB_WAITING_FOR_DEVICE_STATUS);
    }
  }

  private setProbeStatus(status: string | null): void {
    if (this.lastProbeStatus === status) {
      return;
    }
    this.lastProbeStatus = status;
    this.probeStatusEmitter.emit(status);
  }

  private handleStatusChange(status: ConnectionManager['status']): void {
    if (status === 'probing') {
      this.setPhase('probing');
      return;
    }

    if (status === 'connected') {
      if (this.pendingLiveSourceType === 'serial' && this.sessionState.sourceType === 'serial') {
        this.setPendingLiveSourceType(null);
        this.setPhase('connected_serial');
      }
      if (this.pendingLiveSourceType === 'spoof') {
        this.setPhase('connected_spoof');
        this.pendingLiveSourceType = null;
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
      this.setPendingLiveSourceType(null);
      this.setPhase('error');
      this.setSessionState({ sourceType: null, connectedBaudRate: null });
      return;
    }

    if (status === 'disconnected') {
      if (this.manualSerialReconnectInProgress) {
        return;
      }
      this.isSuspendedForLogPlayback = false;
      this.suspendedLiveSession = null;
      this.setPendingLiveSourceType(null);
      this.setPhase('idle');
      this.setSessionState({ sourceType: null, connectedBaudRate: null });
    }
  }
}
