/**
 * Byte source interface for MAVLink data providers.
 *
 * Implemented by SpoofByteSource (testing) and WebSerialByteSource (hardware).
 */

export type ByteCallback = (data: Uint8Array) => void;

export interface IByteSource {
  onData(callback: ByteCallback): () => void;  // returns unsubscribe function
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readonly isConnected: boolean;
}
