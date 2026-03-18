import type { ParamMetadataFile, ParamDef } from '../models/parameter-metadata';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface MetadataShapeSummary {
  topLevelKeys: string[];
  hasParametersWrapper: boolean;
  parametersIsObject: boolean;
  parametersIsArray: boolean;
  innerTopLevelKeys: string[];
  groupsIsArray: boolean;
  groupsLength: number | null;
  arrayParametersIsArray: boolean;
  arrayParametersLength: number | null;
  includesIsArray: boolean;
  externsIsObject: boolean;
}

export function summarizeMetadataShape(value: unknown): MetadataShapeSummary {
  const record = isRecord(value) ? value : null;
  const parametersRecord = isRecord(record?.parameters) ? record.parameters : null;
  const parametersArray = Array.isArray(record?.parameters) ? record.parameters : null;
  const target = parametersRecord ?? record;
  return {
    topLevelKeys: record ? Object.keys(record).sort() : [],
    hasParametersWrapper: Boolean(parametersRecord),
    parametersIsObject: isRecord(record?.parameters),
    parametersIsArray: Array.isArray(record?.parameters),
    innerTopLevelKeys: parametersRecord ? Object.keys(parametersRecord).sort() : [],
    groupsIsArray: Array.isArray(target?.groups),
    groupsLength: Array.isArray(target?.groups) ? target.groups.length : null,
    arrayParametersIsArray: Array.isArray(target?.array_parameters),
    arrayParametersLength: Array.isArray(target?.array_parameters) ? target.array_parameters.length : null,
    includesIsArray: Array.isArray(target?.includes),
    externsIsObject: isRecord(target?.externs),
  };
}

interface CompactMetadataValueOption {
  value: number;
  description: string;
}

interface CompactMetadataParam {
  name: string;
  type: string;
  group: string;
  default: number;
  min: number;
  max: number;
  shortDesc: string;
  longDesc?: string;
  units?: string;
  decimalPlaces?: number;
  rebootRequired?: boolean;
  volatile?: boolean;
  values?: CompactMetadataValueOption[];
}

function isCompactMetadataValueOption(value: unknown): value is CompactMetadataValueOption {
  return isRecord(value)
    && typeof value.value === 'number'
    && typeof value.description === 'string';
}

function isBooleanStyleValues(values: CompactMetadataValueOption[]): boolean {
  if (values.length !== 2) return false;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  return sorted[0].value === 0
    && sorted[1].value === 1
    && sorted[0].description.toLowerCase() === 'disabled'
    && sorted[1].description.toLowerCase() === 'enabled';
}

function mapCompactType(param: CompactMetadataParam): ParamDef['type'] {
  if (param.type === 'Float') return 'Float';
  if (param.type === 'Int32') {
    if (param.values && param.values.length > 0) {
      return isBooleanStyleValues(param.values) ? 'Boolean' : 'Discrete';
    }
    return 'Integer';
  }
  throw new Error(`Invalid metadata file: unknown compact parameter type "${param.type}" for ${param.name}`);
}

function normalizeCompactValues(values: CompactMetadataValueOption[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  return Object.fromEntries(values.map(option => [String(option.value), option.description]));
}

function normalizeCompactParameter(value: unknown): CompactMetadataParam {
  if (!isRecord(value)) {
    throw new Error('Invalid metadata file: compact parameter entry must be an object');
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new Error('Invalid metadata file: compact parameter entry missing name');
  }
  if (typeof value.group !== 'string' || value.group.length === 0) {
    throw new Error(`Invalid metadata file: compact parameter ${value.name} missing group`);
  }
  if (typeof value.type !== 'string' || value.type.length === 0) {
    throw new Error(`Invalid metadata file: compact parameter ${value.name} missing type`);
  }
  if (typeof value.shortDesc !== 'string' || value.shortDesc.length === 0) {
    throw new Error(`Invalid metadata file: compact parameter ${value.name} missing shortDesc`);
  }
  if (typeof value.default !== 'number' || typeof value.min !== 'number' || typeof value.max !== 'number') {
    throw new Error(`Invalid metadata file: compact parameter ${value.name} must define numeric default/min/max`);
  }

  const normalizedValues = Array.isArray(value.values)
    ? value.values.filter(isCompactMetadataValueOption)
    : undefined;

  return {
    name: value.name,
    type: value.type,
    group: value.group,
    default: value.default,
    min: value.min,
    max: value.max,
    shortDesc: value.shortDesc,
    longDesc: typeof value.longDesc === 'string' ? value.longDesc : undefined,
    units: typeof value.units === 'string' ? value.units : undefined,
    decimalPlaces: typeof value.decimalPlaces === 'number' ? value.decimalPlaces : undefined,
    rebootRequired: value.rebootRequired === true,
    volatile: value.volatile === true,
    values: normalizedValues,
  };
}

function normalizeCompactParameterArray(parsed: Record<string, unknown>, parameters: unknown[]): ParamMetadataFile {
  const grouped = new Map<string, ParamDef[]>();
  for (const rawParam of parameters) {
    const param = normalizeCompactParameter(rawParam);
    const normalized: ParamDef = {
      mavlink_id: param.name,
      config_key: param.name,
      type: mapCompactType(param),
      default: param.default,
      min: param.min,
      max: param.max,
      unit: param.units,
      decimal: param.decimalPlaces,
      description: param.shortDesc,
      long_description: param.longDesc,
      reboot_required: param.rebootRequired,
      volatile: param.volatile,
      values: normalizeCompactValues(param.values),
    };
    if (!grouped.has(param.group)) grouped.set(param.group, []);
    grouped.get(param.group)!.push(normalized);
  }

  const groups = [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, parameters]) => ({
      name,
      parameters: parameters.sort((a, b) => a.mavlink_id.localeCompare(b.mavlink_id)),
    }));

  return {
    version: Number(parsed.version),
    includes: [],
    externs: {},
    groups,
    array_parameters: [],
  };
}

