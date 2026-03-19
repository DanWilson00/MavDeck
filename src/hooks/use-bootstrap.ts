import { createSignal, onCleanup, onMount, type Accessor, type Setter } from 'solid-js';
import { applySettingsToAppState, setAppState } from '../store';
import {
  MavlinkWorkerBridge,
  ConnectionManager,
  loadSettings,
  loadDialect,
  loadBundledDialect,
  loadRemoteDialect,
  normalizeGithubUrl,
  initDialect,
  saveDialect,
  DEFAULT_SETTINGS,
  LogViewerService,
  recoverStagedSessions,
  SerialSessionController,
  logDebugError,
  logDebugInfo,
  logDebugWarn,
  type RuntimeServices,
  type MavDeckSettings,
} from '../services';
import { MavlinkMetadataRegistry } from '../mavlink/registry';
import { bindSessionState } from '../services/session-state-sync';

interface BootstrapResult {
  loading: Accessor<boolean>;
  settingsReady: Accessor<boolean>;
  loadedSettings: Accessor<MavDeckSettings>;
  setLoadedSettings: Setter<MavDeckSettings>;
  runtimeServices: Accessor<RuntimeServices | null>;
}

export function useBootstrap(): BootstrapResult {
  const [loading, setLoading] = createSignal(true);
  const [settingsReady, setSettingsReady] = createSignal(false);
  const [loadedSettings, setLoadedSettings] = createSignal<MavDeckSettings>({ ...DEFAULT_SETTINGS });
  const [runtimeServices, setRuntimeServices] = createSignal<RuntimeServices | null>(null);

  let bridge: MavlinkWorkerBridge | undefined;
  let connMgr: ConnectionManager | undefined;
  let serialController: SerialSessionController | undefined;
  let logViewerSvc: LogViewerService | undefined;
  let unsubLogViewer: (() => void) | undefined;
  let unsubLoadComplete: (() => void) | undefined;
  let unsubThroughput: (() => void) | undefined;
  let unsubSessionState: (() => void) | undefined;

  onMount(async () => {
    try {
      await recoverStagedSessions();
      setAppState('logsVersion', v => v + 1);

      // Load persisted settings and apply to store
      const settings = await loadSettings();
      setLoadedSettings(settings);
      applySettingsToAppState(settings);
      setSettingsReady(true);

      // Load dialect: remote URL → cached → bundled
      let json: string;
      let dialectName: string;

      if (settings.dialectUrl) {
        // Remote dialect URL configured — try to fetch latest
        try {
          const fetchUrl = normalizeGithubUrl(settings.dialectUrl);
          const remote = await loadRemoteDialect(fetchUrl);
          json = remote.json;
          dialectName = remote.name;
          await saveDialect(dialectName, json);
        } catch (err) {
          console.warn('[Bootstrap] Remote dialect fetch failed, trying cache:', err);
          logDebugWarn('bootstrap', 'Remote dialect fetch failed; trying cached dialect', {
            dialectUrl: settings.dialectUrl,
            error: err instanceof Error ? err.message : String(err),
          });
          const cached = await loadDialect();
          if (cached) {
            json = cached.json;
            dialectName = cached.name;
            logDebugInfo('bootstrap', 'Loaded cached dialect after remote fetch failure', {
              dialectName,
            });
          } else {
            console.warn('[Bootstrap] No cached dialect, falling back to bundled');
            logDebugWarn('bootstrap', 'No cached dialect available; falling back to bundled dialect', {
              dialectUrl: settings.dialectUrl,
            });
            dialectName = 'common';
            json = await loadBundledDialect();
          }
        }
      } else {
        // No URL configured — use cached custom or bundled
        const cached = await loadDialect();
        if (cached) {
          json = cached.json;
          dialectName = cached.name;
        } else {
          dialectName = 'common';
          json = await loadBundledDialect();
        }
      }

      // Initialize registry and worker bridge
      const reg = new MavlinkMetadataRegistry();
      bridge = new MavlinkWorkerBridge();
      await initDialect(bridge, reg, json);
      setAppState('dialectName', dialectName);

      // Initialize connection manager
      connMgr = new ConnectionManager(bridge);
      serialController = new SerialSessionController({
        connectionManager: connMgr,
        workerBridge: bridge,
        registry: reg,
      });

      // Initialize log viewer service
      logViewerSvc = new LogViewerService(bridge, serialController);
      serialController.setLogViewerService(logViewerSvc);
      unsubSessionState = bindSessionState(serialController, loadedSettings, setLoadedSettings);
      unsubLogViewer = logViewerSvc.subscribe(state => {
        setAppState('logViewerState', state);
      });
      unsubLoadComplete = bridge.onLoadComplete(({ durationSec }) => {
        setAppState('logViewerState', 'durationSec', durationSec);
      });
      unsubThroughput = bridge.onThroughput(bps => {
        setAppState('throughputBytesPerSec', bps);
      });
      setRuntimeServices({
        workerBridge: bridge,
        connectionManager: connMgr,
        registry: reg,
        logViewerService: logViewerSvc,
        serialSessionController: serialController,
      });

      setAppState('isReady', true);
      setLoading(false);
    } catch (err) {
      console.error('MavDeck initialization failed:', err);
      logDebugError('bootstrap', `MavDeck initialization failed: ${err instanceof Error ? err.message : String(err)}`);
      setAppState('connectionStatus', 'error');
      setLoading(false);
    }
  });

  onCleanup(() => {
    unsubThroughput?.();
    unsubSessionState?.();
    unsubLogViewer?.();
    unsubLoadComplete?.();
    logViewerSvc?.unload();
    connMgr?.disconnect();
    serialController?.dispose();
    connMgr?.dispose();
    bridge?.dispose();
    setRuntimeServices(null);
  });

  return { loading, settingsReady, loadedSettings, setLoadedSettings, runtimeServices };
}
