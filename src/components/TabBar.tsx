import { For } from 'solid-js';
import { appState, setAppState } from '../store/app-store';

const TABS = [
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'map', label: 'Map' },
] as const;

export default function TabBar() {
  return (
    <nav
      class="flex border-b"
      style={{
        'background-color': 'var(--bg-panel)',
        'border-color': 'var(--border)',
      }}
    >
      <For each={TABS}>
        {(tab) => (
          <button
            onClick={() => setAppState('activeTab', tab.id)}
            class="px-4 py-2 text-sm font-medium transition-colors relative"
            style={{
              color: appState.activeTab === tab.id
                ? 'var(--accent)'
                : 'var(--text-secondary)',
            }}
          >
            {tab.label}
            {/* Active underline */}
            <div
              class="absolute bottom-0 left-0 right-0 h-0.5 transition-opacity"
              style={{
                'background-color': 'var(--accent)',
                opacity: appState.activeTab === tab.id ? '1' : '0',
              }}
            />
          </button>
        )}
      </For>
    </nav>
  );
}
