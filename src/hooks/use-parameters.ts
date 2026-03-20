import { createSignal, createMemo, createEffect, createRoot } from 'solid-js';
import { useWorkerBridge, logDebugError, logDebugEvent, logDebugInfo, logDebugWarn, type ConnectionStatus } from '../services';
import type { ParameterStateSnapshot, ParamSetResult, ParamFetchStatus } from '../services/parameter-types';
import type { ParamDef } from '../models/parameter-metadata';
import { parseMetadata } from '../services/param-metadata-service';
import {
  buildParamGroups,
  type ParamWithMeta,
  type ArrayParamGroup,
  type ParamGroup,
} from '../services/parameter-grouping';
import { appState } from '../store';

export type { ParamWithMeta, ArrayParamGroup, ParamGroup } from '../services/parameter-grouping';

type MetadataStatusKind = 'idle' | 'loading' | 'success' | 'error';
type MetadataStatusSource = 'device' | 'cache' | 'file' | null;

export interface MetadataStatus {
  kind: MetadataStatusKind;
  source: MetadataStatusSource;
  message: string;
}

// Module-level state — persists across tab switches (component mount/unmount cycles)
const [paramState, setParamState] = createSignal<ParameterStateSnapshot>({
  params: {}, totalCount: 0, receivedCount: 0, fetchStatus: 'idle', error: null,
});
const [metadata, setMetadata] = createSignal<Map<string, ParamDef> | null>(null);
const [lastSetResult, setLastSetResult] = createSignal<ParamSetResult | null>(null);
const [metadataLoading, setMetadataLoading] = createSignal(false);
const [metadataStatus, setMetadataStatus] = createSignal<MetadataStatus>({
  kind: 'idle',
  source: null,
  message: '',
});

let bridgeInitialized = false;
let bridgeRef: ReturnType<typeof useWorkerBridge> | null = null;
let lastParamFetchError: string | null = null;
let lastParamSetFailureKey: string | null = null;

function ensureBridge(bridge: ReturnType<typeof useWorkerBridge>) {
  if (bridgeInitialized) return;
  bridgeInitialized = true;
  bridgeRef = bridge;

  // App-lifetime subscriptions — never unsubscribed
  bridge.onParamState(state => {
    setParamState(state);
    if (state.fetchStatus === 'error' && state.error && state.error !== lastParamFetchError) {
      lastParamFetchError = state.error;
      logDebugError('parameters', `Parameter fetch failed: ${state.error}`, {
        receivedCount: state.receivedCount,
        totalCount: state.totalCount,
      });
    } else if (state.fetchStatus !== 'error') {
      lastParamFetchError = null;
    }
  });
  bridge.onParamSetResult(result => {
    setLastSetResult(result);
    if (!result.success) {
      const failureKey = `${result.paramId}:${result.error}`;
      if (failureKey !== lastParamSetFailureKey) {
        lastParamSetFailureKey = failureKey;
        logDebugWarn('parameters', `Parameter set failed for ${result.paramId}`, {
          requestedValue: result.requestedValue,
          actualValue: result.actualValue,
          error: result.error ?? null,
        });
      }
    } else {
      lastParamSetFailureKey = null;
    }
    setTimeout(() => setLastSetResult(null), 3000);
  });

  // Auto-read params on connection, auto-download metadata when done
  createRoot(() => {
    let prevConnectionStatus: ConnectionStatus = 'disconnected';
    let prevFetchStatus: ParamFetchStatus = 'idle';

    createEffect(() => {
      const status = appState.connectionStatus;
      const wasConnected = prevConnectionStatus === 'connected' || prevConnectionStatus === 'no_data';
      const isNowConnected = status === 'connected' || status === 'no_data';
      prevConnectionStatus = status;

      if (isNowConnected && !wasConnected && !appState.logViewerState.isActive) {
        resetParamState();
        bridge.requestAllParams();
      } else if (!isNowConnected && wasConnected) {
        resetParamState();
        setMetadata(null);
        setMetadataStatus({ kind: 'idle', source: null, message: '' });
      }
    });

    createEffect(() => {
      const fetchStatus = paramState().fetchStatus;
      const wasDone = prevFetchStatus === 'done';
      prevFetchStatus = fetchStatus;

      if (fetchStatus === 'done' && !wasDone && metadata() === null && !appState.logViewerState.isActive) {
        downloadMetadataFromDevice();
      }
    });
  });
}

function resetParamState() {
  setParamState({ params: {}, totalCount: 0, receivedCount: 0, fetchStatus: 'idle', error: null });
}

// Metadata lookup (flat map by name) — now just returns the parsed Map directly
const metadataLookup = createMemo(() => {
  return metadata() ?? new Map<string, ParamDef>();
});

// Grouped params: merge device values with metadata, group by shortDesc prefix
const groupedParams = createMemo((): ParamGroup[] => {
  const state = paramState();
  const lookup = metadataLookup();
  return buildParamGroups(state, lookup, metadata() !== null);
});

