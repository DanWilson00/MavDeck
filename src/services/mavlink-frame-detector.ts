/**
 * Lightweight MAVLink frame detector for baud rate probing.
 *
 * Finds two consecutive well-formed MAVLink frames (v1 or v2) by checking
 * STX bytes and length-predicted frame boundaries. No CRC validation,
 * no registry dependency — designed for fast main-thread baud detection.
 */

const MAVLINK_V1_STX = 0xFE;
const MAVLINK_V2_STX = 0xFD;

/** v1 frame: STX + 5-byte header + payload + 2-byte CRC */
const V1_OVERHEAD = 8;
/** v2 frame: STX + 9-byte header + payload + 2-byte CRC */
const V2_OVERHEAD = 12;

const MAX_PAYLOAD = 255;
const MAX_FRAME = V2_OVERHEAD + MAX_PAYLOAD; // 267
/** Buffer cap: enough for 2 max-size frames plus some slack */
const BUFFER_CAP = MAX_FRAME * 2 + 64; // ~598 bytes

export class MavlinkFrameDetector {
  private buf = new Uint8Array(BUFFER_CAP);
  private len = 0;

  /**
   * Feed incoming bytes. Returns true when two consecutive
   * well-formed frames have been detected (baud rate is correct).
   */
  feed(data: Uint8Array): boolean {
    // Append data, dropping oldest bytes if over capacity
    const needed = this.len + data.length;
    if (needed > BUFFER_CAP) {
      const drop = needed - BUFFER_CAP;
      this.buf.copyWithin(0, drop, this.len);
      this.len -= drop;
    }
    this.buf.set(data, this.len);
    this.len += data.length;

    return this.scan();
  }

  /** Reset internal buffer (call when baud rate changes). */
  reset(): void {
    this.len = 0;
  }

  private scan(): boolean {
    const buf = this.buf;
    const len = this.len;

    for (let i = 0; i < len; i++) {
      const stx = buf[i];
      if (stx !== MAVLINK_V1_STX && stx !== MAVLINK_V2_STX) continue;

      const overhead = stx === MAVLINK_V1_STX ? V1_OVERHEAD : V2_OVERHEAD;

      // Need at least overhead bytes to read the length field
      if (i + 1 >= len) continue;
      const payloadLen = buf[i + 1];
      if (payloadLen > MAX_PAYLOAD) continue;

      const frameSize = overhead + payloadLen;
      const nextStart = i + frameSize;

      // Check we have enough data for the second frame's header
      if (nextStart + 1 >= len) continue;

      const nextStx = buf[nextStart];
      if (nextStx !== MAVLINK_V1_STX && nextStx !== MAVLINK_V2_STX) continue;

      const nextOverhead = nextStx === MAVLINK_V1_STX ? V1_OVERHEAD : V2_OVERHEAD;
      const nextPayloadLen = buf[nextStart + 1];
      if (nextPayloadLen > MAX_PAYLOAD) continue;

      const nextFrameSize = nextOverhead + nextPayloadLen;
      const thirdStart = nextStart + nextFrameSize;

      // Verify second frame fits in buffer (we need its full extent)
      if (thirdStart > len) continue;

      // Two consecutive frames found!
      return true;
    }

    return false;
  }
}
