/**
 * Serial probe service — background probing of serial ports for MAVLink devices.
 *
 * Cycles through previously-granted serial ports and baud rates, feeding bytes
 * into a temporary MavlinkFrameParser to detect valid MAVLink traffic.
 */

import { MavlinkFrameParser } from '../mavlink/frame-parser';
import { MavlinkMessageDecoder } from '../mavlink/decoder';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import { BAUD_PROBE_ORDER, PROBE_TIMEOUT_MS, type BaudRate } from './baud-rates';
import { getSerialPortIdentity, matchesSerialPortIdentity } from './serial-port-identity';

/** Identifies a USB serial port across sessions. */
export interface SerialPortIdentity {
  usbVendorId: number;
  usbProductId: number;
  usbSerialNumber?: string;
}

/** Result of a successful probe. */
export interface ProbeResult {
  port: SerialPort;
  baudRate: BaudRate;
  portIdentity: SerialPortIdentity | null;
}

export type ProbeStatusCallback = (status: string | null) => void;

export const WAITING_FOR_SERIAL_ACCESS_STATUS = 'Waiting for serial port access...';


/** Number of successfully decoded packets required to confirm a working connection. */
const PROBE_DECODE_THRESHOLD = 1;

/** Delay between full probe cycles when no device is found (ms). */
const RETRY_INTERVAL_MS = 3000;


export interface ProbeConfig {
  autoBaud: boolean;
  manualBaudRate: BaudRate;
  lastPortIdentity: SerialPortIdentity | null;
  lastBaudRate: BaudRate | null;
  onResult: (result: ProbeResult) => void;
  onStatus: ProbeStatusCallback;
}

export class SerialProbeService {
  private readonly registry: MavlinkMetadataRegistry;
  private abortController: AbortController | null = null;
  private _isProbing = false;

  constructor(registry: MavlinkMetadataRegistry) {
    this.registry = registry;
  }

  get isProbing(): boolean {
    return this._isProbing;
  }

  startProbing(config: ProbeConfig): void {
    if (this._isProbing) return;
    this._isProbing = true;
    this.abortController = new AbortController();
    this.probeLoop(config, this.abortController.signal);
  }

  stopProbing(): void {
    this._isProbing = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  /**
   * Probe a single user-selected port across baud rates.
   * Used for manual connect with auto-baud detection.
   */
  async probeSinglePort(
    port: SerialPort,
    config: Pick<ProbeConfig, 'autoBaud' | 'manualBaudRate' | 'lastBaudRate' | 'onStatus'>,
    signal: AbortSignal,
  ): Promise<ProbeResult | null> {
    const baudRates = this.buildBaudList({
      ...config,
      lastPortIdentity: null,
      onResult: () => {},
    });

    for (const baudRate of baudRates) {
      if (signal.aborted) return null;

      const label = `Detecting baud rate: trying ${baudRate}`;
      console.log(`[SerialProbe] ${label}...`);
      config.onStatus(`${label}...`);

      const result = await this.probePortAtBaud(port, baudRate, config.onStatus, label, signal);
      if (result) return result;
    }

    return null;
  }

  private async probeLoop(config: ProbeConfig, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const result = await this.probeCycle(config, signal);
      if (signal.aborted) break;

      if (result) {
        this._isProbing = false;
        config.onStatus(null);
        config.onResult(result);
        return;
      }

      config.onStatus('No device found, retrying in 3s...');
      console.log('[SerialProbe] No device found, retrying in 3s...');
      await this.delay(RETRY_INTERVAL_MS, signal);
    }

    this._isProbing = false;
    config.onStatus(null);
  }

  private async probeCycle(config: ProbeConfig, signal: AbortSignal): Promise<ProbeResult | null> {
    let ports: SerialPort[];
    try {
      ports = await navigator.serial.getPorts();
    } catch (e) {
      console.warn('[SerialProbe] Failed to get ports:', e);
      return null;
    }

    console.log(`[SerialProbe] Found ${ports.length} granted port(s)`);
    config.onStatus(`Scanning... (${ports.length} port${ports.length !== 1 ? 's' : ''})`);

    if (ports.length === 0) {
      config.onStatus(WAITING_FOR_SERIAL_ACCESS_STATUS);
      return null;
    }

    // Sort so last-working port is tried first
    if (config.lastPortIdentity) {
      ports.sort((a, b) => {
        const aMatch = this.matchesIdentity(a, config.lastPortIdentity!) ? -1 : 0;
        const bMatch = this.matchesIdentity(b, config.lastPortIdentity!) ? -1 : 0;
        return aMatch - bMatch;
      });
    }

    // Build baud rate list
    const baudRates = this.buildBaudList(config);

    for (let portIdx = 0; portIdx < ports.length; portIdx++) {
      if (signal.aborted) return null;
      const port = ports[portIdx];

      for (const baudRate of baudRates) {
        if (signal.aborted) return null;

        const label = `Probing port ${portIdx + 1}/${ports.length} at ${baudRate} baud`;
        console.log(`[SerialProbe] ${label}...`);
        config.onStatus(`${label}...`);

        const result = await this.probePortAtBaud(port, baudRate, config.onStatus, label, signal);
        if (result) return result;
      }
    }

    return null;
  }

