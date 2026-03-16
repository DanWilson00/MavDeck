export interface ParamMetadataFile {
  version: number;
  includes: string[];
  externs: Record<string, string>;
  groups: ParamGroupDef[];
  array_parameters: ArrayParamDef[];
}

export interface ParamGroupDef {
  name: string;
  parameters: ParamDef[];
}

export interface ParamDef {
  mavlink_id: string;
  config_key: string;
  type: 'Float' | 'Boolean' | 'Discrete' | 'Integer';
  default: number;
  min: number;
  max: number;
  unit?: string;
  decimal?: number;
  description: string;
  long_description?: string;
  volatile?: boolean;
  reboot_required?: boolean;
  values?: Record<string, string>;
}

export interface ArrayParamDef {
  mavlink_prefix: string;
  config_key: string;
  group: string;
  type: string;
  count: number;
  default: number[];
  min: number;
  max: number;
  unit?: string;
  decimal?: number;
  description: string;
}
