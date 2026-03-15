import { onMount, onCleanup } from 'solid-js';
import { appState, setAppState } from '../store';

export function useKeyboardShortcuts(): void {
  onMount(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't handle shortcuts when typing in inputs
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

      if (e.key === 'Escape' && appState.isHelpOpen) {
        e.preventDefault();
        setAppState('isHelpOpen', false);
        return;
      }

      if (appState.isHelpOpen) return;

      switch (e.key) {
        case ' ': {
          e.preventDefault();
          if (appState.connectionStatus !== 'connected' && appState.connectionStatus !== 'no_data') return;
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
