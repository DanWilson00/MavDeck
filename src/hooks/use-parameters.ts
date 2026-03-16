import { createSignal, onCleanup, createMemo } from 'solid-js';
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

export interface ParamGroup {
  name: string;           // config_key prefix
  params: ParamWithMeta[];
}

export function useParameters() {
  const bridge = useWorkerBridge();

  const [paramState, setParamState] = createSignal<ParameterStateSnapshot>({
    params: {}, totalCount: 0, receivedCount: 0, fetchStatus: 'idle', error: null,
  });
  const [metadata, setMetadata] = createSignal<ParamMetadataFile | null>(null);
  const [lastSetResult, setLastSetResult] = createSignal<ParamSetResult | null>(null);
  const [metadataLoading, setMetadataLoading] = createSignal(false);

  // Subscribe to bridge events
  const unsubState = bridge.onParamState(state => setParamState(state));
  const unsubResult = bridge.onParamSetResult(result => {
    setLastSetResult(result);
    // Auto-clear after 3 seconds
    setTimeout(() => setLastSetResult(null), 3000);
  });

  onCleanup(() => { unsubState(); unsubResult(); });

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

    // Sort groups alphabetically, sort params within groups by config_key
    const sorted: ParamGroup[] = [];
    for (const [name, params] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      params.sort((a, b) => {
        const aKey = a.meta?.config_key ?? a.paramId;
        const bKey = b.meta?.config_key ?? b.paramId;
        return aKey.localeCompare(bKey);
      });
      sorted.push({ name, params });
    }
    return sorted;
  });

  // Actions
  function requestAll() {
    bridge.requestAllParams();
  }

  function setParam(paramId: string, value: number) {
    bridge.setParam(paramId, value);
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
  };
}
