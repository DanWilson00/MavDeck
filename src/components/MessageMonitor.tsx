import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { appState } from '../store';
import {
  convertDisplayArray,
  convertDisplayValue,
  formatDisplayValue,
  getDisplayUnit,
  useRegistry,
  useWorkerBridge,
  type MessageStats,
} from '../services';
import type { MavlinkFieldMetadata } from '../mavlink/metadata';
import { formatAutopilotVersionField } from '../services/autopilot-version-format';
import StatusTextLog from './StatusTextLog';
import { toggleSetItem } from './hooks';

interface MessageMonitorProps {
  onFieldSelected?: (messageName: string, fieldName: string) => void;
  activeSignals?: Map<string, string>;
}

export default function MessageMonitor(props: MessageMonitorProps) {
  const registry = useRegistry();
  const workerBridge = useWorkerBridge();
  const [messageStats, setMessageStats] = createSignal<Map<string, MessageStats>>(new Map());
  const [expandedMessages, setExpandedMessages] = createSignal<Set<string>>(new Set());
  const [knownMessageNames, setKnownMessageNames] = createSignal<string[]>([]);

  // Subscribe to stats from worker bridge
  createEffect(() => {
    if (!appState.isReady) return;
    const unsub = workerBridge.onStats(stats => {
      setMessageStats(stats);
      // Only update the name list when new message types appear
      const incoming = [...stats.keys()].sort();
      const known = knownMessageNames();
      if (incoming.length !== known.length || incoming.some((n, i) => n !== known[i])) {
        setKnownMessageNames(incoming);
      }
    });
    onCleanup(unsub);
  });

  function toggleExpanded(name: string) {
    toggleSetItem(setExpandedMessages, name);
  }

  function formatValue(value: number | string | number[], field: MavlinkFieldMetadata, messageName: string): string {
    // AUTOPILOT_VERSION special formatting
    if (messageName === 'AUTOPILOT_VERSION') {
      const special = formatAutopilotVersionField(field.name, value);
      if (special !== null) return special;
    }
    // Enum resolution
    if (field.enumType && typeof value === 'number') {
      const resolved = registry.resolveEnumValue(field.enumType, value);
      if (resolved) return resolved;
    }
    // Float formatting
    if (typeof value === 'number') {
      const displayValue = convertDisplayValue(value, field.units, appState.unitProfile, { fieldName: field.name });
      const displayUnit = getDisplayUnit(field.units, appState.unitProfile, { fieldName: field.name });
      return formatDisplayValue(displayValue, displayUnit, 'monitor', { fieldName: field.name });
    }
    // Arrays
    if (Array.isArray(value)) {
      const displayValues = convertDisplayArray(value, field.units, appState.unitProfile, { fieldName: field.name });
      const displayUnit = getDisplayUnit(field.units, appState.unitProfile, { fieldName: field.name });
      return `[${displayValues.map(v => formatDisplayValue(v, displayUnit, 'monitor', { fieldName: field.name })).join(', ')}]`;
    }
    // Strings
    return String(value);
  }

  function isNumericField(value: unknown): boolean {
    return typeof value === 'number';
  }

  return (
    <div class="flex flex-col h-full" data-testid="message-monitor">
      {/* Message list */}
      <div class="flex-1 overflow-y-auto">
        <Show when={knownMessageNames().length === 0}>
          <div class="px-4 py-5 text-sm" style={{ color: 'var(--text-secondary)' }}>
            No telemetry yet.
          </div>
        </Show>
        <For each={knownMessageNames()}>
          {(name) => {
            const stats = () => messageStats().get(name);
            const meta = () => registry.getMessageByName(name);
            const isExpanded = () => expandedMessages().has(name);

            return (
              <div
                class="border-b"
                style={{ 'border-color': 'var(--border)' }}
                data-testid={`msg-${name}`}
              >
                {/* Collapsed header */}
                <button
                  class="flex items-center justify-between w-full px-3 py-2 text-left transition-colors interactive-hover"
                  style={{ 'background-color': 'transparent' }}
                  onClick={() => toggleExpanded(name)}
                >
                  <div class="flex items-center gap-2">
                    {/* Expand chevron */}
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      style={{
                        color: 'var(--text-secondary)',
                        transform: isExpanded() ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.15s',
                      }}
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <span
                      class="text-xs font-mono"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {name}
                    </span>
                  </div>
                  {/* Frequency badge */}
                  <span
                    class="text-xs px-1.5 py-0.5 rounded font-mono"
                    style={{
                      'background-color': 'color-mix(in srgb, var(--accent-green) 15%, transparent)',
                      color: 'var(--accent-green)',
                    }}
                  >
                    {stats()?.frequency.toFixed(1) ?? '0.0'} Hz
                  </span>
                </button>

                {/* Expanded fields */}
                <Show when={isExpanded() && meta()}>
                  <div class="px-3 pb-2">
                    <For each={meta()!.fields}>
                      {(field) => {
                        const value = () => stats()?.lastMessage.values[field.name];
                        const clickable = () => isNumericField(value()) && props.onFieldSelected;
                        const fieldKey = `${name}.${field.name}`;
                        const activeColor = () => props.activeSignals?.get(fieldKey);

                        return (
                          <button
                            type="button"
                            class="flex items-baseline justify-between py-0.5 text-xs w-full text-left rounded-r px-1 interactive-hover"
                            style={{
                              cursor: clickable() ? 'pointer' : 'default',
                              'border-left': activeColor()
                                ? `3px solid ${activeColor()}`
                                : '3px solid transparent',
                              'background-color': activeColor()
                                ? `color-mix(in srgb, ${activeColor()} 10%, transparent)`
                                : undefined,
                            }}
                            onClick={() => {
                              if (clickable()) {
                                props.onFieldSelected!(name, field.name);
                              }
                            }}
                            disabled={!clickable()}
                            aria-label={`Add ${name}.${field.name} to plot`}
                          >
                            <span
                              class="font-mono"
                              style={{ color: activeColor() || 'var(--text-secondary)' }}
                            >
                              {field.name}
                            </span>
                            <span
                              class="font-mono ml-2 text-right"
                              style={{ color: 'var(--text-primary)' }}
                            >
                              {value() !== undefined ? formatValue(value()!, field, name) : '—'}
                              <Show when={field.units && !field.enumType}>
                                <span style={{ color: 'var(--text-secondary)' }}>
                                  {' '}{getDisplayUnit(field.units, appState.unitProfile, { fieldName: field.name })}
                                </span>
                              </Show>
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      {/* Status text log at bottom */}
      <StatusTextLog />
    </div>
  );
}
