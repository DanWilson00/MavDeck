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
  private isDetached = false;
  private readonly dataCallbacks = new Set<ByteCallback>();

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
    this.dataCallbacks.add(callback);
    return () => {
      this.dataCallbacks.delete(callback);
    };
  }

  /** Open the port at the configured baud rate and start the read loop. */
  async connect(): Promise<void> {
    await this.port.open({ baudRate: this.baudRate });
    this.isDetached = false;
    this._isConnected = true;
    this.readLoop();
  }

  /**
   * Mark the source inactive immediately without waiting for a pending read
   * to unblock. Called internally by disconnect() before cancelling the reader.
   */
  detach(): void {
    this.isDetached = true;
    this._isConnected = false;
    this._isReading = false;
    this.dataCallbacks.clear();
  }

  /** Cancel the reader and close the port. */
  async disconnect(): Promise<void> {
    this.detach();

    try {
      if (this.reader) {
        await this.reader.cancel();
      }
    } catch {
      // Reader may already be released
    }

    try {
      await this.port.close();
    } catch {
      // Port may already be closed
    }
  }

  private async readLoop(): Promise<void> {
    if (!this.port.readable || this._isReading) return;

    this._isReading = true;
    const shouldNotifyDisconnect = () => this._isConnected && !this.isDetached;

    try {
      while (shouldNotifyDisconnect() && this.port.readable) {
        this.reader = this.port.readable.getReader();

        try {
          while (shouldNotifyDisconnect()) {
            const { value, done } = await this.reader.read();
            if (done) {
              break;
            }
            if (this.isDetached) break;
            if (value) {
              for (const cb of this.dataCallbacks) cb(value);
            }
          }
        } catch (err) {
          // BREAK condition is normal on UART when transmitter stops/resumes — recoverable
          if (err instanceof DOMException && err.name === 'BreakError') {
            // BREAK is normal on UART — just re-acquire the reader
          } else {
            throw err; // Non-recoverable — propagate to outer catch
          }
        } finally {
          try {
            this.reader.releaseLock();
          } catch {
            // Reader may already be released
          }
          this.reader = null;
        }
      }
    } catch (err) {
      console.error('[SerialByteSource] readLoop error:', err);
    } finally {
      this._isReading = false;
      if (shouldNotifyDisconnect()) {
        this._isConnected = false;
        this.onDisconnectCb?.();
      }
    }
  }
}
