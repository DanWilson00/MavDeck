import { For } from 'solid-js';
import { appState, selectStatusBarModel, type StatusTone } from '../store';
import { isSerialSupported } from '../services';

const TONE_COLORS: Record<StatusTone, string> = {
  neutral: 'var(--text-secondary)',
  accent: 'var(--accent)',
  good: 'var(--accent-green)',
  warn: '#facc15',
  error: '#fda4af',
};

export default function StatusBar() {
  const model = () => selectStatusBarModel(appState, isSerialSupported());

  return (
    <footer
      class="flex items-center justify-between gap-3 px-3 py-2 shrink-0 border-t"
      style={{
        'background-color': 'var(--bg-panel)',
        'border-color': 'var(--border)',
        'box-shadow': 'var(--shadow-statusbar)',
      }}
    >
      <div
        class="flex min-w-0 items-center gap-2 text-[11px]"
        style={{
          color: 'var(--text-secondary)',
          'font-family': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          'letter-spacing': '0.02em',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: '7px',
            height: '7px',
            'border-radius': '50%',
            'background-color': TONE_COLORS[model().headlineTone],
            'box-shadow': `0 0 8px color-mix(in srgb, ${TONE_COLORS[model().headlineTone]} 55%, transparent)`,
            'flex-shrink': '0',
          }}
        />
        <span style={{ color: TONE_COLORS[model().headlineTone], 'font-weight': '600' }}>
          {model().headline}
        </span>
        <For each={model().badges}>
          {(badge) => (
            <>
              <span style={{ color: 'var(--border)' }}>/</span>
              <span style={{ color: TONE_COLORS[badge.tone] }}>
                {badge.label}
              </span>
            </>
          )}
        </For>
      </div>

      <div
        class="flex min-w-0 items-center justify-end gap-2 text-[11px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        <For each={model().details}>
          {(detail, index) => (
            <>
              {index() > 0 && <DetailDivider />}
              <span class="truncate">{detail}</span>
            </>
          )}
        </For>
      </div>
    </footer>
  );
}

function DetailDivider() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: '1px',
        height: '12px',
        'background-color': 'var(--border)',
        'flex-shrink': '0',
      }}
    />
  );
}
