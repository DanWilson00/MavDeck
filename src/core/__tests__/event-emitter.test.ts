import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../event-emitter';

describe('EventEmitter', () => {
  describe('on / emit', () => {
    it('calls a listener when emitted', () => {
      const emitter = new EventEmitter<(v: number) => void>();
      const listener = vi.fn();

      emitter.on(listener);
      emitter.emit(42);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(42);
    });

    it('calls multiple listeners in subscription order', () => {
      const emitter = new EventEmitter<(v: string) => void>();
      const order: number[] = [];

      emitter.on(() => order.push(1));
      emitter.on(() => order.push(2));
      emitter.on(() => order.push(3));
      emitter.emit('test');

      expect(order).toEqual([1, 2, 3]);
    });

    it('passes multiple arguments to listeners', () => {
      const emitter = new EventEmitter<(a: string, b: number) => void>();
      const listener = vi.fn();

      emitter.on(listener);
      emitter.emit('hello', 99);

      expect(listener).toHaveBeenCalledWith('hello', 99);
    });

    it('handles zero-argument events', () => {
      const emitter = new EventEmitter<() => void>();
      const listener = vi.fn();

      emitter.on(listener);
      emitter.emit();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith();
    });

    it('does not call listeners that were not subscribed', () => {
      const emitter = new EventEmitter<(v: number) => void>();
      const listener = vi.fn();

      // Never subscribed
      emitter.emit(42);

      expect(listener).not.toHaveBeenCalled();
    });

    it('deduplicates the same listener reference', () => {
      const emitter = new EventEmitter<(v: number) => void>();
      const listener = vi.fn();

      emitter.on(listener);
      emitter.on(listener); // same reference, Set deduplicates
      emitter.emit(1);

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('unsubscribe', () => {
    it('returns a function that removes the listener', () => {
      const emitter = new EventEmitter<(v: number) => void>();
      const listener = vi.fn();

      const unsub = emitter.on(listener);
      emitter.emit(1);
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      emitter.emit(2);
      expect(listener).toHaveBeenCalledTimes(1); // not called again
    });

    it('only removes the specific listener', () => {
      const emitter = new EventEmitter<(v: number) => void>();
      const listenerA = vi.fn();
      const listenerB = vi.fn();

      const unsubA = emitter.on(listenerA);
      emitter.on(listenerB);

      unsubA();
      emitter.emit(1);

      expect(listenerA).not.toHaveBeenCalled();
      expect(listenerB).toHaveBeenCalledWith(1);
    });

    it('is safe to call unsubscribe multiple times', () => {
      const emitter = new EventEmitter<() => void>();
      const listener = vi.fn();

      const unsub = emitter.on(listener);
      unsub();
      unsub(); // should not throw

      expect(emitter.size).toBe(0);
    });
  });

  describe('clear', () => {
    it('removes all listeners', () => {
      const emitter = new EventEmitter<() => void>();
      emitter.on(vi.fn());
      emitter.on(vi.fn());
      emitter.on(vi.fn());

      expect(emitter.size).toBe(3);
      emitter.clear();
      expect(emitter.size).toBe(0);
    });

    it('prevents previously subscribed listeners from being called', () => {
      const emitter = new EventEmitter<(v: number) => void>();
      const listener = vi.fn();

      emitter.on(listener);
      emitter.clear();
      emitter.emit(1);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('size', () => {
    it('starts at 0', () => {
      const emitter = new EventEmitter<() => void>();
      expect(emitter.size).toBe(0);
    });

    it('reflects the number of subscribed listeners', () => {
      const emitter = new EventEmitter<() => void>();
      const unsub1 = emitter.on(vi.fn());
      expect(emitter.size).toBe(1);

      const unsub2 = emitter.on(vi.fn());
      expect(emitter.size).toBe(2);

      unsub1();
      expect(emitter.size).toBe(1);

      unsub2();
      expect(emitter.size).toBe(0);
    });
  });
});
