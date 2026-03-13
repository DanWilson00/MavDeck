/**
 * Web Serial byte source — reads from a USB serial port on the main thread.
 *
 * Forwards raw bytes to the worker via a callback. The worker feeds them
 * into ExternalByteSource → MavlinkService pipeline.
 *
 * Web Serial API is main-thread only — cannot run in a Web Worker.
 */

export type SerialBytesCallback = (data: Uint8Array) => void;

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 500000, 921600, 1000000] as const;
export type BaudRate = (typeof BAUD_RATES)[number];
export const DEFAULT_BAUD_RATE: BaudRate = 115200;

/** Check if the browser supports Web Serial. */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

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
   * Request a serial port (triggers browser picker dialog) and connect.
   * Must be called from a user gesture (click handler).
   */
  async connect(): Promise<void> {
    if (!isWebSerialSupported()) {
      throw new Error('Web Serial API is not supported in this browser');
    }

    // Request port — browser shows device picker
    this.port = await navigator.serial.requestPort();

    // Open with 8N1 configuration (Web Serial defaults)
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
