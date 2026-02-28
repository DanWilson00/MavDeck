/**
 * MAVLink frame builder for creating outgoing v2 packets.
 *
 * Used by the spoof source to generate valid MAVLink frames for testing.
 */

import { calculateFrameCrc } from './crc';
import { MAVLINK_V2_STX } from './frame';
import type { MavlinkFieldMetadata } from './metadata';
import type { MavlinkMetadataRegistry } from './registry';

export class MavlinkFrameBuilder {
  private readonly registry: MavlinkMetadataRegistry;

  constructor(registry: MavlinkMetadataRegistry) {
    this.registry = registry;
  }

  /**
   * Build a complete MAVLink v2 frame from message name and field values.
   * Throws if the message name is unknown.
   */
  buildFrame(options: {
    messageName: string;
    values: Record<string, number | string | number[]>;
    systemId?: number;
    componentId?: number;
    sequence?: number;
  }): Uint8Array {
    const metadata = this.registry.getMessageByName(options.messageName);
    if (!metadata) {
      throw new Error(`Unknown message: ${options.messageName}`);
    }

    const systemId = options.systemId ?? 1;
    const componentId = options.componentId ?? 1;
    const sequence = options.sequence ?? 0;

    // Encode payload
    const payload = new Uint8Array(metadata.encodedLength);
    const data = new DataView(payload.buffer);

    for (const field of metadata.fields) {
      if (field.isExtension) continue;
      const value = options.values[field.name];
      if (value === undefined) continue;
      this.encodeField(data, field, value);
    }

    // Build header bytes (excluding STX)
    const header = new Uint8Array([
      payload.length,                   // len
      0,                                // incompat flags
      0,                                // compat flags
      sequence & 0xFF,                  // seq
      systemId & 0xFF,                  // sysid
      componentId & 0xFF,               // compid
      metadata.id & 0xFF,               // msgid low
      (metadata.id >> 8) & 0xFF,        // msgid mid
      (metadata.id >> 16) & 0xFF,       // msgid high
    ]);

    // Calculate CRC
    const crc = calculateFrameCrc(header, payload, metadata.crcExtra);

    // Assemble complete frame: STX + header + payload + CRC
    const frame = new Uint8Array(1 + header.length + payload.length + 2);
    frame[0] = MAVLINK_V2_STX;
    frame.set(header, 1);
    frame.set(payload, 1 + header.length);
    frame[frame.length - 2] = crc & 0xFF;
    frame[frame.length - 1] = (crc >> 8) & 0xFF;

    return frame;
  }

  private encodeField(
    data: DataView,
    field: MavlinkFieldMetadata,
    value: number | string | number[],
  ): void {
    if (field.arrayLength > 1 && field.baseType === 'char') {
      this.encodeString(data, field, value as string);
      return;
    }

    if (field.arrayLength > 1) {
      const arr = value as number[];
      for (let i = 0; i < arr.length && i < field.arrayLength; i++) {
        this.encodeScalar(data, field.offset + (i * field.size), field.baseType, arr[i]);
      }
      return;
    }

    this.encodeScalar(data, field.offset, field.baseType, value as number);
  }

  private encodeScalar(data: DataView, offset: number, type: string, value: number): void {
    switch (type) {
      case 'int8_t':    data.setInt8(offset, value); break;
      case 'uint8_t':   data.setUint8(offset, value); break;
      case 'char':      data.setUint8(offset, value); break;
      case 'int16_t':   data.setInt16(offset, value, true); break;
      case 'uint16_t':  data.setUint16(offset, value, true); break;
      case 'int32_t':   data.setInt32(offset, value, true); break;
      case 'uint32_t':  data.setUint32(offset, value, true); break;
      case 'float':     data.setFloat32(offset, value, true); break;
      case 'double':    data.setFloat64(offset, value, true); break;
      case 'int64_t':
      case 'uint64_t': {
        const lo = value & 0xFFFFFFFF;
        const hi = Math.floor(value / 0x100000000) & 0xFFFFFFFF;
        data.setUint32(offset, lo >>> 0, true);
        data.setUint32(offset + 4, hi >>> 0, true);
        break;
      }
    }
  }

  private encodeString(data: DataView, field: MavlinkFieldMetadata, value: string): void {
    for (let i = 0; i < field.arrayLength; i++) {
      data.setUint8(field.offset + i, i < value.length ? value.charCodeAt(i) : 0);
    }
  }
}
