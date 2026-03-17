import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { appState } from '../store';
import { updateSW } from '../services/update-sw';
import { getDeferredPrompt, clearDeferredPrompt, onPromptAvailable, type BeforeInstallPromptEvent } from '../services/install-prompt';

export default function InstallPrompt() {
  const [installEvent, setInstallEvent] = createSignal<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = createSignal(false);

  onMount(() => {
    const mql = window.matchMedia('(display-mode: standalone)');
    setIsStandalone(mql.matches);

    function handleChange(e: MediaQueryListEvent) {
      setIsStandalone(e.matches);
    }
    mql.addEventListener('change', handleChange);
    onCleanup(() => mql.removeEventListener('change', handleChange));

    // Pick up event already captured at module level
    const captured = getDeferredPrompt();
    if (captured) {
      setInstallEvent(captured);
    }

    // Subscribe for late arrivals
    const unsub = onPromptAvailable((e) => setInstallEvent(e));
    onCleanup(unsub);
  });

  async function handleInstall() {
    const event = installEvent();
    if (!event) return;
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') {
      setInstallEvent(null);
      clearDeferredPrompt();
    }
  }

  return (
    <>
      {/* Install: only in browser (not standalone) when install prompt available */}
      <Show when={!isStandalone() && installEvent()}>
        <button
          class="px-3 py-1 rounded text-sm font-medium transition-colors interactive-hover"
          style={{ 'background-color': 'var(--bg-hover)', color: 'var(--accent)' }}
          onClick={handleInstall}
        >
          Install App
        </button>
      </Show>

      {/* Update: only when installed as PWA and update available */}
      <Show when={isStandalone() && appState.updateAvailable}>
        <button
          onClick={() => updateSW?.(true)}
          class="px-3 py-1 rounded text-sm font-medium transition-colors"
          style={{
            'background-color': 'var(--accent)',
            color: '#000',
          }}
        >
          Update — Reload
        </button>
      </Show>
    </>
  );
}
