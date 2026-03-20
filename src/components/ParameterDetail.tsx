import { createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import type { ParamWithMeta } from '../hooks/use-parameters';
import type { ParamSetResult } from '../services/parameter-types';
import type { ParamDef } from '../models/parameter-metadata';
import { getParameterDisplayName, formatDefaultValue, isAtDefault, formatValue } from '../services/parameter-display';

interface ParameterDetailProps {
  param: ParamWithMeta;
  onSetParam: (paramId: string, value: number) => void;
  lastSetResult: ParamSetResult | null;
  pendingValue: number | null;
  onLocalChange: (value: number | null) => void;
}

/** True for Boolean/Discrete — labels are self-describing, skip unit display */
function isDiscreteLike(meta: ParamDef | null): boolean {
  return meta?.type === 'Boolean' || meta?.type === 'Discrete';
}

/** Format a value with labels for Boolean/Discrete, toFixed for numeric */
function formatDisplayValue(value: number, meta: ParamDef | null): string {
  if (!meta) return String(value);
  if (meta.type === 'Boolean') return value === 0 ? 'OFF' : 'ON';
  if (meta.type === 'Discrete' && meta.values) return meta.values?.find(v => v.value === value)?.description ?? String(value);
  if (meta.decimalPlaces !== undefined) return value.toFixed(meta.decimalPlaces);
  return String(value);
}

export default function ParameterDetail(props: ParameterDetailProps) {
  const [flashState, setFlashState] = createSignal<'none' | 'success' | 'warning' | 'error'>('none');
  const [flashKey, setFlashKey] = createSignal(0);
  let editBoxRef: HTMLDivElement | undefined;

  const fieldName = () => {
    return getParameterDisplayName(props.param.meta, props.param.paramId);
  };

  const meta = () => props.param.meta;
  const displayDescription = () => {
    const long = meta()?.longDesc ?? '';
    return long || '';
  };
  const currentValue = () => props.pendingValue ?? props.param.value;
  const isModified = () => props.pendingValue !== null && props.pendingValue !== props.param.value;

  // Watch for set results matching this param
  let flashTimeout: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(flashTimeout));

  createEffect(() => {
    const result = props.lastSetResult;
    if (!result || result.paramId !== props.param.paramId) return;
    if (result.success) {
      setFlashState('success');
    } else if (result.error) {
      setFlashState('error');
    } else {
      setFlashState('warning');
    }
    setFlashKey(k => k + 1);
    clearTimeout(flashTimeout);
    flashTimeout = setTimeout(() => setFlashState('none'), 2000);
  });

  // Apply glow animation class to the edit control box
  createEffect(() => {
    const state = flashState();
    // Track flashKey to restart animation on consecutive writes
    flashKey();
    if (!editBoxRef) return;
    editBoxRef.classList.remove('param-glow-success', 'param-glow-error', 'param-glow-warning');
    if (state === 'none') return;
    // Force reflow to restart animation
    void editBoxRef.offsetWidth;
    editBoxRef.classList.add(`param-glow-${state}`);
  });

  function handleSave() {
    const val = props.pendingValue;
    if (val === null) return;
    props.onSetParam(props.param.paramId, val);
  }

  function handleRevert() {
    props.onLocalChange(null);
  }

  function handleLocalChange(v: number) {
    props.onLocalChange(v);
  }

  const statusToast = () => {
    switch (flashState()) {
      case 'success': return { icon: '\u2713', text: 'Confirmed', color: 'var(--accent-green)' };
      case 'error': return { icon: '\u2717', text: 'Write failed', color: 'var(--accent-red)' };
      case 'warning': return { icon: '\u26A0', text: 'Timeout \u2014 verify value', color: 'var(--accent-yellow)' };
      default: return null;
    }
  };

  return (
    <div class="h-full overflow-y-auto p-5">
      {/* Header */}
      <h2 class="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
        {fieldName()}
      </h2>
      <Show when={displayDescription()}>
        <p class="text-sm mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {displayDescription()}
        </p>
      </Show>

      {/* Metadata pills */}
      <div class="flex flex-wrap gap-2 mt-2">
        <Show when={meta() && meta()!.type !== 'Boolean' && meta()!.type !== 'Discrete'}>
          <span class="px-2 py-0.5 rounded text-xs" style={{ 'background-color': 'var(--chip-bg)', color: 'var(--text-secondary)' }}>
            {meta()!.min} — {meta()!.max}{meta()!.units && meta()!.units !== 'norm' ? ` ${meta()!.units}` : ''}
          </span>
        </Show>
        <Show when={meta()}>
          <span class="px-2 py-0.5 rounded text-xs" style={{ 'background-color': 'var(--chip-bg)', color: 'var(--text-secondary)' }}>
            default: {formatDefaultValue(meta()!)}
          </span>
        </Show>
      </div>

      {/* Edit control with value comparison header */}
      <div
        ref={editBoxRef}
        class="mt-5 p-4 rounded-lg transition-all"
        style={{
          'background-color': 'var(--bg-hover)',
          border: isModified() ? '1px solid var(--accent)' : '1px solid var(--border)',
          'box-shadow': isModified() ? '0 0 8px color-mix(in srgb, var(--accent) 25%, transparent)' : 'none',
        }}
      >
        {/* Value comparison line */}
        <div class="flex items-baseline gap-2 mb-3">
          <Show when={isModified()} fallback={
            <>
              <span class="text-xs uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Current Value</span>
              <span class="text-xl font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>
                {formatDisplayValue(props.param.value, meta())}
              </span>
              <Show when={!isDiscreteLike(meta()) && meta()?.units && meta()!.units !== 'norm'}>
                <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>{meta()!.units}</span>
              </Show>
              <Show when={meta() && isAtDefault(props.param.value, meta()!)}>
                <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>(default)</span>
              </Show>
            </>
          }>
            <span class="text-xs uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>On vehicle</span>
            <span class="text-xl font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>
              {formatDisplayValue(props.param.value, meta())}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>{'\u2192'}</span>
            <span class="text-xl font-mono font-semibold" style={{ color: 'var(--accent)' }}>
              {formatDisplayValue(currentValue(), meta())}
            </span>
            <Show when={!isDiscreteLike(meta()) && meta()?.units && meta()!.units !== 'norm'}>
              <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>{meta()!.units}</span>
            </Show>
          </Show>
        </div>

        <EditControl param={props.param} value={currentValue()} onChange={handleLocalChange} />

        {/* Actions — inside the edit card */}
        <div class="mt-3 flex items-center gap-2">
          <div class="flex gap-2 mr-auto">
            <Show when={meta() && !isAtDefault(currentValue(), meta()!)}>
              <button
                onClick={() => handleLocalChange(meta()!.default)}
                class="px-3 py-1.5 rounded text-xs font-medium transition-colors"
                style={{
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >
                Restore Default
              </button>
            </Show>
            <Show when={isModified()}>
              <button
                onClick={handleRevert}
                class="px-3 py-1.5 rounded text-xs font-medium transition-colors"
                style={{
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >
                Revert
              </button>
            </Show>
          </div>
          <button
            onClick={handleSave}
            disabled={!isModified()}
            class="px-3 py-1.5 rounded text-xs font-medium transition-colors"
            style={{
              'background-color': isModified() ? 'var(--accent)' : 'transparent',
              color: isModified() ? 'var(--accent-text)' : 'var(--text-secondary)',
              border: isModified() ? '1px solid var(--accent)' : '1px solid var(--border)',
              opacity: isModified() ? '1' : '0.5',
              cursor: isModified() ? 'pointer' : 'not-allowed',
            }}
          >
            Save
          </button>
        </div>
      </div>

      {/* Status toast — keyed by flashKey to restart animation on consecutive writes */}
      <Show when={statusToast()} keyed>
        {(toast) => (
          <div
            class="mt-2 flex items-center gap-1.5 text-sm font-medium param-status-toast"
            style={{ color: toast.color }}
          >
            <span>{toast.icon}</span>
            <span>{toast.text}</span>
          </div>
        )}
      </Show>

      {/* Badges */}
      <Show when={meta()?.rebootRequired}>
        <div
          class="mt-4 flex items-center gap-2 px-3 py-2 rounded text-sm"
          style={{
            'background-color': 'color-mix(in srgb, var(--accent-yellow, #f59e0b) 10%, transparent)',
            color: 'var(--accent-yellow, #f59e0b)',
          }}
        >
          <span>{'\u26A0'}</span>
          <span>Changing this parameter requires a reboot to take effect</span>
        </div>
      </Show>
    </div>
  );
}


interface EditControlProps {
  param: ParamWithMeta;
  value: number;
  onChange: (v: number) => void;
}

function EditControl(props: EditControlProps) {
  const meta = () => props.param.meta;

  return (
    <Show when={meta()} fallback={
      <input
        type="number"
        prop:value={props.value}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (!isNaN(v)) props.onChange(v);
        }}
        class="w-32 px-3 py-2 rounded text-sm font-mono"
        style={{
          'background-color': 'var(--bg-panel)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
        }}
      />
    }>
      {(m) => (
        <Show when={m().type === 'Boolean'} fallback={
          <Show when={m().type === 'Discrete' && m().values} fallback={
            <SliderControl meta={m()} value={props.value} onChange={props.onChange} />
          }>
            <DiscreteControl meta={m()} value={props.value} onChange={props.onChange} />
          </Show>
        }>
          <BooleanControl value={props.value} onChange={props.onChange} />
        </Show>
      )}
    </Show>
  );
}

function BooleanControl(props: { value: number; onChange: (v: number) => void }) {
  const isOn = () => props.value !== 0;
  return (
    <div class="flex items-center gap-3">
      <button
        onClick={() => props.onChange(isOn() ? 0 : 1)}
        class="relative inline-flex items-center rounded-full transition-colors"
        style={{
          width: '80px',
          height: '42px',
          'background-color': isOn() ? 'var(--accent)' : 'var(--bg-hover)',
          border: `2px solid ${isOn() ? 'var(--accent)' : 'var(--border)'}`,
          cursor: 'pointer',
          'flex-shrink': '0',
        }}
      >
        <span
          class="inline-block rounded-full transition-transform"
          style={{
            width: '34px',
            height: '34px',
            'background-color': isOn() ? 'var(--accent-text)' : 'var(--text-secondary)',
            transform: isOn() ? 'translateX(40px)' : 'translateX(2px)',
          }}
        />
      </button>
      <span
        class="text-sm font-medium"
        style={{ color: isOn() ? 'var(--accent)' : 'var(--text-secondary)' }}
      >
        {isOn() ? 'ON' : 'OFF'}
      </span>
    </div>
  );
}

function DiscreteControl(props: { meta: ParamDef; value: number; onChange: (v: number) => void }) {
  const entries = () => props.meta.values ?? [];
  return (
    <div class="flex flex-wrap items-center gap-3">
      <For each={entries()}>
        {(opt) => (
          <button
            onClick={() => props.onChange(opt.value)}
            class="px-4 py-3 rounded-lg text-sm font-medium transition-colors"
            style={{
              'min-height': '44px',
              'background-color': props.value === opt.value ? 'var(--accent)' : 'var(--bg-panel)',
              color: props.value === opt.value ? 'var(--accent-text)' : 'var(--text-secondary)',
              border: `2px solid ${props.value === opt.value ? 'var(--accent)' : 'var(--border)'}`,
            }}
          >
            {opt.description}
          </button>
        )}
      </For>
    </div>
  );
}

function SliderControl(props: { meta: ParamDef; value: number; onChange: (v: number) => void }) {
  const step = () => props.meta.type === 'Integer' ? 1 : (props.meta.decimalPlaces !== undefined ? Math.pow(10, -props.meta.decimalPlaces) : 0.01);
  const unitLabel = () => props.meta.units && props.meta.units !== 'norm' ? props.meta.units : '';
  const fillPercent = () => {
    const range = props.meta.max - props.meta.min;
    if (range === 0) return 0;
    return ((props.value - props.meta.min) / range) * 100;
  };

  return (
    <div class="flex items-center gap-3">
      <span class="text-xs font-mono flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>{props.meta.min}</span>
      <input
        type="range"
        min={props.meta.min}
        max={props.meta.max}
        step={step()}
        prop:value={props.value}
        onInput={(e) => props.onChange(Number(e.currentTarget.value))}
        class="flex-1 custom-slider"
        style={{
          '--fill': `${fillPercent()}%`,
        }}
      />
      <span class="text-xs font-mono flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>{props.meta.max}</span>
      <input
        type="number"
        min={props.meta.min}
        max={props.meta.max}
        step={step()}
        prop:value={formatValue(props.value, props.meta.decimalPlaces)}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (!isNaN(v)) props.onChange(Math.max(props.meta.min, Math.min(props.meta.max, v)));
        }}
        class="w-24 px-2 py-1.5 rounded text-center text-sm font-mono flex-shrink-0"
        style={{
          'background-color': 'var(--bg-panel)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
        }}
      />
      <Show when={unitLabel()}>
        <span class="text-xs flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>{unitLabel()}</span>
      </Show>
    </div>
  );
}
