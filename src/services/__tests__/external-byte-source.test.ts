import { describe, it, expect, vi } from 'vitest';
import { ExternalByteSource } from '../external-byte-source';

describe('ExternalByteSource', () => {
  it('starts disconnected', () => {
    const source = new ExternalByteSource();
    expect(source.isConnected).toBe(false);
  });

  it('connect sets isConnected to true', async () => {
    const source = new ExternalByteSource();
    await source.connect();
    expect(source.isConnected).toBe(true);
  });

  it('disconnect sets isConnected to false', async () => {
    const source = new ExternalByteSource();
    await source.connect();
    source.disconnect();
    expect(source.isConnected).toBe(false);
  });

  it('emitBytes fans out to onData callbacks', async () => {
    const source = new ExternalByteSource();
    await source.connect();

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    source.onData(cb1);
    source.onData(cb2);

    const data = new Uint8Array([0xFD, 0x01, 0x02]);
    source.emitBytes(data);

    expect(cb1).toHaveBeenCalledWith(data);
    expect(cb2).toHaveBeenCalledWith(data);
  });

  it('emitBytes does nothing when disconnected', () => {
    const source = new ExternalByteSource();
    const cb = vi.fn();
    source.onData(cb);

    source.emitBytes(new Uint8Array([0x01]));
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe removes callback', async () => {
    const source = new ExternalByteSource();
    await source.connect();

    const cb = vi.fn();
    const unsub = source.onData(cb);
    unsub();

    source.emitBytes(new Uint8Array([0x01]));
    expect(cb).not.toHaveBeenCalled();
  });

  it('disconnect clears all callbacks', async () => {
    const source = new ExternalByteSource();
    await source.connect();

    const cb = vi.fn();
    source.onData(cb);
    source.disconnect();

    // Reconnect and emit — old callback should not fire
    await source.connect();
    source.emitBytes(new Uint8Array([0x01]));
    expect(cb).not.toHaveBeenCalled();
  });
});
