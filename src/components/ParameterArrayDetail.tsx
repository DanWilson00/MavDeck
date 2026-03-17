import { createSignal, createEffect, Show, For } from 'solid-js';
import type { ArrayParamGroup, ParamWithMeta } from '../hooks/use-parameters';
import type { ParamSetResult } from '../services/parameter-types';
import type { ParamDef } from '../models/parameter-metadata';

interface ParameterArrayDetailProps {
  array: ArrayParamGroup;
  pendingEdits: Map<string, number>;
  onLocalChange: (paramId: string, value: number | null) => void;
  onSetParam: (paramId: string, value: number) => void;
  lastSetResult: ParamSetResult | null;
}

function formatValue(value: number, decimal?: number): string {
  if (decimal !== undefined) return value.toFixed(decimal);
  return String(value);
}

function formatArrayValues(elements: ParamWithMeta[], pendingEdits: Map<string, number>, usePending: boolean): string {
  const vals = elements.map(e => {
    const val = usePending ? (pendingEdits.get(e.paramId) ?? e.value) : e.value;
    return formatValue(val, e.meta?.decimal);
  });
  return '[' + vals.join(', ') + ']';
}

export default function ParameterArrayDetail(props: ParameterArrayDetailProps) {
  const fieldName = () => {
    const key = props.array.elements[0]?.meta?.config_key;
    if (!key) return props.array.description;
    const dotIdx = key.indexOf('.');
    return dotIdx >= 0 ? key.substring(dotIdx + 1) : key;
  };

  const displayDescription = () => {
    const meta = props.array.elements[0]?.meta;
    return meta?.long_description || meta?.description || '';
  };

  const [flashMap, setFlashMap] = createSignal<Map<string, 'success' | 'error'>>(new Map());

  // Watch for set results matching elements in this array
  createEffect(() => {
    const result = props.lastSetResult;
    if (!result) return;
    const isElement = props.array.elements.some(e => e.paramId === result.paramId);
    if (!isElement) return;

    setFlashMap((prev: Map<string, 'success' | 'error'>) => {
      const next = new Map(prev);
      next.set(result.paramId, result.success ? 'success' : 'error');
      return next;
    });
    const paramId = result.paramId;
    setTimeout(() => {
      setFlashMap((prev: Map<string, 'success' | 'error'>) => {
        const next = new Map(prev);
        next.delete(paramId);
        return next;
      });
    }, 2000);
  });

  const hasPendingEdits = () => {
    return props.array.elements.some(e => props.pendingEdits.has(e.paramId));
  };

  function handleSaveAll() {
    for (const elem of props.array.elements) {
      const pending = props.pendingEdits.get(elem.paramId);
      if (pending !== undefined && pending !== elem.value) {
        props.onSetParam(elem.paramId, pending);
      }
    }
  }

  function handleRevertAll() {
    for (const elem of props.array.elements) {
      if (props.pendingEdits.has(elem.paramId)) {
        props.onLocalChange(elem.paramId, null);
      }
    }
  }

  return (
    <div class="h-full flex flex-col" style={{ 'background-color': 'var(--bg-primary)' }}>
      {/* Header */}
      <div class="flex-shrink-0 p-4 border-b" style={{ 'border-color': 'var(--border)' }}>
        <h2 class="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          {fieldName()}
        </h2>
        <Show when={displayDescription()}>
          <p class="text-sm mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {displayDescription()}
          </p>
        </Show>

        {/* Array-level value comparison */}
        <div class="mt-2 font-mono text-sm flex flex-wrap items-center gap-x-1">
          <Show when={hasPendingEdits()} fallback={
            <span style={{ color: 'var(--text-primary)' }}>
              {formatArrayValues(props.array.elements, props.pendingEdits, false)}
            </span>
          }>
            <span style={{ color: 'var(--text-primary)' }}>
              {formatArrayValues(props.array.elements, props.pendingEdits, false)}
            </span>
            <span class="mx-1" style={{ color: 'var(--text-secondary)' }}>{'\u2192'}</span>
            <span style={{ color: 'var(--accent)' }}>
              {formatArrayValues(props.array.elements, props.pendingEdits, true)}
            </span>
          </Show>
        </div>

        <Show when={props.array.unit}>
          <span class="text-xs mt-1 inline-block" style={{ color: 'var(--text-secondary)' }}>
            Unit: {props.array.unit}
          </span>
        </Show>
      </div>

      {/* Scrollable element list */}
      <div class="flex-1 overflow-y-auto p-4 space-y-2">
        <For each={props.array.elements}>
          {(elem: ParamWithMeta) => {
            const index = () => elem.meta?.arrayInfo?.index ?? props.array.elements.indexOf(elem);
            const pendingValue = () => props.pendingEdits.get(elem.paramId);
            const currentValue = () => pendingValue() ?? elem.value;
            const isModified = () => {
              const pv = pendingValue();
              return pv !== undefined && pv !== elem.value;
            };
            const flash = () => flashMap().get(elem.paramId);

            const flashBg = () => {
              const f = flash();
              if (f === 'success') return 'color-mix(in srgb, var(--accent-green) 15%, transparent)';
              if (f === 'error') return 'color-mix(in srgb, var(--accent-red) 15%, transparent)';
              return 'transparent';
            };

            return (
              <div
                class="rounded-lg p-3 transition-colors"
                style={{
                  'background-color': flashBg() !== 'transparent' ? flashBg() : 'var(--bg-hover)',
                  border: isModified() ? '1px solid var(--accent)' : '1px solid var(--border)',
                }}
              >
                <div class="flex items-center gap-3">
                  {/* Index label */}
                  <span
                    class="text-xs font-mono font-semibold flex-shrink-0 w-8 text-center"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    [{index()}]
                  </span>

                  {/* Slider or number input */}
                  <Show when={elem.meta && elem.meta.min !== undefined && elem.meta.max !== undefined} fallback={
                    <input
                      type="number"
                      prop:value={formatValue(currentValue(), elem.meta?.decimal)}
                      onChange={(e) => {
                        const v = Number(e.currentTarget.value);
                        if (!isNaN(v)) props.onLocalChange(elem.paramId, v);
                      }}
                      class="flex-1 px-2 py-1 rounded text-sm font-mono"
                      style={{
                        'background-color': 'var(--bg-panel)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                      }}
                    />
                  }>
                    <ElementSlider
                      meta={elem.meta!}
                      value={currentValue()}
                      onChange={(v) => props.onLocalChange(elem.paramId, v)}
                    />
                  </Show>

                  {/* Pending indicator */}
                  <Show when={isModified()}>
                    <div class="flex items-center gap-1 flex-shrink-0">
                      <span class="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                        {formatValue(elem.value, elem.meta?.decimal)}
                      </span>
                      <span style={{ color: 'var(--text-secondary)' }}>{'\u2192'}</span>
                      <span class="text-xs font-mono font-semibold" style={{ color: 'var(--accent)' }}>
                        {formatValue(currentValue(), elem.meta?.decimal)}
                      </span>
                    </div>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>

      {/* Footer with Save All / Revert All */}
      <div
        class="flex-shrink-0 p-4 border-t flex items-center gap-3"
        style={{ 'border-color': 'var(--border)', 'background-color': 'var(--bg-panel)' }}
      >
        <button
          onClick={handleSaveAll}
          disabled={!hasPendingEdits()}
          class="px-4 py-2 rounded text-sm font-medium transition-colors"
          style={{
            'background-color': hasPendingEdits() ? 'var(--accent)' : 'var(--bg-hover)',
            color: hasPendingEdits() ? '#000' : 'var(--text-secondary)',
            opacity: hasPendingEdits() ? '1' : '0.5',
            cursor: hasPendingEdits() ? 'pointer' : 'not-allowed',
          }}
        >
          Save All
        </button>
        <Show when={hasPendingEdits()}>
          <button
            onClick={handleRevertAll}
            class="px-4 py-2 rounded text-sm font-medium transition-colors"
            style={{
              'background-color': 'var(--bg-hover)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              cursor: 'pointer',
            }}
          >
            Revert All
          </button>
        </Show>
      </div>
    </div>
  );
}

function ElementSlider(props: { meta: ParamDef; value: number; onChange: (v: number) => void }) {
  const step = () =>
    props.meta.type === 'Integer'
      ? 1
      : props.meta.decimal !== undefined
        ? Math.pow(10, -props.meta.decimal)
        : 0.01;

  return (
    <div class="flex items-center gap-2 flex-1 min-w-0">
      <span class="text-xs font-mono flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
        {props.meta.min}
      </span>
      <input
        type="range"
        min={props.meta.min}
        max={props.meta.max}
        step={step()}
        prop:value={props.value}
        onInput={(e) => props.onChange(Number(e.currentTarget.value))}
        class="flex-1 custom-slider min-w-0"
      />
      <span class="text-xs font-mono flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
        {props.meta.max}
      </span>
      <input
        type="number"
        min={props.meta.min}
        max={props.meta.max}
        step={step()}
        prop:value={formatValue(props.value, props.meta.decimal)}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (!isNaN(v)) props.onChange(v);
        }}
        class="w-20 px-2 py-1 rounded text-center text-xs font-mono flex-shrink-0"
        style={{
          'background-color': 'var(--bg-panel)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
        }}
      />
    </div>
  );
}
