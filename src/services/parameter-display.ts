import type { ParamDef } from '../models/parameter-metadata';

export function getParameterDisplayName(meta: ParamDef | null, paramId: string): string {
  if (!meta) return paramId;
  if (meta.shortDesc) return meta.shortDesc;
  if (meta.longDesc) return meta.longDesc;
  return paramId;
}

export function getArrayDisplayName(meta: ParamDef | null, fallbackDescription: string): string {
  if (!meta) return fallbackDescription;
  if (meta.arrayInfo?.prefix) return meta.arrayInfo.prefix;
  if (meta.shortDesc) {
    const bracketIdx = meta.shortDesc.indexOf('[');
    return bracketIdx >= 0 ? meta.shortDesc.substring(0, bracketIdx) : meta.shortDesc;
  }
  if (meta.longDesc) return meta.longDesc;
  return fallbackDescription;
}

/** Format a numeric value with optional decimal places. */
export function formatValue(value: number, decimalPlaces?: number): string {
  if (decimalPlaces !== undefined) return value.toFixed(decimalPlaces);
  return String(value);
}

/**
 * Float-tolerant comparison of a value against the parameter's default,
 * using decimalPlaces to determine the tolerance.
 */
export function isAtDefault(value: number, meta: ParamDef): boolean {
  const tolerance = Math.pow(10, -meta.decimalPlaces) / 2;
  return Math.abs(value - meta.default) < tolerance;
}

/**
 * Format the default value for display, respecting the parameter type.
 */
export function formatDefaultValue(meta: ParamDef): string {
  if (meta.type === 'Boolean') {
    if (meta.values) {
      const match = meta.values.find(v => v.value === meta.default);
      if (match) return match.description;
    }
    return meta.default ? 'Enabled' : 'Disabled';
  }
  if (meta.type === 'Discrete') {
    if (meta.values) {
      const match = meta.values.find(v => v.value === meta.default);
      if (match) return `${match.description} (${meta.default})`;
    }
    return String(meta.default);
  }
  if (meta.type === 'Integer') {
    return String(meta.default);
  }
  // Float
  return meta.default.toFixed(meta.decimalPlaces);
}
