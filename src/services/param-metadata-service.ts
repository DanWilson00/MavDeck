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

function normalizeMetadataBody(parsed: Record<string, unknown>): ParamMetadataFile {
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
      lookup.set(param.mavlink_id, {
        ...param,
        group_name: param.group_name ?? group.name,
      });
    }
  }

  for (const arrayParam of file.array_parameters) {
    for (let i = 0; i < arrayParam.count; i++) {
      const expanded: ParamDef = {
        mavlink_id: `${arrayParam.mavlink_prefix}${i}`,
        config_key: `${arrayParam.config_key}[${i}]`,
        group_name: arrayParam.group,
        type: arrayParam.type as ParamDef['type'],
        default: arrayParam.default[i],
        min: arrayParam.min,
        max: arrayParam.max,
        unit: arrayParam.unit,
        decimal: arrayParam.decimal,
        description: arrayParam.description,
        arrayInfo: { prefix: arrayParam.config_key, index: i, count: arrayParam.count },
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
