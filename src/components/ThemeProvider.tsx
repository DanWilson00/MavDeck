import { createEffect, type ParentProps } from 'solid-js';
import { appState, setAppState } from '../store/app-store';

export default function ThemeProvider(props: ParentProps) {
  // Apply theme CSS class reactively
  createEffect(() => {
    document.documentElement.classList.toggle('light', appState.theme === 'light');
  });

  // Apply global UI scale for text/layout density.
  createEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', appState.uiScale.toFixed(2));
  });

  return <>{props.children}</>;
}

export function toggleTheme(): void {
  setAppState('theme', appState.theme === 'dark' ? 'light' : 'dark');
}
