import { createSignal, createMemo } from 'solid-js';
import { useWorkerBridge } from '../services';
import type { ParameterStateSnapshot, ParamSetResult } from '../services/parameter-types';
import type { ParamMetadataFile, ParamDef } from '../models/parameter-metadata';
import { parseMetadataFile, flattenToLookup } from '../services/param-metadata-service';

export interface ParamWithMeta {
  paramId: string;        // mavlink_id
  value: number;          // current device value
  paramType: number;
  paramIndex: number;
  meta: ParamDef | null;  // null if no metadata for this param
}

export interface ArrayParamGroup {
  prefix: string;            // mavlink_prefix
  description: string;       // from ParamDef description
  unit: string;
  elements: ParamWithMeta[]; // ordered by index
}

export interface ParamGroup {
  name: string;           // config_key prefix
  params: ParamWithMeta[];       // scalar params only
  arrays: ArrayParamGroup[];     // array params grouped by prefix
}

// Module-level state — persists across tab switches (component mount/unmount cycles)
const [paramState, setParamState] = createSignal<ParameterStateSnapshot>({
  params: {}, totalCount: 0, receivedCount: 0, fetchStatus: 'idle', error: null,
});
const [metadata, setMetadata] = createSignal<ParamMetadataFile | null>(null);
const [lastSetResult, setLastSetResult] = createSignal<ParamSetResult | null>(null);
const [metadataLoading, setMetadataLoading] = createSignal(false);

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
  const lookup = metadataLookup();

  if (Object.keys(state.params).length === 0) return [];

  // Build ParamWithMeta for each received param
  const withMeta = new Map<string, ParamWithMeta>();
  for (const [paramId, pv] of Object.entries(state.params)) {
    withMeta.set(paramId, {
      paramId,
      value: pv.value,
      paramType: pv.paramType,
      paramIndex: pv.paramIndex,
      meta: lookup.get(paramId) ?? null,
    });
  }

  // Group by config_key prefix from metadata
  const groups = new Map<string, ParamWithMeta[]>();
  for (const [, pwm] of withMeta) {
    let groupName: string;
    if (pwm.meta?.config_key) {
      const dotIdx = pwm.meta.config_key.indexOf('.');
      groupName = dotIdx >= 0 ? pwm.meta.config_key.substring(0, dotIdx) : pwm.meta.config_key;
    } else {
      groupName = 'Other';  // params without metadata
    }
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName)!.push(pwm);
  }

  // Sort groups alphabetically, partition scalars vs arrays, sort within
  const sorted: ParamGroup[] = [];
  for (const [name, allParams] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Partition: scalars vs array elements
    const scalars: ParamWithMeta[] = [];
    const arrayMap = new Map<string, ParamWithMeta[]>();
    for (const pwm of allParams) {
      if (pwm.meta?.arrayInfo) {
        const prefix = pwm.meta.arrayInfo.prefix;
        if (!arrayMap.has(prefix)) arrayMap.set(prefix, []);
        arrayMap.get(prefix)!.push(pwm);
      } else {
        scalars.push(pwm);
      }
    }

    scalars.sort((a, b) => {
      const aKey = a.meta?.config_key ?? a.paramId;
      const bKey = b.meta?.config_key ?? b.paramId;
      return aKey.localeCompare(bKey);
    });

    const arrays: ArrayParamGroup[] = [];
    for (const [prefix, elements] of [...arrayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      elements.sort((a, b) => a.meta!.arrayInfo!.index - b.meta!.arrayInfo!.index);
      const first = elements[0].meta!;
      arrays.push({
        prefix,
        description: first.description,
        unit: (first.type === 'Boolean' || first.type === 'Discrete') ? '' : (first.unit === 'norm' ? '' : first.unit ?? ''),
        elements,
      });
    }

    sorted.push({ name, params: scalars, arrays });
  }
  return sorted;
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
  try {
    const resp = await fetch(url);
    const json = await resp.text();
    const parsed = parseMetadataFile(json);
    setMetadata(parsed);
  } catch (e) {
    console.error('Failed to load metadata:', e);
  } finally {
    setMetadataLoading(false);
  }
}

function downloadMetadataFromDevice(): void {
  if (!bridgeRef || metadataLoading()) return;
  setMetadataLoading(true);

  const unsubResult = bridgeRef.onFtpMetadataResult((json, crcValid) => {
    unsubResult();
    unsubError();
    try {
      const parsed = parseMetadataFile(json);
      setMetadata(parsed);
      if (!crcValid) console.warn('Metadata CRC mismatch — file may be corrupted');
    } catch (e) {
      console.error('Failed to parse device metadata:', e);
    } finally {
      setMetadataLoading(false);
    }
  });

  const unsubError = bridgeRef.onFtpMetadataError((error) => {
    unsubResult();
    unsubError();
    console.error('FTP metadata download failed:', error);
    setMetadataLoading(false);
  });

  bridgeRef.downloadFtpMetadata();
}

async function loadMetadataFromFile(file: File) {
  setMetadataLoading(true);
  try {
    const json = await file.text();
    const parsed = parseMetadataFile(json);
    setMetadata(parsed);
  } catch (e) {
    console.error('Failed to parse metadata file:', e);
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
    lastSetResult,
    groupedParams,
    requestAll,
    setParam,
    loadMetadataFromUrl,
    loadMetadataFromFile,
    downloadMetadataFromDevice,
  };
}
