import { createEffect, createSignal } from 'solid-js';
import { appState, setAppState } from '../store';
import {
  clearAllLogs,
  deleteLogFile,
  exportLogFile,
  getLogMetadata,
  listLogs,
  parseTlogBytes,
  readLogFile,
  setLogMetadata,
  type LogLibraryEntry,
  logDebugError,
  useLogViewerService,
} from '../services';

export interface EditingState {
  fileName: string;
  displayName: string;
  notes: string;
}

export interface DeletingState {
  fileName: string;
  displayName: string;
}

export function useLogLibrary() {
  const logViewerService = useLogViewerService();
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
      logDebugError('logs', `Failed to list logs: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[LogLibraryPane] Failed to list logs:', err);
      setError('Failed to load logs library.');
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    appState.logsVersion;
    void reload();
  });

  async function handleLoad(fileName: string) {
    setBusyFile(fileName);
    try {
      const bytes = await readLogFile(fileName);
      const records = parseTlogBytes(bytes);
      logViewerService.load(records, fileName);
      setAppState('isPaused', true);
    } catch (err) {
      logDebugError('logs', `Failed to load log "${fileName}": ${err instanceof Error ? err.message : String(err)}`, {
        fileName,
      });
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
      setAppState('logsVersion', value => value + 1);
    } catch (err) {
      logDebugError('logs', `Failed to save log metadata for "${current.fileName}": ${err instanceof Error ? err.message : String(err)}`, {
        fileName: current.fileName,
      });
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

  async function unloadIfActive(fileName: string) {
    if (appState.logViewerState.isActive && appState.logViewerState.sourceName === fileName) {
      logViewerService.unload();
    }
  }

  async function confirmDelete() {
    const current = deleting();
    if (!current) return;
    setBusyFile(current.fileName);
    try {
      await deleteLogFile(current.fileName);
      await unloadIfActive(current.fileName);
      setDeleting(null);
      setAppState('logsVersion', value => value + 1);
    } catch (err) {
      logDebugError('logs', `Failed to delete log "${current.fileName}": ${err instanceof Error ? err.message : String(err)}`, {
        fileName: current.fileName,
      });
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
      setAppState('logsVersion', value => value + 1);
    } catch (err) {
      logDebugError('logs', `Failed to clear all logs: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[LogLibraryPane] Failed to clear all logs:', err);
      setError('Failed to clear all logs.');
      setClearingAll(false);
    }
  }

  async function confirmDeleteSelected() {
    const files = [...selectedFiles()];
    try {
      for (const fileName of files) {
        await unloadIfActive(fileName);
        await deleteLogFile(fileName);
      }
      setSelectedFiles(new Set<string>());
      setDeletingSelected(false);
      setAppState('logsVersion', value => value + 1);
    } catch (err) {
      logDebugError('logs', `Failed to delete selected logs: ${err instanceof Error ? err.message : String(err)}`, {
        fileCount: files.length,
      });
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

  function toggleCollapse() {
    setAppState('isLogPaneCollapsed', value => !value);
  }

  function isLoaded(fileName: string): boolean {
    return appState.logViewerState.isActive && appState.logViewerState.sourceName === fileName;
  }

  return {
    entries,
    loading,
    error,
    editing,
    deleting,
    busyFile,
    menuOpenFile,
    clearingAll,
    selectedFiles,
    lastClickedFile,
    deletingSelected,
    setEditing,
    setDeleting,
    setMenuOpenFile,
    setClearingAll,
    setSelectedFiles,
    setLastClickedFile,
    setDeletingSelected,
    reload,
    handleLoad,
    handleUnload,
    openEdit,
    saveEdit,
    handleExport,
    openDelete,
    confirmDelete,
    confirmClearAll,
    confirmDeleteSelected,
    formatSize,
    toggleCollapse,
    isLoaded,
  };
}
