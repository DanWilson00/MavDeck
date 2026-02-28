/**
 * MAVLink X.25 CRC implementation (CRC-16-MCRF4XX).
 *
 * Calculates CRC-16 over header, payload, and crc_extra byte
 * for MAVLink packet validation.
 */

export class MavlinkCrc {
  private crc = 0xFFFF;

  /** Current CRC value. */
  get value(): number {
    return this.crc;
  }

  /** Reset CRC to initial seed value. */
  reset(): void {
    this.crc = 0xFFFF;
  }

  /** Accumulate a single byte into the CRC. */
  accumulate(byte: number): void {
    byte = byte & 0xFF;
    let tmp = byte ^ (this.crc & 0xFF);
    tmp = (tmp ^ ((tmp << 4) & 0xFF)) & 0xFF;
    this.crc = ((this.crc >> 8) ^ ((tmp << 8) & 0xFFFF) ^ ((tmp << 3) & 0xFFFF) ^ (tmp >> 4)) & 0xFFFF;
  }

  /** Accumulate multiple bytes into the CRC. */
  accumulateBytes(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      this.accumulate(bytes[i]);
    }
  }

  /** Accumulate a string's char codes into the CRC. */
  accumulateString(str: string): void {
    for (let i = 0; i < str.length; i++) {
      this.accumulate(str.charCodeAt(i));
    }
  }

  /** Low byte of the CRC. */
  get lowByte(): number {
    return this.crc & 0xFF;
  }

  /** High byte of the CRC. */
  get highByte(): number {
    return (this.crc >> 8) & 0xFF;
  }
}

/**
 * Calculate CRC for a complete MAVLink frame.
 *
 * CRC is calculated over header bytes (excluding STX), payload bytes,
 * and the crc_extra byte from the message definition.
 */
export function calculateFrameCrc(
  header: Uint8Array,
  payload: Uint8Array,
  crcExtra: number,
): number {
  const crc = new MavlinkCrc();
  crc.accumulateBytes(header);
  crc.accumulateBytes(payload);
  crc.accumulate(crcExtra);
  return crc.value;
}
