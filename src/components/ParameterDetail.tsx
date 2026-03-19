import { createSignal, createEffect, Show, For } from 'solid-js';
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
    setTimeout(() => setFlashState('none'), 2000);
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

  const flashBg = () => {
    switch (flashState()) {
      case 'success': return 'color-mix(in srgb, var(--accent-green) 10%, transparent)';
      case 'warning': return 'color-mix(in srgb, var(--accent-yellow, #f59e0b) 10%, transparent)';
      case 'error': return 'color-mix(in srgb, var(--accent-red) 10%, transparent)';
      default: return 'transparent';
    }
  };

  return (
    <div
      class="h-full overflow-y-auto p-6 transition-colors"
      style={{ 'background-color': flashBg() }}
    >
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
              <span class="text-xs uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Value</span>
              <span class="text-lg font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>
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
            <span class="text-lg font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>
              {formatDisplayValue(props.param.value, meta())}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>{'\u2192'}</span>
            <span class="text-lg font-mono font-semibold" style={{ color: 'var(--accent)' }}>
              {formatDisplayValue(currentValue(), meta())}
            </span>
            <Show when={!isDiscreteLike(meta()) && meta()?.units && meta()!.units !== 'norm'}>
              <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>{meta()!.units}</span>
            </Show>
          </Show>
        </div>

        <EditControl param={props.param} value={currentValue()} onChange={handleLocalChange} />
      </div>

      {/* Actions */}
      <div class="mt-6 flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={!isModified()}
          class="px-4 py-2 rounded text-sm font-medium transition-colors"
          style={{
            'background-color': isModified() ? 'var(--accent)' : 'var(--bg-hover)',
            color: isModified() ? '#000' : 'var(--text-secondary)',
            opacity: isModified() ? '1' : '0.5',
            cursor: isModified() ? 'pointer' : 'not-allowed',
          }}
        >
          Save
        </button>
        <Show when={isModified()}>
          <button
            onClick={handleRevert}
            class="px-4 py-2 rounded text-sm font-medium transition-colors"
            style={{
              'background-color': 'var(--bg-hover)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              cursor: 'pointer',
            }}
          >
            Revert
          </button>
        </Show>
        <Show when={meta() && !isAtDefault(currentValue(), meta()!)}>
          <button
            onClick={() => handleLocalChange(meta()!.default)}
            class="px-4 py-2 rounded text-sm font-medium transition-colors"
            style={{
              'background-color': 'var(--bg-hover)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              cursor: 'pointer',
            }}
          >
            Reset to Default
          </button>
        </Show>
      </div>

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
  return (
    <div class="flex items-center gap-3">
      <button
        onClick={() => props.onChange(0)}
        class="flex-1 py-4 rounded-lg text-sm font-medium transition-colors"
        style={{
          'min-height': '48px',
          'background-color': props.value === 0 ? 'var(--accent)' : 'var(--bg-panel)',
          color: props.value === 0 ? '#000' : 'var(--text-secondary)',
          border: `2px solid ${props.value === 0 ? 'var(--accent)' : 'var(--border)'}`,
        }}
      >
        OFF
      </button>
      <button
        onClick={() => props.onChange(1)}
        class="flex-1 py-4 rounded-lg text-sm font-medium transition-colors"
        style={{
          'min-height': '48px',
          'background-color': props.value === 1 ? 'var(--accent)' : 'var(--bg-panel)',
          color: props.value === 1 ? '#000' : 'var(--text-secondary)',
          border: `2px solid ${props.value === 1 ? 'var(--accent)' : 'var(--border)'}`,
        }}
      >
        ON
      </button>
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
            class="px-5 py-4 rounded-lg text-sm font-medium transition-colors"
            style={{
              'min-height': '48px',
              'background-color': props.value === opt.value ? 'var(--accent)' : 'var(--bg-panel)',
              color: props.value === opt.value ? '#000' : 'var(--text-secondary)',
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
          if (!isNaN(v)) props.onChange(v);
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
