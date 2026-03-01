import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { appState, workerBridge, registry } from '../store/app-store';
import type { MessageStats } from '../services/message-tracker';
import type { MavlinkFieldMetadata } from '../mavlink/metadata';
import StatusTextLog from './StatusTextLog';

interface MessageMonitorProps {
  onFieldSelected?: (messageName: string, fieldName: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  activeSignals?: Map<string, string>;
}

export default function MessageMonitor(props: MessageMonitorProps) {
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
    setExpandedMessages(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  function formatValue(value: number | string | number[], field: MavlinkFieldMetadata): string {
    // Enum resolution
    if (field.enumType && typeof value === 'number') {
      const resolved = registry.resolveEnumValue(field.enumType, value);
      if (resolved) return resolved;
    }
    // Float formatting
    if (typeof value === 'number') {
      if (field.baseType === 'float' || field.baseType === 'double') {
        return value.toFixed(4);
      }
      return String(value);
    }
    // Arrays
    if (Array.isArray(value)) {
      return `[${value.map(v => typeof v === 'number' && (field.baseType === 'float' || field.baseType === 'double') ? v.toFixed(4) : String(v)).join(', ')}]`;
    }
    // Strings
    return String(value);
  }

  function isNumericField(value: unknown): boolean {
    return typeof value === 'number';
  }

  return (
    <Show when={!props.collapsed} fallback={
      <div class="flex flex-col items-center py-2 border-r"
        style={{ width: '40px', 'min-width': '40px', 'background-color': 'var(--bg-panel)', 'border-color': 'var(--border)' }}>
        <button
          onClick={() => props.onToggleCollapse?.()}
          class="p-1 rounded transition-colors interactive-hover"
          style={{ color: 'var(--text-secondary)' }}
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <ChevronRightIcon />
        </button>
      </div>
    }>
      <div
        class="flex flex-col h-full"
        style={{
          'background-color': 'var(--bg-panel)',
          'border-right': '1px solid var(--border)',
          width: '350px',
          'min-width': '280px',
        }}
      >
        {/* Header */}
        <div
          class="flex items-center justify-between px-3 py-2 border-b"
          style={{ 'border-color': 'var(--border)' }}
        >
          <span
            class="text-sm font-semibold"
            style={{ color: 'var(--text-primary)' }}
          >
            Messages
          </span>
          <div class="flex items-center gap-2">
            <span
              class="text-xs px-2 py-0.5 rounded-full"
              style={{
                'background-color': 'var(--bg-hover)',
                color: 'var(--text-secondary)',
              }}
            >
              {messageStats().size}
            </span>
            <button
              onClick={() => props.onToggleCollapse?.()}
              class="p-0.5 rounded transition-colors interactive-hover"
              style={{ color: 'var(--text-secondary)' }}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <ChevronLeftIcon />
            </button>
          </div>
        </div>

        {/* Message list */}
        <div class="flex-1 overflow-y-auto">
          <For each={knownMessageNames()}>
            {(name) => {
              const stats = () => messageStats().get(name);
              const meta = () => registry.getMessageByName(name);
              const isExpanded = () => expandedMessages().has(name);

              return (
                <div
                  class="border-b"
                  style={{ 'border-color': 'var(--border)' }}
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
                                {value() !== undefined ? formatValue(value(), field) : '—'}
                                <Show when={field.units && !field.enumType}>
                                  <span style={{ color: 'var(--text-secondary)' }}>
                                    {' '}{field.units}
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
    </Show>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
