/**
 * Web Serial byte source — reads from a USB serial port on the main thread.
 *
 * Forwards raw bytes to the worker via a callback. The worker feeds them
 * into ExternalByteSource → MavlinkService pipeline.
 *
 * Web Serial API is main-thread only — cannot run in a Web Worker.
 */

export type SerialBytesCallback = (data: Uint8Array) => void;

// Re-export baud rate constants from the shared module for backward compatibility.
export { BAUD_RATES, DEFAULT_BAUD_RATE, isWebSerialSupported } from './baud-rates';
export type { BaudRate } from './baud-rates';
import { isWebSerialSupported } from './baud-rates';

export class WebSerialByteSource {
  private port: SerialPort | null = null;
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
   * (no browser picker dialog). Otherwise, calls `requestPort()` which requires
   * a user gesture.
   */
  async connect(existingPort?: SerialPort): Promise<void> {
    if (!isWebSerialSupported()) {
      throw new Error('Web Serial API is not supported in this browser');
    }

    // Use provided port or request one via browser picker
    this.port = existingPort ?? await navigator.serial.requestPort();
    await this.port.open({ baudRate: this.baudRate });

    this._isConnected = true;

    // Start read loop
    this.readLoop();
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
