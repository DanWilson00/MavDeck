import { describe, it, expect, beforeAll } from 'vitest';
import { SpoofParamResponder } from '../spoof-param-responder';
import { MavlinkMetadataRegistry } from '../../mavlink/registry';
import { MavlinkFrameParser } from '../../mavlink/frame-parser';
import { MavlinkMessageDecoder, type MavlinkMessage } from '../../mavlink/decoder';
import { MavlinkFrameBuilder } from '../../mavlink/frame-builder';
import { loadCommonDialectJson } from '../../test-helpers/load-dialect';

const commonJson = loadCommonDialectJson();

describe('SpoofParamResponder', () => {
  let registry: MavlinkMetadataRegistry;
  let responder: SpoofParamResponder;
  let parser: MavlinkFrameParser;
  let decoder: MavlinkMessageDecoder;
  let frameBuilder: MavlinkFrameBuilder;

  /** Decode response frames into MavlinkMessage objects. */
  function decodeResponses(responseFrames: Uint8Array[]): MavlinkMessage[] {
    const messages: MavlinkMessage[] = [];
    const p = new MavlinkFrameParser(registry);
    const d = new MavlinkMessageDecoder(registry);
    p.onFrame(frame => {
      const msg = d.decode(frame);
      if (msg) messages.push(msg);
    });
    for (const rf of responseFrames) {
      p.parse(rf);
    }
    return messages;
  }

  beforeAll(() => {
    registry = new MavlinkMetadataRegistry();
    registry.loadFromJsonString(commonJson);
    parser = new MavlinkFrameParser(registry);
    decoder = new MavlinkMessageDecoder(registry);
    frameBuilder = new MavlinkFrameBuilder(registry);
  });

  // Fresh responder per test
  function createResponder(): SpoofParamResponder {
    return new SpoofParamResponder(registry);
  }

  describe('handleRequestList', () => {
    it('returns PARAM_VALUE frames for all parameters', () => {
      const r = createResponder();
      const requestMsg: MavlinkMessage = {
        id: registry.getMessageByName('PARAM_REQUEST_LIST')!.id,
        name: 'PARAM_REQUEST_LIST',
        values: { target_system: 1, target_component: 1 },
        systemId: 255,
        componentId: 190,
        sequence: 0,
      };

      const responseFrames = r.handleMessage(requestMsg);
      expect(responseFrames.length).toBeGreaterThan(0);

      const messages = decodeResponses(responseFrames);
      expect(messages.length).toBe(responseFrames.length);

      // All should be PARAM_VALUE
      for (const msg of messages) {
        expect(msg.name).toBe('PARAM_VALUE');
      }

      // param_count should match total number of params
      const paramCount = messages[0].values.param_count as number;
      expect(paramCount).toBe(messages.length);

      // param_index should cover 0..N-1
      const indices = messages.map(m => m.values.param_index as number).sort((a, b) => a - b);
      for (let i = 0; i < indices.length; i++) {
        expect(indices[i]).toBe(i);
      }
    });
  });

  describe('handleRequestRead', () => {
    it('returns correct param when read by index', () => {
      const r = createResponder();

      // First get the full list to know what param is at index 0
      const listMsg: MavlinkMessage = {
        id: registry.getMessageByName('PARAM_REQUEST_LIST')!.id,
        name: 'PARAM_REQUEST_LIST',
        values: { target_system: 1, target_component: 1 },
        systemId: 255,
        componentId: 190,
        sequence: 0,
      };
      const allFrames = r.handleMessage(listMsg);
      const allMessages = decodeResponses(allFrames);
      const firstParam = allMessages[0];

      // Now request by index
      const readMsg: MavlinkMessage = {
        id: registry.getMessageByName('PARAM_REQUEST_READ')!.id,
        name: 'PARAM_REQUEST_READ',
        values: {
          target_system: 1,
          target_component: 1,
          param_id: '',
          param_index: 0,
        },
        systemId: 255,
        componentId: 190,
        sequence: 1,
      };

      const readFrames = r.handleMessage(readMsg);
      expect(readFrames.length).toBe(1);

      const readMessages = decodeResponses(readFrames);
      expect(readMessages.length).toBe(1);
      expect(readMessages[0].values.param_id).toBe(firstParam.values.param_id);
      expect(readMessages[0].values.param_value).toBe(firstParam.values.param_value);
    });

    it('returns correct param when read by name', () => {
      const r = createResponder();

      const readMsg: MavlinkMessage = {
        id: registry.getMessageByName('PARAM_REQUEST_READ')!.id,
        name: 'PARAM_REQUEST_READ',
        values: {
          target_system: 1,
          target_component: 1,
          param_id: 'JS_DEADBAND',
          param_index: -1,
        },
        systemId: 255,
        componentId: 190,
        sequence: 1,
      };

      const readFrames = r.handleMessage(readMsg);
      expect(readFrames.length).toBe(1);

      const readMessages = decodeResponses(readFrames);
      expect(readMessages[0].values.param_id).toBe('JS_DEADBAND');
    });

    it('returns empty for unknown param', () => {
      const r = createResponder();

      const readMsg: MavlinkMessage = {
        id: registry.getMessageByName('PARAM_REQUEST_READ')!.id,
        name: 'PARAM_REQUEST_READ',
        values: {
          target_system: 1,
          target_component: 1,
          param_id: 'NONEXISTENT',
          param_index: -1,
        },
        systemId: 255,
        componentId: 190,
        sequence: 1,
      };

      const readFrames = r.handleMessage(readMsg);
      expect(readFrames.length).toBe(0);
    });
  });

  describe('handleParamSet', () => {
    it('stores new value and returns PARAM_VALUE with updated value', () => {
      const r = createResponder();

      const setMsg: MavlinkMessage = {
        id: registry.getMessageByName('PARAM_SET')!.id,
        name: 'PARAM_SET',
        values: {
          target_system: 1,
          target_component: 1,
          param_id: 'JS_DEADBAND',
          param_value: 0.15,
          param_type: 9,
        },
        systemId: 255,
        componentId: 190,
        sequence: 1,
      };

      const setFrames = r.handleMessage(setMsg);
      expect(setFrames.length).toBe(1);

      const setMessages = decodeResponses(setFrames);
      expect(setMessages[0].values.param_id).toBe('JS_DEADBAND');
      // Float32 round-trip: check approximate equality
      expect(setMessages[0].values.param_value as number).toBeCloseTo(0.15, 5);

      // Verify value is persisted by reading it back
      const readMsg: MavlinkMessage = {
        id: registry.getMessageByName('PARAM_REQUEST_READ')!.id,
        name: 'PARAM_REQUEST_READ',
        values: {
          target_system: 1,
          target_component: 1,
          param_id: 'JS_DEADBAND',
          param_index: -1,
        },
        systemId: 255,
        componentId: 190,
        sequence: 2,
      };

      const readFrames = r.handleMessage(readMsg);
      const readMessages = decodeResponses(readFrames);
      expect(readMessages[0].values.param_value as number).toBeCloseTo(0.15, 5);
    });

    it('returns empty for unknown param', () => {
      const r = createResponder();

      const setMsg: MavlinkMessage = {
        id: registry.getMessageByName('PARAM_SET')!.id,
        name: 'PARAM_SET',
        values: {
          target_system: 1,
          target_component: 1,
          param_id: 'NONEXISTENT',
          param_value: 1.0,
          param_type: 9,
        },
        systemId: 255,
        componentId: 190,
        sequence: 1,
      };

      const setFrames = r.handleMessage(setMsg);
      expect(setFrames.length).toBe(0);
    });
  });

  describe('unhandled messages', () => {
    it('returns empty array for non-param messages', () => {
      const r = createResponder();

      const heartbeatMsg: MavlinkMessage = {
        id: 0,
        name: 'HEARTBEAT',
        values: { type: 2, autopilot: 3, base_mode: 0x81, custom_mode: 0, system_status: 4, mavlink_version: 3 },
        systemId: 1,
        componentId: 1,
        sequence: 0,
      };

      expect(r.handleMessage(heartbeatMsg)).toEqual([]);
    });
  });
});
