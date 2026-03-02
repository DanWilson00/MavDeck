import { createStore } from 'solid-js/store';
import type {
  ConnectionStatus,
  MavlinkWorkerBridge,
  ConnectionManager,
  BaudRate,
  LogViewerService,
  LogViewerState,
} from '../services';
import { DEFAULT_BAUD_RATE, DEFAULT_SETTINGS } from '../services';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { PlotTab, TimeWindow } from '../models';
import { DEFAULT_TIME_WINDOW } from '../models';

export interface AppState {
  connectionStatus: ConnectionStatus;
  theme: 'dark' | 'light';
  uiScale: number;
  activeTab: string;
  activeSubTab: string;
  plotTabs: PlotTab[];
  isPaused: boolean;
  isReady: boolean;
  baudRate: BaudRate;
  bufferCapacity: number;
  isSettingsOpen: boolean;
  timeWindow: TimeWindow;
  addPlotCounter: number;
  mapShowPath: boolean;
  mapTrailLength: number;
  mapLayer: 'street' | 'satellite';
  mapZoom: number;
  mapAutoCenter: boolean;
  isLogPaneCollapsed: boolean;
  offlineReady: boolean;
  offlineStatus: 'checking' | 'ready' | 'error' | 'unsupported';
  offlineError: string | null;
  logsVersion: number;
  logViewerState: LogViewerState;
}

export const [appState, setAppState] = createStore<AppState>({
  connectionStatus: 'disconnected',
  theme: 'dark',
  uiScale: 1,
  activeTab: 'telemetry',
  activeSubTab: 'default',
  plotTabs: [{ id: 'default', name: 'Tab 1', plots: [] }],
  isPaused: false,
  isReady: false,
  baudRate: DEFAULT_BAUD_RATE,
  bufferCapacity: DEFAULT_SETTINGS.bufferCapacity,
  isSettingsOpen: false,
  timeWindow: DEFAULT_TIME_WINDOW,
  addPlotCounter: 0,
  mapShowPath: DEFAULT_SETTINGS.mapShowPath,
  mapTrailLength: DEFAULT_SETTINGS.mapTrailLength,
  mapLayer: DEFAULT_SETTINGS.mapLayer,
  mapZoom: DEFAULT_SETTINGS.mapZoom,
  mapAutoCenter: DEFAULT_SETTINGS.mapAutoCenter,
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
});

// Class instances with methods and TypedArrays — MUST NOT go in createStore.
// SolidJS's deep proxy would wrap their internals, breaking class methods.
// Initialized in App.tsx onMount before any UI reads them.
export let workerBridge: MavlinkWorkerBridge = null!;
export let connectionManager: ConnectionManager = null!;
export let registry: MavlinkMetadataRegistry = null!;
export let logViewerService: LogViewerService = null!;

export function setWorkerBridge(bridge: MavlinkWorkerBridge): void {
  workerBridge = bridge;
}

export function setConnectionManager(mgr: ConnectionManager): void {
  connectionManager = mgr;
}

export function setRegistry(reg: MavlinkMetadataRegistry): void {
  registry = reg;
}

export function setLogViewerService(service: LogViewerService): void {
  logViewerService = service;
}
