import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MavlinkMetadataRegistry } from '../registry';

const commonJson = readFileSync(
  resolve(__dirname, '../../../public/dialects/common.json'),
  'utf-8',
);

describe('MavlinkMetadataRegistry', () => {
  let registry: MavlinkMetadataRegistry;

  beforeEach(() => {
    registry = new MavlinkMetadataRegistry();
    registry.loadFromJsonString(commonJson);
  });

  it('loads 200+ messages without error', () => {
    expect(registry.messageCount).toBeGreaterThan(200);
  });

  it('getMessageById(0) returns HEARTBEAT with crcExtra 50', () => {
    const msg = registry.getMessageById(0);
    expect(msg).toBeDefined();
    expect(msg!.name).toBe('HEARTBEAT');
    expect(msg!.crcExtra).toBe(50);
  });

  it('getMessageById(30) returns ATTITUDE with crcExtra 39 and 7 fields', () => {
    const msg = registry.getMessageById(30);
    expect(msg).toBeDefined();
    expect(msg!.name).toBe('ATTITUDE');
    expect(msg!.crcExtra).toBe(39);
    expect(msg!.fields.length).toBe(7);
  });

  it('getMessageByName("HEARTBEAT") returns same as getMessageById(0)', () => {
    const byId = registry.getMessageById(0);
    const byName = registry.getMessageByName('HEARTBEAT');
    expect(byName).toBe(byId);
  });

  it('getEnum("MAV_TYPE") has entry for value 2 = "MAV_TYPE_QUADROTOR"', () => {
    const enumMeta = registry.getEnum('MAV_TYPE');
    expect(enumMeta).toBeDefined();
    const entry = enumMeta!.entries.get(2);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('MAV_TYPE_QUADROTOR');
  });

  it('resolveEnumValue("MAV_TYPE", 2) returns "MAV_TYPE_QUADROTOR"', () => {
    expect(registry.resolveEnumValue('MAV_TYPE', 2)).toBe('MAV_TYPE_QUADROTOR');
  });

  it('getMessageById(99999) returns undefined', () => {
    expect(registry.getMessageById(99999)).toBeUndefined();
  });

  it('getMessageByName("NONEXISTENT") returns undefined', () => {
    expect(registry.getMessageByName('NONEXISTENT')).toBeUndefined();
  });

  it('has multiple enums loaded', () => {
    expect(registry.enumCount).toBeGreaterThan(10);
  });
});
