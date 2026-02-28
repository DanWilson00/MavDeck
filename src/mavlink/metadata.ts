/**
 * MAVLink metadata type definitions and factory functions.
 *
 * These interfaces define the structure of MAVLink message and enum
 * metadata loaded from the JSON dialect file.
 */

export interface MavlinkFieldMetadata {
  name: string;
  type: string;           // "uint32_t", "float", "char", etc.
  baseType: string;       // same as type for non-arrays
  offset: number;         // byte offset in payload
  size: number;           // type size in bytes (1, 2, 4, or 8)
  arrayLength: number;    // 1 for scalars, >1 for arrays
  units: string;          // "rad", "m/s", "degE7", etc.
  enumType: string;       // enum name or "" if none
  description: string;
  isExtension: boolean;
}

export interface MavlinkMessageMetadata {
  id: number;
  name: string;
  description: string;
  crcExtra: number;           // 0-255
  encodedLength: number;      // total non-extension payload bytes
  fields: MavlinkFieldMetadata[];
}

export interface MavlinkEnumEntry {
  name: string;
  value: number;
  description: string;
}

export interface MavlinkEnumMetadata {
  name: string;
  description: string;
  isBitmask: boolean;
  entries: Map<number, MavlinkEnumEntry>;
}

/** Create a MavlinkFieldMetadata from JSON dialect format. */
export function createFieldMetadata(json: Record<string, unknown>): MavlinkFieldMetadata {
  return {
    name: json['name'] as string,
    type: json['type'] as string,
    baseType: json['base_type'] as string,
    offset: json['offset'] as number,
    size: json['size'] as number,
    arrayLength: (json['array_length'] as number | undefined) ?? 1,
    units: (json['units'] as string | undefined) ?? '',
    enumType: (json['enum'] as string | undefined) ?? '',
    description: (json['description'] as string | undefined) ?? '',
    isExtension: (json['extension'] as boolean | undefined) ?? false,
  };
}

/** Create a MavlinkMessageMetadata from JSON dialect format. */
export function createMessageMetadata(json: Record<string, unknown>): MavlinkMessageMetadata {
  const fieldsJson = json['fields'] as Record<string, unknown>[];
  const fields = fieldsJson.map(f => createFieldMetadata(f));

  return {
    id: json['id'] as number,
    name: json['name'] as string,
    description: (json['description'] as string | undefined) ?? '',
    crcExtra: json['crc_extra'] as number,
    encodedLength: json['encoded_length'] as number,
    fields,
  };
}

/** Create a MavlinkEnumMetadata from JSON dialect format. */
export function createEnumMetadata(json: Record<string, unknown>): MavlinkEnumMetadata {
  const entriesJson = json['entries'] as Record<string, Record<string, unknown>>;
  const entries = new Map<number, MavlinkEnumEntry>();

  for (const entry of Object.values(entriesJson)) {
    const enumEntry: MavlinkEnumEntry = {
      name: entry['name'] as string,
      value: entry['value'] as number,
      description: (entry['description'] as string | undefined) ?? '',
    };
    entries.set(enumEntry.value, enumEntry);
  }

  return {
    name: json['name'] as string,
    description: (json['description'] as string | undefined) ?? '',
    isBitmask: (json['bitmask'] as boolean | undefined) ?? false,
    entries,
  };
}
