/**
 * Worker-side serial byte source — reads from an already-obtained SerialPort.
 *
 * Implements IByteSource so it can be plugged directly into the MavlinkService
 * pipeline running inside the Web Worker. The port must already be granted
 * (obtained via navigator.serial.getPorts()) before constructing this class;
 * connect() will open it at the configured baud rate.
 */

import type { ByteCallback, IByteSource } from './byte-source';

export class WorkerSerialByteSource implements IByteSource {
  private readonly port: SerialPort;
  private readonly baudRate: number;
  private readonly onDisconnectCb?: () => void;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _isConnected = false;
  private _isReading = false;
  private dataCallback: ByteCallback | null = null;

  constructor(port: SerialPort, baudRate: number, onDisconnect?: () => void) {
    this.port = port;
    this.baudRate = baudRate;
    this.onDisconnectCb = onDisconnect;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Register a callback to receive incoming bytes.
   * Returns an unsubscribe function.
   */
  onData(callback: ByteCallback): () => void {
    this.dataCallback = callback;
    return () => {
      if (this.dataCallback === callback) {
        this.dataCallback = null;
      }
    };
  }

  /** Open the port at the configured baud rate and start the read loop. */
  async connect(): Promise<void> {
    await this.port.open({ baudRate: this.baudRate });
    this._isConnected = true;
    this.readLoop();
  }

  /** Cancel the reader and close the port. Fire-and-forget async cleanup. */
  disconnect(): void {
    this._isConnected = false;
    this._isReading = false;

    void (async () => {
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
        await this.port.close();
      } catch {
        // Port may already be closed
      }
    })();
  }

  private async readLoop(): Promise<void> {
    if (!this.port.readable || this._isReading) return;

    this._isReading = true;

    try {
      while (this._isConnected && this.port.readable) {
        this.reader = this.port.readable.getReader();

        try {
          while (this._isConnected) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) {
              this.dataCallback?.(value);
            }
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch {
      // Port disconnected or read error — clean up silently
    } finally {
      this._isReading = false;
      if (this._isConnected) {
        // Unexpected disconnect — clean up and notify
        this._isConnected = false;
        this.onDisconnectCb?.();
      }
    }
  }
}
