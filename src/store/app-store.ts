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
  webusbAvailability: 'unknown' | 'needs_grant' | 'needs_regrant_android' | 'waiting_for_device' | 'granted';
  lastPortVendorId: number | null;
  lastPortProductId: number | null;
  lastPortSerialNumber: string | null;
  lastSuccessfulBaudRate: BaudRate | null;
  connectedBaudRate: BaudRate | null;
  throughputBytesPerSec: number;
  updateAvailable: boolean;
}

export function createInitialAppState(): AppState {
  return {
    connectionStatus: 'disconnected',
    activeTab: DEFAULT_SETTINGS.activeTab,
    theme: DEFAULT_SETTINGS.theme,
    uiScale: DEFAULT_SETTINGS.uiScale,
    unitProfile: DEFAULT_SETTINGS.unitProfile,
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
    sidebarCollapsed: DEFAULT_SETTINGS.sidebarCollapsed,
    sidebarWidth: DEFAULT_SETTINGS.sidebarWidth,
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
    autoConnect: DEFAULT_SETTINGS.autoConnect,
    autoDetectBaud: DEFAULT_SETTINGS.autoDetectBaud,
    probeStatus: null,
    webusbAvailability: 'unknown',
    lastPortVendorId: DEFAULT_SETTINGS.lastPortVendorId,
    lastPortProductId: DEFAULT_SETTINGS.lastPortProductId,
    lastPortSerialNumber: DEFAULT_SETTINGS.lastPortSerialNumber,
    lastSuccessfulBaudRate: DEFAULT_SETTINGS.lastSuccessfulBaudRate,
    connectedBaudRate: null,
    throughputBytesPerSec: 0,
    updateAvailable: false,
  };
}

export const [appState, setAppState] = createStore<AppState>(createInitialAppState());

type PersistedSettingsState = Pick<
  AppState,
  'activeTab' | 'theme' | 'uiScale' | 'unitProfile' | 'baudRate' | 'bufferCapacity' | 'mapShowPath' |
  'mapTrailLength' | 'mapLayer' | 'mapZoom' | 'mapAutoCenter' | 'sidebarCollapsed' |
  'sidebarWidth' | 'autoConnect' | 'autoDetectBaud' | 'lastSuccessfulBaudRate'
  | 'lastPortVendorId' | 'lastPortProductId' | 'lastPortSerialNumber'
>;

export function applySettingsToAppState(settings: PersistedSettingsState): void {
  batch(() => {
    setAppState('activeTab', settings.activeTab);
    setAppState('theme', settings.theme);
    setAppState('uiScale', settings.uiScale);
    setAppState('unitProfile', settings.unitProfile);
    setAppState('baudRate', settings.baudRate);
    setAppState('bufferCapacity', settings.bufferCapacity);
    setAppState('mapShowPath', settings.mapShowPath);
    setAppState('mapTrailLength', settings.mapTrailLength);
    setAppState('mapLayer', settings.mapLayer);
    setAppState('mapZoom', settings.mapZoom);
    setAppState('mapAutoCenter', settings.mapAutoCenter);
    setAppState('sidebarCollapsed', settings.sidebarCollapsed);
    setAppState('sidebarWidth', settings.sidebarWidth);
    setAppState('autoConnect', settings.autoConnect);
    setAppState('autoDetectBaud', settings.autoDetectBaud);
    setAppState('lastPortVendorId', settings.lastPortVendorId);
    setAppState('lastPortProductId', settings.lastPortProductId);
    setAppState('lastPortSerialNumber', settings.lastPortSerialNumber);
    setAppState('lastSuccessfulBaudRate', settings.lastSuccessfulBaudRate);
  });
}

export function mergeAppStateIntoSettings(settings: typeof DEFAULT_SETTINGS): typeof DEFAULT_SETTINGS {
  return {
    ...settings,
    activeTab: appState.activeTab,
    theme: appState.theme,
    uiScale: appState.uiScale,
    unitProfile: appState.unitProfile,
    baudRate: appState.baudRate,
    bufferCapacity: appState.bufferCapacity,
    mapShowPath: appState.mapShowPath,
    mapTrailLength: appState.mapTrailLength,
    mapLayer: appState.mapLayer,
    mapZoom: appState.mapZoom,
    mapAutoCenter: appState.mapAutoCenter,
    sidebarCollapsed: appState.sidebarCollapsed,
    sidebarWidth: appState.sidebarWidth,
    autoConnect: appState.autoConnect,
    autoDetectBaud: appState.autoDetectBaud,
    lastPortVendorId: appState.lastPortVendorId,
    lastPortProductId: appState.lastPortProductId,
    lastPortSerialNumber: appState.lastPortSerialNumber,
    lastSuccessfulBaudRate: appState.lastSuccessfulBaudRate,
  };
}

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
