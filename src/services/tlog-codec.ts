export interface TlogRecord {
  timestampUs: number;
  packet: Uint8Array;
}

export function encodeTlogRecord(timestampUs: number, packet: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + packet.length);
  const dv = new DataView(out.buffer);
  const safeTs = Math.max(0, Math.floor(timestampUs));
  dv.setBigUint64(0, BigInt(safeTs), true);
  out.set(packet, 8);
  return out;
}

export function parseTlogBytes(bytes: Uint8Array): TlogRecord[] {
  const records: TlogRecord[] = [];
  let offset = 0;

  while (offset + 8 <= bytes.length) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const tsUs = Number(dv.getBigUint64(0, true));
    offset += 8;

    const packetLen = parsePacketLength(bytes, offset);
    if (packetLen <= 0 || offset + packetLen > bytes.length) break;

    records.push({
      timestampUs: tsUs,
      packet: bytes.slice(offset, offset + packetLen),
    });
    offset += packetLen;
  }

  return records;
}

function parsePacketLength(bytes: Uint8Array, offset: number): number {
  const stx = bytes[offset];
  if (stx === 0xfe) {
    if (offset + 2 > bytes.length) return -1;
    const payloadLen = bytes[offset + 1];
    return 8 + payloadLen;
  }
  if (stx === 0xfd) {
    if (offset + 2 > bytes.length) return -1;
    const payloadLen = bytes[offset + 1];
    return 12 + payloadLen;
  }
  return -1;
}
