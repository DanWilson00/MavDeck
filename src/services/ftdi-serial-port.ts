/**
 * FTDI WebUSB serial driver — FT232R family (3MHz base clock, single-port).
 *
 * Implements PortLike so it plugs into the existing serial pipeline.
 * Used on Android where native Web Serial is unavailable.
 *
 * Protocol reference: FTDI AN_120 (vendor request interface) and
 * the Linux ftdi_sio driver for divisor encoding.
 */

import type { PortLike } from './serial-backend';

// ── FTDI constants ──────────────────────────────────────────────────────────

export const FTDI_VENDOR_ID = 0x0403;

/** FT232R family base clock (3 MHz). */
const FTDI_BASE_CLOCK = 3_000_000;

/** Every bulk-IN packet from FTDI starts with 2 modem-status bytes. */
const FTDI_MODEM_STATUS_SIZE = 2;

// Vendor control-transfer request codes
const FTDI_RESET = 0x00;
const FTDI_MODEM_CTRL = 0x01;
const FTDI_SET_FLOW = 0x02;
const FTDI_SET_BAUD = 0x03;
const FTDI_SET_DATA = 0x04;

// ── Baud divisor ────────────────────────────────────────────────────────────

/**
 * Sub-integer fraction → 3-bit encoding.
 * Bit 2 maps to wValue bit 14; bits 1:0 map to wIndex bits 1:0.
 */
const SUB_INTEGER_TABLE: readonly [fraction: number, code: number][] = [
  [0.000, 0],
  [0.125, 1],
  [0.250, 2],
  [0.375, 3],
  [0.500, 4],
  [0.625, 5],
  [0.750, 6],
  [0.875, 7],
];

/** Compute the FTDI baud-rate divisor for FT232R (3 MHz clock). */
export function computeBaudDivisor(baudRate: number): { value: number; index: number } {
  const exactDivisor = FTDI_BASE_CLOCK / baudRate;
  const intPart = Math.floor(exactDivisor);
  const fracPart = exactDivisor - intPart;

  // Find closest sub-integer encoding
  let bestCode = 0;
  let bestDist = Infinity;
  for (const [frac, code] of SUB_INTEGER_TABLE) {
    const dist = Math.abs(fracPart - frac);
    if (dist < bestDist) {
      bestDist = dist;
      bestCode = code;
    }
  }

  // Encode: integer in wValue bits 13:0, sub-int bit 2 → wValue bit 14,
  // sub-int bits 1:0 → wIndex bits 1:0
  const value = (intPart & 0x3FFF) | ((bestCode & 0x04) << 12); // bit 2 → bit 14
  const index = bestCode & 0x03;

  return { value, index };
}

// ── FtdiSerialPort ──────────────────────────────────────────────────────────

export class FtdiSerialPort implements PortLike {
  private readonly device: USBDevice;
  private readonly interfaceNumber: number;
  private readonly endpointIn: number;
  private readonly endpointOut: number;
  private _readable: ReadableStream<Uint8Array> | null = null;
  private _writable: WritableStream<Uint8Array> | null = null;
  private _closed = false;
  private disconnectListener: (() => void) | null = null;

  constructor(device: USBDevice) {
    // Validate single-interface vendor-specific layout (FT232R)
    const config = device.configuration;
    if (!config) {
      throw new Error('FTDI: device has no active configuration');
    }

    if (config.interfaces.length !== 1) {
      throw new Error(
        `FTDI: expected 1 interface (single-port FT232R), got ${config.interfaces.length}. ` +
        'Multi-port FTDI chips (FT2232H/FT4232H) are not supported.',
      );
    }

    const iface = config.interfaces[0];
    const alt = iface.alternate;

    if (alt.interfaceClass !== 0xFF) {
      throw new Error(
        `FTDI: expected vendor-specific interface class 0xFF, got 0x${alt.interfaceClass.toString(16)}`,
      );
    }

    let bulkIn: number | null = null;
    let bulkOut: number | null = null;
    for (const ep of alt.endpoints) {
      if (ep.type !== 'bulk') continue;
      if (ep.direction === 'in') bulkIn = ep.endpointNumber;
      if (ep.direction === 'out') bulkOut = ep.endpointNumber;
    }

    if (bulkIn === null || bulkOut === null) {
      throw new Error('FTDI: could not find bulk IN and OUT endpoints');
    }

    this.device = device;
    this.interfaceNumber = iface.interfaceNumber;
    this.endpointIn = bulkIn;
    this.endpointOut = bulkOut;
  }

