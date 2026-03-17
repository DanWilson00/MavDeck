export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<(e: BeforeInstallPromptEvent | null) => void>();

// Attach immediately at import time — before SolidJS renders —
// so the synchronous beforeinstallprompt event is never missed.
if (typeof window !== 'undefined' && !window.matchMedia('(display-mode: standalone)').matches) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    listeners.forEach(fn => fn(deferredPrompt));
  });
}

export function getDeferredPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

export function clearDeferredPrompt(): void {
  deferredPrompt = null;
}

export function onPromptAvailable(fn: (e: BeforeInstallPromptEvent | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
