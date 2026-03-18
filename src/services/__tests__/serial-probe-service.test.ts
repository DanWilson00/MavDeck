import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MavlinkMetadataRegistry } from '../../mavlink/registry';
import { MavlinkFrameBuilder } from '../../mavlink/frame-builder';
import { loadCommonDialectJson } from '../../test-helpers/load-dialect';
import { PROBE_TIMEOUT_MS } from '../baud-rates';
import { SerialProbeService } from '../serial-probe-service';

const commonJson = loadCommonDialectJson();

function createStructuredGarbageFrame(payloadLength = 9): Uint8Array {
  return new Uint8Array(12 + payloadLength);
}

function createMockProbePort(chunksByBaud: Record<number, Uint8Array[]>) {
  let pendingResolve: ((value: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
  const queue: ReadableStreamReadResult<Uint8Array>[] = [];

  const push = (value: ReadableStreamReadResult<Uint8Array>) => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(value);
      return;
    }
    queue.push(value);
  };

  const open = vi.fn(async ({ baudRate }: { baudRate: number }) => {
    queue.length = 0;
    pendingResolve = null;
    const chunks = chunksByBaud[baudRate] ?? [];
    for (const chunk of chunks) {
      push({ done: false, value: chunk });
    }
  });
  const close = vi.fn(async () => {
    push({ done: true, value: undefined });
  });
  const cancel = vi.fn(async () => {
    push({ done: true, value: undefined });
  });
  const releaseLock = vi.fn();

  return {
    port: {
      open,
      close,
      getInfo: () => ({ usbVendorId: 11, usbProductId: 22 }),
      forget: async () => {},
      writable: null,
      readable: {
        getReader: () => ({
          read: () => {
            if (queue.length > 0) {
              return Promise.resolve(queue.shift()!);
            }
            return new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => {
              pendingResolve = resolve;
            });
          },
          cancel,
          releaseLock,
        }),
      },
    } as unknown as SerialPort,
    open,
    close,
  };
}

describe('SerialProbeService', () => {
  let registry: MavlinkMetadataRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new MavlinkMetadataRegistry();
    registry.loadFromJsonString(commonJson);
  });

  it('skips garbage at earlier baud rates and succeeds on the first decoded packet', async () => {
    const builder = new MavlinkFrameBuilder(registry);
    const heartbeat = builder.buildFrame({
      messageName: 'HEARTBEAT',
      values: {
        type: 2,
        autopilot: 3,
        base_mode: 0x81,
        custom_mode: 0,
        system_status: 4,
        mavlink_version: 3,
      },
    });
    const { port, open } = createMockProbePort({
      921600: [createStructuredGarbageFrame(), createStructuredGarbageFrame()],
      500000: [heartbeat],
    });
    const service = new SerialProbeService(registry);
    const statuses: string[] = [];
    const signal = new AbortController().signal;

    const probePromise = service.probeSinglePort(port, {
      autoBaud: true,
      manualBaudRate: 500000,
      lastBaudRate: 921600,
      onStatus: (status) => {
        if (status) statuses.push(status);
      },
    }, signal);

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS * 7 + 20);

    await expect(probePromise).resolves.toMatchObject({ baudRate: 500000 });
    expect(open).toHaveBeenCalled();
    expect(statuses.some(status => status.includes('500000') && status.includes('packets'))).toBe(true);
  });
});
