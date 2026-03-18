/**
 * Shared baud rate constants for serial communication.
 *
 * Extracted from webserial-byte-source.ts so that modules (e.g., serial-probe-service,
 * worker bundles) can import baud rate types without pulling in WebSerialByteSource
 * and its `requestPort()` reference.
 */

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 500000, 921600, 1000000] as const;
export type BaudRate = (typeof BAUD_RATES)[number];
export const DEFAULT_BAUD_RATE: BaudRate = 500000;

/** Baud rates to try during auto-detection, in priority order (most common first). */
export const BAUD_PROBE_ORDER: BaudRate[] = [115200, 57600, 921600, 230400, 38400, 19200, 9600, 500000, 1000000];

/** Timeout per baud rate probe attempt (ms). */
export const PROBE_TIMEOUT_MS = 2000;

/** Check if the browser supports Web Serial. */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/** Check if the browser supports WebUSB (used by serial polyfill on Android). */
export function isWebUsbAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

/** Any serial connection method available (native Web Serial or WebUSB polyfill). */
export function isSerialSupported(): boolean {
  return isWebSerialSupported() || isWebUsbAvailable();
}
