import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import PlotChart from './PlotChart';
import type { PlotConfig } from '../models/plot-config';
import { appState, workerBridge } from '../store/app-store';

interface PlotPanelProps {
  config: PlotConfig;
  onClose: (plotId: string) => void;
  onOpenSignalSelector: (plotId: string) => void;
}

export default function PlotPanel(props: PlotPanelProps) {
  const [liveValues, setLiveValues] = createSignal<Map<string, number>>(new Map());

  // Track live values for display
  createEffect(() => {
    if (!appState.isReady) return;
    const unsub = workerBridge.onUpdate(buffers => {
      const vals = new Map<string, number>();
      for (const sig of props.config.signals) {
        if (!sig.visible) continue;
        const buf = buffers.get(sig.fieldKey);
        if (buf && buf.values.length > 0) {
          vals.set(sig.fieldKey, buf.values[buf.values.length - 1]);
        }
      }
      setLiveValues(vals);
    });
    onCleanup(unsub);
  });

  function formatLiveValue(val: number | undefined): string {
    if (val === undefined) return '\u2014';
    if (Number.isInteger(val)) return String(val);
    return val.toFixed(4);
  }

  return (
    <div
      class="flex flex-col h-full rounded"
      style={{
        'background-color': 'var(--bg-panel)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}
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
                style={{ color: sig.color }}
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
        {/* Close button */}
        <button
          class="p-0.5 rounded transition-colors flex-shrink-0"
          style={{ color: 'var(--text-secondary)' }}
          onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
          onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
          onClick={(e) => {
            e.stopPropagation();
            props.onClose(props.config.id);
          }}
          title="Remove plot"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Live values bar */}
      <Show when={props.config.signals.filter(s => s.visible).length > 0}>
        <div
          class="flex items-center gap-3 px-2 py-1 border-b"
          style={{ 'border-color': 'var(--border)' }}
        >
          <For each={props.config.signals.filter(s => s.visible)}>
            {(sig) => (
              <span class="text-sm font-mono" style={{ color: sig.color }}>
                {formatLiveValue(liveValues().get(sig.fieldKey))}
              </span>
            )}
          </For>
        </div>
      </Show>

      {/* Chart area */}
      <div class="flex-1 min-h-0">
        <PlotChart
          signals={props.config.signals}
          timeWindow={props.config.timeWindow}
          isPaused={appState.isPaused}
        />
      </div>
    </div>
  );
}
