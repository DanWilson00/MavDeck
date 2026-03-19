export interface ParamValueOption {
  value: number;
  description: string;
}

export interface ParamDef {
  name: string;              // MAVLink param ID ("SCL_RFADE_VEL")
  type: 'Float' | 'Boolean' | 'Discrete' | 'Integer';  // inferred
  group: string;             // "scaler"
  default: number;
  min: number;
  max: number;
  shortDesc: string;         // "scaler.roll_cmd_fade_start_vel_mps"
  longDesc: string;          // "Velocity above which roll command begins to fade"
  units: string;             // "m/s", "norm", ""
  decimalPlaces: number;
  rebootRequired: boolean;
  values?: ParamValueOption[];
  arrayInfo?: {
    prefix: string;          // base shortDesc without [n]
    index: number;
    count: number;
  };
}
