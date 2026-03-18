import { MavlinkFrameParser } from '../mavlink/frame-parser';
import { MavlinkMessageDecoder } from '../mavlink/decoder';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';

export interface WaitForDecodedPacketOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  threshold?: number;
}

export interface MavlinkDecodeVerifierOptions {
  onDecodedPacket?: (decodedCount: number) => void;
}

export class MavlinkDecodeVerifier {
  private readonly parser: MavlinkFrameParser;
  private readonly decoder: MavlinkMessageDecoder;
  private readonly listeners = new Set<(decodedCount: number) => void>();
  private readonly parserUnsub: () => void;
  private decodedCount = 0;

  constructor(
    registry: MavlinkMetadataRegistry,
    options: MavlinkDecodeVerifierOptions = {},
  ) {
    this.parser = new MavlinkFrameParser(registry);
    this.decoder = new MavlinkMessageDecoder(registry);
    this.parserUnsub = this.parser.onFrame((frame) => {
      if (!this.decoder.decode(frame)) {
        return;
      }

      this.decodedCount += 1;
      options.onDecodedPacket?.(this.decodedCount);
      for (const listener of this.listeners) {
        listener(this.decodedCount);
      }
    });
  }

  parse(data: Uint8Array): void {
    this.parser.parse(data);
  }

  waitForDecodedPacket(options: WaitForDecodedPacketOptions): Promise<boolean> {
    const threshold = options.threshold ?? 1;
    if (this.decodedCount >= threshold) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const settle = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== null) {
          clearTimeout(timeout);
        }
        this.listeners.delete(handleDecoded);
        if (options.signal) {
          options.signal.removeEventListener('abort', handleAbort);
        }
        resolve(value);
      };

      const handleDecoded = (count: number) => {
        if (count >= threshold) {
          settle(true);
        }
      };

      const handleAbort = () => {
        settle(false);
      };

      this.listeners.add(handleDecoded);
      timeout = setTimeout(() => settle(false), options.timeoutMs);
      if (options.signal) {
        options.signal.addEventListener('abort', handleAbort, { once: true });
      }
    });
  }

  dispose(): void {
    this.parserUnsub();
    this.listeners.clear();
  }
}
