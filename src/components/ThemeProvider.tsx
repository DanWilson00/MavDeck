import { createEffect, type ParentProps } from 'solid-js';
import { appState, setAppState } from '../store/app-store';

export default function ThemeProvider(props: ParentProps) {
  // Apply theme CSS class reactively
  createEffect(() => {
    document.documentElement.classList.toggle('light', appState.theme === 'light');
  });

  return <>{props.children}</>;
}

export function toggleTheme(): void {
  setAppState('theme', appState.theme === 'dark' ? 'light' : 'dark');
}
