/**
 * MAVLink metadata registry for loading and querying dialect metadata.
 *
 * Provides O(1) lookups for messages by ID or name, and enum resolution.
 */

import {
  type MavlinkMessageMetadata,
  type MavlinkEnumMetadata,
  createMessageMetadata,
  createEnumMetadata,
} from './metadata';

export class MavlinkMetadataRegistry {
  private messagesById = new Map<number, MavlinkMessageMetadata>();
  private messagesByName = new Map<string, MavlinkMessageMetadata>();
  private enums = new Map<string, MavlinkEnumMetadata>();

  /** Load metadata from a JSON string (common.json format). */
  loadFromJsonString(jsonString: string): void {
    const json = JSON.parse(jsonString) as Record<string, unknown>;
    this.loadFromJson(json);
  }

  /** Load metadata from a parsed JSON object. */
  private loadFromJson(json: Record<string, unknown>): void {
    this.messagesById.clear();
    this.messagesByName.clear();
    this.enums.clear();

    // Load enums
    const enumsJson = json['enums'] as Record<string, Record<string, unknown>> | undefined;
    if (enumsJson) {
      for (const enumData of Object.values(enumsJson)) {
        const meta = createEnumMetadata(enumData);
        this.enums.set(meta.name, meta);
      }
    }

    // Load messages
    const messagesJson = json['messages'] as Record<string, Record<string, unknown>> | undefined;
    if (messagesJson) {
      for (const msgData of Object.values(messagesJson)) {
        const meta = createMessageMetadata(msgData);
        this.messagesById.set(meta.id, meta);
        this.messagesByName.set(meta.name, meta);
      }
    }
  }

  /** Get message metadata by ID. Returns undefined if not found. */
  getMessageById(id: number): MavlinkMessageMetadata | undefined {
    return this.messagesById.get(id);
  }

  /** Get message metadata by name. Returns undefined if not found. */
  getMessageByName(name: string): MavlinkMessageMetadata | undefined {
    return this.messagesByName.get(name);
  }

  /** Get enum metadata by name. Returns undefined if not found. */
  getEnum(name: string): MavlinkEnumMetadata | undefined {
    return this.enums.get(name);
  }

  /** Resolve an enum value to its entry name. Returns undefined if not found. */
  resolveEnumValue(enumName: string, value: number): string | undefined {
    return this.enums.get(enumName)?.entries.get(value)?.name;
  }

  /** Number of loaded messages. */
  get messageCount(): number {
    return this.messagesById.size;
  }

  /** Number of loaded enums. */
  get enumCount(): number {
    return this.enums.size;
  }
}
