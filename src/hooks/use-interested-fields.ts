import { createEffect } from 'solid-js';
import { appState, workerBridge } from '../store';

const MAP_REQUIRED_FIELDS = [
  'GLOBAL_POSITION_INT.lat',
  'GLOBAL_POSITION_INT.lon',
  'GLOBAL_POSITION_INT.alt',
  'GLOBAL_POSITION_INT.hdg',
];

export function useInterestedFields(): void {
  // Stream fields needed by ALL tabs (all charts stay alive for instant switching).
  createEffect(() => {
    if (!appState.isReady) return;

    const interested = new Set<string>(MAP_REQUIRED_FIELDS);
    for (const tab of appState.plotTabs) {
      for (const plot of tab.plots) {
        for (const signal of plot.signals) {
          if (signal.visible) {
            interested.add(signal.fieldKey);
          }
        }
      }
    }

    workerBridge.setInterestedFields([...interested]);
  });
}
