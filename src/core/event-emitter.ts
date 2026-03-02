/**
 * Lightweight typed event emitter.
 *
 * Replaces the repeated pattern of `new Set<Callback>()` + manual
 * subscribe/unsubscribe/iterate boilerplate found across the codebase.
 *
 * Usage:
 * ```ts
 * type OnChange = (value: number) => void;
 * const change = new EventEmitter<OnChange>();
 *
 * const unsub = change.on(v => console.log(v));
 * change.emit(42);  // logs 42
 * unsub();          // unsubscribed
 * ```
 */
export class EventEmitter<T extends (...args: never[]) => void> {
  private readonly listeners = new Set<T>();

  /** Subscribe a listener. Returns an unsubscribe function. */
  on(listener: T): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Invoke all listeners with the given arguments. */
  emit(...args: Parameters<T>): void {
    for (const listener of this.listeners) {
      listener(...args);
    }
  }

  /** Remove all listeners. */
  clear(): void {
    this.listeners.clear();
  }

  /** Number of active listeners. */
  get size(): number {
    return this.listeners.size;
  }
}
