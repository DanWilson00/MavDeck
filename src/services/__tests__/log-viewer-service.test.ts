import { describe, expect, it, vi } from 'vitest';
import { LogViewerService } from '../log-viewer-service';
import type { SerialSessionController } from '../serial-session-controller';
import type { MavlinkWorkerBridge } from '../worker-bridge';

describe('log-viewer-service', () => {
  it('load enters log mode before sending the log to the worker', () => {
    const bridge = {
      loadLog: vi.fn(),
      unloadLog: vi.fn(),
    } as unknown as MavlinkWorkerBridge;
    const serialSessionController = {
      enterLogMode: vi.fn(),
    } as unknown as SerialSessionController;

    const service = new LogViewerService(bridge, serialSessionController);
    const callback = vi.fn();
    service.subscribe(callback);

    service.load([
      { timestampUs: 1_000_000, packet: Uint8Array.from([1, 2, 3]) },
      { timestampUs: 2_000_000, packet: Uint8Array.from([4, 5]) },
    ], 'flight.tlog');

    expect(serialSessionController.enterLogMode).toHaveBeenCalledOnce();
    expect(bridge.loadLog).toHaveBeenCalledWith(
      [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5])],
      [1000, 2000],
      2000,
    );
    expect(callback).toHaveBeenLastCalledWith({
      isActive: true,
      sourceName: 'flight.tlog',
      durationSec: 0,
      recordCount: 2,
    });
  });

  it('unload clears local state and uses unloadLog instead of disconnect', () => {
    const bridge = {
      loadLog: vi.fn(),
      unloadLog: vi.fn(),
    } as unknown as MavlinkWorkerBridge;
    const serialSessionController = {
      enterLogMode: vi.fn(),
    } as unknown as SerialSessionController;

    const service = new LogViewerService(bridge, serialSessionController);
    const callback = vi.fn();
    service.subscribe(callback);

    service.load([{ timestampUs: 1_000_000, packet: Uint8Array.from([1]) }], 'flight.tlog');
    service.unload();

    expect(bridge.unloadLog).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenLastCalledWith({
      isActive: false,
      sourceName: '',
      durationSec: 0,
      recordCount: 0,
    });
  });
});
