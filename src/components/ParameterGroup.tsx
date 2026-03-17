import { For, Show } from 'solid-js';
import type { ParamGroup } from '../hooks/use-parameters';
import ParameterRow from './ParameterRow';

interface ParameterGroupProps {
  group: ParamGroup;
  selectedParamId: string | null;
  selectedArrayPrefix: string | null;
  modifiedParamIds: Set<string>;
  pendingEdits: Map<string, number>;
  expanded: boolean;
  onToggle: () => void;
  onSelectParam: (paramId: string) => void;
  onSelectArray: (prefix: string) => void;
}

export default function ParameterGroup(props: ParameterGroupProps) {
  return (
    <div class="mt-0.5">
      {/* Group header */}
      <button
        onClick={() => props.onToggle()}
        class="w-full flex items-center gap-2 px-4 py-1.5 text-left transition-colors"
        style={{ 'background-color': 'var(--bg-hover)' }}
      >
        <svg
          width="10" height="10" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5"
          style={{
            color: 'var(--text-secondary)',
            transform: props.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span class="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
          {props.group.name}
        </span>
        <span class="text-sm" style={{ color: 'var(--text-secondary)' }}>
          ({props.group.params.length + props.group.arrays.reduce((sum, a) => sum + a.elements.length, 0)})
        </span>
      </button>

      {/* Parameter rows */}
      <Show when={props.expanded}>
        <For each={props.group.params}>
          {(param) => (
            <ParameterRow
              param={param}
              selected={props.selectedParamId === param.paramId}
              modified={props.modifiedParamIds.has(param.paramId)}
              pendingValue={props.pendingEdits.get(param.paramId) ?? null}
              onClick={() => props.onSelectParam(param.paramId)}
            />
          )}
        </For>
        <For each={props.group.arrays}>
          {(array) => {
            const isSelected = () => props.selectedArrayPrefix === array.prefix;
            const anyModified = () => array.elements.some(e => props.modifiedParamIds.has(e.paramId));
            const anyPending = () => array.elements.some(e => {
              const pv = props.pendingEdits.get(e.paramId);
              return pv !== undefined && pv !== e.value;
            });

            const formatElemVal = (val: number, idx: number) => {
              const m = array.elements[idx]?.meta;
              if (m?.decimal !== undefined) return val.toFixed(m.decimal);
              return String(val);
            };

            const currentVals = () =>
              '[' + array.elements.map((e, i) => formatElemVal(e.value, i)).join(', ') + ']';

            const pendingVals = () =>
              '[' + array.elements.map((e, i) => {
                const pv = props.pendingEdits.get(e.paramId);
                return formatElemVal(pv ?? e.value, i);
              }).join(', ') + ']';

            const fieldName = () => {
              const key = array.elements[0]?.meta?.config_key;
              if (!key) return array.description;
              const dotIdx = key.indexOf('.');
              return dotIdx >= 0 ? key.substring(dotIdx + 1) : key;
            };

            return (
              <div
                onClick={() => props.onSelectArray(array.prefix)}
                class="flex items-center px-4 py-2.5 cursor-pointer transition-colors"
                style={{
                  'background-color': isSelected() ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
                  'border-left': isSelected() ? '2px solid var(--accent)' : '2px solid transparent',
                }}
              >
                {/* Modified dot */}
                <Show when={anyModified()} fallback={<div class="w-1.5 mr-2" />}>
                  <div
                    class="w-1.5 h-1.5 rounded-full mr-2 flex-shrink-0"
                    style={{ 'background-color': 'var(--accent)' }}
                  />
                </Show>

                {/* Name from config_key */}
                <span class="flex-1 text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {fieldName()}
                </span>

                {/* Value display */}
                <Show when={anyPending()} fallback={
                  <span class="text-sm font-mono ml-2 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>
                    {currentVals()}
                  </span>
                }>
                  <span class="text-sm font-mono ml-2 flex-shrink-0" style={{ color: 'var(--text-primary)' }}>
                    {currentVals()}
                  </span>
                  <span class="text-xs mx-1 flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>{'\u2192'}</span>
                  <span class="text-sm font-mono flex-shrink-0" style={{ color: 'var(--accent)' }}>
                    {pendingVals()}
                  </span>
                </Show>

                {/* Unit */}
                <Show when={array.unit}>
                  <span class="text-xs ml-1.5 w-10 flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
                    {array.unit}
                  </span>
                </Show>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
