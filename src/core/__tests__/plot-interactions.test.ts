import { describe, expect, it, vi } from 'vitest';
import { createPlotInteractionController } from '../plot-interactions';

describe('PlotInteractionController', () => {
  it('starts in live mode with no zoom', () => {
    const controller = createPlotInteractionController();
    const snapshot = controller.getSnapshot();

    expect(snapshot.mode).toBe('live');
    expect(snapshot.zoomRange).toBeNull();
    expect(snapshot.lastSourcePlotId).toBeNull();
  });

  it('emitZoom transitions to zoomed mode', () => {
    const controller = createPlotInteractionController();
    controller.emitZoom({ min: 10, max: 20 }, 'plot-1');

    const snapshot = controller.getSnapshot();
    expect(snapshot.mode).toBe('zoomed');
    expect(snapshot.zoomRange).toEqual({ min: 10, max: 20 });
    expect(snapshot.lastSourcePlotId).toBe('plot-1');
  });

  it('emitReset transitions back to live mode', () => {
    const controller = createPlotInteractionController();
    controller.emitZoom({ min: 10, max: 20 }, 'plot-1');
    controller.emitReset('plot-2');

    const snapshot = controller.getSnapshot();
    expect(snapshot.mode).toBe('live');
    expect(snapshot.zoomRange).toBeNull();
    expect(snapshot.lastSourcePlotId).toBe('plot-2');
  });

  it('subscribe notifies on zoom changes', () => {
    const controller = createPlotInteractionController();
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.emitZoom({ min: 5, max: 15 }, 'plot-A');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      mode: 'zoomed',
      zoomRange: { min: 5, max: 15 },
      lastSourcePlotId: 'plot-A',
    });
  });

  it('subscribe notifies on reset', () => {
    const controller = createPlotInteractionController();
    const listener = vi.fn();

    controller.emitZoom({ min: 1, max: 2 }, 'plot-1');
    controller.subscribe(listener);
    controller.emitReset('plot-1');

    expect(listener).toHaveBeenCalledWith({
      mode: 'live',
      zoomRange: null,
      lastSourcePlotId: 'plot-1',
    });
  });

  it('unsubscribe stops notifications', () => {
    const controller = createPlotInteractionController();
    const listener = vi.fn();
    const unsub = controller.subscribe(listener);

    controller.emitZoom({ min: 1, max: 2 }, 'plot-1');
    expect(listener).toHaveBeenCalledOnce();

    unsub();
    controller.emitZoom({ min: 3, max: 4 }, 'plot-2');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('deduplicates identical zoom ranges', () => {
    const controller = createPlotInteractionController();
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.emitZoom({ min: 10, max: 20 }, 'plot-1');
    controller.emitZoom({ min: 10, max: 20 }, 'plot-2');

    expect(listener).toHaveBeenCalledOnce();
  });

  it('emits when zoom range changes', () => {
    const controller = createPlotInteractionController();
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.emitZoom({ min: 10, max: 20 }, 'plot-1');
    controller.emitZoom({ min: 10, max: 25 }, 'plot-1');

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('deduplicates reset when already in live mode', () => {
    const controller = createPlotInteractionController();
    const listener = vi.fn();
    controller.subscribe(listener);

    // Already live with null zoom — reset should be a no-op
    controller.emitReset('plot-1');

    expect(listener).not.toHaveBeenCalled();
  });

  it('multiple subscribers all receive events', () => {
    const controller = createPlotInteractionController();
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    controller.subscribe(listener1);
    controller.subscribe(listener2);

    controller.emitZoom({ min: 0, max: 100 }, 'plot-X');

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });
});
