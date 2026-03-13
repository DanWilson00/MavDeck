export const UNIT_PROFILES = ['raw', 'metric', 'imperial', 'aviation'] as const;
export type UnitProfile = (typeof UNIT_PROFILES)[number];

export type UnitFamily =
  | 'angle'
  | 'angularRate'
  | 'length'
  | 'distance'
  | 'altitude'
  | 'speed'
  | 'coordinate'
  | 'heading'
  | 'headingRate'
  | 'temperature';

export type DisplaySurface = 'monitor' | 'plot' | 'map';

interface UnitContext {
  messageType?: string;
  fieldName?: string;
}

interface UnitDescriptor {
  family: UnitFamily;
  rawUnit: string;
}

const FT_PER_M = 3.280839895013123;
const KT_PER_MPS = 1.9438444924406048;
const NM_PER_M = 1 / 1852;

function isAltitudeField(fieldName: string): boolean {
  return /(^|_)(alt|altitude|relative_alt|height|agl|amsl)(_|$)/i.test(fieldName);
}

function isDistanceField(fieldName: string): boolean {
  return /(dist|distance|range|radius|spacing|baseline|offset|error)/i.test(fieldName);
}

function resolveUnitDescriptor(rawUnit: string, context: UnitContext = {}): UnitDescriptor | null {
  const fieldName = context.fieldName ?? '';

  switch (rawUnit) {
    case 'rad':
      return { family: 'angle', rawUnit };
    case 'rad/s':
    case 'mrad/s':
      return { family: 'angularRate', rawUnit };
    case 'degE5':
    case 'degE7':
      return { family: 'coordinate', rawUnit };
    case 'deg':
    case 'cdeg':
      return { family: 'heading', rawUnit };
    case 'cdeg/s':
      return { family: 'headingRate', rawUnit };
    case 'cdegC':
    case 'degC':
      return { family: 'temperature', rawUnit };
    case 'mm':
    case 'cm':
    case 'dm':
    case 'dam':
    case 'm':
      if (isAltitudeField(fieldName)) return { family: 'altitude', rawUnit };
      if (isDistanceField(fieldName)) return { family: 'distance', rawUnit };
      return { family: 'length', rawUnit };
    case 'cm/s':
    case 'dm/s':
    case 'm/s':
      return { family: 'speed', rawUnit };
    default:
      return null;
  }
}

function toMeters(rawValue: number, rawUnit: string): number {
  switch (rawUnit) {
    case 'mm': return rawValue / 1000;
    case 'cm': return rawValue / 100;
    case 'dm': return rawValue / 10;
    case 'dam': return rawValue * 10;
    case 'm': return rawValue;
    default: return rawValue;
  }
}

function toMetersPerSecond(rawValue: number, rawUnit: string): number {
  switch (rawUnit) {
    case 'cm/s': return rawValue / 100;
    case 'dm/s': return rawValue / 10;
    case 'm/s': return rawValue;
    default: return rawValue;
  }
}

function toDegrees(rawValue: number, rawUnit: string): number {
  switch (rawUnit) {
    case 'rad': return rawValue * (180 / Math.PI);
    case 'cdeg': return rawValue / 100;
    case 'degE5': return rawValue / 1e5;
    case 'degE7': return rawValue / 1e7;
    case 'deg': return rawValue;
    default: return rawValue;
  }
}

function toDegreesPerSecond(rawValue: number, rawUnit: string): number {
  switch (rawUnit) {
    case 'rad/s': return rawValue * (180 / Math.PI);
    case 'mrad/s': return (rawValue / 1000) * (180 / Math.PI);
    case 'cdeg/s': return rawValue / 100;
    default: return rawValue;
  }
}

function toDegreesCelsius(rawValue: number, rawUnit: string): number {
  switch (rawUnit) {
    case 'cdegC': return rawValue / 100;
    case 'degC': return rawValue;
    default: return rawValue;
  }
}

export function getDisplayUnit(rawUnit: string, profile: UnitProfile, context: UnitContext = {}): string {
  if (profile === 'raw') return rawUnit;

  const descriptor = resolveUnitDescriptor(rawUnit, context);
  if (!descriptor) return rawUnit;

  switch (descriptor.family) {
    case 'angle':
    case 'coordinate':
    case 'heading':
      return 'deg';
    case 'angularRate':
    case 'headingRate':
      return 'deg/s';
    case 'temperature':
      return profile === 'imperial' ? 'degF' : 'degC';
    case 'speed':
      if (profile === 'imperial') return 'ft/s';
      if (profile === 'aviation') return 'kt';
      return 'm/s';
    case 'distance':
      if (profile === 'aviation') return 'nm';
      if (profile === 'imperial') return 'ft';
      return 'm';
    case 'altitude':
    case 'length':
      if (profile === 'imperial' || profile === 'aviation') return 'ft';
      return 'm';
  }
}

