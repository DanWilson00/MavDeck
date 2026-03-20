/**
 * MAVLink FTP sub-protocol types and payload encode/decode.
 *
 * The FTP protocol operates inside FILE_TRANSFER_PROTOCOL messages.
 * The payload field is a 251-byte array with a fixed header layout.
 */

// ---------------------------------------------------------------------------
// Opcodes
// ---------------------------------------------------------------------------

export const FTP_OPCODE_TERMINATE_SESSION = 1;
export const FTP_OPCODE_RESET_SESSIONS = 2;
export const FTP_OPCODE_OPEN_FILE_RO = 4;
export const FTP_OPCODE_READ_FILE = 5;
export const FTP_OPCODE_BURST_READ_FILE = 15;
export const FTP_OPCODE_ACK = 128;
export const FTP_OPCODE_NAK = 129;

// ---------------------------------------------------------------------------
// Error codes (used in NAK data[0])
// ---------------------------------------------------------------------------

export const FTP_ERR_EOF = 6;
export const FTP_ERR_UNKNOWN_COMMAND = 7;
export const FTP_ERR_FILENOTFOUND = 10;

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Maximum data bytes per FTP payload. */
export const FTP_DATA_MAX_SIZE = 239;

/** Total FTP payload size (fixed 251 bytes). */
export const FTP_PAYLOAD_SIZE = 251;

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

export interface FtpPayload {
  seq: number;           // uint16 LE @ offset 0
  session: number;       // uint8 @ offset 2
  opcode: number;        // uint8 @ offset 3
  size: number;          // uint8 @ offset 4
  reqOpcode: number;     // uint8 @ offset 5
  burstComplete: number; // uint8 @ offset 6
  // padding byte @ offset 7
  offset: number;        // uint32 LE @ offset 8
  data: Uint8Array;      // bytes 12..12+size
}

// ---------------------------------------------------------------------------
// Encode / Decode
// ---------------------------------------------------------------------------

/** Encode an FTP payload into a 251-byte number array for FILE_TRANSFER_PROTOCOL. */
export function encodeFtpPayload(p: Partial<FtpPayload>): number[] {
  const buf = new Uint8Array(FTP_PAYLOAD_SIZE);
  const view = new DataView(buf.buffer);

  view.setUint16(0, p.seq ?? 0, true);
  buf[2] = p.session ?? 0;
  buf[3] = p.opcode ?? 0;
  buf[4] = p.size ?? 0;
  buf[5] = p.reqOpcode ?? 0;
  buf[6] = p.burstComplete ?? 0;
  // buf[7] = 0; // padding
  view.setUint32(8, p.offset ?? 0, true);

  if (p.data) {
    buf.set(p.data.subarray(0, FTP_DATA_MAX_SIZE), 12);
  }

  return Array.from(buf);
}

/** Decode an FTP payload from a number array or Uint8Array. */
export function decodeFtpPayload(raw: number[] | Uint8Array): FtpPayload {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const size = bytes[4];
  return {
    seq: view.getUint16(0, true),
    session: bytes[2],
    opcode: bytes[3],
    size,
    reqOpcode: bytes[5],
    burstComplete: bytes[6],
    offset: view.getUint32(8, true),
    data: bytes.slice(12, 12 + size),
  };
}
