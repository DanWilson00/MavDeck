import { describe, expect, it } from 'vitest';
import { forwardStatusText, type StatusTextAssemblyState } from '../mavlink-worker-pipeline-helpers';
import type { MavlinkMessage } from '../../mavlink/decoder';
import type { WorkerEvent } from '../worker-protocol';

function makeStatusTextMessage(values: Record<string, number | string>): MavlinkMessage {
  return {
    id: 253,
    name: 'STATUSTEXT',
    values,
    systemId: 1,
    componentId: 1,
    sequence: 0,
  };
}

describe('forwardStatusText', () => {
  it('forwards a non-chunked STATUSTEXT immediately', () => {
    const events: WorkerEvent[] = [];
    const state: StatusTextAssemblyState = { partials: new Map() };

    forwardStatusText(
      state,
      makeStatusTextMessage({ severity: 4, text: 'GPS warning', id: 0, chunk_seq: 0 }),
      1000,
      (event) => events.push(event),
    );

    expect(events).toEqual([
      { type: 'statustext', severity: 4, text: 'GPS warning', timestamp: 1000 },
    ]);
  });

  it('reassembles chunked STATUSTEXT before forwarding', () => {
    const events: WorkerEvent[] = [];
    const state: StatusTextAssemblyState = { partials: new Map() };
    const chunkA = 'A'.repeat(50);
    const chunkB = 'B'.repeat(20);

    forwardStatusText(
      state,
      makeStatusTextMessage({ severity: 6, text: chunkA, id: 42, chunk_seq: 0 }),
      1000,
      (event) => events.push(event),
    );
    forwardStatusText(
      state,
      makeStatusTextMessage({ severity: 6, text: chunkB, id: 42, chunk_seq: 1 }),
      1010,
      (event) => events.push(event),
    );

    expect(events).toEqual([
      { type: 'statustext', severity: 6, text: chunkA + chunkB, timestamp: 1010 },
    ]);
    expect(state.partials.size).toBe(0);
  });
});
