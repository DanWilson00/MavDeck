/**
 * External byte source — receives bytes from outside the worker.
 *
 * Used for Web Serial: main thread reads serial port and posts bytes
 * to the worker, which calls emitBytes() to feed the MAVLink pipeline.
 */

import type { ByteCallback, IByteSource } from './byte-source';

export class ExternalByteSource implements IByteSource {
  private readonly callbacks = new Set<ByteCallback>();
  private _isConnected = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  onData(callback: ByteCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  async connect(): Promise<void> {
    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    this._isConnected = false;
    this.callbacks.clear();
  }

  async write(): Promise<void> {
    throw new Error('ExternalByteSource does not support write');
  }

  /** Feed bytes from outside (called by worker message handler). */
  emitBytes(data: Uint8Array): void {
    if (!this._isConnected) return;
    for (const cb of this.callbacks) {
      cb(data);
    }
  }
}
