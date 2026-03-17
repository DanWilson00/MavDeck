/**
 * CRC32 (zlib / ISO 3309) for verifying downloaded files.
 *
 * NOT the same as MAVLink's X.25 CRC — this is standard CRC32 used by
 * the component metadata protocol for file integrity checks.
 */

/** Precomputed CRC32 lookup table (256 entries). */
const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
  }
  TABLE[i] = crc;
}

/** Compute CRC32 (zlib convention) over a byte array. Returns unsigned 32-bit integer. */
export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
