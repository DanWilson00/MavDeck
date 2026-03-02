import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { appState, logViewerService, setAppState } from '../store';
import {
  clearAllLogs,
  deleteLogFile,
  exportLogFile,
  getLogMetadata,
  listLogs,
  readLogFile,
  setLogMetadata,
  parseTlogBytes,
  type LogLibraryEntry,
} from '../services';

interface EditingState {
  fileName: string;
  displayName: string;
  notes: string;
}

interface DeletingState {
  fileName: string;
  displayName: string;
}

export default function LogLibraryPane() {
  const [entries, setEntries] = createSignal<LogLibraryEntry[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<EditingState | null>(null);
  const [deleting, setDeleting] = createSignal<DeletingState | null>(null);
  const [busyFile, setBusyFile] = createSignal<string | null>(null);
  const [menuOpenFile, setMenuOpenFile] = createSignal<string | null>(null);
  const [clearingAll, setClearingAll] = createSignal(false);
  const [selectedFiles, setSelectedFiles] = createSignal<Set<string>>(new Set());
  const [lastClickedFile, setLastClickedFile] = createSignal<string | null>(null);
  const [deletingSelected, setDeletingSelected] = createSignal(false);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setEntries(await listLogs());
    } catch (err) {
      console.error('[LogLibraryPane] Failed to list logs:', err);
      setError('Failed to load logs library.');
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    appState.logsVersion;
    reload();
  });

  // Close overflow menu on outside click
  function handleDocumentClick(e: MouseEvent) {
    if (menuOpenFile() === null) return;
    const target = e.target as HTMLElement;
    if (!target.closest('[data-log-menu]')) {
      setMenuOpenFile(null);
    }
  }

  onMount(() => {
    document.addEventListener('click', handleDocumentClick, true);
  });
  onCleanup(() => {
    document.removeEventListener('click', handleDocumentClick, true);
  });

  async function handleLoad(fileName: string) {
    setBusyFile(fileName);
    try {
      const bytes = await readLogFile(fileName);
      const records = parseTlogBytes(bytes);
      logViewerService.load(records, fileName);
      setAppState('isPaused', true);
    } catch (err) {
      console.error('[LogLibraryPane] Failed to load log:', err);
      setError(`Failed to load "${fileName}".`);
    } finally {
      setBusyFile(null);
    }
  }

  function handleUnload() {
    logViewerService.unload();
  }

  async function openEdit(fileName: string) {
    setMenuOpenFile(null);
    const meta = await getLogMetadata(fileName);
    setEditing({
      fileName,
      displayName: meta.displayName,
      notes: meta.notes,
    });
  }

  async function saveEdit() {
    const current = editing();
    if (!current) return;
    setBusyFile(current.fileName);
    try {
      await setLogMetadata(current.fileName, {
        displayName: current.displayName,
        notes: current.notes,
      });
      setEditing(null);
      setAppState('logsVersion', v => v + 1);
    } catch (err) {
      console.error('[LogLibraryPane] Failed to save log metadata:', err);
      setError('Failed to save log changes.');
    } finally {
      setBusyFile(null);
    }
  }

  function handleExport(fileName: string) {
    setMenuOpenFile(null);
    exportLogFile(fileName);
  }

  function openDelete(fileName: string, displayName: string) {
    setMenuOpenFile(null);
    setDeleting({ fileName, displayName });
  }

  async function confirmDelete() {
    const current = deleting();
    if (!current) return;
    setBusyFile(current.fileName);
    try {
      await deleteLogFile(current.fileName);
      if (appState.logViewerState.isActive && appState.logViewerState.sourceName === current.fileName) {
        logViewerService.unload();
      }
      setDeleting(null);
      setAppState('logsVersion', v => v + 1);
    } catch (err) {
      console.error('[LogLibraryPane] Failed to delete log:', err);
      setError('Failed to delete log.');
    } finally {
      setBusyFile(null);
    }
  }

  async function confirmClearAll() {
    try {
      if (appState.logViewerState.isActive) {
        logViewerService.unload();
      }
      await clearAllLogs();
      setClearingAll(false);
      setAppState('logsVersion', v => v + 1);
    } catch (err) {
      console.error('[LogLibraryPane] Failed to clear all logs:', err);
      setError('Failed to clear all logs.');
      setClearingAll(false);
    }
  }

  async function confirmDeleteSelected() {
    const files = [...selectedFiles()];
    try {
      for (const fileName of files) {
        if (appState.logViewerState.isActive && appState.logViewerState.sourceName === fileName) {
          logViewerService.unload();
        }
        await deleteLogFile(fileName);
      }
      setSelectedFiles(new Set());
      setDeletingSelected(false);
      setAppState('logsVersion', v => v + 1);
    } catch (err) {
      console.error('[LogLibraryPane] Failed to delete selected logs:', err);
      setError('Failed to delete some logs.');
      setDeletingSelected(false);
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatTime(ms: number): string {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function toggleCollapse() {
    setAppState('isLogPaneCollapsed', prev => !prev);
  }

  function isLoaded(fileName: string): boolean {
    return appState.logViewerState.isActive && appState.logViewerState.sourceName === fileName;
  }

  return (
    <div class="flex flex-col select-none" style={{ 'max-height': '40%' }}>
      {/* Collapsible header */}
      <div
        class="flex items-center justify-between w-full px-3 py-2 text-xs font-semibold uppercase tracking-wide cursor-pointer interactive-hover"
        style={{ color: 'var(--text-secondary)', 'background-color': 'var(--bg-panel)' }}
        onClick={toggleCollapse}
      >
        <div class="flex items-center gap-1.5">
          <span style={{ 'font-size': '10px', 'line-height': '1' }}>
            {appState.isLogPaneCollapsed ? '\u25B8' : '\u25BE'}
          </span>
          <span>Logs</span>
        </div>
        <div class="flex items-center gap-1">
          <Show when={selectedFiles().size > 0}>
            <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {selectedFiles().size} selected
            </span>
          </Show>
          <Show when={entries().length > 0}>
            <button
              class="p-0.5 rounded interactive-hover"
              style={{ color: selectedFiles().size > 0 ? '#ef4444' : 'var(--text-secondary)' }}
              title={selectedFiles().size > 0 ? `Delete ${selectedFiles().size} selected` : 'Clear all logs'}
              onClick={(e) => {
                e.stopPropagation();
                if (selectedFiles().size > 0) setDeletingSelected(true);
                else setClearingAll(true);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
              </svg>
            </button>
          </Show>
          <button
            class="p-0.5 rounded interactive-hover"
            style={{ color: 'var(--text-secondary)' }}
            title="Refresh logs"
            onClick={(e) => { e.stopPropagation(); reload(); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Collapsible body */}
      <Show when={!appState.isLogPaneCollapsed}>
        <div class="flex-1 min-h-0 overflow-y-auto">
          {/* Error banner */}
          <Show when={error()}>
            {(msg) => (
              <div class="text-xs px-3 py-1.5 mx-2 mt-1 rounded" style={{ color: '#ef4444', 'background-color': 'rgba(239,68,68,0.1)' }}>
                {msg()}
              </div>
            )}
          </Show>

          <Show when={!loading()} fallback={
            <div class="text-xs px-3 py-2" style={{ color: 'var(--text-secondary)' }}>Loading...</div>
          }>
            <Show
              when={entries().length > 0}
              fallback={
                <div class="text-xs px-3 py-2" style={{ color: 'var(--text-secondary)' }}>No logs yet.</div>
              }
            >
              <div class="py-0.5">
                <For each={entries()}>
                  {(entry) => {
                    const loaded = () => isLoaded(entry.fileName);
                    const busy = () => busyFile() === entry.fileName;
                    const menuOpen = () => menuOpenFile() === entry.fileName;
                    const selected = () => selectedFiles().has(entry.fileName);

                    return (
                      <div
                        class="group relative flex items-center gap-2 px-3 py-1.5 cursor-pointer interactive-hover"
                        style={{
                          'border-left': loaded() ? '3px solid var(--accent)' : selected() ? '3px solid var(--text-secondary)' : '3px solid transparent',
                          'background-color': loaded() ? 'rgba(59,130,246,0.08)' : selected() ? 'rgba(255,255,255,0.04)' : 'transparent',
                          opacity: busy() ? '0.6' : '1',
                        }}
                        onClick={(e) => {
                          if (busy()) return;
                          if (e.ctrlKey || e.metaKey) {
                            // Multi-select toggle
                            setSelectedFiles(prev => {
                              const next = new Set(prev);
                              // If starting multi-select while a log is loaded, include it
                              const activeName = appState.logViewerState.isActive ? appState.logViewerState.sourceName : null;
                              if (next.size === 0 && activeName && activeName !== entry.fileName) {
                                next.add(activeName);
                              }
                              if (next.has(entry.fileName)) next.delete(entry.fileName);
                              else next.add(entry.fileName);
                              return next;
                            });
                            setLastClickedFile(entry.fileName);
                            return;
                          }
                          if (e.shiftKey) {
                            // Range select — seed anchor from loaded log if no prior click
                            const anchor = lastClickedFile() || (appState.logViewerState.isActive ? appState.logViewerState.sourceName : null);
                            if (!anchor) return;
                            const list = entries();
                            const anchorIdx = list.findIndex(e => e.fileName === anchor);
                            const targetIdx = list.findIndex(e => e.fileName === entry.fileName);
                            if (anchorIdx !== -1 && targetIdx !== -1) {
                              const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
                              setSelectedFiles(prev => {
                                const next = new Set(prev);
                                for (let i = lo; i <= hi; i++) next.add(list[i].fileName);
                                return next;
                              });
                            }
                            if (!lastClickedFile()) setLastClickedFile(anchor);
                            return;
                          }
                          // Normal click — clear selection, load/unload
                          if (selectedFiles().size > 0) setSelectedFiles(new Set());
                          setLastClickedFile(entry.fileName);
                          if (loaded()) {
                            handleUnload();
                          } else {
                            handleLoad(entry.fileName);
                          }
                        }}
                      >
                        {/* Name + time */}
                        <div class="flex-1 min-w-0 flex items-center gap-2">
                          <span
                            class="text-xs truncate"
                            style={{ color: 'var(--text-primary)' }}
                            title={entry.displayName}
                          >
                            {entry.displayName}
                          </span>
                        </div>

                        {/* Size */}
                        <span class="text-xs whitespace-nowrap flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
                          {formatSize(entry.sizeBytes)}
                        </span>

                        {/* Delete button (X) — visible on hover or when loaded */}
                        <button
                          class="flex-shrink-0 rounded-full interactive-hover"
                          style={{
                            width: '16px',
                            height: '16px',
                            display: 'flex',
                            'align-items': 'center',
                            'justify-content': 'center',
                            color: '#ef4444',
                            visibility: loaded() ? 'visible' : undefined,
                          }}
                          classList={{
                            'invisible group-hover:visible': !loaded(),
                          }}
                          title="Delete log"
                          onClick={(e) => { e.stopPropagation(); openDelete(entry.fileName, entry.displayName); }}
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                            <line x1="2" y1="2" x2="8" y2="8" />
                            <line x1="8" y1="2" x2="2" y2="8" />
                          </svg>
                        </button>

                        {/* Overflow menu trigger - visible on hover or when menu is open */}
                        <div
                          data-log-menu
                          class="relative flex-shrink-0"
                          style={{
                            visibility: menuOpen() ? 'visible' : undefined,
                          }}
                          classList={{
                            'invisible group-hover:visible': !menuOpen(),
                          }}
                        >
                          <button
                            class="rounded interactive-hover px-0.5"
                            style={{ color: 'var(--text-secondary)', 'font-size': '14px', 'line-height': '1' }}
                            title="More actions"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpenFile(prev => prev === entry.fileName ? null : entry.fileName);
                            }}
                          >
                            &#x22EF;
                          </button>

                          {/* Dropdown menu */}
                          <Show when={menuOpen()}>
                            <div
                              data-log-menu
                              class="absolute right-0 top-full z-50 mt-1 rounded border shadow-lg py-1"
                              style={{
                                'background-color': 'var(--bg-panel)',
                                border: '1px solid var(--border)',
                                'min-width': '120px',
                              }}
                            >
                              <button
                                class="w-full text-left px-3 py-1.5 text-xs interactive-hover"
                                style={{ color: 'var(--text-primary)' }}
                                onClick={(e) => { e.stopPropagation(); openEdit(entry.fileName); }}
                              >
                                Rename
                              </button>
                              <button
                                class="w-full text-left px-3 py-1.5 text-xs interactive-hover"
                                style={{ color: 'var(--text-primary)' }}
                                onClick={(e) => { e.stopPropagation(); handleExport(entry.fileName); }}
                              >
                                Export
                              </button>
                              <button
                                class="w-full text-left px-3 py-1.5 text-xs interactive-hover"
                                style={{ color: '#ef4444' }}
                                onClick={(e) => { e.stopPropagation(); openDelete(entry.fileName, entry.displayName); }}
                              >
                                Delete
                              </button>
                            </div>
                          </Show>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </Show>

      {/* Edit modal */}
      <Show when={editing()}>
        {(current) => (
          <div class="fixed inset-0 z-[9998] flex items-center justify-center" style={{ 'background-color': 'rgba(0,0,0,0.45)' }}>
            <div class="w-[520px] max-w-[92vw] rounded-lg border p-4 space-y-3" style={{ border: '1px solid var(--border)', 'background-color': 'var(--bg-panel)' }}>
              <h3 class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Edit Log</h3>
              <div>
                <label class="text-xs" style={{ color: 'var(--text-secondary)' }}>Display Name</label>
                <input
                  type="text"
                  value={current().displayName}
                  class="w-full mt-1 rounded px-2 py-1.5 text-sm"
                  style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                  onInput={(e) => setEditing(prev => prev ? { ...prev, displayName: e.currentTarget.value } : prev)}
                />
              </div>
              <div>
                <label class="text-xs" style={{ color: 'var(--text-secondary)' }}>Notes</label>
                <textarea
                  value={current().notes}
                  rows={5}
                  class="w-full mt-1 rounded px-2 py-1.5 text-sm"
                  style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                  onInput={(e) => setEditing(prev => prev ? { ...prev, notes: e.currentTarget.value } : prev)}
                />
              </div>
              <div class="flex justify-end gap-2">
                <button
                  class="px-3 py-1.5 rounded text-xs interactive-hover"
                  style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-primary)' }}
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
                <button
                  class="px-3 py-1.5 rounded text-xs interactive-hover"
                  style={{ 'background-color': 'var(--accent)', color: '#000' }}
                  onClick={saveEdit}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* Delete confirmation modal */}
      <Show when={deleting()}>
        {(current) => (
          <div class="fixed inset-0 z-[9998] flex items-center justify-center" style={{ 'background-color': 'rgba(0,0,0,0.45)' }}>
            <div class="w-[480px] max-w-[92vw] rounded-lg border p-4 space-y-3" style={{ border: '1px solid var(--border)', 'background-color': 'var(--bg-panel)' }}>
              <h3 class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Delete Log</h3>
              <p class="text-xs" style={{ color: 'var(--text-secondary)' }}>
                This will permanently delete <span style={{ color: 'var(--text-primary)' }}>{current().displayName}</span>.
              </p>
              <div class="flex justify-end gap-2">
                <button
                  class="px-3 py-1.5 rounded text-xs interactive-hover"
                  style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-primary)' }}
                  onClick={() => setDeleting(null)}
                >
                  Cancel
                </button>
                <button
                  class="px-3 py-1.5 rounded text-xs interactive-hover"
                  style={{ 'background-color': '#7f1d1d', color: '#fecaca' }}
                  onClick={confirmDelete}
                >
                  Delete Log
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
      {/* Delete Selected confirmation modal */}
      <Show when={deletingSelected()}>
        <div class="fixed inset-0 z-[9998] flex items-center justify-center" style={{ 'background-color': 'rgba(0,0,0,0.45)' }}>
          <div class="w-[480px] max-w-[92vw] rounded-lg border p-4 space-y-3" style={{ border: '1px solid var(--border)', 'background-color': 'var(--bg-panel)' }}>
            <h3 class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Delete Selected Logs</h3>
            <p class="text-xs" style={{ color: 'var(--text-secondary)' }}>
              This will permanently delete <span style={{ color: 'var(--text-primary)' }}>{selectedFiles().size}</span> log{selectedFiles().size !== 1 ? 's' : ''}.
            </p>
            <div class="flex justify-end gap-2">
              <button
                class="px-3 py-1.5 rounded text-xs interactive-hover"
                style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-primary)' }}
                onClick={() => setDeletingSelected(false)}
              >
                Cancel
              </button>
              <button
                class="px-3 py-1.5 rounded text-xs interactive-hover"
                style={{ 'background-color': '#7f1d1d', color: '#fecaca' }}
                onClick={confirmDeleteSelected}
              >
                Delete {selectedFiles().size} Log{selectedFiles().size !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Clear All confirmation modal */}
      <Show when={clearingAll()}>
        <div class="fixed inset-0 z-[9998] flex items-center justify-center" style={{ 'background-color': 'rgba(0,0,0,0.45)' }}>
          <div class="w-[480px] max-w-[92vw] rounded-lg border p-4 space-y-3" style={{ border: '1px solid var(--border)', 'background-color': 'var(--bg-panel)' }}>
            <h3 class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Clear All Logs</h3>
            <p class="text-xs" style={{ color: 'var(--text-secondary)' }}>
              This will permanently delete all <span style={{ color: 'var(--text-primary)' }}>{entries().length}</span> log{entries().length !== 1 ? 's' : ''}.
            </p>
            <div class="flex justify-end gap-2">
              <button
                class="px-3 py-1.5 rounded text-xs interactive-hover"
                style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-primary)' }}
                onClick={() => setClearingAll(false)}
              >
                Cancel
              </button>
              <button
                class="px-3 py-1.5 rounded text-xs interactive-hover"
                style={{ 'background-color': '#7f1d1d', color: '#fecaca' }}
                onClick={confirmClearAll}
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
