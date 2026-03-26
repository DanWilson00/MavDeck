import { describe, it, expect } from 'vitest';
import { formatAutopilotVersionField } from '../autopilot-version-format';

describe('formatAutopilotVersionField', () => {
  describe('software version fields (*_sw_version)', () => {
    it('decodes packed version v0.2.0-dev', () => {
      // 0x00020000 = (0 << 24) | (2 << 16) | (0 << 8) | 0(DEV)
      expect(formatAutopilotVersionField('flight_sw_version', 0x00020000)).toBe('v0.2.0-dev');
    });

    it('decodes official version without suffix', () => {
      // 0x010200FF = (1 << 24) | (2 << 16) | (0 << 8) | 255(OFFICIAL)
      expect(formatAutopilotVersionField('flight_sw_version', 0x010200FF)).toBe('v1.2.0');
    });

    it('decodes alpha version', () => {
      // type 64 = ALPHA
      expect(formatAutopilotVersionField('flight_sw_version', 0x04030240)).toBe('v4.3.2-alpha');
    });

    it('decodes beta version', () => {
      // type 128 = BETA
      expect(formatAutopilotVersionField('flight_sw_version', 0x01000180)).toBe('v1.0.1-beta');
    });

    it('decodes rc version', () => {
      // type 192 = RC
      expect(formatAutopilotVersionField('flight_sw_version', 0x020100C0)).toBe('v2.1.0-rc');
    });

    it('returns null for zero (unpopulated)', () => {
      expect(formatAutopilotVersionField('flight_sw_version', 0)).toBeNull();
    });

    it('works for middleware_sw_version', () => {
      expect(formatAutopilotVersionField('middleware_sw_version', 0x00020000)).toBe('v0.2.0-dev');
    });

    it('works for os_sw_version', () => {
      expect(formatAutopilotVersionField('os_sw_version', 0x010200FF)).toBe('v1.2.0');
    });
  });

  describe('custom version fields (*_custom_version)', () => {
    it('decodes ASCII git hash bytes', () => {
      // "b6dcbdc" as ASCII byte values + null terminator
      expect(formatAutopilotVersionField('flight_custom_version', [98, 54, 100, 99, 98, 100, 99, 0])).toBe('b6dcbdc');
    });

    it('decodes full 8-char hash with no null', () => {
      // "abcdef12" as ASCII
      expect(formatAutopilotVersionField('flight_custom_version', [97, 98, 99, 100, 101, 102, 49, 50])).toBe('abcdef12');
    });

    it('returns null for all zeros', () => {
      expect(formatAutopilotVersionField('flight_custom_version', [0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    });

    it('works for middleware_custom_version', () => {
      expect(formatAutopilotVersionField('middleware_custom_version', [97, 98, 99, 0, 0, 0, 0, 0])).toBe('abc');
    });

    it('works for os_custom_version', () => {
      expect(formatAutopilotVersionField('os_custom_version', [49, 50, 51, 52, 53, 54, 55, 56])).toBe('12345678');
    });
  });

  describe('uid field', () => {
    it('formats as hex string', () => {
      expect(formatAutopilotVersionField('uid', 0x123456789AB)).toBe('0x00000123456789AB');
    });

    it('returns null for zero', () => {
      expect(formatAutopilotVersionField('uid', 0)).toBeNull();
    });
  });

  describe('uid2 field', () => {
    it('decodes LE uint32 triplet as hex UID', () => {
      // bytes 0-3: [68, 0, 39, 0]  → LE uint32 = 0x00270044
      // bytes 4-7: [17, 81, 51, 49] → LE uint32 = 0x31335111
      // bytes 8-11: [50, 53, 50, 55] → LE uint32 = 0x37323532
      // Display: uid2, uid1, uid0 → 373235323133511100270044
      const bytes = [68, 0, 39, 0, 17, 81, 51, 49, 50, 53, 50, 55, 0, 0, 0, 0, 0, 0];
      expect(formatAutopilotVersionField('uid2', bytes)).toBe('373235323133511100270044');
    });

    it('returns null for all zeros', () => {
      expect(formatAutopilotVersionField('uid2', Array(18).fill(0))).toBeNull();
    });
  });

  describe('unknown fields', () => {
    it('returns null for board_version', () => {
      expect(formatAutopilotVersionField('board_version', 42)).toBeNull();
    });

    it('returns null for capabilities', () => {
      expect(formatAutopilotVersionField('capabilities', 12345)).toBeNull();
    });

    it('returns null for vendor_id', () => {
      expect(formatAutopilotVersionField('vendor_id', 1)).toBeNull();
    });
  });
});
