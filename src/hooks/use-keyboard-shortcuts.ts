import { onMount, onCleanup } from 'solid-js';
import { appState, setAppState } from '../store';

export function useKeyboardShortcuts(): void {
  onMount(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't handle shortcuts when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key) {
        case ' ': {
          e.preventDefault();
          if (appState.connectionStatus !== 'connected') return;
          if (appState.logViewerState.isActive) return;
          setAppState('isPaused', !appState.isPaused);
          break;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
  });
}
