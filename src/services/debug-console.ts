import { EventEmitter } from '../core/event-emitter';

export type DebugConsoleSource = 'metadata-ftp' | 'app';
export type DebugConsoleLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DebugConsoleEntry {
  id: number;
  source: DebugConsoleSource;
  level: DebugConsoleLevel;
  message: string;
  timestamp: number;
  details?: Record<string, string | number | boolean | null>;
}

const MAX_DEBUG_CONSOLE_ENTRIES = 400;

let nextDebugConsoleId = 0;
let entries: DebugConsoleEntry[] = [];

const entryEmitter = new EventEmitter<(entry: DebugConsoleEntry) => void>();
const clearEmitter = new EventEmitter<() => void>();

export function getDebugConsoleEntries(): DebugConsoleEntry[] {
  return entries;
}

export function addDebugConsoleEntry(
  entry: Omit<DebugConsoleEntry, 'id' | 'timestamp'> & { timestamp?: number },
): DebugConsoleEntry {
  const fullEntry: DebugConsoleEntry = {
    ...entry,
    id: nextDebugConsoleId++,
    timestamp: entry.timestamp ?? Date.now(),
  };
  entries = [...entries, fullEntry];
  if (entries.length > MAX_DEBUG_CONSOLE_ENTRIES) {
    entries = entries.slice(entries.length - MAX_DEBUG_CONSOLE_ENTRIES);
  }
  entryEmitter.emit(fullEntry);
  return fullEntry;
}

export function clearDebugConsoleEntries(): void {
  entries = [];
  clearEmitter.emit();
}

export function onDebugConsoleEntry(callback: (entry: DebugConsoleEntry) => void): () => void {
  return entryEmitter.on(callback);
}

export function onDebugConsoleClear(callback: () => void): () => void {
  return clearEmitter.on(callback);
}
