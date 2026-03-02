import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MavlinkMetadataRegistry } from '../registry';
import { MavlinkMessageDecoder } from '../decoder';
import { MavlinkVersion, type MavlinkFrame } from '../frame';

const commonJson = readFileSync(
  resolve(__dirname, '../../../public/dialects/common.json'),
  'utf-8',
);

describe('MavlinkMessageDecoder', () => {
  let registry: MavlinkMetadataRegistry;
  let decoder: MavlinkMessageDecoder;

  beforeEach(() => {
    registry = new MavlinkMetadataRegistry();
    registry.loadFromJsonString(commonJson);
    decoder = new MavlinkMessageDecoder(registry);
  });

  function makeFrame(messageId: number, payload: Uint8Array): MavlinkFrame {
    return {
      version: MavlinkVersion.V2,
      payloadLength: payload.length,
      incompatFlags: 0,
      compatFlags: 0,
      sequence: 0,
      systemId: 1,
      componentId: 1,
      messageId,
      payload,
      rawPacket: payload,
      crcValid: true,
    };
  }

  it('decodes HEARTBEAT payload correctly', () => {
    // custom_mode=0, type=2, autopilot=3, base_mode=0x81, system_status=4, mavlink_version=3
    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x81, 0x04, 0x03]);
    const msg = decoder.decode(makeFrame(0, payload));

    expect(msg).not.toBeNull();
    expect(msg!.name).toBe('HEARTBEAT');
    expect(msg!.values.custom_mode).toBe(0);
    expect(msg!.values.type).toBe(2);
    expect(msg!.values.autopilot).toBe(3);
    expect(msg!.values.base_mode).toBe(0x81);
    expect(msg!.values.system_status).toBe(4);
    expect(msg!.values.mavlink_version).toBe(3);
  });

  it('decodes ATTITUDE payload with float values', () => {
    const payload = new Uint8Array(28);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, 1000, true);      // time_boot_ms
    dv.setFloat32(4, 0.5, true);      // roll
    dv.setFloat32(8, -0.3, true);     // pitch
    dv.setFloat32(12, 1.2, true);     // yaw
    dv.setFloat32(16, 0.01, true);    // rollspeed
    dv.setFloat32(20, -0.02, true);   // pitchspeed
    dv.setFloat32(24, 0.03, true);    // yawspeed

    const msg = decoder.decode(makeFrame(30, payload));

    expect(msg).not.toBeNull();
    expect(msg!.name).toBe('ATTITUDE');
    expect(msg!.values.time_boot_ms).toBe(1000);
    expect(msg!.values.roll).toBeCloseTo(0.5);
    expect(msg!.values.pitch).toBeCloseTo(-0.3);
    expect(msg!.values.yaw).toBeCloseTo(1.2);
  });

  it('handles zero-trimmed payloads (shorter than encodedLength)', () => {
    // Send only 5 bytes of a 9-byte HEARTBEAT — missing fields should be 0
    const payload = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x02]);
    const msg = decoder.decode(makeFrame(0, payload));

    expect(msg).not.toBeNull();
    expect(msg!.values.custom_mode).toBe(1);
    expect(msg!.values.type).toBe(2);
    // Zero-padded fields
    expect(msg!.values.autopilot).toBe(0);
    expect(msg!.values.base_mode).toBe(0);
    expect(msg!.values.system_status).toBe(0);
    expect(msg!.values.mavlink_version).toBe(0);
  });

  it('decodes message with char array as string', () => {
    // STATUSTEXT (id=253): severity(uint8_t) at offset 0, text(char[50]) at offset 1
    const meta = registry.getMessageByName('STATUSTEXT');
    expect(meta).toBeDefined();

    const payload = new Uint8Array(meta!.encodedLength);
    payload[0] = 6; // severity = MAV_SEVERITY_INFO
    // Write "Hello" into the char array
    const textField = meta!.fields.find(f => f.name === 'text');
    expect(textField).toBeDefined();
    const textBytes = new TextEncoder().encode('Hello');
    payload.set(textBytes, textField!.offset);

    const msg = decoder.decode(makeFrame(253, payload));

    expect(msg).not.toBeNull();
    expect(msg!.values.severity).toBe(6);
    expect(msg!.values.text).toBe('Hello');
  });

  it('decodes message with numeric array as number[]', () => {
    // SET_ATTITUDE_TARGET (id=82) has q: float[4] at offset 4, size 4
    const meta = registry.getMessageByName('SET_ATTITUDE_TARGET');
    expect(meta).toBeDefined();

    const qField = meta!.fields.find(f => f.name === 'q');
    expect(qField).toBeDefined();
    expect(qField!.arrayLength).toBe(4);

    const payload = new Uint8Array(meta!.encodedLength);
    const dv = new DataView(payload.buffer);
    // Write 4 floats at the q field offset
    dv.setFloat32(qField!.offset, 1.0, true);
    dv.setFloat32(qField!.offset + 4, 0.0, true);
    dv.setFloat32(qField!.offset + 8, 0.0, true);
    dv.setFloat32(qField!.offset + 12, 0.0, true);

    const msg = decoder.decode(makeFrame(82, payload));

    expect(msg).not.toBeNull();
    const q = msg!.values.q;
    expect(Array.isArray(q)).toBe(true);
    expect(q).toHaveLength(4);
    expect((q as number[])[0]).toBeCloseTo(1.0);
    expect((q as number[])[1]).toBeCloseTo(0.0);
    expect((q as number[])[2]).toBeCloseTo(0.0);
    expect((q as number[])[3]).toBeCloseTo(0.0);
  });

  it('returns null for unknown message ID', () => {
    const payload = new Uint8Array(10);
    const msg = decoder.decode(makeFrame(99999, payload));
    expect(msg).toBeNull();
  });
});
