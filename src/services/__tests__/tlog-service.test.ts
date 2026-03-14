import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kvStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => kvStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    kvStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    kvStore.delete(key);
  }),
  keys: vi.fn(async () => [...kvStore.keys()]),
}));

import { getLogMetadata, readLogFile, recoverStagedSessions, stageSessionChunk, stageSessionStart } from '../tlog-service';

class MemoryFile {
  constructor(
    public readonly name: string,
    private readonly bytes: Uint8Array,
    public readonly lastModified: number,
  ) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer;
  }
}

class MemoryWritable {
  private chunks: Uint8Array[] = [];

  constructor(
    private readonly name: string,
    private readonly files: Map<string, { bytes: Uint8Array; lastModified: number }>,
  ) {}

  async write(chunk: ArrayBuffer): Promise<void> {
    this.chunks.push(new Uint8Array(chunk));
  }

  async close(): Promise<void> {
    const size = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.files.set(this.name, { bytes, lastModified: Date.now() });
  }

  async abort(): Promise<void> {
    this.chunks = [];
  }
}

class MemoryFileHandle {
  constructor(
    public readonly name: string,
    private readonly files: Map<string, { bytes: Uint8Array; lastModified: number }>,
  ) {}

  async createWritable(): Promise<MemoryWritable> {
    return new MemoryWritable(this.name, this.files);
  }

  async getFile(): Promise<MemoryFile> {
    const entry = this.files.get(this.name) ?? { bytes: new Uint8Array(0), lastModified: 0 };
    return new MemoryFile(this.name, entry.bytes, entry.lastModified);
  }
}

class MemoryDirectoryHandle {
  public readonly kind = 'directory' as const;

  constructor(private readonly files: Map<string, { bytes: Uint8Array; lastModified: number }>) {}

  async getDirectoryHandle(_name: string, _options?: { create?: boolean }): Promise<MemoryDirectoryHandle> {
    return this;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
    if (!this.files.has(name) && !options?.create) {
      throw new Error('missing file');
    }
    if (!this.files.has(name) && options?.create) {
      this.files.set(name, { bytes: new Uint8Array(0), lastModified: Date.now() });
    }
    return new MemoryFileHandle(name, this.files);
  }

  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
  }

  async *values(): AsyncIterable<MemoryFileHandle> {
    for (const name of this.files.keys()) {
      yield new MemoryFileHandle(name, this.files);
    }
  }
}

describe('tlog-service', () => {
  const files = new Map<string, { bytes: Uint8Array; lastModified: number }>();
  const root = new MemoryDirectoryHandle(files);

  beforeEach(() => {
    kvStore.clear();
    files.clear();
    Object.defineProperty(globalThis.navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: vi.fn(async () => root),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recovers a staged multi-chunk session without overcounting packet totals', async () => {
    await stageSessionStart({ sessionId: 'session-1', startedAtMs: 1000 });
    await stageSessionChunk({
      sessionId: 'session-1',
      seq: 0,
      startUs: 1_000_000,
      endUs: 2_000_000,
      packetCount: 2,
      bytes: Uint8Array.from([1, 2, 3]).buffer,
    });
    await stageSessionChunk({
      sessionId: 'session-1',
      seq: 1,
      startUs: 3_000_000,
      endUs: 4_000_000,
      packetCount: 1,
      bytes: Uint8Array.from([4, 5]).buffer,
    });

    await recoverStagedSessions();

    expect(kvStore.size).toBe(1);
    const [metaKey] = [...kvStore.keys()];
    expect(metaKey).toContain('mavdeck-tlog-meta-');

    const meta = await getLogMetadata((metaKey as string).replace('mavdeck-tlog-meta-', ''));
    expect(meta.displayName.endsWith('.tlog')).toBe(true);

    const bytes = await readLogFile(meta.fileName);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
  });
});
