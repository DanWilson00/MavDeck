import { describe, it, expect } from 'vitest';
import {
  encodeFtpPayload,
  decodeFtpPayload,
  FTP_OPCODE_OPEN_FILE_RO,
  FTP_OPCODE_ACK,
  FTP_PAYLOAD_SIZE,
} from '../ftp-types';

describe('FTP payload encode/decode', () => {
  it('round-trips a complete payload', () => {
    const data = new TextEncoder().encode('/general.json');
    const original = {
      seq: 42,
      session: 3,
      opcode: FTP_OPCODE_OPEN_FILE_RO,
      size: data.length,
      reqOpcode: 0,
      burstComplete: 0,
      offset: 1024,
      data,
    };

    const encoded = encodeFtpPayload(original);
    expect(encoded.length).toBe(FTP_PAYLOAD_SIZE);

    const decoded = decodeFtpPayload(encoded);
    expect(decoded.seq).toBe(42);
    expect(decoded.session).toBe(3);
    expect(decoded.opcode).toBe(FTP_OPCODE_OPEN_FILE_RO);
    expect(decoded.size).toBe(data.length);
    expect(decoded.reqOpcode).toBe(0);
    expect(decoded.burstComplete).toBe(0);
    expect(decoded.offset).toBe(1024);
    expect(new TextDecoder().decode(decoded.data)).toBe('/general.json');
  });

  it('round-trips an ACK with file size in data', () => {
    const sizeData = new Uint8Array(4);
    new DataView(sizeData.buffer).setUint32(0, 5000, true);

    const encoded = encodeFtpPayload({
      seq: 1,
      session: 0,
      opcode: FTP_OPCODE_ACK,
      size: 4,
      reqOpcode: FTP_OPCODE_OPEN_FILE_RO,
      data: sizeData,
    });

    const decoded = decodeFtpPayload(encoded);
    expect(decoded.opcode).toBe(FTP_OPCODE_ACK);
    expect(decoded.reqOpcode).toBe(FTP_OPCODE_OPEN_FILE_RO);
    expect(new DataView(decoded.data.buffer, decoded.data.byteOffset).getUint32(0, true)).toBe(5000);
  });

  it('encodes defaults for missing fields', () => {
    const encoded = encodeFtpPayload({});
    const decoded = decodeFtpPayload(encoded);
    expect(decoded.seq).toBe(0);
    expect(decoded.session).toBe(0);
    expect(decoded.opcode).toBe(0);
    expect(decoded.size).toBe(0);
    expect(decoded.offset).toBe(0);
  });

  it('verifies byte layout matches spec offsets', () => {
    const encoded = encodeFtpPayload({
      seq: 0x1234,       // LE @ offset 0
      session: 0xAB,     // @ offset 2
      opcode: 0xCD,      // @ offset 3
      size: 0x0F,        // @ offset 4
      reqOpcode: 0xEF,   // @ offset 5
      burstComplete: 1,  // @ offset 6
      offset: 0xDEADBEEF, // LE @ offset 8
    });

    expect(encoded[0]).toBe(0x34);  // seq low
    expect(encoded[1]).toBe(0x12);  // seq high
    expect(encoded[2]).toBe(0xAB);  // session
    expect(encoded[3]).toBe(0xCD);  // opcode
    expect(encoded[4]).toBe(0x0F);  // size
    expect(encoded[5]).toBe(0xEF);  // reqOpcode
    expect(encoded[6]).toBe(1);     // burstComplete
    expect(encoded[8]).toBe(0xEF);  // offset byte 0
    expect(encoded[9]).toBe(0xBE);  // offset byte 1
    expect(encoded[10]).toBe(0xAD); // offset byte 2
    expect(encoded[11]).toBe(0xDE); // offset byte 3
  });
});
