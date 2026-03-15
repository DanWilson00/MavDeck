import { batch } from 'solid-js';
import { createStore } from 'solid-js/store';
import type {
  ConnectionStatus,
  BaudRate,
  UnitProfile,
  LogViewerState,
} from '../services';
import { DEFAULT_BAUD_RATE, DEFAULT_SETTINGS } from '../services';
import type { PlotTab, TimeWindow } from '../models';
import { DEFAULT_TIME_WINDOW } from '../models';

export interface AppState {
  connectionStatus: ConnectionStatus;
  theme: 'dark' | 'light';
  uiScale: number;
  unitProfile: UnitProfile;
  activeTab: string;
  activeSubTab: string;
  plotTabs: PlotTab[];
  isPaused: boolean;
  isReady: boolean;
  baudRate: BaudRate;
  bufferCapacity: number;
  isSettingsOpen: boolean;
  isHelpOpen: boolean;
  timeWindow: TimeWindow;
  addPlotCounter: number;
  mapShowPath: boolean;
  mapTrailLength: number;
  mapLayer: 'street' | 'satellite';
  mapZoom: number;
  mapAutoCenter: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  isLogPaneCollapsed: boolean;
  offlineReady: boolean;
  offlineStatus: 'checking' | 'ready' | 'error' | 'unsupported';
  offlineError: string | null;
  logsVersion: number;
  logViewerState: LogViewerState;
  dialectName: string;
  connectionSourceType: 'serial' | 'spoof' | null;
  autoConnect: boolean;
  autoDetectBaud: boolean;
  probeStatus: string | null;
  lastSuccessfulBaudRate: BaudRate | null;
  connectedBaudRate: BaudRate | null;
  throughputBytesPerSec: number;
}

export const [appState, setAppState] = createStore<AppState>({
  connectionStatus: 'disconnected',
  theme: 'dark',
  uiScale: 1,
  unitProfile: DEFAULT_SETTINGS.unitProfile,
  activeTab: 'telemetry',
  activeSubTab: 'default',
  plotTabs: [{ id: 'default', name: 'Tab 1', plots: [] }],
  isPaused: false,
  isReady: false,
  baudRate: DEFAULT_BAUD_RATE,
  bufferCapacity: DEFAULT_SETTINGS.bufferCapacity,
  isSettingsOpen: false,
  isHelpOpen: false,
  timeWindow: DEFAULT_TIME_WINDOW,
  addPlotCounter: 0,
  mapShowPath: DEFAULT_SETTINGS.mapShowPath,
  mapTrailLength: DEFAULT_SETTINGS.mapTrailLength,
  mapLayer: DEFAULT_SETTINGS.mapLayer,
  mapZoom: DEFAULT_SETTINGS.mapZoom,
  mapAutoCenter: DEFAULT_SETTINGS.mapAutoCenter,
  sidebarCollapsed: false,
  sidebarWidth: 350,
  isLogPaneCollapsed: true,
  offlineReady: false,
  offlineStatus: 'checking',
  offlineError: null,
  logsVersion: 0,
  logViewerState: {
    isActive: false,
    sourceName: '',
    durationSec: 0,
    recordCount: 0,
  },
  dialectName: '',
  connectionSourceType: null,
  autoConnect: false,
  autoDetectBaud: false,
  probeStatus: null,
  lastSuccessfulBaudRate: null,
  connectedBaudRate: null,
  throughputBytesPerSec: 0,
});

// ---------------------------------------------------------------------------
// Tab management actions
// ---------------------------------------------------------------------------

function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function nextTabNumber(): number {
  let max = 0;
  for (const tab of appState.plotTabs) {
    const match = tab.name.match(/^Tab (\d+)$/);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return max + 1;
}

/** Create a new plot tab with an auto-generated name, set it active, and return its id. */
export function addPlotTab(): string {
  const id = generateTabId();
  const name = `Tab ${nextTabNumber()}`;
  const newTab: PlotTab = { id, name, plots: [] };
  batch(() => {
    setAppState('plotTabs', tabs => [...tabs, newTab]);
    setAppState('activeSubTab', id);
  });
  return id;
}

/** Delete a plot tab. If it was the last tab, a fresh "Tab 1" replaces it. Switches to a neighbor if deleting the active tab. */
export function deletePlotTab(tabId: string): void {
  batch(() => {
    const tabs = appState.plotTabs;
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    if (tabs.length === 1) {
      // Last tab — replace with a fresh default
      const freshId = generateTabId();
      setAppState('plotTabs', [{ id: freshId, name: 'Tab 1', plots: [] }]);
      setAppState('activeSubTab', freshId);
      return;
    }

    // If deleting the active tab, switch to a neighbor
    if (appState.activeSubTab === tabId) {
      const neighborIdx = idx > 0 ? idx - 1 : 1;
      setAppState('activeSubTab', tabs[neighborIdx].id);
    }

    setAppState('plotTabs', tabs => tabs.filter(t => t.id !== tabId));
  });
}

/** Rename a plot tab. Rejects empty names after trimming. */
export function renamePlotTab(tabId: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;

  const idx = appState.plotTabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;

  setAppState('plotTabs', idx, 'name', trimmed);
}

/** Reorder plot tabs by moving the tab at fromIdx to toIdx (splice-based). */
export function reorderPlotTabs(fromIdx: number, toIdx: number): void {
  if (fromIdx === toIdx) return;
  const tabs = [...appState.plotTabs];
  if (fromIdx < 0 || fromIdx >= tabs.length || toIdx < 0 || toIdx >= tabs.length) return;

  const [moved] = tabs.splice(fromIdx, 1);
  tabs.splice(toIdx, 0, moved);
  setAppState('plotTabs', tabs);
}

/** Switch the active sub-tab. */
export function setActiveSubTab(tabId: string): void {
  if (!appState.plotTabs.some(t => t.id === tabId)) return;
  setAppState('activeSubTab', tabId);
}
