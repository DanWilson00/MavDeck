import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { appState, workerBridge } from '../store/app-store';

const MAX_ENTRIES = 100;

const SEVERITY_LABELS: Record<number, string> = {
  0: 'EMERGENCY',
  1: 'ALERT',
  2: 'CRITICAL',
  3: 'ERROR',
  4: 'WARNING',
  5: 'NOTICE',
  6: 'INFO',
  7: 'DEBUG',
};

const SEVERITY_COLORS: Record<number, string> = {
  0: '#ef4444', // red
  1: '#ef4444',
  2: '#ef4444',
  3: '#f97316', // orange
  4: '#eab308', // amber
  5: '#00d4ff', // cyan
  6: '#94a3b8', // blue-gray
  7: '#6b7280', // gray
};

interface LogEntry {
  id: number;
  severity: number;
  text: string;
  timestamp: number;
}

let nextId = 0;

export default function StatusTextLog() {
  const [entries, setEntries] = createSignal<LogEntry[]>([]);
  const [isExpanded, setIsExpanded] = createSignal(false);
  let scrollRef: HTMLDivElement | undefined;

  // Subscribe to STATUSTEXT messages from worker
  createEffect(() => {
    if (!appState.isReady) return;
    const unsub = workerBridge.onStatusText(entry => {
      setEntries(prev => {
        const next = [...prev, { ...entry, id: nextId++ }];
        if (next.length > MAX_ENTRIES) {
          return next.slice(next.length - MAX_ENTRIES);
        }
        return next;
      });
      // Auto-scroll after DOM update
      requestAnimationFrame(() => {
        if (scrollRef && isExpanded()) {
          scrollRef.scrollTop = scrollRef.scrollHeight;
        }
      });
    });
    onCleanup(unsub);
  });

  function formatTime(timestamp: number): string {
    const d = new Date(timestamp);
    return d.toTimeString().slice(0, 8); // HH:MM:SS
  }

  return (
    <div
      class="border-t"
      style={{
        'border-color': 'var(--border)',
        'background-color': 'var(--bg-panel)',
      }}
    >
      {/* Header */}
      <button
        class="flex items-center justify-between w-full px-3 transition-colors"
        style={{
          height: '36px',
          'background-color': 'transparent',
        }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-hover)'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        onClick={() => setIsExpanded(prev => !prev)}
      >
        <div class="flex items-center gap-2">
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
          <span class="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            Status
          </span>
          <Show when={entries().length > 0}>
            <span
              class="text-xs px-1.5 py-0.5 rounded-full"
              style={{
                'background-color': 'var(--bg-hover)',
                color: 'var(--text-secondary)',
              }}
            >
              {entries().length}
            </span>
          </Show>
        </div>
      </button>

      {/* Expanded log */}
      <Show when={isExpanded()}>
        <div
          ref={scrollRef}
          class="overflow-y-auto px-2 pb-2"
          style={{ 'max-height': '180px' }}
        >
          <For each={entries()}>
            {(entry) => (
              <div
                class="text-xs font-mono py-0.5 flex gap-2"
                style={{ color: SEVERITY_COLORS[entry.severity] ?? 'var(--text-secondary)' }}
              >
                <span style={{ color: 'var(--text-secondary)', 'flex-shrink': '0' }}>
                  [{formatTime(entry.timestamp)}]
                </span>
                <span style={{ 'flex-shrink': '0' }}>
                  [{SEVERITY_LABELS[entry.severity] ?? `SEV${entry.severity}`}]
                </span>
                <span>{entry.text}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
