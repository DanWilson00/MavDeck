import { get, set, del, clear } from 'idb-keyval';

const METADATA_CACHE_PREFIX = 'mavdeck-metadata-cache-v1:';

interface CachedMetadataEntry {
  crc: number;
  json: string;
  cachedAt: number;
}

const memoryCache = new Map<string, CachedMetadataEntry>();

function cacheKey(crc: number): string {
  return `${METADATA_CACHE_PREFIX}${crc >>> 0}`;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

export async function getCachedMetadataByCrc(crc: number): Promise<string | null> {
  const key = cacheKey(crc);

  if (!hasIndexedDb()) {
    return memoryCache.get(key)?.json ?? null;
  }

  const entry = await get<CachedMetadataEntry>(key);
  return entry?.json ?? null;
}

export async function putCachedMetadata(crc: number, json: string): Promise<void> {
  const key = cacheKey(crc);
  const entry: CachedMetadataEntry = {
    crc: crc >>> 0,
    json,
    cachedAt: Date.now(),
  };

  if (!hasIndexedDb()) {
    memoryCache.set(key, entry);
    return;
  }

  await set(key, entry);
}

export async function clearCachedMetadataByCrc(crc: number): Promise<void> {
  const key = cacheKey(crc);

  if (!hasIndexedDb()) {
    memoryCache.delete(key);
    return;
  }

  await del(key);
}

export async function clearMetadataCache(): Promise<void> {
  memoryCache.clear();

  if (!hasIndexedDb()) {
    return;
  }

  await clear();
}
