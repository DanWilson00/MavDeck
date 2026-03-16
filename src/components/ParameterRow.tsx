import { createSignal, Show, createEffect } from 'solid-js';
import type { ParamWithMeta } from '../hooks/use-parameters';
import type { ParamSetResult } from '../services/parameter-types';

interface ParameterRowProps {
  param: ParamWithMeta;
  onSetParam: (paramId: string, value: number) => void;
  lastSetResult: ParamSetResult | null;
}

export default function ParameterRow(props: ParameterRowProps) {
  const [localValue, setLocalValue] = createSignal<number | null>(null);
  const [flashState, setFlashState] = createSignal<'none' | 'success' | 'warning' | 'error'>('none');

  // Field name: remove config_key prefix
  const fieldName = () => {
    const key = props.param.meta?.config_key;
    if (!key) return props.param.paramId;
    const dotIdx = key.indexOf('.');
    return dotIdx >= 0 ? key.substring(dotIdx + 1) : key;
  };

  const description = () => props.param.meta?.description ?? '';
  const isModified = () => localValue() !== null && localValue() !== props.param.value;

  // Watch for set results matching this param
  createEffect(() => {
    const result = props.lastSetResult;
    if (!result || result.paramId !== props.param.paramId) return;
    if (result.success) {
      setFlashState('success');
      setLocalValue(null);  // Clear local edit
    } else if (result.error) {
      setFlashState('error');
    } else {
      setFlashState('warning');
    }
    setTimeout(() => setFlashState('none'), 2000);
  });

  // Reset local value when device value changes
  createEffect(() => {
    const _ = props.param.value;
    setLocalValue(null);
  });

  function handleSave() {
    const val = localValue();
    if (val === null) return;
    props.onSetParam(props.param.paramId, val);
  }

  function handleResetDefault() {
    if (!props.param.meta) return;
    props.onSetParam(props.param.paramId, props.param.meta.default);
  }

  const currentValue = () => localValue() ?? props.param.value;
  const meta = () => props.param.meta;

  // Flash background color
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
      class="px-4 py-3 transition-colors"
      style={{ 'background-color': flashBg() }}
    >
      {/* Line 1: Name, description, badges */}
      <div class="flex items-center gap-2 mb-1.5">
        <span class="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {fieldName()}
        </span>
        <Show when={description()}>
          <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {'\u00B7'} {description()}
          </span>
        </Show>
        <Show when={meta()?.reboot_required}>
          <span
            class="text-xs px-1.5 py-0.5 rounded"
            style={{
              'background-color': 'color-mix(in srgb, var(--accent-yellow, #f59e0b) 20%, transparent)',
              color: 'var(--accent-yellow, #f59e0b)',
            }}
          >
            Reboot required
          </span>
        </Show>
        <Show when={meta()?.volatile}>
          <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>volatile</span>
        </Show>
      </div>

      {/* Line 2: Control */}
      <div class="flex items-center gap-3">
        <div class="flex-1">
          {renderControl(props.param, currentValue(), (v) => setLocalValue(v))}
        </div>

        {/* Value display + unit */}
        <Show when={meta()?.type !== 'Boolean' && meta()?.type !== 'Discrete'}>
          <span class="text-sm font-mono w-20 text-right" style={{ color: 'var(--text-primary)' }}>
            {formatValue(currentValue(), meta()?.decimal)}
          </span>
          <Show when={meta()?.unit}>
            <span class="text-xs w-10" style={{ color: 'var(--text-secondary)' }}>
              {meta()!.unit}
            </span>
          </Show>
        </Show>

        {/* Default reset */}
        <Show when={meta()}>
          <button
            onClick={handleResetDefault}
            class="text-xs transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            title={`Reset to default: ${meta()!.default}`}
          >
            {'\u21BA'} {formatValue(meta()!.default, meta()?.decimal)}
          </button>
        </Show>

        {/* Save button */}
        <Show when={isModified()}>
          <button
            onClick={handleSave}
            class="px-2 py-0.5 rounded text-xs font-medium transition-colors"
            style={{ 'background-color': 'var(--accent)', color: '#000' }}
          >
            Save
          </button>
        </Show>
      </div>
    </div>
  );
}

function formatValue(value: number, decimal?: number): string {
  if (decimal !== undefined) return value.toFixed(decimal);
  return String(value);
}

function renderControl(
  param: ParamWithMeta,
  value: number,
  onChange: (v: number) => void,
) {
  const meta = param.meta;

  // Boolean: segmented toggle
  if (meta?.type === 'Boolean') {
    return (
      <div class="flex items-center gap-1">
        <button
          onClick={() => onChange(0)}
          class="px-3 py-1 rounded-l text-xs font-medium transition-colors"
          style={{
            'background-color': value === 0 ? 'var(--accent)' : 'var(--bg-hover)',
            color: value === 0 ? '#000' : 'var(--text-secondary)',
          }}
        >
          OFF
        </button>
        <button
          onClick={() => onChange(1)}
          class="px-3 py-1 rounded-r text-xs font-medium transition-colors"
          style={{
            'background-color': value === 1 ? 'var(--accent)' : 'var(--bg-hover)',
            color: value === 1 ? '#000' : 'var(--text-secondary)',
          }}
        >
          ON
        </button>
      </div>
    );
  }

  // Discrete: dropdown
  if (meta?.type === 'Discrete' && meta.values) {
    return (
      <select
        value={String(value)}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        class="px-2 py-1 rounded text-sm"
        style={{
          'background-color': 'var(--bg-hover)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
        }}
      >
        {Object.entries(meta.values).map(([val, label]) => (
          <option value={val}>{label}</option>
        ))}
      </select>
    );
  }

  // Float/Integer: range slider + number input
  if (meta) {
    const step = meta.type === 'Integer' ? 1 : (meta.decimal !== undefined ? Math.pow(10, -meta.decimal) : 0.01);
    return (
      <div class="flex items-center gap-2 w-full">
        <span class="text-xs w-10 text-right" style={{ color: 'var(--text-secondary)' }}>
          {meta.min}
        </span>
        <input
          type="range"
          min={meta.min}
          max={meta.max}
          step={step}
          value={value}
          onInput={(e) => onChange(Number(e.currentTarget.value))}
          class="flex-1 accent-current"
          style={{ color: 'var(--accent)' }}
        />
        <span class="text-xs w-10" style={{ color: 'var(--text-secondary)' }}>
          {meta.max}
        </span>
        <input
          type="number"
          min={meta.min}
          max={meta.max}
          step={step}
          value={formatValue(value, meta.decimal)}
          onChange={(e) => {
            const v = Number(e.currentTarget.value);
            if (!isNaN(v)) onChange(v);
          }}
          class="w-20 px-1 py-0.5 rounded text-sm text-right font-mono"
          style={{
            'background-color': 'var(--bg-hover)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
          }}
        />
      </div>
    );
  }

  // No metadata: plain number input
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => {
        const v = Number(e.currentTarget.value);
        if (!isNaN(v)) onChange(v);
      }}
      class="w-32 px-2 py-1 rounded text-sm font-mono"
      style={{
        'background-color': 'var(--bg-hover)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border)',
      }}
    />
  );
}
