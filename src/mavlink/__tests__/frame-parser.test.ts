import { describe, it, expect, beforeEach } from 'vitest';
import { MavlinkMetadataRegistry } from '../registry';
import { MavlinkFrameParser } from '../frame-parser';
import { MavlinkFrameBuilder } from '../frame-builder';
import { MavlinkMessageDecoder, type MavlinkMessage } from '../decoder';
import type { MavlinkFrame } from '../frame';
import { loadCommonDialectJson } from '../../test-helpers/load-dialect';

const commonJson = loadCommonDialectJson();

describe('MavlinkFrameParser', () => {
  let registry: MavlinkMetadataRegistry;
  let parser: MavlinkFrameParser;
  let builder: MavlinkFrameBuilder;

  beforeEach(() => {
    registry = new MavlinkMetadataRegistry();
    registry.loadFromJsonString(commonJson);
    parser = new MavlinkFrameParser(registry);
    builder = new MavlinkFrameBuilder(registry);
  });

  function buildHeartbeat(seq = 0): Uint8Array {
    return builder.buildFrame({
      messageName: 'HEARTBEAT',
      values: {
        custom_mode: 0,
        type: 2,
        autopilot: 3,
        base_mode: 0x81,
        system_status: 4,
        mavlink_version: 3,
      },
      systemId: 1,
      componentId: 1,
      sequence: seq,
    });
  }

  it('parses a valid HEARTBEAT v2 frame fed byte-by-byte', () => {
    const frameBytes = buildHeartbeat();
    const frames: MavlinkFrame[] = [];
    parser.onFrame(f => frames.push(f));

    // Feed one byte at a time
    for (let i = 0; i < frameBytes.length; i++) {
      parser.parse(new Uint8Array([frameBytes[i]]));
    }

    expect(frames.length).toBe(1);
    expect(frames[0].messageId).toBe(0);
    expect(frames[0].systemId).toBe(1);
    expect(frames[0].componentId).toBe(1);
    expect(frames[0].sequence).toBe(0);
    expect(frames[0].crcValid).toBe(true);
    expect(parser.framesReceived).toBe(1);
  });

  it('parses the same frame in one chunk', () => {
    const frameBytes = buildHeartbeat();
    const frames: MavlinkFrame[] = [];
    parser.onFrame(f => frames.push(f));

    parser.parse(frameBytes);

    expect(frames.length).toBe(1);
    expect(frames[0].messageId).toBe(0);
    expect(frames[0].crcValid).toBe(true);
  });

  it('rejects a frame with bad CRC', () => {
    const frameBytes = buildHeartbeat();
    // Corrupt the CRC
    frameBytes[frameBytes.length - 1] ^= 0xFF;

    const frames: MavlinkFrame[] = [];
    parser.onFrame(f => frames.push(f));

    parser.parse(frameBytes);

    expect(frames.length).toBe(0);
    expect(parser.crcErrors).toBe(1);
  });

  it('increments unknownMessages for unknown message ID', () => {
    const frameBytes = buildHeartbeat();
    // Use a fresh registry with no messages loaded
    const emptyRegistry = new MavlinkMetadataRegistry();
    const emptyParser = new MavlinkFrameParser(emptyRegistry);

    const frames: MavlinkFrame[] = [];
    emptyParser.onFrame(f => frames.push(f));
    emptyParser.parse(frameBytes);

    expect(frames.length).toBe(0);
    expect(emptyParser.unknownMessages).toBe(1);
  });

  it('parses two valid frames concatenated', () => {
    const frame1 = buildHeartbeat(0);
    const frame2 = buildHeartbeat(1);
    const combined = new Uint8Array(frame1.length + frame2.length);
    combined.set(frame1);
    combined.set(frame2, frame1.length);

    const frames: MavlinkFrame[] = [];
    parser.onFrame(f => frames.push(f));
    parser.parse(combined);

    expect(frames.length).toBe(2);
    expect(frames[0].sequence).toBe(0);
    expect(frames[1].sequence).toBe(1);
    expect(parser.framesReceived).toBe(2);
  });

  it('re-syncs on STX after garbage bytes', () => {
    const frameBytes = buildHeartbeat();
    const garbage = new Uint8Array([0x01, 0x02, 0x03, 0xFF, 0x00]);
    const combined = new Uint8Array(garbage.length + frameBytes.length);
    combined.set(garbage);
    combined.set(frameBytes, garbage.length);

    const frames: MavlinkFrame[] = [];
    parser.onFrame(f => frames.push(f));
    parser.parse(combined);

    expect(frames.length).toBe(1);
    expect(frames[0].crcValid).toBe(true);
  });

  it('round-trips: FrameBuilder → FrameParser → Decoder → original values', () => {
    const decoder = new MavlinkMessageDecoder(registry);
    const frameBytes = buildHeartbeat();

    let decoded: MavlinkMessage | null = null;
    parser.onFrame(f => { decoded = decoder.decode(f); });
    parser.parse(frameBytes);

    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe('HEARTBEAT');
    expect(decoded!.values.type).toBe(2);
    expect(decoded!.values.autopilot).toBe(3);
    expect(decoded!.values.base_mode).toBe(0x81);
    expect(decoded!.values.system_status).toBe(4);
    expect(decoded!.values.mavlink_version).toBe(3);
    expect(decoded!.values.custom_mode).toBe(0);
  });

  it('round-trips an ATTITUDE frame with float values', () => {
    const decoder = new MavlinkMessageDecoder(registry);
    const frameBytes = builder.buildFrame({
      messageName: 'ATTITUDE',
      values: {
        time_boot_ms: 12345,
        roll: 0.5,
        pitch: -0.3,
        yaw: 1.2,
        rollspeed: 0.01,
        pitchspeed: -0.02,
        yawspeed: 0.03,
      },
    });

    let decoded: MavlinkMessage | null = null;
    parser.onFrame(f => { decoded = decoder.decode(f); });
    parser.parse(frameBytes);

    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe('ATTITUDE');
    expect(decoded!.values.time_boot_ms).toBe(12345);
    expect(decoded!.values.roll).toBeCloseTo(0.5);
    expect(decoded!.values.pitch).toBeCloseTo(-0.3);
    expect(decoded!.values.yaw).toBeCloseTo(1.2);
    expect(decoded!.values.rollspeed).toBeCloseTo(0.01);
    expect(decoded!.values.pitchspeed).toBeCloseTo(-0.02);
    expect(decoded!.values.yawspeed).toBeCloseTo(0.03);
  });

  it('recovers after a corrupted frame and parses the next valid frame', () => {
    const validFrame = buildHeartbeat(42);
    // Build a corrupted frame: valid STX + header start, but truncated/garbled,
    // followed by a valid frame. The parser should discard the bad one and find the good one.
    const corrupted = new Uint8Array([
      0xFD, // STX v2
      0x09, // len = 9
      0x00, // incompat
      0x00, // compat
      0x00, // seq
      0x01, // sysid
      0x01, // compid
      0x00, 0x00, 0x00, // msgid = 0 (HEARTBEAT)
      // 9 payload bytes (garbage)
      0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
      // Bad CRC
      0x00, 0x00,
    ]);
    const combined = new Uint8Array(corrupted.length + validFrame.length);
    combined.set(corrupted);
    combined.set(validFrame, corrupted.length);

    const frames: MavlinkFrame[] = [];
    parser.onFrame(f => frames.push(f));
    parser.parse(combined);

    // Corrupted frame rejected (CRC error), valid frame parsed
    expect(parser.crcErrors).toBe(1);
    expect(frames.length).toBe(1);
    expect(frames[0].sequence).toBe(42);
    expect(frames[0].crcValid).toBe(true);
  });

  it('unsubscribe stops receiving frames', () => {
    const frames: MavlinkFrame[] = [];
    const unsub = parser.onFrame(f => frames.push(f));
    parser.parse(buildHeartbeat(0));
    expect(frames.length).toBe(1);

    unsub();
    parser.parse(buildHeartbeat(1));
    expect(frames.length).toBe(1); // no new frame received
  });
});
