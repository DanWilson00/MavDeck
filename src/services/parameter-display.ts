import type { ParamDef } from '../models/parameter-metadata';

export function getParameterDisplayName(meta: ParamDef | null, paramId: string): string {
  if (!meta) return paramId;
  if (meta.config_key) return meta.config_key;
  if (meta.description) return meta.description;
  return paramId;
}

export function getArrayDisplayName(meta: ParamDef | null, fallbackDescription: string): string {
  if (!meta) return fallbackDescription;
  if (meta.arrayInfo?.prefix) return meta.arrayInfo.prefix;
  if (meta.config_key) {
    const bracketIdx = meta.config_key.indexOf('[');
    return bracketIdx >= 0 ? meta.config_key.substring(0, bracketIdx) : meta.config_key;
  }
  if (meta.description) return meta.description;
  return fallbackDescription;
}
