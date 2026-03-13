import { createSignal, onCleanup, onMount, batch, type Accessor } from 'solid-js';
import { appState, setAppState, setWorkerBridge, setConnectionManager, setRegistry, setLogViewerService } from '../store';
import {
  MavlinkWorkerBridge,
  ConnectionManager,
  loadSettings,
  loadDialect,
  loadBundledDialect,
  initDialect,
  DEFAULT_SETTINGS,
  LogViewerService,
  recoverStagedSessions,
  type MavDeckSettings,
} from '../services';
import { MavlinkMetadataRegistry } from '../mavlink/registry';

interface BootstrapResult {
  loading: Accessor<boolean>;
  settingsReady: Accessor<boolean>;
  loadedSettings: Accessor<MavDeckSettings>;
}

export function useBootstrap(): BootstrapResult {
  const [loading, setLoading] = createSignal(true);
  const [settingsReady, setSettingsReady] = createSignal(false);
  const [loadedSettings, setLoadedSettings] = createSignal<MavDeckSettings>({ ...DEFAULT_SETTINGS });

  let bridge: MavlinkWorkerBridge | undefined;
  let connMgr: ConnectionManager | undefined;
  let logViewerSvc: LogViewerService | undefined;
  let unsubLogViewer: (() => void) | undefined;
  let unsubLoadComplete: (() => void) | undefined;

  onMount(async () => {
    try {
      await recoverStagedSessions();
      setAppState('logsVersion', v => v + 1);

      // Load persisted settings and apply to store
      const settings = await loadSettings();
      setLoadedSettings(settings);
      batch(() => {
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
      });
      setSettingsReady(true);

      // Load dialect: custom from IndexedDB, or parse bundled XML (never cached)
      let json: string;
      let dialectName: string;

      const cached = await loadDialect();
      if (cached) {
        // Custom dialect was imported previously — restore it
        json = cached.json;
        dialectName = cached.name;
      } else {
        // Default: parse bundled XML every load (fast enough, avoids stale cache)
        dialectName = 'common';
        json = await loadBundledDialect();
      }

      // Initialize registry and worker bridge
      const reg = new MavlinkMetadataRegistry();
      bridge = new MavlinkWorkerBridge();
      await initDialect(bridge, reg, json);
      setRegistry(reg);
      setAppState('dialectName', dialectName);
      setWorkerBridge(bridge);

      // Initialize log viewer service
      logViewerSvc = new LogViewerService(bridge);
      setLogViewerService(logViewerSvc);
      unsubLogViewer = logViewerSvc.subscribe(state => {
        setAppState('logViewerState', state);
      });
      unsubLoadComplete = bridge.onLoadComplete(({ durationSec }) => {
        setAppState('logViewerState', 'durationSec', durationSec);
      });

      // Initialize connection manager
      connMgr = new ConnectionManager(bridge);
      setConnectionManager(connMgr);

      setAppState('isReady', true);
      setLoading(false);
    } catch (err) {
      console.error('MavDeck initialization failed:', err);
      setAppState('connectionStatus', 'error');
      setLoading(false);
    }
  });

  onCleanup(() => {
    unsubLogViewer?.();
    unsubLoadComplete?.();
    logViewerSvc?.unload();
    connMgr?.disconnect();
    connMgr?.dispose();
    bridge?.dispose();
  });

  return { loading, settingsReady, loadedSettings };
}
