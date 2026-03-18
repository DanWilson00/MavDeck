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
  return new Map(defs.map(def => [def.mavlink_id, def]));
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

  it('continues to use metadata grouping when a metadata file is loaded', () => {
    const state = makeState([
      { paramId: 'PSC_ACCZ_P', paramIndex: 0 },
      { paramId: 'NO_META_PARAM', paramIndex: 1 },
    ]);
    const lookup = makeMeta([{
      mavlink_id: 'PSC_ACCZ_P',
      config_key: 'position.accz.p',
      type: 'Float',
      default: 0,
      min: 0,
      max: 1,
      description: 'Test parameter',
    }]);

    const groups = buildParamGroups(state, lookup, true);

    expect(groups.map(g => g.name)).toEqual(['Other', 'position']);
    expect(groups.find(g => g.name === 'Other')!.params.map(p => p.paramId)).toEqual(['NO_META_PARAM']);
    expect(groups.find(g => g.name === 'position')!.params.map(p => p.paramId)).toEqual(['PSC_ACCZ_P']);
  });
});
