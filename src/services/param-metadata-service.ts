import type { ParamDef, ParamValueOption } from '../models/parameter-metadata';

/** Raw parameter entry as it appears in the flat JSON file. */
interface RawParam {
  name: string;
  type: string;
  group: string;
  default: number;
  min: number;
  max: number;
  shortDesc: string;
  longDesc: string;
  units: string;
  decimalPlaces: number;
  rebootRequired: boolean;
  values?: ParamValueOption[];
}

interface RawParamsFile {
  version: number;
  parameters: RawParam[];
}

/**
 * Infer the display type from the raw JSON `type` field and optional `values` array.
 *
 * - `"Int32"` with exactly two values at 0 and 1 → `Boolean`
 * - `"Int32"` with other values → `Discrete`
 * - `"Int32"` with no values → `Integer`
 * - `"Float"` → `Float`
 */
function inferType(rawType: string, values?: ParamValueOption[]): ParamDef['type'] {
  if (rawType === 'Float') return 'Float';

  // Int32 (or any integer type)
  if (values && values.length > 0) {
    if (
      values.length === 2 &&
      values.some(v => v.value === 0) &&
      values.some(v => v.value === 1)
    ) {
      return 'Boolean';
    }
    return 'Discrete';
  }
  return 'Integer';
}

const ARRAY_PATTERN = /^(.+)\[(\d+)\]$/;

/**
 * Parse a flat params JSON string into a Map<name, ParamDef>.
 *
 * Expects `{ version, parameters: [...] }` format.
 */
export function parseMetadata(json: string): Map<string, ParamDef> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid metadata file: top-level JSON value must be an object');
  }
  const raw = parsed as RawParamsFile;
  if (!Array.isArray(raw.parameters)) {
    throw new Error('Invalid metadata file: parameters must be an array');
  }

  const lookup = new Map<string, ParamDef>();

  // First pass: build all ParamDefs without arrayInfo
  for (const p of raw.parameters) {
    const def: ParamDef = {
      name: p.name,
      type: inferType(p.type, p.values),
      group: p.group,
      default: p.default,
      min: p.min,
      max: p.max,
      shortDesc: p.shortDesc,
      longDesc: p.longDesc,
      units: p.units,
      decimalPlaces: p.decimalPlaces,
      rebootRequired: p.rebootRequired,
      values: p.values,
    };
    lookup.set(p.name, def);
  }

  // Second pass: detect array parameters by shortDesc pattern and attach arrayInfo
  const arrayGroups = new Map<string, ParamDef[]>();
  for (const def of lookup.values()) {
    const match = def.shortDesc.match(ARRAY_PATTERN);
    if (match) {
      const prefix = match[1];
      if (!arrayGroups.has(prefix)) arrayGroups.set(prefix, []);
      arrayGroups.get(prefix)!.push(def);
    }
  }

  for (const [prefix, members] of arrayGroups) {
    const count = members.length;
    for (const def of members) {
      const match = def.shortDesc.match(ARRAY_PATTERN)!;
      def.arrayInfo = {
        prefix,
        index: parseInt(match[2], 10),
        count,
      };
    }
  }

  return lookup;
}