// Actions
function requestAll() {
  bridgeRef?.requestAllParams();
}

function setParam(paramId: string, value: number) {
  bridgeRef?.setParam(paramId, value);
}

async function loadMetadataFromUrl(url: string) {
  setMetadataLoading(true);
  setMetadataStatus({ kind: 'loading', source: 'file', message: 'Loading metadata...' });
  try {
    const resp = await fetch(url);
    const json = await resp.text();
    const parsed = parseMetadata(json);
    setMetadata(parsed);
    setMetadataStatus({ kind: 'success', source: 'file', message: 'Loaded metadata' });
  } catch (e) {
    console.error('Failed to load metadata:', e);
    logDebugError('parameters', `Metadata load failed: ${e instanceof Error ? e.message : String(e)}`, {
      url,
    });
    setMetadataStatus({
      kind: 'error',
      source: 'file',
      message: `Metadata load failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  } finally {
    setMetadataLoading(false);
  }
}

function downloadMetadataFromDevice(): void {
  if (!bridgeRef || metadataLoading()) return;
  setMetadataLoading(true);
  setMetadataStatus({ kind: 'loading', source: 'device', message: 'Loading metadata from device...' });
  let loadedFromCache = false;

  const logProgress = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    details?: Record<string, string | number | boolean | null>,
    body?: string,
  ) => {
    logDebugEvent('metadata-ftp', level, message, details, body);
    if (!appState.debugConsoleEnabled) return;
    const prefix = '[Metadata FTP]';
    if (level === 'error') console.error(prefix, message, details ?? '', body ?? '');
    else if (level === 'warn') console.warn(prefix, message, details ?? '', body ?? '');
    else if (level === 'info') console.info(prefix, message, details ?? '', body ?? '');
    else console.debug(prefix, message, details ?? '', body ?? '');
  };

  logProgress('info', 'Metadata download requested from Parameters tab');

  const unsubProgress = bridgeRef.onFtpMetadataProgress((progress) => {
    if (progress.stage === 'metadata:cache:hit') {
      loadedFromCache = true;
      setMetadataStatus({ kind: 'success', source: 'cache', message: 'Loaded metadata from cache' });
    }
    logProgress(progress.level, `${progress.stage}: ${progress.message}`, progress.details, progress.body);
  });

  const unsubResult = bridgeRef.onFtpMetadataResult((json, crcValid) => {
    unsubResult();
    unsubError();
    unsubProgress();
    try {
      const parsed = parseMetadata(json);
      setMetadata(parsed);
      if (!crcValid) {
        logProgress('warn', 'Metadata CRC mismatch — file may be corrupted');
      }
      setMetadataStatus({
        kind: 'success',
        source: loadedFromCache ? 'cache' : 'device',
        message: loadedFromCache ? 'Loaded metadata from cache' : 'Downloaded metadata from device',
      });
      logProgress('info', 'Metadata file parsed and loaded into the app');
    } catch (e) {
      const errorMessage = `Metadata parse failed: ${e instanceof Error ? e.message : String(e)}`;
      setMetadataStatus({ kind: 'error', source: 'device', message: errorMessage });
      logProgress('error', `Failed to parse device metadata: ${e instanceof Error ? e.message : String(e)}`);
      console.error('Failed to parse device metadata:', e);
    } finally {
      setMetadataLoading(false);
    }
  });

  const unsubError = bridgeRef.onFtpMetadataError((error) => {
    unsubResult();
    unsubError();
    unsubProgress();
    setMetadataStatus({ kind: 'error', source: 'device', message: `Metadata download failed: ${error}` });
    logProgress('error', `Metadata download failed: ${error}`);
    console.error('FTP metadata download failed:', error);
    setMetadataLoading(false);
  });

  bridgeRef.downloadFtpMetadata();
}

async function loadMetadataFromFile(file: File) {
  setMetadataLoading(true);
  setMetadataStatus({ kind: 'loading', source: 'file', message: `Loading metadata from ${file.name}...` });
  try {
    const json = await file.text();
    const parsed = parseMetadata(json);
    setMetadata(parsed);
    setMetadataStatus({ kind: 'success', source: 'file', message: `Loaded metadata from ${file.name}` });
  } catch (e) {
    console.error('Failed to parse metadata file:', e);
    logDebugError('parameters', `Metadata parse failed for ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    setMetadataStatus({
      kind: 'error',
      source: 'file',
      message: `Metadata parse failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  } finally {
    setMetadataLoading(false);
  }
}

export function useParameters() {
  // Initialize bridge subscription on first call (requires SolidJS context)
  const bridge = useWorkerBridge();
  ensureBridge(bridge);

  return {
    paramState,
    metadata,
    metadataLoading,
    metadataStatus,
    lastSetResult,
    groupedParams,
    requestAll,
    setParam,
    loadMetadataFromUrl,
    loadMetadataFromFile,
    downloadMetadataFromDevice,
  };
}
