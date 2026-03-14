/**
 * Shared baud rate constants for serial communication.
 *
 * Extracted from webserial-byte-source.ts so that modules (e.g., serial-probe-service,
 * worker bundles) can import baud rate types without pulling in WebSerialByteSource
 * and its `requestPort()` reference.
 */

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 500000, 921600, 1000000] as const;
export type BaudRate = (typeof BAUD_RATES)[number];
export const DEFAULT_BAUD_RATE: BaudRate = 115200;

/** Check if the browser supports Web Serial. */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}
