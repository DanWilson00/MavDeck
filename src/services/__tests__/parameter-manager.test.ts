import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ParameterManager } from '../parameter-manager';
import type { MavlinkMessage } from '../../mavlink/decoder';
import type { ParamSetResult, ParameterStateSnapshot } from '../parameter-types';

function makeParamValue(
  paramId: string,
  value: number,
  index: number,
  count: number,
  paramType = 9,
): MavlinkMessage {
  return {
    id: 22,
    name: 'PARAM_VALUE',
    values: {
      param_id: paramId,
      param_value: value,
      param_type: paramType,
      param_count: count,
      param_index: index,
    },
    systemId: 1,
    componentId: 1,
    sequence: 0,
  };
}

describe('ParameterManager', () => {
  let sendFrame: ReturnType<typeof vi.fn<(messageName: string, values: Record<string, number | string | number[]>) => void>>;
  let getVehicleId: ReturnType<typeof vi.fn<() => { systemId: number; componentId: number }>>;
  let manager: ParameterManager;

  beforeEach(() => {
    vi.useFakeTimers();
    sendFrame = vi.fn();
    getVehicleId = vi.fn().mockReturnValue({ systemId: 1, componentId: 1 });
    manager = new ParameterManager(sendFrame, getVehicleId);
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it('requestAll sends PARAM_REQUEST_LIST', () => {
    manager.requestAll();

    expect(sendFrame).toHaveBeenCalledWith('PARAM_REQUEST_LIST', {
      target_system: 1,
      target_component: 1,
    });
  });

  it('processes PARAM_VALUE messages and updates state', () => {
    manager.requestAll();

    manager.handleMessage(makeParamValue('PARAM_A', 1.0, 0, 3));
    manager.handleMessage(makeParamValue('PARAM_B', 2.0, 1, 3));
    manager.handleMessage(makeParamValue('PARAM_C', 3.0, 2, 3));

    const snapshot = manager.getSnapshot();
    expect(snapshot.receivedCount).toBe(3);
    expect(snapshot.totalCount).toBe(3);
    expect(snapshot.params['PARAM_A']?.value).toBe(1.0);
    expect(snapshot.params['PARAM_B']?.value).toBe(2.0);
    expect(snapshot.params['PARAM_C']?.value).toBe(3.0);
  });

  it('completes immediately when all indices received', () => {
    const states: ParameterStateSnapshot[] = [];
    manager.onStateChange(s => states.push(s));

    manager.requestAll();
    manager.handleMessage(makeParamValue('P1', 1.0, 0, 2));
    manager.handleMessage(makeParamValue('P2', 2.0, 1, 2));

    const snapshot = manager.getSnapshot();
    expect(snapshot.fetchStatus).toBe('done');
  });

  it('detects gaps and sends PARAM_REQUEST_READ for missing indices', () => {
    manager.requestAll();
    sendFrame.mockClear();

    // Send params 0 and 2, missing 1
    manager.handleMessage(makeParamValue('P0', 0, 0, 3));
    manager.handleMessage(makeParamValue('P2', 2, 2, 3));

    // Advance past gap fill timer
    vi.advanceTimersByTime(2000);

    // Should have sent PARAM_REQUEST_READ for index 1
    const readCalls = sendFrame.mock.calls.filter(
      (c: unknown[]) => c[0] === 'PARAM_REQUEST_READ',
    );
    expect(readCalls.length).toBe(1);
    expect(readCalls[0][1]).toEqual({
      target_system: 1,
      target_component: 1,
      param_id: '',
      param_index: 1,
    });
  });

  it('setValue sends PARAM_SET with correct fields', () => {
    // Pre-populate a param so its type is cached
    manager.handleMessage(makeParamValue('MY_PARAM', 1.0, 0, 1));
    sendFrame.mockClear();

    manager.setValue('MY_PARAM', 5.0);

    expect(sendFrame).toHaveBeenCalledWith('PARAM_SET', {
      target_system: 1,
      target_component: 1,
      param_id: 'MY_PARAM',
      param_value: 5.0,
      param_type: 9,
    });
  });

  it('setValue success when matching PARAM_VALUE is received', () => {
    const results: ParamSetResult[] = [];
    manager.onSetResult(r => results.push(r));

    manager.setValue('MY_PARAM', 5.0);
    manager.handleMessage(makeParamValue('MY_PARAM', 5.0, 0, 1));

    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].paramId).toBe('MY_PARAM');
    expect(results[0].requestedValue).toBe(5.0);
    expect(results[0].actualValue).toBe(5.0);
  });

  it('setValue timeout retries then errors after max retries', () => {
    const results: ParamSetResult[] = [];
    manager.onSetResult(r => results.push(r));

    manager.setValue('MY_PARAM', 5.0);
    expect(sendFrame).toHaveBeenCalledTimes(1);

    // Advance through 3 retries (1s each)
    vi.advanceTimersByTime(1000); // retry 1
    expect(sendFrame).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000); // retry 2
    expect(sendFrame).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(1000); // retry 3 -> max reached, error
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Timeout');
  });

  it('deduplication keeps latest value for same paramIndex', () => {
    manager.requestAll();
    manager.handleMessage(makeParamValue('P0', 1.0, 0, 2));
    manager.handleMessage(makeParamValue('P0', 99.0, 0, 2));

    const snapshot = manager.getSnapshot();
    expect(snapshot.params['P0']?.value).toBe(99.0);
    expect(snapshot.receivedCount).toBe(1); // Still just 1 unique index
  });

  it('tolerant float comparison for setValue success', () => {
    const results: ParamSetResult[] = [];
    manager.onSetResult(r => results.push(r));

    manager.setValue('FLOAT_P', 0.7);
    manager.handleMessage(makeParamValue('FLOAT_P', 0.699999988, 0, 1));

    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
  });

  it('rejects second setValue while one is pending', () => {
    const results: ParamSetResult[] = [];
    manager.onSetResult(r => results.push(r));

    manager.setValue('P1', 1.0);
    manager.setValue('P2', 2.0);

    expect(results.length).toBe(1);
    expect(results[0].paramId).toBe('P2');
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('already in progress');
  });

  it('ignores non-PARAM_VALUE messages', () => {
    const msg: MavlinkMessage = {
      id: 0,
      name: 'HEARTBEAT',
      values: { type: 1, autopilot: 3 },
      systemId: 1,
      componentId: 1,
      sequence: 0,
    };
    manager.handleMessage(msg);
    const snapshot = manager.getSnapshot();
    expect(snapshot.receivedCount).toBe(0);
  });

  it('trims null bytes from param_id', () => {
    manager.handleMessage(makeParamValue('P1\0\0\0\0', 1.0, 0, 1));
    const snapshot = manager.getSnapshot();
    expect(snapshot.params['P1']).toBeDefined();
    expect(snapshot.params['P1\0\0\0\0']).toBeUndefined();
  });

  it('emits state changes throttled to 10Hz', () => {
    const states: ParameterStateSnapshot[] = [];
    manager.onStateChange(s => states.push(s));

    manager.requestAll();

    // First emit should happen immediately
    expect(states.length).toBe(1);

    // Rapid updates within 100ms should be batched
    manager.handleMessage(makeParamValue('P0', 0, 0, 5));
    manager.handleMessage(makeParamValue('P1', 1, 1, 5));
    manager.handleMessage(makeParamValue('P2', 2, 2, 5));

    // Still just 1 since throttle hasn't elapsed
    expect(states.length).toBe(1);

    // After throttle window, should emit batched update
    vi.advanceTimersByTime(100);
    expect(states.length).toBe(2);
    expect(states[1].receivedCount).toBe(3);
  });

  it('gap fill gives up after max rounds with error status', () => {
    manager.requestAll();
    sendFrame.mockClear();

    manager.handleMessage(makeParamValue('P0', 0, 0, 3));
    // Missing indices 1 and 2

    // Round 1
    vi.advanceTimersByTime(2000);
    // Round 2
    vi.advanceTimersByTime(2000);
    // Round 3 -> should give up
    vi.advanceTimersByTime(2000);

    const snapshot = manager.getSnapshot();
    expect(snapshot.fetchStatus).toBe('error');
    expect(snapshot.error).toContain('Missing');
  });
});
