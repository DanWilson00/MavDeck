import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseMetadataFile,
  flattenToLookup,
  groupByConfigKeyPrefix,
  summarizeMetadataShape,
} from '../param-metadata-service';

const jsonContent = readFileSync(
  join(__dirname, '..', '..', '..', 'parameters.json'),
  'utf-8'
);

describe('parseMetadataFile', () => {
  it('parses the bundled parameters.json successfully', () => {
    const file = parseMetadataFile(jsonContent);
    expect(file.version).toBe(1);
    expect(file.groups.length).toBeGreaterThan(0);
    expect(file.array_parameters.length).toBeGreaterThan(0);
  });

  it('throws on missing version field', () => {
    expect(() => parseMetadataFile('{}')).toThrow('missing version field');
  });

  it('throws when groups is not an array', () => {
    expect(() => parseMetadataFile('{"version":1,"groups":{}}')).toThrow('groups must be an array');
  });

  it('defaults missing array_parameters/includes/externs to empty values', () => {
    const file = parseMetadataFile('{"version":1,"groups":[]}');
    expect(file.includes).toEqual([]);
    expect(file.externs).toEqual({});
    expect(file.array_parameters).toEqual([]);
  });

  it('parses wrapped parameter metadata under top-level parameters', () => {
    const file = parseMetadataFile('{"version":1,"parameters":{"groups":[],"array_parameters":[]}}');
    expect(file.version).toBe(1);
    expect(file.groups).toEqual([]);
    expect(file.array_parameters).toEqual([]);
  });

  it('parses compact qgc-style parameter metadata arrays', () => {
    const file = parseMetadataFile(JSON.stringify({
      version: 1,
      parameters: [
        {
          name: 'WM_MAX_ROLL',
          type: 'Float',
          group: 'Control',
          default: 0.7,
          min: 0,
          max: 1,
          shortDesc: 'Max roll command',
          longDesc: 'Maximum fraction of roll stick input applied to wing commands',
          units: 'norm',
          decimalPlaces: 2,
        },
        {
          name: 'JS_THUMB_DIR',
          type: 'Int32',
          group: 'Input',
          default: 1,
          min: -1,
          max: 1,
          shortDesc: 'Thumb direction',
          values: [
            { value: -1, description: 'Reverse' },
            { value: 1, description: 'Normal' },
          ],
        },
      ],
    }));

    expect(file.groups.map(g => g.name)).toEqual(['Control', 'Input']);
    expect(file.array_parameters).toEqual([]);
    expect(file.groups[0].parameters[0].mavlink_id).toBe('WM_MAX_ROLL');
    expect(file.groups[0].parameters[0].type).toBe('Float');
    expect(file.groups[1].parameters[0].type).toBe('Discrete');
    expect(file.groups[1].parameters[0].values).toEqual({ '-1': 'Reverse', '1': 'Normal' });
  });

  it('maps Int32 disabled/enabled values to Boolean', () => {
    const file = parseMetadataFile(JSON.stringify({
      version: 1,
      parameters: [
        {
          name: 'SCL_RFADE_EN',
          type: 'Int32',
          group: 'Control',
          default: 0,
          min: 0,
          max: 1,
          shortDesc: 'Enable fade',
          values: [
            { value: 0, description: 'Disabled' },
            { value: 1, description: 'Enabled' },
          ],
        },
      ],
    }));

    expect(file.groups[0].parameters[0].type).toBe('Boolean');
  });

  it('throws when wrapped parameters.groups is not an array', () => {
    expect(() => parseMetadataFile('{"version":1,"parameters":{"groups":{}}}')).toThrow('wrapper.parameters: groups must be an array');
  });

  it('throws when outer and inner versions differ', () => {
    expect(() => parseMetadataFile('{"version":1,"parameters":{"version":2,"groups":[]}}')).toThrow('outer and inner version fields do not match');
  });

  it('throws on unknown compact parameter type', () => {
    expect(() => parseMetadataFile('{"version":1,"parameters":[{"name":"P1","type":"String","group":"Test","default":0,"min":0,"max":1,"shortDesc":"bad"}]}'))
      .toThrow('unknown compact parameter type');
  });
});

