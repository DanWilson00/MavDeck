import { get, set, del, keys } from 'idb-keyval';

const LOGS_DIR = 'logs';
const STAGE_META_PREFIX = 'mavdeck-tlog-stage-meta-';
const STAGE_CHUNK_PREFIX = 'mavdeck-tlog-stage-chunk-';
const LOG_META_PREFIX = 'mavdeck-tlog-meta-';
const RECOVERY_LOCK_KEY = 'mavdeck-tlog-recovery-lock';

const MAX_NOTE_LENGTH = 2000;

export interface LogSessionStart {
  sessionId: string;
  startedAtMs: number;
}

export interface LogSessionChunk {
  sessionId: string;
  seq: number;
  startUs: number;
  endUs: number;
  packetCount: number;
  bytes: ArrayBuffer;
}

export interface LogSessionEnd {
  sessionId: string;
  endedAtMs: number;
  firstPacketUs?: number;
  lastPacketUs?: number;
  packetCount: number;
}

interface StageMeta {
  sessionId: string;
  startedAtMs: number;
  endedAtMs?: number;
  firstPacketUs?: number;
  lastPacketUs?: number;
  packetCount: number;
  maxSeq: number;
}

export interface LogMetadata {
  fileName: string;
  displayName: string;
  notes: string;
  updatedAt: number;
}

export interface LogLibraryEntry {
  fileName: string;
  displayName: string;
  notes: string;
  sizeBytes: number;
  createdAtMs: number;
}

