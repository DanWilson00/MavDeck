import { describe, expect, it, vi } from 'vitest';
import { WorkerSerialByteSource } from '../worker-serial-byte-source';

function createDeferredRead(): {
  promise: Promise<ReadableStreamReadResult<Uint8Array>>;
  resolve: (value: ReadableStreamReadResult<Uint8Array>) => void;
} {
  let resolve!: (value: ReadableStreamReadResult<Uint8Array>) => void;
  const promise = new Promise<ReadableStreamReadResult<Uint8Array>>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('WorkerSerialByteSource', () => {
  it('detach stops late bytes from reaching callbacks', async () => {
    const read = createDeferredRead();
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => {});
    const port = {
      open,
      close,
      readable: {
        getReader: vi.fn(() => ({
          read: vi.fn(() => read.promise),
          cancel,
          releaseLock,
        })),
      },
    } as unknown as SerialPort;

    const source = new WorkerSerialByteSource(port, 115200);
    const onData = vi.fn();
    source.onData(onData);

    await source.connect();
    source.detach();
    read.resolve({ value: new Uint8Array([1, 2, 3]), done: false });
    await Promise.resolve();

    expect(onData).not.toHaveBeenCalled();
    expect(source.isConnected).toBe(false);
  });

  it('recovers from BreakError and continues reading', async () => {
    let readCallCount = 0;
    const releaseLock = vi.fn();
    const cancel = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => {});

    const read = vi.fn(async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      readCallCount++;
      if (readCallCount === 1) {
        // First read returns data
        return { value: new Uint8Array([1, 2, 3]), done: false };
      }
      if (readCallCount === 2) {
        // Second read throws BreakError
        throw new DOMException('Break received', 'BreakError');
      }
      if (readCallCount === 3) {
        // Third read (after recovery) returns more data
        return { value: new Uint8Array([4, 5, 6]), done: false };
      }
      // Fourth read: hang forever — test will detach to stop the loop
      return new Promise(() => {});
    });

    const port = {
      open,
      close,
      readable: {
        getReader: vi.fn(() => ({
          read,
          cancel,
          releaseLock,
        })),
      },
    } as unknown as SerialPort;

    const onDisconnect = vi.fn();
    const source = new WorkerSerialByteSource(port, 115200, onDisconnect);
    const onData = vi.fn();
    source.onData(onData);

    await source.connect();
    // Wait until the 4th read (hanging) is reached, proving recovery happened
    await vi.waitFor(() => expect(readCallCount).toBeGreaterThanOrEqual(4));

    // Should have received data before and after the BreakError
    expect(onData).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenNthCalledWith(1, new Uint8Array([1, 2, 3]));
    expect(onData).toHaveBeenNthCalledWith(2, new Uint8Array([4, 5, 6]));

    // Reader lock released once after BreakError recovery (second reader still active)
    expect(releaseLock).toHaveBeenCalledTimes(1);

    // No disconnect triggered — BreakError is recoverable
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(source.isConnected).toBe(true);

    // Clean up
    source.detach();
  });

  it('disconnect still closes after a prior detach', async () => {
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => {});
    const port = {
      open,
      close,
      readable: {
        getReader: vi.fn(() => ({
          read: vi.fn(async () => ({ done: true, value: undefined })),
          cancel,
          releaseLock,
        })),
      },
    } as unknown as SerialPort;

    const source = new WorkerSerialByteSource(port, 115200);

    await source.connect();
    source.detach();
    await source.disconnect();

    expect(close).toHaveBeenCalledOnce();
  });
});
