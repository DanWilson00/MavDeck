import { createSignal, createMemo } from 'solid-js';
import { useWorkerBridge, addDebugConsoleEntry } from '../services';
import type { ParameterStateSnapshot, ParamSetResult } from '../services/parameter-types';
import type { ParamMetadataFile, ParamDef } from '../models/parameter-metadata';
import { parseMetadataFile, flattenToLookup } from '../services/param-metadata-service';
import {
  buildParamGroups,
  type ParamWithMeta,
  type ArrayParamGroup,
  type ParamGroup,
} from '../services/parameter-grouping';
import { appState } from '../store';
import { summarizeMetadataShape } from '../services/param-metadata-service';

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
const [metadata, setMetadata] = createSignal<ParamMetadataFile | null>(null);
const [lastSetResult, setLastSetResult] = createSignal<ParamSetResult | null>(null);
const [metadataLoading, setMetadataLoading] = createSignal(false);
const [metadataStatus, setMetadataStatus] = createSignal<MetadataStatus>({
  kind: 'idle',
  source: null,
  message: '',
});

let bridgeInitialized = false;
let bridgeRef: ReturnType<typeof useWorkerBridge> | null = null;

function ensureBridge(bridge: ReturnType<typeof useWorkerBridge>) {
  if (bridgeInitialized) return;
  bridgeInitialized = true;
  bridgeRef = bridge;

  // App-lifetime subscriptions — never unsubscribed
  bridge.onParamState(state => setParamState(state));
  bridge.onParamSetResult(result => {
    setLastSetResult(result);
    setTimeout(() => setLastSetResult(null), 3000);
  });
}

// Metadata lookup (flat map by mavlink_id)
const metadataLookup = createMemo(() => {
  const meta = metadata();
  if (!meta) return new Map<string, ParamDef>();
  return flattenToLookup(meta);
});

// Grouped params: merge device values with metadata, group by config_key prefix
const groupedParams = createMemo((): ParamGroup[] => {
  const state = paramState();
  const metaFile = metadata();
  const lookup = metadataLookup();
  return buildParamGroups(state, lookup, metaFile !== null);
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
    const parsed = parseMetadataFile(json);
    setMetadata(parsed);
    setMetadataStatus({ kind: 'success', source: 'file', message: 'Loaded metadata' });
  } catch (e) {
    console.error('Failed to load metadata:', e);
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

  const logProgress = (level: 'debug' | 'info' | 'warn' | 'error', message: string, details?: Record<string, string | number | boolean | null>) => {
    addDebugConsoleEntry({ source: 'metadata-ftp', level, message, details });
    if (!appState.debugConsoleEnabled) return;
    const prefix = '[Metadata FTP]';
    if (level === 'error') console.error(prefix, message, details ?? '');
    else if (level === 'warn') console.warn(prefix, message, details ?? '');
    else if (level === 'info') console.info(prefix, message, details ?? '');
    else console.debug(prefix, message, details ?? '');
  };

  logProgress('info', 'Metadata download requested from Parameters tab');

  const unsubProgress = bridgeRef.onFtpMetadataProgress((progress) => {
    if (progress.stage === 'metadata:cache:hit') {
      loadedFromCache = true;
      setMetadataStatus({ kind: 'success', source: 'cache', message: 'Loaded metadata from cache' });
    }
    logProgress(progress.level, `${progress.stage}: ${progress.message}`, progress.details);
  });

  const unsubResult = bridgeRef.onFtpMetadataResult((json, crcValid) => {
    unsubResult();
    unsubError();
    unsubProgress();
    try {
      const parsedRaw = JSON.parse(json) as unknown;
      const shape = summarizeMetadataShape(parsedRaw);
      logProgress('info', 'Parsed metadata JSON top-level shape', {
        topLevelKeys: shape.topLevelKeys.join(','),
        hasParametersWrapper: shape.hasParametersWrapper,
        parametersIsObject: shape.parametersIsObject,
        parametersIsArray: shape.parametersIsArray,
        innerTopLevelKeys: shape.innerTopLevelKeys.join(','),
        groupsIsArray: shape.groupsIsArray,
        groupsLength: shape.groupsLength,
        arrayParametersIsArray: shape.arrayParametersIsArray,
        arrayParametersLength: shape.arrayParametersLength,
        includesIsArray: shape.includesIsArray,
        externsIsObject: shape.externsIsObject,
      });
      const parsed = parseMetadataFile(json);
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
    const parsedRaw = JSON.parse(json) as unknown;
    const shape = summarizeMetadataShape(parsedRaw);
    addDebugConsoleEntry({
      source: 'metadata-ftp',
      level: 'info',
      message: 'Loaded metadata file top-level shape',
      details: {
        topLevelKeys: shape.topLevelKeys.join(','),
        hasParametersWrapper: shape.hasParametersWrapper,
        parametersIsObject: shape.parametersIsObject,
        parametersIsArray: shape.parametersIsArray,
        innerTopLevelKeys: shape.innerTopLevelKeys.join(','),
        groupsIsArray: shape.groupsIsArray,
        groupsLength: shape.groupsLength,
        arrayParametersIsArray: shape.arrayParametersIsArray,
        arrayParametersLength: shape.arrayParametersLength,
      },
    });
    const parsed = parseMetadataFile(json);
    setMetadata(parsed);
    setMetadataStatus({ kind: 'success', source: 'file', message: `Loaded metadata from ${file.name}` });
  } catch (e) {
    console.error('Failed to parse metadata file:', e);
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
