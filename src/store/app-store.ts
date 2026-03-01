import { createStore } from 'solid-js/store';
import type { ConnectionStatus } from '../services/worker-bridge';
import type { MavlinkWorkerBridge } from '../services/worker-bridge';
import type { ConnectionManager } from '../services/connection-manager';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { PlotTab } from '../models/plot-config';
import type { BaudRate } from '../services/webserial-byte-source';
import { DEFAULT_BAUD_RATE } from '../services/webserial-byte-source';

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
  isSettingsOpen: boolean;
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
  isSettingsOpen: false,
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
