/**
 * Web Serial byte source — reads from a USB serial port on the main thread.
 *
 * Forwards raw bytes to the worker via a callback. The worker feeds them
 * into ExternalByteSource → MavlinkService pipeline.
 *
 * Web Serial API is main-thread only — cannot run in a Web Worker.
 */

import type { PortLike } from './serial-backend';

export type SerialBytesCallback = (data: Uint8Array) => void;

// Re-export baud rate constants from the shared module for backward compatibility.
export { BAUD_RATES, DEFAULT_BAUD_RATE, isWebSerialSupported } from './baud-rates';
export type { BaudRate } from './baud-rates';

export class WebSerialByteSource {
  private port: PortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _isConnected = false;
  private _isReading = false;
  private readonly baudRate: number;
  private readonly onBytes: SerialBytesCallback;
  private readonly onDisconnect?: () => void;

  constructor(baudRate: number, onBytes: SerialBytesCallback, onDisconnect?: () => void) {
    this.baudRate = baudRate;
    this.onBytes = onBytes;
    this.onDisconnect = onDisconnect;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Connect to a serial port. If `existingPort` is provided, uses it directly
   * (no browser picker dialog). Otherwise throws — caller must provide a port.
   */
  async connect(existingPort: PortLike): Promise<void> {
    this.port = existingPort;
    await this.port.open({ baudRate: this.baudRate });

    this._isConnected = true;

    // Start read loop
    this.readLoop();
  }

  /** Write bytes to the serial port. */
  async write(data: Uint8Array): Promise<void> {
    if (!this.port?.writable) throw new Error('Serial port not writable');
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  /** Disconnect and clean up. */
  async disconnect(): Promise<void> {
    this._isConnected = false;
    this._isReading = false;

    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
        this.reader = null;
      }
    } catch {
      // Reader may already be released
    }

    try {
      if (this.port) {
        await this.port.close();
        this.port = null;
      }
    } catch {
      // Port may already be closed
    }
  }

  private async readLoop(): Promise<void> {
    if (!this.port?.readable || this._isReading) return;

    this._isReading = true;

    try {
      while (this._isConnected && this.port.readable) {
        this.reader = this.port.readable.getReader();

        try {
          while (this._isConnected) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) {
              this.onBytes(value);
            }
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch {
      // Port disconnected or read error — clean up silently
      // The connection manager handles status via the disconnect path
    } finally {
      this._isReading = false;
      if (this._isConnected) {
        // Unexpected disconnect — clean up and notify
        this._isConnected = false;
        this.onDisconnect?.();
      }
    }
  }
}
