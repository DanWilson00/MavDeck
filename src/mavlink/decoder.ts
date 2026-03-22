/**
 * MAVLink message decoder.
 *
 * Decodes raw payload bytes into field values using metadata.
 * All multi-byte reads use little-endian byte order per MAVLink spec.
 */

import type { MavlinkFrame } from './frame';
import { MAVLINK_MAX_PAYLOAD_LEN } from './frame';
import type { MavlinkFieldMetadata, MavlinkMessageMetadata } from './metadata';
import type { MavlinkMetadataRegistry } from './registry';

export interface MavlinkMessage {
  id: number;
  name: string;
  values: Record<string, number | string | number[]>;
  systemId: number;
  componentId: number;
  sequence: number;
}

export class MavlinkMessageDecoder {
  private readonly registry: MavlinkMetadataRegistry;
  /**
   * Pre-allocated buffer for zero-padding truncated v2 payloads. Avoids allocation per message.
   * Safe to share across calls because decoding is synchronous (no concurrent access).
   */
  private readonly paddingBuffer = new Uint8Array(MAVLINK_MAX_PAYLOAD_LEN);

  constructor(registry: MavlinkMetadataRegistry) {
    this.registry = registry;
  }

  /** Decode a frame into a message. Returns null if the message ID is unknown. */
  decode(frame: MavlinkFrame): MavlinkMessage | null {
    const metadata = this.registry.getMessageById(frame.messageId);
    if (!metadata) return null;

    const values = this.decodePayload(frame.payload, metadata);

    return {
      id: frame.messageId,
      name: metadata.name,
      values,
      systemId: frame.systemId,
      componentId: frame.componentId,
      sequence: frame.sequence,
    };
  }

  private decodePayload(
    payload: Uint8Array,
    metadata: MavlinkMessageMetadata,
  ): Record<string, number | string | number[]> {
    // MAVLink v2 zero-trimming: pad payload to expected length using pre-allocated buffer
    let paddedPayload: Uint8Array;
    if (payload.length < metadata.encodedLength) {
      this.paddingBuffer.fill(0, payload.length, metadata.encodedLength);
      this.paddingBuffer.set(payload);
      paddedPayload = this.paddingBuffer.subarray(0, metadata.encodedLength);
    } else {
      paddedPayload = payload;
    }

    const data = new DataView(paddedPayload.buffer, paddedPayload.byteOffset, paddedPayload.byteLength);
    const values: Record<string, number | string | number[]> = {};

    for (const field of metadata.fields) {
      if (field.offset + field.size > paddedPayload.length) continue;
      values[field.name] = this.decodeField(data, field, paddedPayload.length);
    }

    return values;
  }

  private decodeField(
    data: DataView,
    field: MavlinkFieldMetadata,
    payloadLength: number,
  ): number | string | number[] {
    if (field.arrayLength > 1) {
      return this.decodeArrayField(data, field, payloadLength);
    }
    return this.decodeScalar(data, field.offset, field.baseType);
  }

  private decodeScalar(data: DataView, offset: number, type: string): number {
    switch (type) {
      case 'int8_t':    return data.getInt8(offset);
      case 'uint8_t':   return data.getUint8(offset);
      case 'char':      return data.getUint8(offset);
      case 'int16_t':   return data.getInt16(offset, true);
      case 'uint16_t':  return data.getUint16(offset, true);
      case 'int32_t':   return data.getInt32(offset, true);
      case 'uint32_t':  return data.getUint32(offset, true);
      case 'float':     return data.getFloat32(offset, true);
      case 'double':    return data.getFloat64(offset, true);
      case 'int64_t': {
        const lo = data.getUint32(offset, true);
        const hi = data.getInt32(offset + 4, true);
        return hi * 0x100000000 + lo;
      }
      case 'uint64_t': {
        const lo = data.getUint32(offset, true);
        const hi = data.getUint32(offset + 4, true);
        return hi * 0x100000000 + lo;
      }
      default:          return data.getUint8(offset);
    }
  }

  private decodeArrayField(
    data: DataView,
    field: MavlinkFieldMetadata,
    payloadLength: number,
  ): string | number[] {
    // char arrays → string, trimmed of trailing nulls
    if (field.baseType === 'char') {
      const bytes: number[] = [];
      for (let i = 0; i < field.arrayLength; i++) {
        const offset = field.offset + i;
        if (offset >= payloadLength) break;
        const byte = data.getUint8(offset);
        if (byte === 0) break;
        bytes.push(byte);
      }
      return String.fromCharCode(...bytes);
    }

    // Numeric arrays — always return declared length, zero-padding truncated elements
    const values: number[] = new Array<number>(field.arrayLength);
    for (let i = 0; i < field.arrayLength; i++) {
      const offset = field.offset + (i * field.size);
      if (offset + field.size > payloadLength) {
        values[i] = 0;
      } else {
        values[i] = this.decodeScalar(data, offset, field.baseType);
      }
    }
    return values;
  }
}
