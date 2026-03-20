import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseMetadata } from '../param-metadata-service';

const jsonContent = readFileSync(
  join(__dirname, '..', '..', '..', 'public', 'params.json'),
  'utf-8'
);

describe('parseMetadata', () => {
  it('parses params.json successfully with correct total count', () => {
    const lookup = parseMetadata(jsonContent);
    expect(lookup.size).toBe(36);
  });

  it('throws on non-object input', () => {
    expect(() => parseMetadata('"hello"')).toThrow('top-level JSON value must be an object');
    expect(() => parseMetadata('[]')).toThrow('top-level JSON value must be an object');
  });

  it('throws when parameters is not an array', () => {
    expect(() => parseMetadata('{"version":1}')).toThrow('parameters must be an array');
    expect(() => parseMetadata('{"version":1,"parameters":{}}')).toThrow('parameters must be an array');
  });

  it('infers Boolean type for Int32 with {0,1} values', () => {
    const lookup = parseMetadata(jsonContent);
    const param = lookup.get('SCL_RFADE_EN');
    expect(param).toBeDefined();
    expect(param!.type).toBe('Boolean');
  });

  it('infers Discrete type for Int32 with non-boolean values', () => {
    const lookup = parseMetadata(jsonContent);
    const param = lookup.get('JOY_THUMB_DIR');
    expect(param).toBeDefined();
    expect(param!.type).toBe('Discrete');
  });

  it('preserves Float type for Float parameters', () => {
    const lookup = parseMetadata(jsonContent);

    const rfadeVel = lookup.get('SCL_RFADE_VEL');
    expect(rfadeVel).toBeDefined();
    expect(rfadeVel!.type).toBe('Float');

    // SCL_PFF_V0 has all whole-number values but is Float type in JSON
    const pffV0 = lookup.get('SCL_PFF_V0');
    expect(pffV0).toBeDefined();
    expect(pffV0!.type).toBe('Float');

    // UM_MAX_TORQUE is Float in JSON
    const umMaxTorque = lookup.get('UM_MAX_TORQUE');
    expect(umMaxTorque).toBeDefined();
    expect(umMaxTorque!.type).toBe('Float');
  });

  it('infers Integer type for Int32 with no values', () => {
    const syntheticJson = JSON.stringify({
      version: 1,
      parameters: [{
        name: 'TEST_INT',
        type: 'Int32',
        group: 'test',
        default: 0,
        min: 0,
        max: 100,
        shortDesc: 'test.param',
        longDesc: 'A test integer parameter',
        units: '',
        decimalPlaces: 0,
        rebootRequired: false,
      }],
    });
    const lookup = parseMetadata(syntheticJson);
    const param = lookup.get('TEST_INT');
    expect(param).toBeDefined();
    expect(param!.type).toBe('Integer');
  });

  it('auto-detects array parameters from shortDesc bracket pattern', () => {
    const lookup = parseMetadata(jsonContent);

    const param0 = lookup.get('SCL_PFF_V0');
    expect(param0).toBeDefined();
    expect(param0!.arrayInfo).toEqual({ prefix: 'scaler.pitch_ff_vel_mps', index: 0, count: 5 });

    const param4 = lookup.get('SCL_PFF_V4');
    expect(param4).toBeDefined();
    expect(param4!.arrayInfo).toEqual({ prefix: 'scaler.pitch_ff_vel_mps', index: 4, count: 5 });

    // All 5 elements of each array exist
    for (let i = 0; i < 5; i++) {
      expect(lookup.has(`SCL_PFF_V${i}`)).toBe(true);
      expect(lookup.has(`SCL_PFF_C${i}`)).toBe(true);
    }
  });

  it('preserves values as ParamValueOption arrays', () => {
    const lookup = parseMetadata(jsonContent);
    const param = lookup.get('SCL_RFADE_EN');
    expect(param).toBeDefined();
    expect(param!.values).toEqual([
      { value: 0, description: 'Disabled' },
      { value: 1, description: 'Enabled' },
    ]);
  });

  it('contains a scalar parameter with all correct fields', () => {
    const lookup = parseMetadata(jsonContent);
    const param = lookup.get('WMAP_MAX_ROLL');
    expect(param).toBeDefined();
    expect(param!.name).toBe('WMAP_MAX_ROLL');
    expect(param!.shortDesc).toBe('wing_mapping.max_roll_cmd');
    expect(param!.longDesc).toBe('Maximum fraction of roll stick input applied to wing commands');
    expect(param!.group).toBe('wing_mapping');
    expect(param!.type).toBe('Float');
    expect(param!.default).toBe(0.7);
    expect(param!.min).toBe(0);
    expect(param!.max).toBe(1);
    expect(param!.units).toBe('norm');
    expect(param!.decimalPlaces).toBe(2);
    expect(param!.rebootRequired).toBe(false);
  });

  it('array parameter defaults match JSON values', () => {
    const lookup = parseMetadata(jsonContent);
    expect(lookup.get('SCL_PFF_V0')!.default).toBe(0);
    expect(lookup.get('SCL_PFF_V4')!.default).toBe(20);
  });
});
