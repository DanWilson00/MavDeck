import { describe, expect, it } from 'vitest';
import { buildParamGroups, deriveFallbackParamGroupName } from '../../services/parameter-grouping';
import type { ParameterStateSnapshot } from '../../services/parameter-types';
import type { ParamDef } from '../../models/parameter-metadata';

function makeState(params: Array<{ paramId: string; value?: number; paramType?: number; paramIndex: number }>): ParameterStateSnapshot {
  return {
    params: Object.fromEntries(params.map(p => [p.paramId, {
      paramId: p.paramId,
      value: p.value ?? 0,
      paramType: p.paramType ?? 9,
      paramIndex: p.paramIndex,
    }])),
    totalCount: params.length,
    receivedCount: params.length,
    fetchStatus: 'done',
    error: null,
  };
}

function makeMeta(defs: ParamDef[]): Map<string, ParamDef> {
  return new Map(defs.map(def => [def.name, def]));
}

function makeParamDef(overrides: Partial<ParamDef> & { name: string }): ParamDef {
  return {
    type: 'Float',
    group: '',
    default: 0,
    min: 0,
    max: 1,
    shortDesc: '',
    longDesc: '',
    units: '',
    decimalPlaces: 0,
    rebootRequired: false,
    ...overrides,
  };
}

describe('deriveFallbackParamGroupName', () => {
  it('uses the token before the first underscore', () => {
    expect(deriveFallbackParamGroupName('PSC_ACCZ_P')).toBe('PSC');
  });

  it('uses the full param id when no underscore exists', () => {
    expect(deriveFallbackParamGroupName('ROLLRATE')).toBe('ROLLRATE');
  });
});

describe('buildParamGroups', () => {
  it('groups params by mavlink id prefix when no metadata file is loaded', () => {
    const state = makeState([
      { paramId: 'PSC_ACCZ_P', paramIndex: 0 },
      { paramId: 'PSC_ACCZ_I', paramIndex: 1 },
      { paramId: 'ATC_RAT_RLL_P', paramIndex: 2 },
    ]);

    const groups = buildParamGroups(state, new Map(), false);

    expect(groups.map(g => g.name)).toEqual(['ATC', 'PSC']);
    expect(groups.find(g => g.name === 'PSC')!.params.map(p => p.paramId)).toEqual([
      'PSC_ACCZ_I',
      'PSC_ACCZ_P',
    ]);
  });

  it('uses the full param id as the group when no underscore exists and no metadata file is loaded', () => {
    const state = makeState([
      { paramId: 'ROLLRATE', paramIndex: 0 },
      { paramId: 'PSC_ACCZ_P', paramIndex: 1 },
    ]);

    const groups = buildParamGroups(state, new Map(), false);

    expect(groups.map(g => g.name)).toEqual(['PSC', 'ROLLRATE']);
    expect(groups.find(g => g.name === 'ROLLRATE')!.params.map(p => p.paramId)).toEqual(['ROLLRATE']);
  });

  it('prefers explicit metadata group names when a metadata file is loaded', () => {
    const state = makeState([
      { paramId: 'PSC_ACCZ_P', paramIndex: 0 },
      { paramId: 'NO_META_PARAM', paramIndex: 1 },
    ]);
    const lookup = makeMeta([makeParamDef({
      name: 'PSC_ACCZ_P',
      shortDesc: 'position.accz.p',
      group: 'Control',
      longDesc: 'Test parameter',
    })]);

    const groups = buildParamGroups(state, lookup, true);

    expect(groups.map(g => g.name)).toEqual(['Control', 'Other']);
    expect(groups.find(g => g.name === 'Other')!.params.map(p => p.paramId)).toEqual(['NO_META_PARAM']);
    expect(groups.find(g => g.name === 'Control')!.params.map(p => p.paramId)).toEqual(['PSC_ACCZ_P']);
  });

  it('falls back to shortDesc prefixes when metadata is loaded without explicit group names', () => {
    const state = makeState([
      { paramId: 'PSC_ACCZ_P', paramIndex: 0 },
    ]);
    const lookup = makeMeta([makeParamDef({
      name: 'PSC_ACCZ_P',
      shortDesc: 'position.accz.p',
      longDesc: 'Test parameter',
    })]);

    const groups = buildParamGroups(state, lookup, true);

    expect(groups.map(g => g.name)).toEqual(['position']);
    expect(groups.find(g => g.name === 'position')!.params.map(p => p.paramId)).toEqual(['PSC_ACCZ_P']);
  });

  it('builds arrays from metadata arrayInfo and keeps the shortDesc prefix as the array label', () => {
    const state = makeState([
      { paramId: 'ARR_0', paramIndex: 0, value: 1 },
      { paramId: 'ARR_1', paramIndex: 1, value: 2 },
      { paramId: 'OTHER', paramIndex: 2, value: 3 },
    ]);
    const lookup = makeMeta([
      makeParamDef({
        name: 'ARR_0',
        shortDesc: 'scaler.pitch_ff_cmd[0]',
        group: 'Control',
        longDesc: 'Pitch FF command',
        max: 10,
        arrayInfo: { prefix: 'scaler.pitch_ff_cmd', index: 0, count: 2 },
      }),
      makeParamDef({
        name: 'ARR_1',
        shortDesc: 'scaler.pitch_ff_cmd[1]',
        group: 'Control',
        longDesc: 'Pitch FF command',
        max: 10,
        arrayInfo: { prefix: 'scaler.pitch_ff_cmd', index: 1, count: 2 },
      }),
      makeParamDef({
        name: 'OTHER',
        shortDesc: 'wing_mapping.max_roll_cmd',
        group: 'Control',
        longDesc: 'Roll command',
      }),
    ]);

    const groups = buildParamGroups(state, lookup, true);

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Control');
    expect(groups[0].params.map(p => p.paramId)).toEqual(['OTHER']);
    expect(groups[0].arrays).toHaveLength(1);
    expect(groups[0].arrays[0].prefix).toBe('scaler.pitch_ff_cmd');
    expect(groups[0].arrays[0].label).toBe('scaler.pitch_ff_cmd');
    expect(groups[0].arrays[0].elements.map(p => p.paramId)).toEqual(['ARR_0', 'ARR_1']);
  });
});