  private buildBaudList(config: ProbeConfig): BaudRate[] {
    if (!config.autoBaud) {
      return [config.manualBaudRate];
    }

    const rates: BaudRate[] = [];

    // Last successful baud rate first
    if (config.lastBaudRate) {
      rates.push(config.lastBaudRate);
    }

    // Then the rest in priority order, deduplicating
    for (const rate of BAUD_PROBE_ORDER) {
      if (!rates.includes(rate)) {
        rates.push(rate);
      }
    }

    return rates;
  }

  private async probePortAtBaud(
    port: SerialPort,
    baudRate: BaudRate,
    onStatus: ProbeStatusCallback,
    statusLabel: string,
    signal: AbortSignal,
  ): Promise<ProbeResult | null> {
    // Defensive close in case port is still open from a prior connection
    await this.closePort(port);

    try {
      await port.open({ baudRate });
    } catch (e) {
      console.warn(`[SerialProbe] Port open failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }

    if (!port.readable) {
      console.warn('[SerialProbe] Port opened but not readable');
      await this.closePort(port);
      return null;
    }

    const parser = new MavlinkFrameParser(this.registry);
    const decoder = new MavlinkMessageDecoder(this.registry);
    let decodedCount = 0;
    let resolved = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const result = await new Promise<ProbeResult | null>((resolve) => {
      const finish = (value: ProbeResult | null) => {
        if (resolved) return;
        resolved = true;
        unsub();
        resolve(value);
      };

      const unsub = parser.onFrame((frame) => {
        const decoded = decoder.decode(frame);
        if (!decoded) return;

        decodedCount++;
        console.log(`[SerialProbe] Got ${decodedCount}/${PROBE_DECODE_THRESHOLD} decoded packets at ${baudRate}`);
        onStatus(`${statusLabel} (${decodedCount}/${PROBE_DECODE_THRESHOLD} packets)`);
        if (decodedCount >= PROBE_DECODE_THRESHOLD) {
          finish({ port, baudRate, portIdentity: this.getPortIdentity(port) });
        }
      });

      const timer = setTimeout(() => {
        console.log(`[SerialProbe] Timeout — no valid frames at ${baudRate}`);
        finish(null);
      }, PROBE_TIMEOUT_MS);

      const onAbort = () => {
        clearTimeout(timer);
        finish(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });

      reader = port.readable!.getReader();
      const readLoop = async () => {
        try {
          while (!resolved) {
            const { value, done } = await reader!.read();
            if (done || resolved) break;
            if (value) parser.parse(value);
          }
        } catch (e) {
          console.warn(`[SerialProbe] Read error: ${e instanceof Error ? e.message : e}`);
        }
        finish(null);
      };
      readLoop();
    });

    // Clean up reader
    try {
      if (reader) {
        await (reader as ReadableStreamDefaultReader<Uint8Array>).cancel();
        (reader as ReadableStreamDefaultReader<Uint8Array>).releaseLock();
      }
    } catch {
      // Reader may already be released
    }

    if (result) {
      const identity = result.portIdentity;
      console.log(`[SerialProbe] Match found! Port: ${identity ? `vendor=0x${identity.usbVendorId.toString(16)}, product=0x${identity.usbProductId.toString(16)}` : 'unknown'}, baud: ${baudRate}`);
    }

    // Always close port — WebSerialByteSource.connect() will re-open it.
    // This avoids ambiguous reader/stream state on handoff.
    await this.closePort(port);

    return result;
  }

  private async closePort(port: SerialPort): Promise<void> {
    try {
      await port.close();
    } catch {
      // Port may already be closed
    }
  }

  private getPortIdentity(port: SerialPort): SerialPortIdentity | null {
    return getSerialPortIdentity(port);
  }

  private matchesIdentity(port: SerialPort, identity: SerialPortIdentity): boolean {
    return matchesSerialPortIdentity(port, identity);
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
