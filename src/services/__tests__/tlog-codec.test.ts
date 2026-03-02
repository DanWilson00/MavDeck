import { describe, expect, it } from 'vitest';
import { encodeTlogRecord, parseTlogBytes } from '../tlog-codec';

describe('tlog-codec', () => {
  it('encodes and parses two MAVLink v2 records', () => {
    const packetA = new Uint8Array([0xfd, 0x02, 0x00, 0x00, 0x01, 0x01, 0x01, 0x1e, 0x00, 0x00, 0xaa, 0xbb, 0x11, 0x22]);
    const packetB = new Uint8Array([0xfd, 0x01, 0x00, 0x00, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0xcc, 0x33, 0x44]);

    const recA = encodeTlogRecord(1_000_000, packetA);
    const recB = encodeTlogRecord(2_500_000, packetB);
    const file = new Uint8Array(recA.length + recB.length);
    file.set(recA, 0);
    file.set(recB, recA.length);

    const parsed = parseTlogBytes(file);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].timestampUs).toBe(1_000_000);
    expect(parsed[1].timestampUs).toBe(2_500_000);
    expect(Array.from(parsed[0].packet)).toEqual(Array.from(packetA));
    expect(Array.from(parsed[1].packet)).toEqual(Array.from(packetB));
  });

  it('stops on malformed packet header', () => {
    const badPacket = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const rec = encodeTlogRecord(123, badPacket);
    const parsed = parseTlogBytes(rec);
    expect(parsed).toHaveLength(0);
  });
});
