import { createStore } from 'solid-js/store';
import type { ConnectionStatus } from '../services/worker-bridge';
import type { MavlinkWorkerBridge } from '../services/worker-bridge';
import type { ConnectionManager } from '../services/connection-manager';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { PlotTab, TimeWindow } from '../models/plot-config';
import { DEFAULT_TIME_WINDOW } from '../models/plot-config';
import type { BaudRate } from '../services/webserial-byte-source';
import { DEFAULT_BAUD_RATE } from '../services/webserial-byte-source';
import { DEFAULT_SETTINGS } from '../services/settings-service';

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
});

// Class instances with methods and TypedArrays — MUST NOT go in createStore.
// SolidJS's deep proxy would wrap their internals, breaking class methods.
// Initialized in App.tsx onMount before any UI reads them.
export let workerBridge: MavlinkWorkerBridge = null!;
export let connectionManager: ConnectionManager = null!;
export let registry: MavlinkMetadataRegistry = null!;

export function setWorkerBridge(bridge: MavlinkWorkerBridge): void {
  workerBridge = bridge;
}

export function setConnectionManager(mgr: ConnectionManager): void {
  connectionManager = mgr;
}

export function setRegistry(reg: MavlinkMetadataRegistry): void {
  registry = reg;
}