function normalizeMetadataBody(parsed: Record<string, unknown>): ParamMetadataFile {
  if (Array.isArray(parsed.parameters)) {
    return normalizeCompactParameterArray(parsed, parsed.parameters);
  }

  const body = isRecord(parsed.parameters) ? parsed.parameters : parsed;

  if (!Array.isArray(body.groups)) {
    const prefix = body === parsed ? 'Invalid metadata file' : 'Invalid metadata file: wrapper.parameters';
    throw new Error(`${prefix}: groups must be an array`);
  }

  const outerVersion = parsed.version;
  const innerVersion = body.version;
  if (outerVersion !== undefined && innerVersion !== undefined && Number(outerVersion) !== Number(innerVersion)) {
    throw new Error('Invalid metadata file: outer and inner version fields do not match');
  }

  return {
    version: Number(innerVersion ?? outerVersion),
    includes: Array.isArray(body.includes) ? body.includes.filter((v): v is string => typeof v === 'string') : [],
    externs: isRecord(body.externs)
      ? Object.fromEntries(Object.entries(body.externs).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : {},
    groups: body.groups as ParamMetadataFile['groups'],
    array_parameters: Array.isArray(body.array_parameters)
      ? body.array_parameters as ParamMetadataFile['array_parameters']
      : [],
  };
}

/**
 * Parse a JSON string into a ParamMetadataFile, with basic validation.
 */
export function parseMetadataFile(json: string): ParamMetadataFile {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error('Invalid metadata file: top-level JSON value must be an object');
  }
  if (parsed.version === undefined || parsed.version === null) {
    throw new Error('Invalid metadata file: missing version field');
  }

  return normalizeMetadataBody(parsed);
}

/**
 * Build a flat lookup from mavlink_id to ParamDef.
 * Array parameters are expanded into individual entries.
 */
export function flattenToLookup(file: ParamMetadataFile): Map<string, ParamDef> {
  const lookup = new Map<string, ParamDef>();

  for (const group of file.groups) {
    for (const param of group.parameters) {
      lookup.set(param.mavlink_id, param);
    }
  }

  for (const arrayParam of file.array_parameters) {
    for (let i = 0; i < arrayParam.count; i++) {
      const expanded: ParamDef = {
        mavlink_id: `${arrayParam.mavlink_prefix}${i}`,
        config_key: `${arrayParam.config_key}[${i}]`,
        type: arrayParam.type as ParamDef['type'],
        default: arrayParam.default[i],
        min: arrayParam.min,
        max: arrayParam.max,
        unit: arrayParam.unit,
        decimal: arrayParam.decimal,
        description: arrayParam.description,
        arrayInfo: { prefix: arrayParam.mavlink_prefix, index: i, count: arrayParam.count },
      };
      lookup.set(expanded.mavlink_id, expanded);
    }
  }

  return lookup;
}

/**
 * Group parameters by config_key prefix (everything before the first ".").
 * Keys without a dot use the full key as the group name.
 * Each group's params are sorted alphabetically by config_key.
 */
export function groupByConfigKeyPrefix(lookup: Map<string, ParamDef>): Map<string, ParamDef[]> {
  const groups = new Map<string, ParamDef[]>();

  for (const param of lookup.values()) {
    const dotIndex = param.config_key.indexOf('.');
    const prefix = dotIndex === -1 ? param.config_key : param.config_key.substring(0, dotIndex);

    let group = groups.get(prefix);
    if (!group) {
      group = [];
      groups.set(prefix, group);
    }
    group.push(param);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.config_key.localeCompare(b.config_key));
  }

  return groups;
}
