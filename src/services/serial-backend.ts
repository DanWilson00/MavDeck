/**
 * Serial backend abstraction — supports native Web Serial and WebUSB.
 *
 * On desktop Chrome/Edge, uses native Web Serial API.
 * On Android Chrome (no Web Serial), falls back to WebUSB with FTDI driver.
 */

import { isWebSerialSupported, isWebUsbAvailable } from './baud-rates';

export type SerialBackend = 'native' | 'webusb';

/**
 * Common interface for serial ports from both native Web Serial and WebUSB drivers.
 * Both provide the same surface: open/close, readable/writable streams, getInfo, forget.
 */
export interface PortLike {
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): SerialPortInfo;
  forget(): Promise<void>;
}

/** Determine which serial backend to use, or null if none is available. */
export function getSerialBackend(): SerialBackend | null {
  if (isWebSerialSupported()) return 'native';
  if (isWebUsbAvailable()) return 'webusb';
  return null;
}

/**
 * Request a serial port via the appropriate backend.
 * Both paths show a browser-native device picker (requires user gesture).
 */
export async function requestPort(backend: SerialBackend): Promise<PortLike> {
  if (backend === 'native') {
    return navigator.serial.requestPort();
  }
  const { requestFtdiPort } = await import('./ftdi-serial-port');
  return requestFtdiPort();
}

/**
 * Get previously-granted ports from the appropriate backend.
 * Native: navigator.serial.getPorts()
 * WebUSB: get granted FTDI devices
 */
export async function getGrantedPorts(backend: SerialBackend): Promise<PortLike[]> {
  if (backend === 'native') {
    return navigator.serial.getPorts();
  }
  const { getGrantedFtdiPorts } = await import('./ftdi-serial-port');
  return getGrantedFtdiPorts();
}
