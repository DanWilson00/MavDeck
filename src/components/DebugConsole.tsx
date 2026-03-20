import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { appState } from '../store';
import {
  DEBUG_CONSOLE_SOURCES,
  DEBUG_CONSOLE_SOURCE_LABELS,
  clearDebugConsoleEntries,
  getDebugConsoleEntries,
  onDebugConsoleClear,
  onDebugConsoleEntry,
  type DebugConsoleEntry,
  type DebugConsoleLevel,
  type DebugConsoleSource,
} from '../services/debug-console';

const LEVEL_LABELS: Record<DebugConsoleLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

const LEVEL_COLORS: Record<DebugConsoleLevel, string> = {
  debug: '#6b7280',
  info: '#94a3b8',
  warn: '#eab308',
  error: '#f97316',
};

const [isExpanded, setIsExpanded] = createSignal(false);
const [consoleHeight, setConsoleHeight] = createSignal(180);
const [sourceFilter, setSourceFilter] = createSignal<'all' | DebugConsoleSource>('all');
const [levelFilter, setLevelFilter] = createSignal<'all' | DebugConsoleLevel>('all');

export default function DebugConsole() {
  const [entries, setEntries] = createSignal<DebugConsoleEntry[]>(getDebugConsoleEntries());
  let scrollRef: HTMLDivElement | undefined;
  let dragStartY = 0;
  let dragStartHeight = 0;

  createEffect(() => {
    const unsubEntry = onDebugConsoleEntry((entry) => {
      setEntries(prev => [...prev, entry]);
      requestAnimationFrame(() => {
        if (scrollRef && isExpanded()) {
          scrollRef.scrollTop = scrollRef.scrollHeight;
        }
      });
    });
    const unsubClear = onDebugConsoleClear(() => {
      setEntries([]);
    });
    onCleanup(() => {
      unsubEntry();
      unsubClear();
    });
  });

  const filteredEntries = createMemo(() => entries().filter((entry) => {
    const sourceOk = sourceFilter() === 'all' || entry.source === sourceFilter();
    const levelOk = levelFilter() === 'all' || entry.level === levelFilter();
    return sourceOk && levelOk;
  }));

  function formatTime(timestamp: number): string {
    const d = new Date(timestamp);
    return d.toTimeString().slice(0, 8);
  }

  function formatDetails(entry: DebugConsoleEntry): string {
    if (!entry.details || Object.keys(entry.details).length === 0) return '';
    return ` ${Object.entries(entry.details).map(([k, v]) => `${k}=${String(v)}`).join(' ')}`;
  }

  return (
    <Show when={appState.debugConsoleEnabled}>
      <div
        class="border-t"
        style={{
          'border-color': 'var(--border)',
          'background-color': 'var(--bg-panel)',
        }}
      >
        <div
          class="flex items-center justify-between w-full px-3 py-2 text-xs font-semibold uppercase tracking-wide cursor-pointer interactive-hover"
          style={{ color: 'var(--text-secondary)' }}
          onClick={() => setIsExpanded(prev => !prev)}
        >
          <div class="flex items-center gap-1.5">
            <span style={{ 'font-size': '10px', 'line-height': '1' }}>
              {isExpanded() ? '\u25BE' : '\u25B8'}
            </span>
            <span>Debug Console</span>
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
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="p-0.5 rounded transition-colors interactive-hover normal-case"
              style={{ color: 'var(--text-secondary)' }}
              onClick={(e) => {
                e.stopPropagation();
                clearDebugConsoleEntries();
              }}
            >
              Clear
            </button>
          </div>
        </div>

        <Show when={isExpanded()}>
          <div
            style={{ height: '4px', cursor: 'ns-resize', 'background-color': 'var(--border)' }}
            onPointerDown={(e) => {
              dragStartY = e.clientY;
              dragStartHeight = consoleHeight();
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              const delta = dragStartY - e.clientY;
              setConsoleHeight(Math.min(500, Math.max(80, dragStartHeight + delta)));
            }}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }}
          />

          <div class="flex items-center gap-2 px-3 py-2 border-b" style={{ 'border-color': 'var(--border)' }}>
            <select
              class="rounded px-2 py-1 text-xs"
              style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              value={sourceFilter()}
              onChange={(e) => setSourceFilter(e.currentTarget.value as 'all' | DebugConsoleSource)}
            >
              <option value="all">All Sources</option>
              <For each={DEBUG_CONSOLE_SOURCES}>
                {(source) => (
                  <option value={source}>{DEBUG_CONSOLE_SOURCE_LABELS[source]}</option>
                )}
              </For>
            </select>
            <select
              class="rounded px-2 py-1 text-xs"
              style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              value={levelFilter()}
              onChange={(e) => setLevelFilter(e.currentTarget.value as 'all' | DebugConsoleLevel)}
            >
              <option value="all">All Levels</option>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
          </div>

          <div
            ref={scrollRef}
            class="overflow-y-auto px-2 pb-2"
            style={{ height: `${consoleHeight()}px` }}
          >
            <For each={filteredEntries()}>
              {(entry) => (
                <div
                  class="text-xs font-mono py-0.5 flex gap-2"
                  style={{ color: LEVEL_COLORS[entry.level] }}
                >
                  <span style={{ color: 'var(--text-secondary)', 'flex-shrink': '0' }}>
                    [{formatTime(entry.timestamp)}]
                  </span>
                  <span style={{ 'flex-shrink': '0' }}>
                    [{LEVEL_LABELS[entry.level]}]
                  </span>
                  <span style={{ 'flex-shrink': '0', color: 'var(--text-secondary)' }}>
                    [{DEBUG_CONSOLE_SOURCE_LABELS[entry.source]}]
                  </span>
                  <div style={{ 'min-width': '0', flex: '1 1 auto' }}>
                    <div>{entry.message}{formatDetails(entry)}</div>
                    <Show when={entry.body}>
                      <pre
                        class="mt-1 rounded px-2 py-1 overflow-x-auto"
                        style={{
                          margin: '0.25rem 0 0',
                          'background-color': 'var(--bg-hover)',
                          color: 'var(--text-primary)',
                          'white-space': 'pre-wrap',
                          'word-break': 'break-word',
                        }}
                      >
                        {entry.body}
                      </pre>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
