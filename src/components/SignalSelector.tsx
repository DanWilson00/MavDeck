import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { appState, workerBridge } from '../store';
import type { PlotConfig } from '../models';
import { toggleSetItem } from './hooks';

interface SignalSelectorProps {
  plotConfig: PlotConfig;
  onToggleSignal: (plotId: string, fieldKey: string) => void;
  onClose: () => void;
}

export default function SignalSelector(props: SignalSelectorProps) {
  const [availableFields, setAvailableFields] = createSignal<string[]>([]);
  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(new Set());

  // Get available fields from worker updates
  createEffect(() => {
    if (!appState.isReady) return;
    const unsub = workerBridge.onAvailableFields(fields => {
      setAvailableFields(fields);
    });
    onCleanup(unsub);
  });

  // Group fields by message type: { "ATTITUDE": ["roll", "pitch", ...], ... }
  function groupedFields(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const key of availableFields()) {
      const dotIdx = key.indexOf('.');
      if (dotIdx === -1) continue;
      const msgType = key.substring(0, dotIdx);
      const fieldName = key.substring(dotIdx + 1);
      if (!groups.has(msgType)) groups.set(msgType, []);
      groups.get(msgType)!.push(fieldName);
    }
    return groups;
  }

  function isSelected(fieldKey: string): boolean {
    return props.plotConfig.signals.some(s => s.fieldKey === fieldKey);
  }

  function getSignalColor(fieldKey: string): string | undefined {
    const sig = props.plotConfig.signals.find(s => s.fieldKey === fieldKey);
    return sig?.color;
  }

  function toggleGroup(msgType: string) {
    toggleSetItem(setExpandedGroups, msgType);
  }

  return (
    <div
      class="fixed inset-0 flex items-center justify-center z-50"
      style={{ 'background-color': 'rgba(0,0,0,0.5)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        class="rounded-lg shadow-xl max-h-[70vh] w-[400px] flex flex-col"
        style={{
          'background-color': 'var(--bg-panel)',
          border: '1px solid var(--border)',
        }}
      >
        {/* Header */}
        <div
          class="flex items-center justify-between px-4 py-3 border-b"
          style={{ 'border-color': 'var(--border)' }}
        >
          <span class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Select Signals
          </span>
          <button
            class="p-1 rounded transition-colors interactive-hover"
            style={{ color: 'var(--text-secondary)' }}
            onClick={() => props.onClose()}
            aria-label="Close signal selector"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Field list */}
        <div class="flex-1 overflow-y-auto p-2">
          <For each={Array.from(groupedFields().entries())}>
            {([msgType, fields]) => (
              <div class="mb-1">
                {/* Group header */}
                <button
                  class="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left transition-colors interactive-hover"
                  style={{ color: 'var(--text-primary)' }}
                  onClick={() => toggleGroup(msgType)}
                >
                  <svg
                    width="10" height="10" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2"
                    style={{
                      transform: expandedGroups().has(msgType) ? 'rotate(90deg)' : 'rotate(0deg)',
                      transition: 'transform 0.15s',
                    }}
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span class="text-xs font-mono font-semibold">{msgType}</span>
                  <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    ({fields.length})
                  </span>
                </button>

                {/* Fields */}
                <Show when={expandedGroups().has(msgType)}>
                  <div class="ml-4">
                    <For each={fields}>
                      {(fieldName) => {
                        const fieldKey = `${msgType}.${fieldName}`;
                        const selected = () => isSelected(fieldKey);
                        const color = () => getSignalColor(fieldKey);

                        return (
                          <button
                            class="flex items-center gap-2 w-full px-2 py-1 rounded text-left transition-colors interactive-hover"
                            onClick={() => props.onToggleSignal(props.plotConfig.id, fieldKey)}
                          >
                            {/* Color dot or checkbox */}
                            <div
                              class="w-3 h-3 rounded-sm border flex-shrink-0"
                              style={{
                                'background-color': selected() ? (color() ?? 'var(--accent)') : 'transparent',
                                'border-color': selected() ? (color() ?? 'var(--accent)') : 'var(--text-secondary)',
                              }}
                            />
                            <span
                              class="text-xs font-mono"
                              style={{ color: selected() ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                            >
                              {fieldName}
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>

          <Show when={availableFields().length === 0}>
            <div class="text-center py-4 text-xs" style={{ color: 'var(--text-secondary)' }}>
              No data received yet. Connect to start seeing fields.
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
