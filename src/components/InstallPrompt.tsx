import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { appState } from '../store';
import { updateSW } from '../index';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

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

    // Only listen for install prompt if not already installed
    if (!mql.matches) {
      function handleBeforeInstall(e: Event) {
        e.preventDefault();
        setInstallEvent(e as BeforeInstallPromptEvent);
      }

      window.addEventListener('beforeinstallprompt', handleBeforeInstall);
      onCleanup(() => window.removeEventListener('beforeinstallprompt', handleBeforeInstall));
    }
  });

  async function handleInstall() {
    const event = installEvent();
    if (!event) return;
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === 'accepted') {
      setInstallEvent(null);
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