describe('summarizeMetadataShape', () => {
  it('reports the top-level metadata structure', () => {
    const summary = summarizeMetadataShape(JSON.parse(jsonContent));
    expect(summary.hasParametersWrapper).toBe(false);
    expect(summary.parametersIsObject).toBe(false);
    expect(summary.parametersIsArray).toBe(false);
    expect(summary.innerTopLevelKeys).toEqual([]);
    expect(summary.groupsIsArray).toBe(true);
    expect(summary.arrayParametersIsArray).toBe(true);
    expect(summary.includesIsArray).toBe(true);
    expect(summary.externsIsObject).toBe(true);
    expect(summary.topLevelKeys).toEqual(['array_parameters', 'externs', 'groups', 'includes', 'version']);
  });

  it('reports wrapped parameter metadata structure', () => {
    const summary = summarizeMetadataShape(JSON.parse('{"version":1,"parameters":{"groups":[],"array_parameters":[]}}'));
    expect(summary.topLevelKeys).toEqual(['parameters', 'version']);
    expect(summary.hasParametersWrapper).toBe(true);
    expect(summary.parametersIsObject).toBe(true);
    expect(summary.parametersIsArray).toBe(false);
    expect(summary.innerTopLevelKeys).toEqual(['array_parameters', 'groups']);
    expect(summary.groupsIsArray).toBe(true);
    expect(summary.arrayParametersIsArray).toBe(true);
  });

  it('reports compact parameter-array metadata structure', () => {
    const summary = summarizeMetadataShape(JSON.parse('{"version":1,"parameters":[]}'));
    expect(summary.topLevelKeys).toEqual(['parameters', 'version']);
    expect(summary.hasParametersWrapper).toBe(false);
    expect(summary.parametersIsObject).toBe(false);
    expect(summary.parametersIsArray).toBe(true);
    expect(summary.groupsIsArray).toBe(false);
  });
});

describe('flattenToLookup', () => {
  const file = parseMetadataFile(jsonContent);
  const lookup = flattenToLookup(file);

  it('produces the correct total count (26 scalar + 10 array = 36)', () => {
    expect(lookup.size).toBe(36);
  });

  it('contains a scalar parameter with correct fields', () => {
    const param = lookup.get('WM_MAX_ROLL');
    expect(param).toBeDefined();
    expect(param!.config_key).toBe('wing_mapping.max_roll_cmd');
    expect(param!.type).toBe('Float');
    expect(param!.default).toBe(0.7);
  });

  it('expands array parameters with correct mavlink_id and config_key', () => {
    const param0 = lookup.get('SCL_PFF_V0');
    expect(param0).toBeDefined();
    expect(param0!.config_key).toBe('scaler.pitch_ff_vel_mps[0]');
    expect(param0!.default).toBe(0.0);

    const param4 = lookup.get('SCL_PFF_V4');
    expect(param4).toBeDefined();
    expect(param4!.config_key).toBe('scaler.pitch_ff_vel_mps[4]');
    expect(param4!.default).toBe(20.0);
  });

  it('expands all array elements', () => {
    for (let i = 0; i < 5; i++) {
      expect(lookup.has(`SCL_PFF_V${i}`)).toBe(true);
      expect(lookup.has(`SCL_PFF_C${i}`)).toBe(true);
    }
  });
});

describe('groupByConfigKeyPrefix', () => {
  const file = parseMetadataFile(jsonContent);
  const lookup = flattenToLookup(file);
  const groups = groupByConfigKeyPrefix(lookup);

  it('produces the expected group names', () => {
    const groupNames = [...groups.keys()].sort();
    expect(groupNames).toEqual([
      'joystick',
      'port_actuator',
      'rear_actuator',
      'sb_actuator',
      'scaler',
      'ultramotion_max_torque',
      'wing_mapping',
    ]);
  });

  it('sorts params within each group by config_key', () => {
    for (const params of groups.values()) {
      for (let i = 1; i < params.length; i++) {
        expect(params[i].config_key.localeCompare(params[i - 1].config_key)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('groups ultramotion_max_torque as a single-entry group (no dot in config_key)', () => {
    const group = groups.get('ultramotion_max_torque');
    expect(group).toBeDefined();
    expect(group!.length).toBe(1);
    expect(group![0].mavlink_id).toBe('UM_MAX_TORQUE');
  });
});
