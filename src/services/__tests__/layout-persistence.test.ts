import { describe, expect, it } from 'vitest';
import type { PlotTab } from '../../models';
import { deserializePlotTabs, serializePlotTabs } from '../layout-persistence';

describe('layout-persistence', () => {
  it('round-trips plot tabs without sharing references', () => {
    const tabs: PlotTab[] = [{
      id: 'tab-1',
      name: 'Tab 1',
      plots: [{
        id: 'plot-1',
        title: 'Altitude',
        scalingMode: 'auto',
        timeWindow: 30,
        gridPos: { x: 0, y: 0, w: 6, h: 4 },
        signals: [{
          id: 'sig-1',
          messageType: 'GLOBAL_POSITION_INT',
          fieldName: 'alt',
          fieldKey: 'GLOBAL_POSITION_INT.alt',
          color: '#00d4ff',
          visible: true,
        }],
      }],
    }];

    const persisted = serializePlotTabs(tabs);
    const restored = deserializePlotTabs(persisted);

    expect(restored).toEqual(tabs);
    expect(restored).not.toBe(tabs);
    expect(restored[0]).not.toBe(tabs[0]);
    expect(restored[0].plots[0]).not.toBe(tabs[0].plots[0]);
    expect(restored[0].plots[0].signals[0]).not.toBe(tabs[0].plots[0].signals[0]);
  });
});
