import { Show } from 'solid-js';
import type { ParamWithMeta } from '../hooks/use-parameters';

interface ParameterRowProps {
  param: ParamWithMeta;
  selected: boolean;
  modified: boolean;
  pendingValue: number | null;
  onClick: () => void;
}

export default function ParameterRow(props: ParameterRowProps) {
  const fieldName = () => {
    const key = props.param.meta?.config_key;
    if (!key) return props.param.paramId;
    const dotIdx = key.indexOf('.');
    return dotIdx >= 0 ? key.substring(dotIdx + 1) : key;
  };

  const meta = () => props.param.meta;

  const formatVal = (val: number) => {
    const m = meta();
    if (!m) return String(val);
    if (m.type === 'Boolean') return val === 0 ? 'OFF' : 'ON';
    if (m.type === 'Discrete' && m.values) return m.values[String(val)] ?? String(val);
    if (m.decimal !== undefined) return val.toFixed(m.decimal);
    return String(val);
  };

  const unit = () => {
    const m = meta();
    if (!m) return '';
    if (m.type === 'Boolean' || m.type === 'Discrete') return '';
    if (m.unit === 'norm') return '';
    return m.unit ?? '';
  };

  const hasPending = () => props.pendingValue !== null && props.pendingValue !== props.param.value;

  return (
    <div
      onClick={() => props.onClick()}
      class="flex items-center px-4 py-2.5 cursor-pointer transition-colors"
      style={{
        'background-color': props.selected ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
        'border-left': props.selected ? '2px solid var(--accent)' : '2px solid transparent',
      }}
    >
      {/* Modified dot */}
      <Show when={props.modified} fallback={<div class="w-1.5 mr-2" />}>
        <div
          class="w-1.5 h-1.5 rounded-full mr-2 flex-shrink-0"
          style={{ 'background-color': 'var(--accent)' }}
        />
      </Show>

      {/* Field name */}
      <span class="flex-1 text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
        {fieldName()}
      </span>

      {/* Value display */}
      <Show when={hasPending()} fallback={
        <span class="text-sm font-mono ml-2 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>
          {formatVal(props.param.value)}
        </span>
      }>
        <span class="text-sm font-mono ml-2 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>
          {formatVal(props.param.value)}
        </span>
        <span class="text-xs mx-1 flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>{'\u2192'}</span>
        <span class="text-sm font-mono flex-shrink-0" style={{ color: 'var(--accent)' }}>
          {formatVal(props.pendingValue!)}
        </span>
      </Show>

      {/* Unit */}
      <Show when={unit()}>
        <span class="text-xs ml-1.5 w-10 flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
          {unit()}
        </span>
      </Show>

      {/* Reboot badge */}
      <Show when={meta()?.reboot_required}>
        <span class="text-xs ml-1 flex-shrink-0" style={{ color: 'var(--accent-yellow, #f59e0b)' }}>
          {'\u26A0'}
        </span>
      </Show>
    </div>
  );
}
