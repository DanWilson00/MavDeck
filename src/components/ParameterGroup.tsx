import { createSignal, For } from 'solid-js';
import type { ParamGroup } from '../hooks/use-parameters';
import type { ParamSetResult } from '../services/parameter-types';
import ParameterRow from './ParameterRow';

interface ParameterGroupProps {
  group: ParamGroup;
  onSetParam: (paramId: string, value: number) => void;
  lastSetResult: ParamSetResult | null;
}

export default function ParameterGroup(props: ParameterGroupProps) {
  const [expanded, setExpanded] = createSignal(true);

  return (
    <div
      class="rounded-lg overflow-hidden"
      style={{ 'background-color': 'var(--bg-panel)', border: '1px solid var(--border)' }}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded())}
        class="w-full flex items-center gap-2 px-4 py-2 text-left transition-colors"
        style={{ 'background-color': 'var(--bg-hover)' }}
      >
        <svg
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2"
          style={{
            color: 'var(--text-secondary)',
            transform: expanded() ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span class="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {props.group.name}
        </span>
        <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>
          ({props.group.params.length})
        </span>
      </button>

      {/* Parameters */}
      {expanded() && (
        <div class="divide-y" style={{ 'border-color': 'var(--border)' }}>
          <For each={props.group.params}>
            {(param) => (
              <ParameterRow
                param={param}
                onSetParam={props.onSetParam}
                lastSetResult={props.lastSetResult}
              />
            )}
          </For>
        </div>
      )}
    </div>
  );
}
