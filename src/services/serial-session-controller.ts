import type { Accessor, Setter } from 'solid-js';
import type { ConnectionManager } from './connection-manager';
import type { LogViewerService } from './log-viewer-service';
import { saveSettingsDebounced, type MavDeckSettings } from './settings-service';
import type { MavlinkWorkerBridge } from './worker-bridge';
import type { BaudRate } from './baud-rates';
import type { SerialPortIdentity } from './serial-probe-service';

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

export class SerialSessionController {
  private readonly connectionManager: ConnectionManager;
  private readonly workerBridge: MavlinkWorkerBridge;
  private logViewerService: LogViewerService | null;

  constructor(config: SerialSessionControllerConfig) {
    this.connectionManager = config.connectionManager;
    this.workerBridge = config.workerBridge;
    this.logViewerService = config.logViewerService ?? null;
  }

  setLogViewerService(logViewerService: LogViewerService): void {
    this.logViewerService = logViewerService;
  }

  onStatusChange(callback: Parameters<ConnectionManager['onStatusChange']>[0]): () => void {
    return this.connectionManager.onStatusChange(callback);
  }

  onProbeStatus(callback: Parameters<MavlinkWorkerBridge['onProbeStatus']>[0]): () => void {
    return this.workerBridge.onProbeStatus(callback);
  }

  onSerialConnected(callback: Parameters<MavlinkWorkerBridge['onSerialConnected']>[0]): () => void {
    return this.workerBridge.onSerialConnected(callback);
  }

  disconnect(): void {
    this.connectionManager.disconnect();
  }

  enterLogMode(): void {
    this.connectionManager.disconnect();
    this.connectionManager.stopAutoConnect();
  }

  grantAccess(): Promise<void> {
    return navigator.serial.requestPort()
      .then(() => {
        this.workerBridge.notifyPortsChanged();
      })
      .catch(() => {});
  }

  async connectManual(options: ManualConnectOptions): Promise<void> {
    if (options.unloadLog) {
      this.logViewerService?.unload();
    }

    this.connectionManager.stopAutoConnect();

    let port: SerialPort;
    try {
      port = await navigator.serial.requestPort();
    } catch {
      return;
    }

    const info = port.getInfo();
    const portIdentity = info.usbVendorId != null && info.usbProductId != null
      ? { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId }
      : null;

    this.connectionManager.connect({
      type: 'webserial',
      baudRate: options.baudRate,
      autoDetectBaud: options.autoDetectBaud,
      portIdentity,
      lastBaudRate: options.lastBaudRate,
    });
  }

  syncAutoConnect(options: AutoConnectOptions): void {
    if (!options.enabled) {
      this.connectionManager.stopAutoConnect();
      return;
    }

    if (this.connectionManager.status === 'connected' || this.connectionManager.status === 'connecting') {
      return;
    }

    this.connectionManager.startAutoConnect({
      autoBaud: options.autoBaud,
      manualBaudRate: options.manualBaudRate,
      lastPortIdentity: options.lastPortIdentity,
      lastBaudRate: options.lastBaudRate,
    });
  }

  stopAutoConnect(): void {
    this.connectionManager.stopAutoConnect();
  }

  async forgetAllPorts(): Promise<void> {
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
}
