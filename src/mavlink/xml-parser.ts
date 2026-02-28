/**
 * MAVLink XML dialect parser.
 *
 * Parses MAVLink XML dialect definitions using browser DOMParser and
 * generates JSON metadata compatible with MavlinkMetadataRegistry.
 * This enables users to import custom dialect files at runtime.
 */

import { MavlinkCrc } from './crc';

/** Type sizes in bytes for MAVLink types. */
const TYPE_SIZES: Record<string, number> = {
  'int8_t': 1,
  'uint8_t': 1,
  'char': 1,
  'int16_t': 2,
  'uint16_t': 2,
  'int32_t': 4,
  'uint32_t': 4,
  'float': 4,
  'int64_t': 8,
  'uint64_t': 8,
  'double': 8,
};

interface FieldDef {
  name: string;
  type: string;
  baseType: string;
  arrayLength: number;
  isExtension: boolean;
  units: string;
  enumType: string;
  description: string;
}

interface EnumEntryDef {
  name: string;
  value: number;
  description: string;
}

interface EnumDef {
  name: string;
  description: string;
  bitmask: boolean;
  entries: EnumEntryDef[];
}

interface MessageDef {
  id: number;
  name: string;
  description: string;
  fields: FieldDef[];
}

interface ParsedDialect {
  messages: Map<number, MessageDef>;
  enums: Map<string, EnumDef>;
}

function getBaseType(type: string): string {
  if (type === 'uint8_t_mavlink_version') return 'uint8_t';
  const bracketIdx = type.indexOf('[');
  return bracketIdx >= 0 ? type.substring(0, bracketIdx) : type;
}

function getArrayLength(type: string): number {
  const bracketIdx = type.indexOf('[');
  if (bracketIdx < 0) return 1;
  const closeBracket = type.indexOf(']');
  return parseInt(type.substring(bracketIdx + 1, closeBracket), 10) || 1;
}

function typeSize(baseType: string): number {
  return TYPE_SIZES[baseType] ?? 1;
}

/**
 * Order fields for wire serialization.
 * Non-extension fields sorted by type size descending (largest first).
 * Extension fields keep original order and come after.
 */
function orderFields(fields: FieldDef[]): FieldDef[] {
  const nonExt = fields.filter(f => !f.isExtension);
  const ext = fields.filter(f => f.isExtension);
  nonExt.sort((a, b) => typeSize(b.baseType) - typeSize(a.baseType));
  return [...nonExt, ...ext];
}

function calculateCrcExtra(messageName: string, fields: FieldDef[]): number {
  const crc = new MavlinkCrc();
  crc.accumulateString(messageName + ' ');

  // CRC uses wire-ordered (sorted by size) non-extension fields
  const ordered = orderFields(fields);
  for (const field of ordered) {
    if (field.isExtension) continue;
    crc.accumulateString(field.baseType + ' ');
    crc.accumulateString(field.name + ' ');
    if (field.arrayLength > 1) {
      crc.accumulate(field.arrayLength);
    }
  }

  return (crc.value & 0xFF) ^ (crc.value >> 8);
}

function parseEnum(element: Element): EnumDef {
  const name = element.getAttribute('name') ?? '';
  const bitmask = element.getAttribute('bitmask') === 'true';
  const descEl = element.querySelector(':scope > description');
  const description = descEl?.textContent?.trim() ?? '';

  const entries: EnumEntryDef[] = [];
  for (const entryEl of element.querySelectorAll(':scope > entry')) {
    const entryName = entryEl.getAttribute('name') ?? '';
    const value = parseInt(entryEl.getAttribute('value') ?? '0', 10) || 0;
    const entryDescEl = entryEl.querySelector(':scope > description');
    const entryDescription = entryDescEl?.textContent?.trim() ?? '';
    entries.push({ name: entryName, value, description: entryDescription });
  }

  return { name, description, bitmask, entries };
}

function parseField(element: Element, isExtension: boolean): FieldDef {
  const name = element.getAttribute('name') ?? '';
  const type = element.getAttribute('type') ?? 'uint8_t';
  const units = element.getAttribute('units') ?? '';
  const enumType = element.getAttribute('enum') ?? '';
  const description = element.textContent?.trim() ?? '';

  return {
    name,
    type,
    baseType: getBaseType(type),
    arrayLength: getArrayLength(type),
    isExtension,
    units,
    enumType,
    description,
  };
}

function parseMessage(element: Element): MessageDef {
  const id = parseInt(element.getAttribute('id') ?? '0', 10) || 0;
  const name = element.getAttribute('name') ?? '';
  const descEl = element.querySelector(':scope > description');
  const description = descEl?.textContent?.trim() ?? '';

  const fields: FieldDef[] = [];
  let inExtensions = false;

  for (const child of element.children) {
    if (child.tagName === 'extensions') {
      inExtensions = true;
    } else if (child.tagName === 'field') {
      fields.push(parseField(child, inExtensions));
    }
  }

  return { id, name, description, fields };
}

