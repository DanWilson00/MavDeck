import { EventEmitter } from '../core/event-emitter';

export interface StatusTextLogEntry {
  id: number;
  severity: number;
  text: string;
  timestamp: number;
}

const MAX_STATUS_TEXT_ENTRIES = 100;

let nextStatusTextId = 0;
let entries: StatusTextLogEntry[] = [];

const entryEmitter = new EventEmitter<(entry: StatusTextLogEntry) => void>();
const clearEmitter = new EventEmitter<() => void>();

export function getStatusTextEntries(): StatusTextLogEntry[] {
  return entries;
}

export function addStatusTextEntry(
  entry: Omit<StatusTextLogEntry, 'id'>,
): StatusTextLogEntry {
  const fullEntry: StatusTextLogEntry = {
    ...entry,
    id: nextStatusTextId++,
  };
  entries = [...entries, fullEntry];
  if (entries.length > MAX_STATUS_TEXT_ENTRIES) {
    entries = entries.slice(entries.length - MAX_STATUS_TEXT_ENTRIES);
  }
  entryEmitter.emit(fullEntry);
  return fullEntry;
}

export function clearStatusTextEntries(): void {
  entries = [];
  clearEmitter.emit();
}

export function onStatusTextEntry(callback: (entry: StatusTextLogEntry) => void): () => void {
  return entryEmitter.on(callback);
}

export function onStatusTextClear(callback: () => void): () => void {
  return clearEmitter.on(callback);
}
