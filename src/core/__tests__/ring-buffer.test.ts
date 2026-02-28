import { describe, it, expect, beforeEach } from 'vitest';
import { RingBuffer } from '../ring-buffer';

describe('RingBuffer', () => {
  let buffer: RingBuffer;

  beforeEach(() => {
    buffer = new RingBuffer(20);
  });

  describe('push and length', () => {
    it('starts empty with length 0', () => {
      expect(buffer.length).toBe(0);
    });

    it('push 10 items → length is 10', () => {
      for (let i = 0; i < 10; i++) {
        buffer.push(i * 1000, i * 100);
      }
      expect(buffer.length).toBe(10);
    });

    it('push 10 items → toUplotData returns 10-element arrays', () => {
      for (let i = 0; i < 10; i++) {
        buffer.push(i * 1000, i * 100);
      }
      const [ts, vals] = buffer.toUplotData();
      expect(ts.length).toBe(10);
      expect(vals.length).toBe(10);
    });

    it('push capacity+5 items → length is capacity, oldest 5 are gone', () => {
      const capacity = 20;
      const totalPushes = capacity + 5;

      for (let i = 0; i < totalPushes; i++) {
        buffer.push(i * 1000, i * 100);
      }

      expect(buffer.length).toBe(capacity);

      const [ts, vals] = buffer.toUplotData();
      expect(ts.length).toBe(capacity);
      expect(vals.length).toBe(capacity);

      // The oldest 5 (i=0..4) should be gone; first entry should be i=5
      // Timestamps stored as epoch-ms, toUplotData divides by 1000
      expect(ts[0]).toBe(5); // 5*1000 ms → 5 seconds
      expect(vals[0]).toBe(500); // 5*100

      // Last entry should be i=24
      expect(ts[capacity - 1]).toBe(24); // 24*1000 ms → 24 seconds
      expect(vals[capacity - 1]).toBe(2400); // 24*100
    });
  });

  describe('wrap-around ordering', () => {
    it('timestamps in toUplotData are monotonically increasing after wrap', () => {
      const capacity = 20;
      // Push more than capacity to force multiple wraps
      for (let i = 0; i < capacity * 3; i++) {
        buffer.push(i * 1000, i);
      }

      const [ts] = buffer.toUplotData();
      expect(ts.length).toBe(capacity);

      for (let i = 1; i < ts.length; i++) {
        expect(ts[i]).toBeGreaterThan(ts[i - 1]);
      }
    });

    it('values in toUplotData match their timestamps after wrap', () => {
      const capacity = 20;
      const totalPushes = capacity + 7;

      for (let i = 0; i < totalPushes; i++) {
        buffer.push(i * 1000, i);
      }

      const [ts, vals] = buffer.toUplotData();
      // Each value should equal its timestamp in seconds (since value=i, ts=i*1000/1000=i)
      for (let i = 0; i < ts.length; i++) {
        expect(vals[i]).toBe(ts[i]);
      }
    });
  });

  describe('toUplotData timestamp conversion', () => {
    it('timestamps are in seconds (not ms)', () => {
      // Push timestamps in epoch-ms
      buffer.push(1700000000000, 42); // ~Nov 2023 in ms
      buffer.push(1700000001000, 43); // 1 second later in ms

      const [ts] = buffer.toUplotData();
      expect(ts[0]).toBe(1700000000); // epoch-seconds
      expect(ts[1]).toBe(1700000001); // epoch-seconds
    });

    it('preserves sub-second precision in conversion', () => {
      buffer.push(1700000000500, 1); // 0.5s
      const [ts] = buffer.toUplotData();
      expect(ts[0]).toBe(1700000000.5);
    });
  });

  describe('toUplotData allocation behavior', () => {
    it('returns subarrays of the same underlying buffers across calls', () => {
      buffer.push(1000, 1);
      buffer.push(2000, 2);

      const [ts1, vals1] = buffer.toUplotData();
      const [ts2, vals2] = buffer.toUplotData();

      // subarray() views share the same ArrayBuffer
      expect(ts1.buffer).toBe(ts2.buffer);
      expect(vals1.buffer).toBe(vals2.buffer);
    });

    it('returns empty subarrays for empty buffer (not new arrays)', () => {
      const [ts, vals] = buffer.toUplotData();
      expect(ts.length).toBe(0);
      expect(vals.length).toBe(0);
    });
  });

  describe('getLatestValue', () => {
    it('returns undefined for empty buffer', () => {
      expect(buffer.getLatestValue()).toBeUndefined();
    });

    it('returns most recently pushed value', () => {
      buffer.push(1000, 42);
      buffer.push(2000, 99);
      buffer.push(3000, 7);
      expect(buffer.getLatestValue()).toBe(7);
    });

    it('returns correct value after wrap-around', () => {
      for (let i = 0; i < 25; i++) {
        buffer.push(i * 1000, i);
      }
      expect(buffer.getLatestValue()).toBe(24);
    });
  });

  describe('getLatestTimestamp', () => {
    it('returns undefined for empty buffer', () => {
      expect(buffer.getLatestTimestamp()).toBeUndefined();
    });

    it('returns most recently pushed timestamp in epoch-ms', () => {
      buffer.push(1000, 42);
      buffer.push(2000, 99);
      expect(buffer.getLatestTimestamp()).toBe(2000);
    });
  });

  describe('clear', () => {
    it('resets length to 0', () => {
      buffer.push(1000, 1);
      buffer.push(2000, 2);
      buffer.push(3000, 3);
      expect(buffer.length).toBe(3);

      buffer.clear();
      expect(buffer.length).toBe(0);
    });

    it('toUplotData returns empty arrays after clear', () => {
      buffer.push(1000, 1);
      buffer.clear();

      const [ts, vals] = buffer.toUplotData();
      expect(ts.length).toBe(0);
      expect(vals.length).toBe(0);
    });

    it('getLatestValue returns undefined after clear', () => {
      buffer.push(1000, 42);
      buffer.clear();
      expect(buffer.getLatestValue()).toBeUndefined();
    });

    it('getLatestTimestamp returns undefined after clear', () => {
      buffer.push(1000, 42);
      buffer.clear();
      expect(buffer.getLatestTimestamp()).toBeUndefined();
    });

    it('can push new data after clear', () => {
      for (let i = 0; i < 15; i++) {
        buffer.push(i * 1000, i);
      }
      buffer.clear();

      buffer.push(99000, 99);
      expect(buffer.length).toBe(1);
      expect(buffer.getLatestValue()).toBe(99);

      const [ts, vals] = buffer.toUplotData();
      expect(ts.length).toBe(1);
      expect(ts[0]).toBe(99); // 99000 / 1000
      expect(vals[0]).toBe(99);
    });
  });

  describe('empty buffer', () => {
    it('toUplotData returns empty arrays', () => {
      const [ts, vals] = buffer.toUplotData();
      expect(ts.length).toBe(0);
      expect(vals.length).toBe(0);
    });

    it('getLatestValue returns undefined', () => {
      expect(buffer.getLatestValue()).toBeUndefined();
    });

    it('getLatestTimestamp returns undefined', () => {
      expect(buffer.getLatestTimestamp()).toBeUndefined();
    });

    it('length is 0', () => {
      expect(buffer.length).toBe(0);
    });
  });

  describe('default capacity', () => {
    it('uses capacity of 2000 by default', () => {
      const defaultBuffer = new RingBuffer();
      expect(defaultBuffer.capacity).toBe(2000);
    });
  });

  describe('edge cases', () => {
    it('works with capacity of 1', () => {
      const tiny = new RingBuffer(1);
      tiny.push(1000, 10);
      expect(tiny.length).toBe(1);
      expect(tiny.getLatestValue()).toBe(10);

      tiny.push(2000, 20);
      expect(tiny.length).toBe(1);
      expect(tiny.getLatestValue()).toBe(20);

      const [ts, vals] = tiny.toUplotData();
      expect(ts.length).toBe(1);
      expect(ts[0]).toBe(2); // 2000 / 1000
      expect(vals[0]).toBe(20);
    });

    it('handles exactly capacity items without losing data', () => {
      const capacity = 20;
      for (let i = 0; i < capacity; i++) {
        buffer.push(i * 1000, i);
      }

      expect(buffer.length).toBe(capacity);
      const [ts, vals] = buffer.toUplotData();

      // All items should be present
      for (let i = 0; i < capacity; i++) {
        expect(ts[i]).toBe(i); // i*1000 / 1000
        expect(vals[i]).toBe(i);
      }
    });
  });
});