function mergeDialects(target: ParsedDialect, source: ParsedDialect): void {
  for (const [id, msg] of source.messages) {
    if (!target.messages.has(id)) {
      target.messages.set(id, msg);
    }
  }
  for (const [name, enumDef] of source.enums) {
    if (!target.enums.has(name)) {
      target.enums.set(name, enumDef);
    }
  }
}

function parseXmlRecursive(
  files: Map<string, string>,
  fileName: string,
  parsedFiles: Set<string>,
): ParsedDialect {
  if (parsedFiles.has(fileName)) {
    return { messages: new Map(), enums: new Map() };
  }
  parsedFiles.add(fileName);

  const xmlContent = files.get(fileName);
  if (!xmlContent) {
    return { messages: new Map(), enums: new Map() };
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlContent, 'text/xml');
  const root = doc.documentElement;

  if (root.tagName !== 'mavlink') {
    throw new Error(`Invalid MAVLink XML in ${fileName}: root element must be <mavlink>`);
  }

  const messages = new Map<number, MessageDef>();
  const enums = new Map<string, EnumDef>();

  // Parse enums
  for (const enumsEl of root.querySelectorAll(':scope > enums')) {
    for (const enumEl of enumsEl.querySelectorAll(':scope > enum')) {
      const enumDef = parseEnum(enumEl);
      enums.set(enumDef.name, enumDef);
    }
  }

  // Parse messages
  for (const msgsEl of root.querySelectorAll(':scope > messages')) {
    for (const msgEl of msgsEl.querySelectorAll(':scope > message')) {
      const msgDef = parseMessage(msgEl);
      messages.set(msgDef.id, msgDef);
    }
  }

  const dialect: ParsedDialect = { messages, enums };

  // Process includes
  for (const includeEl of root.querySelectorAll(':scope > include')) {
    const includeFile = includeEl.textContent?.trim() ?? '';
    if (includeFile) {
      // Normalize: extract just the filename
      const normalized = includeFile.split('/').pop()!.split('\\').pop()!;
      const included = parseXmlRecursive(files, normalized, parsedFiles);
      mergeDialects(dialect, included);
    }
  }

  return dialect;
}

function generateJson(dialect: ParsedDialect, dialectName: string): string {
  // Build enums JSON
  const enumsJson: Record<string, unknown> = {};
  for (const [, enumDef] of dialect.enums) {
    const entriesJson: Record<string, unknown> = {};
    for (const entry of enumDef.entries) {
      entriesJson[entry.value.toString()] = {
        name: entry.name,
        value: entry.value,
        description: entry.description,
      };
    }
    enumsJson[enumDef.name] = {
      name: enumDef.name,
      description: enumDef.description,
      bitmask: enumDef.bitmask,
      entries: entriesJson,
    };
  }

  // Build messages JSON
  const messagesJson: Record<string, unknown> = {};
  for (const [, msg] of dialect.messages) {
    const crcExtra = calculateCrcExtra(msg.name, msg.fields);
    const ordered = orderFields(msg.fields);

    // Calculate offsets
    let offset = 0;
    const fieldsJson: Record<string, unknown>[] = [];
    for (const field of ordered) {
      const size = typeSize(field.baseType);
      const totalSize = size * field.arrayLength;

      fieldsJson.push({
        name: field.name,
        type: field.type,
        base_type: field.baseType,
        offset,
        size,
        array_length: field.arrayLength,
        units: field.units,
        enum: field.enumType,
        description: field.description,
        extension: field.isExtension,
      });

      offset += totalSize;
    }

    // Encoded length = sum of non-extension field sizes
    let encodedLength = 0;
    for (const field of fieldsJson) {
      if (!(field['extension'] as boolean)) {
        encodedLength += (field['size'] as number) * (field['array_length'] as number);
      }
    }

    messagesJson[msg.id.toString()] = {
      id: msg.id,
      name: msg.name,
      description: msg.description,
      crc_extra: crcExtra,
      encoded_length: encodedLength,
      fields: fieldsJson,
    };
  }

  const output = {
    schema_version: '1.0.0',
    dialect: { name: dialectName, version: 3 },
    enums: enumsJson,
    messages: messagesJson,
  };

  return JSON.stringify(output, null, 2);
}

/**
 * Parse MAVLink XML dialect definitions from an in-memory file map.
 *
 * @param files - Map of filename to XML content (e.g., "common.xml" → XML string)
 * @param mainFile - Entry point dialect filename
 * @returns JSON string in the same format as common.json, loadable by MavlinkMetadataRegistry
 */
export function parseFromFileMap(
  files: Map<string, string>,
  mainFile: string,
): string {
  const xmlContent = files.get(mainFile);
  if (!xmlContent) {
    throw new Error(`Main file not found in map: ${mainFile}`);
  }

  const dialectName = mainFile.replace('.xml', '');
  const parsedFiles = new Set<string>();
  const dialect = parseXmlRecursive(files, mainFile, parsedFiles);

  return generateJson(dialect, dialectName);
}
