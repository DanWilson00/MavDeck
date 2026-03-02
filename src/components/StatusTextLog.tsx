import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { appState, workerBridge } from '../store';

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
  const [logHeight, setLogHeight] = createSignal(180);
  let scrollRef: HTMLDivElement | undefined;
  let dragStartY = 0;
  let dragStartHeight = 0;

  // Clear entries when log source changes
  createEffect(() => {
    appState.logViewerState.sourceName;
    setEntries([]);
  });

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
      <div
        class="flex items-center justify-between w-full px-3 py-2 text-xs font-semibold uppercase tracking-wide cursor-pointer interactive-hover"
        style={{ color: 'var(--text-secondary)', 'background-color': 'var(--bg-panel)' }}
        onClick={() => setIsExpanded(prev => !prev)}
      >
        <div class="flex items-center gap-1.5">
          <span style={{ 'font-size': '10px', 'line-height': '1' }}>
            {isExpanded() ? '\u25BE' : '\u25B8'}
          </span>
          <span>Status</span>
          <Show when={entries().length > 0}>
            <span
              class="text-xs px-1.5 py-0.5 rounded-full normal-case"
              style={{
                'background-color': 'var(--bg-hover)',
                color: 'var(--text-secondary)',
              }}
            >
              {entries().length}
            </span>
            <button
              class="p-0.5 rounded transition-colors interactive-hover"
              style={{ color: 'var(--text-secondary)' }}
              title="Clear status messages"
              aria-label="Clear status messages"
              onClick={(e) => {
                e.stopPropagation();
                setEntries([]);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </Show>
        </div>
      </div>

      {/* Expanded log */}
      <Show when={isExpanded()}>
        {/* Drag handle */}
        <div
          style={{ height: '4px', cursor: 'ns-resize', 'background-color': 'var(--border)' }}
          onPointerDown={(e) => {
            dragStartY = e.clientY;
            dragStartHeight = logHeight();
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            const delta = dragStartY - e.clientY;
            setLogHeight(Math.min(500, Math.max(60, dragStartHeight + delta)));
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
        />
        <div
          ref={scrollRef}
          class="overflow-y-auto px-2 pb-2"
          style={{ height: `${logHeight()}px` }}
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
