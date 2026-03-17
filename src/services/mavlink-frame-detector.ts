/**
 * Lightweight MAVLink frame detector for baud rate probing.
 *
 * Finds three consecutive well-formed MAVLink frames (v1 or v2) by checking
 * STX bytes and length-predicted frame boundaries. No CRC validation,
 * no registry dependency — designed for fast main-thread baud detection.
 *
 * Requiring 3 frames (vs 2) dramatically reduces false positives from
 * random garbage at wrong baud rates (~1/16B vs ~1/65K).
 */

const MAVLINK_V1_STX = 0xFE;
const MAVLINK_V2_STX = 0xFD;

/** v1 frame: STX + 5-byte header + payload + 2-byte CRC */
const V1_OVERHEAD = 8;
/** v2 frame: STX + 9-byte header + payload + 2-byte CRC */
const V2_OVERHEAD = 12;

const MAX_PAYLOAD = 255;
const MAX_FRAME = V2_OVERHEAD + MAX_PAYLOAD; // 267
/** Buffer cap: enough for 3 max-size frames plus some slack */
const BUFFER_CAP = MAX_FRAME * 3 + 64; // ~865 bytes

export class MavlinkFrameDetector {
  private buf = new Uint8Array(BUFFER_CAP);
  private len = 0;

  /**
   * Feed incoming bytes. Returns true when three consecutive
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

  /**
   * Check for a valid frame header at `pos`. Returns the frame size if valid,
   * or -1 if not a valid frame start.
   */
  private frameAt(pos: number): number {
    if (pos + 1 >= this.len) return -1;

    const stx = this.buf[pos];
    if (stx !== MAVLINK_V1_STX && stx !== MAVLINK_V2_STX) return -1;

    const overhead = stx === MAVLINK_V1_STX ? V1_OVERHEAD : V2_OVERHEAD;
    const payloadLen = this.buf[pos + 1];
    if (payloadLen > MAX_PAYLOAD) return -1;

    return overhead + payloadLen;
  }

  private scan(): boolean {
    const len = this.len;

    for (let i = 0; i < len; i++) {
      // First frame
      const frame1Size = this.frameAt(i);
      if (frame1Size < 0) continue;

      const secondStart = i + frame1Size;

      // Second frame
      const frame2Size = this.frameAt(secondStart);
      if (frame2Size < 0) continue;

      const thirdStart = secondStart + frame2Size;

      // Third frame — just need to verify its header exists and is valid
      const frame3Size = this.frameAt(thirdStart);
      if (frame3Size < 0) continue;

      // Verify the third frame fits in buffer (we need at least its header)
      if (thirdStart + frame3Size > len) continue;

      // Three consecutive frames found!
      return true;
    }

    return false;
  }
}
