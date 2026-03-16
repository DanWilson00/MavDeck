import type { ParamMetadataFile, ParamDef } from '../models/parameter-metadata';

/**
 * Parse a JSON string into a ParamMetadataFile, with basic validation.
 */
export function parseMetadataFile(json: string): ParamMetadataFile {
  const parsed = JSON.parse(json) as ParamMetadataFile;
  if (parsed.version === undefined || parsed.version === null) {
    throw new Error('Invalid metadata file: missing version field');
  }
  return parsed;
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
