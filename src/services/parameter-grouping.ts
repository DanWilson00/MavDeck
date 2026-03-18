import type { ParamDef } from '../models/parameter-metadata';
import type { ParameterStateSnapshot } from './parameter-types';

export interface ParamWithMeta {
  paramId: string;
  value: number;
  paramType: number;
  paramIndex: number;
  meta: ParamDef | null;
}

export interface ArrayParamGroup {
  prefix: string;
  description: string;
  unit: string;
  elements: ParamWithMeta[];
}

export interface ParamGroup {
  name: string;
  params: ParamWithMeta[];
  arrays: ArrayParamGroup[];
}

export function deriveFallbackParamGroupName(paramId: string): string {
  const underscoreIdx = paramId.indexOf('_');
  return underscoreIdx >= 0 ? paramId.substring(0, underscoreIdx) : paramId;
}

export function buildParamGroups(
  state: ParameterStateSnapshot,
  lookup: Map<string, ParamDef>,
  hasMetadataFile: boolean,
): ParamGroup[] {
  if (Object.keys(state.params).length === 0) return [];

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

  const groups = new Map<string, ParamWithMeta[]>();
  for (const [, pwm] of withMeta) {
    let groupName: string;
    if (pwm.meta?.config_key) {
      const dotIdx = pwm.meta.config_key.indexOf('.');
      groupName = dotIdx >= 0 ? pwm.meta.config_key.substring(0, dotIdx) : pwm.meta.config_key;
    } else if (!hasMetadataFile) {
      groupName = deriveFallbackParamGroupName(pwm.paramId);
    } else {
      groupName = 'Other';
    }
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName)!.push(pwm);
  }

  const sorted: ParamGroup[] = [];
  for (const [name, allParams] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
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
}
