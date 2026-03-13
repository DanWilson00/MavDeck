import { Show } from 'solid-js';
import { appState, setAppState } from '../store';

export default function HelpOverlay() {
  return (
    <Show when={appState.isHelpOpen}>
      <div
        class="fixed inset-0 z-[1100] flex items-center justify-center px-4"
        style={{ 'background-color': 'rgba(0, 0, 0, 0.56)' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setAppState('isHelpOpen', false);
        }}
        >
        <div
          class="w-full max-w-xl rounded-xl border shadow-2xl"
          style={{
            'background-color': 'var(--bg-panel)',
            'border-color': 'var(--border)',
          }}
        >
          <div
            class="flex items-center justify-between gap-4 border-b px-4 py-3"
            style={{ 'border-color': 'var(--border)' }}
          >
            <div class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Help
            </div>
            <button
              class="rounded px-2 py-1 text-xs interactive-hover"
              style={{ color: 'var(--text-secondary)' }}
              onClick={() => setAppState('isHelpOpen', false)}
              aria-label="Close help"
              title="Close help"
            >
              Close
            </button>
          </div>

          <div class="grid gap-4 px-4 py-4 sm:grid-cols-2">
            <section>
              <h2 class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Modes
              </h2>
              <ul class="mt-2 space-y-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <li>Logs replace live telemetry until unloaded.</li>
                <li>Pause applies to live charts only.</li>
              </ul>
            </section>

            <section>
              <h2 class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Plots
              </h2>
              <ul class="mt-2 space-y-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <li>Select a plot before adding fields.</li>
                <li>Double-click a plot header to open its signal picker.</li>
              </ul>
            </section>

            <section>
              <h2 class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Charts
              </h2>
              <ul class="mt-2 space-y-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <li>Zoom is linked across visible plots.</li>
                <li>Double-click a chart to reset zoom.</li>
              </ul>
            </section>

            <section>
              <h2 class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Map
              </h2>
              <ul class="mt-2 space-y-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <li>Dragging disables auto-center.</li>
                <li>Logs show the full path when position data exists.</li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    </Show>
  );
}
