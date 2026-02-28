import { describe, it, expect } from 'vitest';
import { MavlinkCrc, calculateFrameCrc } from '../crc';

describe('MavlinkCrc', () => {
  it('returns 0x6F91 for ASCII "123456789"', () => {
    const crc = new MavlinkCrc();
    crc.accumulateString('123456789');
    expect(crc.value).toBe(0x6F91);
  });

  it('returns 0xFFFF for empty input', () => {
    const crc = new MavlinkCrc();
    expect(crc.value).toBe(0xFFFF);
  });

  it('accumulating one byte at a time equals accumulating all at once', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);

    const crcOneAtATime = new MavlinkCrc();
    for (let i = 0; i < data.length; i++) {
      crcOneAtATime.accumulate(data[i]);
    }

    const crcAllAtOnce = new MavlinkCrc();
    crcAllAtOnce.accumulateBytes(data);

    expect(crcOneAtATime.value).toBe(crcAllAtOnce.value);
  });

  it('reset returns CRC to 0xFFFF', () => {
    const crc = new MavlinkCrc();
    crc.accumulateString('test');
    expect(crc.value).not.toBe(0xFFFF);
    crc.reset();
    expect(crc.value).toBe(0xFFFF);
  });

  it('lowByte and highByte decompose correctly', () => {
    const crc = new MavlinkCrc();
    crc.accumulateString('123456789');
    expect(crc.lowByte).toBe(0x6F91 & 0xFF);
    expect(crc.highByte).toBe((0x6F91 >> 8) & 0xFF);
  });
});

describe('calculateFrameCrc', () => {
  it('calculates CRC over header + payload + crcExtra', () => {
    // Build a HEARTBEAT v2 header (without STX): len, incompat, compat, seq, sysid, compid, msgid(3)
    const header = new Uint8Array([0x09, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00]);
    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x81, 0x04, 0x03]);
    const crcExtra = 50; // HEARTBEAT CRC extra

    const crc = calculateFrameCrc(header, payload, crcExtra);
    // Verify it's a valid 16-bit value
    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThanOrEqual(0xFFFF);

    // Manually verify with MavlinkCrc
    const manual = new MavlinkCrc();
    manual.accumulateBytes(header);
    manual.accumulateBytes(payload);
    manual.accumulate(crcExtra);
    expect(crc).toBe(manual.value);
  });
});
