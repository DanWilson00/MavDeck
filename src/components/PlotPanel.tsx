import { For, Show } from 'solid-js';
import PlotChart from './PlotChart';
import type { PlotConfig } from '../models/plot-config';
import { getThemeColor } from '../models/plot-config';
import { appState } from '../store/app-store';
import type { PlotInteractionController } from './plot-interactions';

interface PlotPanelProps {
  config: PlotConfig;
  onClose: (plotId: string) => void;
  onOpenSignalSelector: (plotId: string) => void;
  isSelected: () => boolean;
  onSelect: () => void;
  onClearSignals: () => void;
  interactionGroupId: string;
  interactionController: PlotInteractionController;
}

export default function PlotPanel(props: PlotPanelProps) {
  return (
    <div
      class="flex flex-col h-full rounded"
      style={{
        'background-color': 'var(--bg-panel)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
        outline: props.isSelected() ? '2px solid var(--accent)' : 'none',
        'outline-offset': '-2px',
      }}
      onClick={() => props.onSelect()}
    >
      {/* Header */}
      <div
        class="flex items-center justify-between px-2 py-1 border-b cursor-grab"
        style={{ 'border-color': 'var(--border)', 'min-height': '32px' }}
        onDblClick={() => props.onOpenSignalSelector(props.config.id)}
      >
        {/* Signal names */}
        <div class="flex items-center gap-2 flex-1 overflow-hidden">
          <For each={props.config.signals.filter(s => s.visible)}>
            {(sig) => (
              <span
                class="text-xs font-mono truncate"
                style={{ color: getThemeColor(sig.color, appState.theme) }}
              >
                {sig.fieldKey}
              </span>
            )}
          </For>
          <Show when={props.config.signals.filter(s => s.visible).length === 0}>
            <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>
              No signals
            </span>
          </Show>
        </div>
        <div class="flex items-center gap-0.5 flex-shrink-0">
          {/* Clear all signals button */}
          <Show when={props.config.signals.length > 0}>
            <button
              class="p-0.5 rounded transition-colors interactive-hover"
              style={{ color: 'var(--text-secondary)' }}
              onClick={(e) => {
                e.stopPropagation();
                props.onClearSignals();
              }}
              title="Clear all signals"
              aria-label="Clear all signals"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 20H7L3 4h18" />
                <path d="M6.47 6.47L17.53 17.53" />
              </svg>
            </button>
          </Show>
          {/* Close button */}
          <button
            class="p-0.5 rounded transition-colors interactive-hover"
            style={{ color: 'var(--text-secondary)' }}
            onClick={(e) => {
              e.stopPropagation();
              props.onClose(props.config.id);
            }}
            title="Remove plot"
            aria-label="Remove plot"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Chart area */}
      <div class="flex-1 min-h-0">
        <PlotChart
          plotId={props.config.id}
          interactionGroupId={props.interactionGroupId}
          interactionController={props.interactionController}
          signals={props.config.signals}
          timeWindow={props.config.timeWindow}
          isPaused={appState.isPaused}
        />
      </div>
    </div>
  );
}
