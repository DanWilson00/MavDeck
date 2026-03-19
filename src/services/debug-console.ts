import { EventEmitter } from '../core/event-emitter';

export const DEBUG_CONSOLE_SOURCES = [
  'app',
  'bootstrap',
  'layout',
  'logs',
  'metadata-ftp',
  'parameters',
  'serial',
  'settings',
  'worker',
] as const;

export type DebugConsoleSource = typeof DEBUG_CONSOLE_SOURCES[number];
export type DebugConsoleLevel = 'debug' | 'info' | 'warn' | 'error';

export const DEBUG_CONSOLE_SOURCE_LABELS: Record<DebugConsoleSource, string> = {
  app: 'App',
  bootstrap: 'Bootstrap',
  layout: 'Layout',
  logs: 'Logs',
  'metadata-ftp': 'Metadata FTP',
  parameters: 'Parameters',
  serial: 'Serial',
  settings: 'Settings',
  worker: 'Worker',
};

export interface DebugConsoleEntry {
  id: number;
  source: DebugConsoleSource;
  level: DebugConsoleLevel;
  message: string;
  timestamp: number;
  body?: string;
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

export function logDebugEvent(
  source: DebugConsoleSource,
  level: DebugConsoleLevel,
  message: string,
  details?: Record<string, string | number | boolean | null>,
  body?: string,
): DebugConsoleEntry {
  return addDebugConsoleEntry({ source, level, message, details, body });
}

export function logDebugInfo(
  source: DebugConsoleSource,
  message: string,
  details?: Record<string, string | number | boolean | null>,
  body?: string,
): DebugConsoleEntry {
  return logDebugEvent(source, 'info', message, details, body);
}

export function logDebugWarn(
  source: DebugConsoleSource,
  message: string,
  details?: Record<string, string | number | boolean | null>,
  body?: string,
): DebugConsoleEntry {
  return logDebugEvent(source, 'warn', message, details, body);
}

export function logDebugError(
  source: DebugConsoleSource,
  message: string,
  details?: Record<string, string | number | boolean | null>,
  body?: string,
): DebugConsoleEntry {
  return logDebugEvent(source, 'error', message, details, body);
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
