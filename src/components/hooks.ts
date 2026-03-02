import type { Setter } from 'solid-js';

/** Toggle an item in a Set-based signal. */
export function toggleSetItem<T>(setter: Setter<Set<T>>, item: T): void {
  setter(prev => {
    const next = new Set(prev);
    if (next.has(item)) next.delete(item);
    else next.add(item);
    return next;
  });
}
