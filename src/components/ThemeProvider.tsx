import { onMount, createEffect, type ParentProps } from 'solid-js';
import { get, set } from 'idb-keyval';
import { appState, setAppState } from '../store/app-store';

const THEME_KEY = 'mavdeck-theme';

export default function ThemeProvider(props: ParentProps) {
  // Load persisted theme on mount
  onMount(async () => {
    const saved = await get<'dark' | 'light'>(THEME_KEY);
    if (saved) {
      setAppState('theme', saved);
    }
  });

  // Apply theme class to <html> and persist whenever it changes
  createEffect(() => {
    const theme = appState.theme;
    document.documentElement.classList.toggle('light', theme === 'light');
    set(THEME_KEY, theme);
  });

  return <>{props.children}</>;
}

export function toggleTheme(): void {
  setAppState('theme', appState.theme === 'dark' ? 'light' : 'dark');
}
