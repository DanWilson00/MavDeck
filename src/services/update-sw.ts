/** Stored reference to the SW update function. Call with `true` to activate new SW and reload. */
export let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;

export function setUpdateSW(fn: (reloadPage?: boolean) => Promise<void>) {
  updateSW = fn;
}