  async open(options: SerialOptions): Promise<void> {
    await this.device.open();

    try {
      await this.device.selectConfiguration(1);
    } catch (e: unknown) {
      // Some Android devices throw InvalidStateError if configuration is already selected
      if (!(e instanceof DOMException && e.name === 'InvalidStateError')) {
        throw e;
      }
    }

    await this.device.claimInterface(this.interfaceNumber);

    const baudRate = options.baudRate;
    const divisor = computeBaudDivisor(baudRate);

    // Reset
    await this.vendorTransfer(FTDI_RESET, 0x0000, 0x0000);
    // Set baud
    await this.vendorTransfer(FTDI_SET_BAUD, divisor.value, divisor.index);
    // Set data: 8N1
    await this.vendorTransfer(FTDI_SET_DATA, 0x0008, 0x0000);
    // Set flow: none
    await this.vendorTransfer(FTDI_SET_FLOW, 0x0000, 0x0000);
    // DTR on
    await this.vendorTransfer(FTDI_MODEM_CTRL, 0x0101, 0x0000);
    // RTS on
    await this.vendorTransfer(FTDI_MODEM_CTRL, 0x0202, 0x0000);

    // Listen for cable-pull
    const onDisconnect = (event: USBConnectionEvent) => {
      if (event.device === this.device) {
        this.teardownStreams();
      }
    };
    this.disconnectListener = () => navigator.usb.removeEventListener('disconnect', onDisconnect);
    navigator.usb.addEventListener('disconnect', onDisconnect);
  }

  async close(): Promise<void> {
    this._closed = true;
    this.teardownStreams();
    this.disconnectListener?.();
    this.disconnectListener = null;

    try {
      await this.device.releaseInterface(this.interfaceNumber);
    } catch {
      // Interface may already be released
    }

    if (this.device.opened) {
      await this.device.close();
    }
  }

  get readable(): ReadableStream<Uint8Array> | null {
    if (this._closed) return null;
    if (!this._readable) {
      const device = this.device;
      const epIn = this.endpointIn;

      this._readable = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          // Loop until we get actual data — status-only packets (≤2 bytes) are skipped.
          // We must enqueue before returning, otherwise some ReadableStream implementations
          // re-invoke pull synchronously, causing a busy loop.
          for (;;) {
            try {
              const result = await device.transferIn(epIn, 64);
              if (!result.data || result.data.byteLength <= FTDI_MODEM_STATUS_SIZE) {
                continue; // Status-only packet — try again
              }
              // Strip 2-byte modem status prefix
              const payload = new Uint8Array(
                result.data.buffer,
                result.data.byteOffset + FTDI_MODEM_STATUS_SIZE,
                result.data.byteLength - FTDI_MODEM_STATUS_SIZE,
              );
              controller.enqueue(payload);
              return;
            } catch {
              controller.error(new Error('FTDI: USB read error'));
              this._readable = null;
              return;
            }
          }
        },
      });
    }
    return this._readable;
  }

  get writable(): WritableStream<Uint8Array> | null {
    if (this._closed) return null;
    if (!this._writable) {
      const device = this.device;
      const epOut = this.endpointOut;

      this._writable = new WritableStream<Uint8Array>({
        write: async (chunk) => {
          try {
            await device.transferOut(epOut, chunk);
          } catch {
            this._writable = null;
            throw new Error('FTDI: USB write error');
          }
        },
      });
    }
    return this._writable;
  }

  getInfo(): SerialPortInfo {
    return {
      usbVendorId: this.device.vendorId,
      usbProductId: this.device.productId,
    };
  }

  async forget(): Promise<void> {
    await this.device.forget();
  }

  private async vendorTransfer(request: number, value: number, index: number): Promise<void> {
    await this.device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'device',
      request,
      value,
      index,
    });
  }

  private teardownStreams(): void {
    if (this._readable) {
      this._readable.cancel().catch(() => {});
      this._readable = null;
    }
    if (this._writable) {
      this._writable.abort().catch(() => {});
      this._writable = null;
    }
  }
}

// ── Factory functions ───────────────────────────────────────────────────────

/** Show the WebUSB device picker filtered to FTDI vendor devices. */
export async function requestFtdiPort(): Promise<FtdiSerialPort> {
  const device = await navigator.usb.requestDevice({
    filters: [{ vendorId: FTDI_VENDOR_ID }],
  });
  return new FtdiSerialPort(device);
}

/** Get all previously-granted FTDI devices. */
export async function getGrantedFtdiPorts(): Promise<FtdiSerialPort[]> {
  const devices = await navigator.usb.getDevices();
  const ports: FtdiSerialPort[] = [];
  for (const device of devices) {
    if (device.vendorId !== FTDI_VENDOR_ID) continue;
    try {
      ports.push(new FtdiSerialPort(device));
    } catch {
      // Skip devices that fail validation (multi-port chips, etc.)
    }
  }
  return ports;
}
