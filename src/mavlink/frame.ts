/**
 * MAVLink frame structure and protocol constants.
 */

export enum MavlinkVersion {
  V1 = 1,
  V2 = 2,
}

export interface MavlinkFrame {
  version: MavlinkVersion;
  payloadLength: number;       // 0-255
  incompatFlags: number;       // v2 only (0 for v1)
  compatFlags: number;         // v2 only (0 for v1)
  sequence: number;            // 0-255
  systemId: number;            // 1-255
  componentId: number;         // 0-255
  messageId: number;           // 0-255 (v1) or 0-16777215 (v2)
  payload: Uint8Array;         // raw payload bytes
  rawPacket: Uint8Array;       // full wire packet bytes (stx..crc)
  crcValid: boolean;           // receivedCrc === calculatedCrc
}

export const MAVLINK_V1_STX = 0xFE;
export const MAVLINK_V2_STX = 0xFD;
export const MAVLINK_V1_HEADER_LEN = 5;   // bytes after STX
export const MAVLINK_V2_HEADER_LEN = 9;   // bytes after STX
export const MAVLINK_CRC_LEN = 2;
export const MAVLINK_MAX_PAYLOAD_LEN = 255;
