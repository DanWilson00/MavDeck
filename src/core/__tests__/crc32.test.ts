import { describe, it, expect } from 'vitest';
import { crc32 } from '../crc32';

describe('crc32', () => {
  it('returns 0x00000000 for empty input', () => {
    expect(crc32(new Uint8Array([]))).toBe(0x00000000);
  });

  it('returns 0xCBF43926 for "123456789"', () => {
    const data = new TextEncoder().encode('123456789');
    expect(crc32(data)).toBe(0xCBF43926);
  });

  it('returns consistent results for identical input', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    expect(crc32(data)).toBe(crc32(data));
  });

  it('returns different results for different input', () => {
    const a = new Uint8Array([0x01, 0x02]);
    const b = new Uint8Array([0x03, 0x04]);
    expect(crc32(a)).not.toBe(crc32(b));
  });
});
