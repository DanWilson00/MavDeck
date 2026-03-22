import { describe, expect, it } from 'vitest';
import {
  clearMainThreadTelemetryState,
  clearStatusTextAssembly,
  forwardStatusText,
  serializeStats,
  type PipelineFieldState,
  type StatusTextAssemblyState,
} from '../mavlink-worker-pipeline-helpers';
import type { MavlinkMessage } from '../../mavlink/decoder';
import type { MessageStats } from '../../services/message-tracker';
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

  it('ignores non-STATUSTEXT messages', () => {
    const events: WorkerEvent[] = [];
    const state: StatusTextAssemblyState = { partials: new Map() };

    forwardStatusText(
      state,
      { id: 0, name: 'HEARTBEAT', values: { severity: 1, text: 'hi' }, systemId: 1, componentId: 1, sequence: 0 },
      1000,
      (event) => events.push(event),
    );

    expect(events).toHaveLength(0);
  });

  it('ignores empty text', () => {
    const events: WorkerEvent[] = [];
    const state: StatusTextAssemblyState = { partials: new Map() };

    forwardStatusText(
      state,
      makeStatusTextMessage({ severity: 4, text: '', id: 0, chunk_seq: 0 }),
      1000,
      (event) => events.push(event),
    );

    expect(events).toHaveLength(0);
  });

  it('drops out-of-order chunks', () => {
    const events: WorkerEvent[] = [];
    const state: StatusTextAssemblyState = { partials: new Map() };
    const chunkA = 'A'.repeat(50);

    // Send chunk 0
    forwardStatusText(
      state,
      makeStatusTextMessage({ severity: 6, text: chunkA, id: 10, chunk_seq: 0 }),
      1000,
      (event) => events.push(event),
    );

    // Skip chunk 1, send chunk 2 — should be dropped
    forwardStatusText(
      state,
      makeStatusTextMessage({ severity: 6, text: 'final', id: 10, chunk_seq: 2 }),
      1020,
      (event) => events.push(event),
    );

    expect(events).toHaveLength(0); // neither chunk emitted a complete message
    expect(state.partials.size).toBe(1); // chunk 0 still pending
  });
});

describe('serializeStats', () => {
  it('converts a Map to a plain object', () => {
    const msg: MavlinkMessage = { id: 0, name: 'HEARTBEAT', values: {}, systemId: 1, componentId: 1, sequence: 0 };
    const stats = new Map<string, MessageStats>([
      ['HEARTBEAT', { count: 10, frequency: 1, lastMessage: msg, lastReceived: 1000 }],
      ['ATTITUDE', { count: 5, frequency: 2, lastMessage: msg, lastReceived: 2000 }],
    ]);

    const result = serializeStats(stats);
    expect(Object.keys(result)).toEqual(['HEARTBEAT', 'ATTITUDE']);
    expect(result['HEARTBEAT'].count).toBe(10);
    expect(result['ATTITUDE'].frequency).toBe(2);
  });

  it('returns empty object for empty map', () => {
    const result = serializeStats(new Map());
    expect(result).toEqual({});
  });
});

describe('clearMainThreadTelemetryState', () => {
  it('resets signature and posts empty fields/update/stats', () => {
    const events: WorkerEvent[] = [];
    const state: PipelineFieldState = {
      interestedFields: new Set(['HEARTBEAT.type']),
      lastAvailableFieldsSignature: 'HEARTBEAT.type|ATTITUDE.roll',
    };

    clearMainThreadTelemetryState(state, (event) => events.push(event));

    expect(state.lastAvailableFieldsSignature).toBe('');
    expect(events).toEqual([
      { type: 'availableFields', fields: [] },
      { type: 'update', buffers: {} },
      { type: 'stats', stats: {} },
    ]);
  });
});

describe('clearStatusTextAssembly', () => {
  it('clears all partial messages', () => {
    const state: StatusTextAssemblyState = {
      partials: new Map([
        ['1:1:42', { text: 'partial', severity: 4, timestamp: 100, nextChunkSeq: 1 }],
      ]),
    };

    clearStatusTextAssembly(state);
    expect(state.partials.size).toBe(0);
  });
});
