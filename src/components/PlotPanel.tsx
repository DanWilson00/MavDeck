import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import PlotChart from './PlotChart';
import type { PlotConfig } from '../models';
import { getThemeColor } from '../models';
import { formatSignalDisplayLabel, getSignalDisplayUnit, useRegistry } from '../services';
import { appState } from '../store';
import type { PlotInteractionController } from '../core';

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
  const registry = useRegistry();
  const visibleSignals = createMemo(() => props.config.signals.filter(s => s.visible));
  const [signalStripWidth, setSignalStripWidth] = createSignal(0);
  const [measurementVersion, setMeasurementVersion] = createSignal(0);
  const MORE_BADGE_RESERVE_PX = 72;
  let signalStripRef: HTMLDivElement | undefined;
  let measurementRef: HTMLDivElement | undefined;
  const compactNames = createMemo(() => {
    const counts = new Map<string, number>();
    for (const sig of visibleSignals()) {
      counts.set(sig.fieldName, (counts.get(sig.fieldName) ?? 0) + 1);
    }

    return new Map(
      visibleSignals().map(sig => [
        sig.id,
        counts.get(sig.fieldName)! > 1 ? `${sig.messageType}.${sig.fieldName}` : sig.fieldName,
      ]),
    );
  });
  const fittedSignalCount = createMemo(() => {
    measurementVersion();
    const signals = visibleSignals();
    const containerWidth = signalStripWidth();
    if (!measurementRef || containerWidth <= 0 || signals.length === 0) {
      return signals.length;
    }

    const chipWidths = Array.from(measurementRef.querySelectorAll<HTMLElement>('[data-measure-chip="true"]')).map(
      chip => chip.offsetWidth,
    );
    if (chipWidths.length !== signals.length) {
      return signals.length;
    }

    let usedWidth = 0;
    let fitCount = 0;
    for (let i = 0; i < chipWidths.length; i += 1) {
      const remainingAfterThis = chipWidths.length - (i + 1);
      const reservedWidth = remainingAfterThis > 0 ? MORE_BADGE_RESERVE_PX : 0;
      if (usedWidth + chipWidths[i] + reservedWidth > containerWidth) {
        break;
      }
      usedWidth += chipWidths[i];
      fitCount += 1;
    }

    return fitCount > 0 ? fitCount : 1;
  });
  const inlineSignals = createMemo(() => visibleSignals().slice(0, fittedSignalCount()));
  const hiddenSignals = createMemo(() => visibleSignals().slice(fittedSignalCount()));
  const hiddenSignalsTitle = createMemo(() =>
    hiddenSignals()
      .map(sig => formatSignalDisplayLabel(registry, sig, appState.unitProfile))
      .join('\n'),
  );

  onMount(() => {
    if (!signalStripRef) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setSignalStripWidth(entry.contentRect.width);
    });

    observer.observe(signalStripRef);
    setSignalStripWidth(signalStripRef.getBoundingClientRect().width);

    onCleanup(() => observer.disconnect());
  });

  onMount(() => {
    if (!measurementRef) {
      return;
    }

    const observer = new ResizeObserver(() => {
      setMeasurementVersion(version => version + 1);
    });

    observer.observe(measurementRef);
    setMeasurementVersion(version => version + 1);

    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      class="flex flex-col h-full rounded"
      style={{
        'background-color': 'var(--bg-panel)',
        border: '1px solid var(--border)',
        'box-shadow': 'var(--shadow-panel)',
        overflow: 'hidden',
        outline: props.isSelected() ? '2px solid var(--accent)' : 'none',
        'outline-offset': '-2px',
      }}
      onClick={() => props.onSelect()}
    >
      {/* Header */}
      <div
        class="flex items-center gap-2 px-2 py-1 border-b cursor-grab"
        style={{ 'border-color': 'var(--border)', 'min-height': '32px' }}
        onDblClick={() => props.onOpenSignalSelector(props.config.id)}
      >
        {/* Signal names */}
        <div ref={signalStripRef} class="flex flex-1 min-w-0 items-center gap-1.5 overflow-hidden pr-1">
          <For each={inlineSignals()}>
            {(sig) => (
              <span
                class="inline-flex max-w-[13rem] min-w-0 flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-mono"
                style={{
                  color: getThemeColor(sig.color, appState.theme),
                  'background-color': 'var(--chip-bg)',
                }}
                title={formatSignalDisplayLabel(registry, sig, appState.unitProfile)}
              >
                <span
                  class="inline-block h-1.5 w-1.5 rounded-full flex-shrink-0"
                  style={{ 'background-color': getThemeColor(sig.color, appState.theme) }}
                />
                <span class="truncate">
                  {compactNames().get(sig.id) ?? sig.fieldName}
                  {' '}
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {getSignalDisplayUnit(registry, sig, appState.unitProfile)}
                  </span>
                </span>
              </span>
            )}
          </For>
          <Show when={hiddenSignals().length > 0}>
            <span
              class="inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-mono"
              style={{
                color: 'var(--text-secondary)',
                'background-color': 'var(--chip-bg)',
              }}
              title={hiddenSignalsTitle()}
            >
              +
              {hiddenSignals().length}
              {' '}
              more
            </span>
          </Show>
          <Show when={visibleSignals().length === 0}>
            <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>
              No signals
            </span>
          </Show>
        </div>
        <div
          ref={measurementRef}
          class="pointer-events-none absolute invisible left-0 top-0 -z-10 flex items-center gap-1.5 px-2 py-1"
          aria-hidden="true"
        >
          <For each={visibleSignals()}>
            {(sig) => (
              <span
                data-measure-chip="true"
                class="inline-flex max-w-[13rem] min-w-0 flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-mono"
              >
                <span class="inline-block h-1.5 w-1.5 rounded-full flex-shrink-0" />
                <span class="truncate">
                  {compactNames().get(sig.id) ?? sig.fieldName}
                  {' '}
                  <span>
                    {getSignalDisplayUnit(registry, sig, appState.unitProfile)}
                  </span>
                </span>
              </span>
            )}
          </For>
        </div>
        <div class="flex items-center gap-0.5 flex-shrink-0 ml-auto">
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
      <div class="relative flex-1 min-h-0">
        <Show
          when={props.config.signals.length > 0}
          fallback={
            <div class="flex h-full items-center justify-center px-4 text-center">
              <div class="max-w-xs">
                <p class="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Empty plot
                </p>
                <button
                  class="mt-3 rounded px-3 py-1.5 text-xs font-medium interactive-hover"
                  style={{
                    'background-color': 'var(--bg-hover)',
                    color: 'var(--text-primary)',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onOpenSignalSelector(props.config.id);
                  }}
                >
                  Add signals
                </button>
              </div>
            </div>
          }
        >
          <PlotChart
            plotId={props.config.id}
            interactionGroupId={props.interactionGroupId}
            interactionController={props.interactionController}
            signals={props.config.signals}
            timeWindow={props.config.timeWindow}
            isPaused={appState.isPaused}
          />
        </Show>
      </div>
    </div>
  );
}