export function convertDisplayValue(
  rawValue: number,
  rawUnit: string,
  profile: UnitProfile,
  context: UnitContext = {},
): number {
  if (profile === 'raw') return rawValue;

  const descriptor = resolveUnitDescriptor(rawUnit, context);
  if (!descriptor) return rawValue;

  switch (descriptor.family) {
    case 'angle':
    case 'coordinate':
    case 'heading':
      return toDegrees(rawValue, rawUnit);
    case 'angularRate':
    case 'headingRate':
      return toDegreesPerSecond(rawValue, rawUnit);
    case 'length':
    case 'altitude': {
      const meters = toMeters(rawValue, rawUnit);
      return profile === 'imperial' || profile === 'aviation' ? meters * FT_PER_M : meters;
    }
    case 'distance': {
      const meters = toMeters(rawValue, rawUnit);
      if (profile === 'aviation') return meters * NM_PER_M;
      if (profile === 'imperial') return meters * FT_PER_M;
      return meters;
    }
    case 'speed': {
      const metersPerSecond = toMetersPerSecond(rawValue, rawUnit);
      if (profile === 'imperial') return metersPerSecond * FT_PER_M;
      if (profile === 'aviation') return metersPerSecond * KT_PER_MPS;
      return metersPerSecond;
    }
    case 'temperature': {
      const celsius = toDegreesCelsius(rawValue, rawUnit);
      return profile === 'imperial' ? (celsius * 9) / 5 + 32 : celsius;
    }
  }
}

export function convertDisplayValues(
  rawValues: Float64Array,
  rawUnit: string,
  profile: UnitProfile,
  context: UnitContext = {},
): Float64Array {
  if (profile === 'raw') return rawValues;

  const descriptor = resolveUnitDescriptor(rawUnit, context);
  if (!descriptor) return rawValues;

  const out = new Float64Array(rawValues.length);
  for (let i = 0; i < rawValues.length; i++) {
    out[i] = convertDisplayValue(rawValues[i], rawUnit, profile, context);
  }
  return out;
}

export function convertDisplayArray(
  rawValues: number[],
  rawUnit: string,
  profile: UnitProfile,
  context: UnitContext = {},
): number[] {
  if (profile === 'raw') return rawValues;
  return rawValues.map(v => convertDisplayValue(v, rawUnit, profile, context));
}

export function formatSignalLabel(
  fieldKey: string,
  rawUnit: string,
  profile: UnitProfile,
  context: UnitContext = {},
): string {
  const displayUnit = getDisplayUnit(rawUnit, profile, context);
  return displayUnit ? `${fieldKey} ${displayUnit}` : fieldKey;
}

function trimTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/, '');
}

function getDisplayDecimals(
  displayUnit: string,
  surface: DisplaySurface,
  context: UnitContext = {},
): number | null {
  const fieldName = context.fieldName ?? '';
  const isCoordinate = /^(lat|latitude|lon|longitude)$/i.test(fieldName);

  switch (displayUnit) {
    case 'deg':
      return isCoordinate ? 6 : surface === 'map' ? 1 : 2;
    case 'deg/s':
      return 2;
    case 'm':
      if (surface === 'map' && isAltitudeField(fieldName)) return 1;
      return 2;
    case 'ft':
      return surface === 'plot' ? 1 : 0;
    case 'm/s':
      return 2;
    case 'ft/s':
      return 1;
    case 'kt':
      return 1;
    case 'nm':
      return 2;
    case 'degC':
    case 'degF':
      return 1;
    default:
      return null;
  }
}

export function formatDisplayValue(
  value: number,
  displayUnit: string,
  surface: DisplaySurface,
  context: UnitContext = {},
): string {
  if (Number.isNaN(value)) return '--';
  if (!Number.isFinite(value)) return String(value);

  const decimals = getDisplayDecimals(displayUnit, surface, context);
  if (decimals == null) {
    return Number.isInteger(value) ? String(value) : trimTrailingZeros(value.toFixed(4));
  }

  const fixed = value.toFixed(decimals);
  const fieldName = context.fieldName ?? '';
  const isCoordinate = /^(lat|latitude|lon|longitude)$/i.test(fieldName);
  if (isCoordinate && displayUnit === 'deg') return fixed;
  return trimTrailingZeros(fixed);
}
