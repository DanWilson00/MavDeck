export type ZoomRange = { min: number; max: number } | null;
export type InteractionMode = 'live' | 'zoomed';

export interface PlotInteractionSnapshot {
  mode: InteractionMode;
  zoomRange: ZoomRange;
  lastSourcePlotId: string | null;
}

type Listener = (snapshot: PlotInteractionSnapshot) => void;

export interface PlotInteractionController {
  getSnapshot: () => PlotInteractionSnapshot;
  subscribe: (listener: Listener) => () => void;
  emitZoom: (range: { min: number; max: number }, sourcePlotId: string) => void;
  emitReset: (sourcePlotId: string) => void;
}

export function createPlotInteractionController(): PlotInteractionController {
  let snapshot: PlotInteractionSnapshot = {
    mode: 'live',
    zoomRange: null,
    lastSourcePlotId: null,
  };
  const listeners = new Set<Listener>();

  function notify() {
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitZoom: (range, sourcePlotId) => {
      if (
        snapshot.mode === 'zoomed' &&
        snapshot.zoomRange &&
        snapshot.zoomRange.min === range.min &&
        snapshot.zoomRange.max === range.max
      ) {
        return;
      }
      snapshot = {
        mode: 'zoomed',
        zoomRange: range,
        lastSourcePlotId: sourcePlotId,
      };
      notify();
    },
    emitReset: (sourcePlotId) => {
      if (snapshot.mode === 'live' && snapshot.zoomRange === null) {
        return;
      }
      snapshot = {
        mode: 'live',
        zoomRange: null,
        lastSourcePlotId: sourcePlotId,
      };
      notify();
    },
  };
}