export function buildLogFileName(startMs: number, durationSec: number): string {
  const d = new Date(startMs);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${stamp}__${durationSec}s.tlog`;
}

function stageMetaKey(sessionId: string): string {
  return `${STAGE_META_PREFIX}${sessionId}`;
}

function stageChunkKey(sessionId: string, seq: number): string {
  return `${STAGE_CHUNK_PREFIX}${sessionId}-${seq.toString().padStart(6, '0')}`;
}

function logMetaKey(fileName: string): string {
  return `${LOG_META_PREFIX}${fileName}`;
}

async function getLogsDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!('storage' in navigator) || !navigator.storage.getDirectory) {
    throw new Error('OPFS is not supported in this browser');
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(LOGS_DIR, { create: true });
}

export async function stageSessionStart(start: LogSessionStart): Promise<void> {
  const meta: StageMeta = {
    sessionId: start.sessionId,
    startedAtMs: start.startedAtMs,
    packetCount: 0,
    maxSeq: -1,
  };
  await set(stageMetaKey(start.sessionId), meta);
}

export async function stageSessionChunk(chunk: LogSessionChunk): Promise<void> {
  const key = stageMetaKey(chunk.sessionId);
  const existing = await get<StageMeta>(key);
  if (!existing) return;

  const meta: StageMeta = {
    ...existing,
    firstPacketUs: existing.firstPacketUs == null ? chunk.startUs : Math.min(existing.firstPacketUs, chunk.startUs),
    lastPacketUs: existing.lastPacketUs == null ? chunk.endUs : Math.max(existing.lastPacketUs, chunk.endUs),
    packetCount: existing.packetCount + chunk.packetCount,
    maxSeq: Math.max(existing.maxSeq, chunk.seq),
  };

  await Promise.all([
    set(stageChunkKey(chunk.sessionId, chunk.seq), chunk.bytes),
    set(key, meta),
  ]);
}

export async function finalizeSession(end: LogSessionEnd): Promise<string | null> {
  const metaKey = stageMetaKey(end.sessionId);
  const meta = await get<StageMeta>(metaKey);
  if (!meta) return null;

  const firstUs = end.firstPacketUs ?? meta.firstPacketUs;
  const lastUs = end.lastPacketUs ?? meta.lastPacketUs;
  const startMs = firstUs != null ? Math.floor(firstUs / 1000) : meta.startedAtMs;
  const durationSec = firstUs != null && lastUs != null ? Math.max(0, Math.ceil((lastUs - firstUs) / 1_000_000)) : 0;
  const fileName = await buildUniqueName(await getLogsDirectory(), buildLogFileName(startMs, durationSec));

  const dir = await getLogsDirectory();
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writer = await handle.createWritable();
  try {
    for (let seq = 0; seq <= meta.maxSeq; seq++) {
      const chunk = await get<ArrayBuffer>(stageChunkKey(end.sessionId, seq));
      if (!chunk) continue;
      await writer.write(chunk);
    }
    await writer.close();
  } catch (err) {
    await writer.abort();
    throw err;
  }

  await cleanupStagedSession(end.sessionId, meta.maxSeq);
  await setLogMetadata(fileName, {
    displayName: fileName,
    notes: '',
  });
  return fileName;
}

async function buildUniqueName(dir: FileSystemDirectoryHandle, desired: string): Promise<string> {
  const dot = desired.lastIndexOf('.');
  const stem = dot >= 0 ? desired.slice(0, dot) : desired;
  const ext = dot >= 0 ? desired.slice(dot) : '';

  let candidate = desired;
  let idx = 1;
  while (true) {
    try {
      await dir.getFileHandle(candidate, { create: false });
      candidate = `${stem}_${idx}${ext}`;
      idx++;
    } catch {
      return candidate;
    }
  }
}

async function cleanupStagedSession(sessionId: string, maxSeq: number): Promise<void> {
  const deletes: Promise<void>[] = [del(stageMetaKey(sessionId))];
  for (let seq = 0; seq <= maxSeq; seq++) {
    deletes.push(del(stageChunkKey(sessionId, seq)));
  }
  await Promise.all(deletes);
}

export async function recoverStagedSessions(): Promise<void> {
  const hasLock = await get<boolean>(RECOVERY_LOCK_KEY);
  if (hasLock) return;
  await set(RECOVERY_LOCK_KEY, true);
  try {
    const allKeys = await keys();
    const stageKeys = allKeys
      .filter((k): k is string => typeof k === 'string' && k.startsWith(STAGE_META_PREFIX));

    for (const key of stageKeys) {
      const meta = await get<StageMeta>(key);
      if (!meta) continue;
      await finalizeSession({
        sessionId: meta.sessionId,
        endedAtMs: Date.now(),
        firstPacketUs: meta.firstPacketUs,
        lastPacketUs: meta.lastPacketUs,
        packetCount: meta.packetCount,
      });
    }
  } finally {
    await del(RECOVERY_LOCK_KEY);
  }
}

export async function listLogs(): Promise<LogLibraryEntry[]> {
  const dir = await getLogsDirectory();
  const entries: LogLibraryEntry[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file') continue;
    const file = await (entry as FileSystemFileHandle).getFile();
    const meta = await get<LogMetadata>(logMetaKey(entry.name));
    entries.push({
      fileName: entry.name,
      displayName: meta?.displayName || entry.name,
      notes: meta?.notes || '',
      sizeBytes: file.size,
      createdAtMs: file.lastModified,
    });
  }
  entries.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return entries;
}

export async function readLogFile(fileName: string): Promise<Uint8Array> {
  const dir = await getLogsDirectory();
  const handle = await dir.getFileHandle(fileName, { create: false });
  const file = await handle.getFile();
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

export async function exportLogFile(fileName: string): Promise<void> {
  const bytes = await readLogFile(fileName);
  const blob = new Blob([Uint8Array.from(bytes)], { type: 'application/octet-stream' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

export async function deleteLogFile(fileName: string): Promise<void> {
  const dir = await getLogsDirectory();
  await dir.removeEntry(fileName);
  await del(logMetaKey(fileName));
}

export async function clearAllLogs(): Promise<void> {
  const entries = await listLogs();
  await Promise.all(entries.map(e => deleteLogFile(e.fileName)));
}

export async function setLogMetadata(fileName: string, input: { displayName: string; notes: string }): Promise<void> {
  const value: LogMetadata = {
    fileName,
    displayName: input.displayName.trim() || fileName,
    notes: input.notes.slice(0, MAX_NOTE_LENGTH),
    updatedAt: Date.now(),
  };
  await set(logMetaKey(fileName), value);
}

export async function getLogMetadata(fileName: string): Promise<LogMetadata> {
  const meta = await get<LogMetadata>(logMetaKey(fileName));
  if (meta) return meta;
  return {
    fileName,
    displayName: fileName,
    notes: '',
    updatedAt: Date.now(),
  };
}
