import { For, Show, createSignal } from 'solid-js';
import {
  appState,
  addPlotTab,
  deletePlotTab,
  renamePlotTab,
  reorderPlotTabs,
  setActiveSubTab,
} from '../store';

interface PlotTabBarProps {
  onLayoutDirty: () => void;
}

const IS_TOUCH_DEVICE = 'ontouchstart' in globalThis;

export default function PlotTabBar(props: PlotTabBarProps) {
  const [editingTabId, setEditingTabId] = createSignal<string | null>(null);
  const [editingValue, setEditingValue] = createSignal('');
  const [dragSourceIdx, setDragSourceIdx] = createSignal<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = createSignal<number | null>(null);

  function handleTabClick(tabId: string) {
    const editing = editingTabId();
    if (editing === tabId) return; // Don't switch when clicking the tab being edited
    if (editing !== null) {
      commitRename(editing); // Commit current edit before switching
    }
    setActiveSubTab(tabId);
  }

  function handleDoubleClick(tabId: string, currentName: string) {
    setEditingTabId(tabId);
    setEditingValue(currentName);
  }

  function commitRename(tabId: string) {
    const value = editingValue().trim();
    if (value) {
      renamePlotTab(tabId, value);
      props.onLayoutDirty();
    }
    setEditingTabId(null);
  }

  function cancelRename() {
    setEditingTabId(null);
  }

  function handleInputKeyDown(e: KeyboardEvent, tabId: string) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename(tabId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }

  function handleDelete(e: MouseEvent, tabId: string) {
    e.stopPropagation();
    const tab = appState.plotTabs.find(t => t.id === tabId);
    if (tab && tab.plots.length > 0) {
      if (!window.confirm(`Close tab "${tab.name}"? It has ${tab.plots.length} plot(s).`)) return;
    }
    deletePlotTab(tabId);
    props.onLayoutDirty();
  }

  function handleAdd() {
    addPlotTab();
    props.onLayoutDirty();
  }

  // --- Drag & drop ---
  function handleDragStart(e: DragEvent, idx: number) {
    if (!e.dataTransfer) return;
    setDragSourceIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  }

  function handleDragOver(e: DragEvent, idx: number) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    setDragOverIdx(idx);
  }

  function handleDragLeave() {
    setDragOverIdx(null);
  }

  function handleDrop(e: DragEvent, toIdx: number) {
    e.preventDefault();
    const fromIdx = dragSourceIdx();
    setDragSourceIdx(null);
    setDragOverIdx(null);
    if (fromIdx !== null && fromIdx !== toIdx) {
      reorderPlotTabs(fromIdx, toIdx);
      props.onLayoutDirty();
    }
  }

  function handleDragEnd() {
    setDragSourceIdx(null);
    setDragOverIdx(null);
  }

  return (
    <div
      class="flex items-center border-b overflow-x-auto"
      style={{
        'background-color': 'transparent',
        'border-color': 'var(--border-subtle)',
        height: '34px',
        'min-height': '34px',
      }}
    >
      <For each={appState.plotTabs}>
        {(tab, idx) => {
          const isActive = () => appState.activeSubTab === tab.id;
          const isEditing = () => editingTabId() === tab.id;
          const showDropIndicator = () =>
            dragOverIdx() === idx() && dragSourceIdx() !== null && dragSourceIdx() !== idx();

          let longPressTimer: ReturnType<typeof setTimeout> | null = null;
          let touchStartPos: { x: number; y: number } | null = null;

          function handleTouchStart(e: TouchEvent) {
            const touch = e.touches[0];
            touchStartPos = { x: touch.clientX, y: touch.clientY };
            longPressTimer = setTimeout(() => {
              longPressTimer = null;
              handleDoubleClick(tab.id, tab.name);
            }, 500);
          }

          function handleTouchMove(e: TouchEvent) {
            if (!longPressTimer || !touchStartPos) return;
            const touch = e.touches[0];
            const dx = touch.clientX - touchStartPos.x;
            const dy = touch.clientY - touchStartPos.y;
            if (Math.sqrt(dx * dx + dy * dy) > 10) {
              clearTimeout(longPressTimer);
              longPressTimer = null;
            }
          }

          function handleTouchEnd() {
            if (longPressTimer) {
              clearTimeout(longPressTimer);
              longPressTimer = null;
            }
          }

          return (
            <div
              class="group relative flex items-center gap-1 px-3 shrink-0 cursor-pointer select-none"
              style={{
                height: '100%',
                'background-color': 'transparent',
                color: isActive() ? 'var(--text-primary)' : 'var(--text-secondary)',
                'border-bottom': isActive() ? '2px solid var(--accent)' : '2px solid transparent',
                'border-right': '1px solid var(--border-subtle)',
              }}
              draggable={!isEditing()}
              onClick={() => handleTabClick(tab.id)}
              onDblClick={() => handleDoubleClick(tab.id, tab.name)}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onDragStart={(e) => handleDragStart(e, idx())}
              onDragOver={(e) => handleDragOver(e, idx())}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, idx())}
              onDragEnd={handleDragEnd}
            >
              {/* Drop indicator line */}
              <Show when={showDropIndicator()}>
                <div
                  class="absolute top-0 bottom-0"
                  style={{
                    left: '-1px',
                    width: '2px',
                    'background-color': 'var(--accent)',
                  }}
                />
              </Show>

              {/* Tab label or rename input */}
              <Show
                when={isEditing()}
                fallback={
                  <span class="text-xs font-medium whitespace-nowrap">
                    {tab.name}
                  </span>
                }
              >
                <input
                  class="text-xs font-medium bg-transparent outline-none border-b"
                style={{
                  color: 'var(--text-primary)',
                  'border-color': 'var(--accent)',
                  width: `${Math.max(editingValue().length, 3)}ch`,
                }}
                  value={editingValue()}
                  onInput={(e) => setEditingValue(e.currentTarget.value)}
                  onKeyDown={(e) => handleInputKeyDown(e, tab.id)}
                  onBlur={() => commitRename(tab.id)}
                  ref={(el) => {
                    // Auto-focus and select all when input mounts
                    requestAnimationFrame(() => {
                      el.focus();
                      el.select();
                    });
                  }}
                />
              </Show>

              {/* Delete button */}
              <button
                class={`flex items-center justify-center rounded transition-opacity ${IS_TOUCH_DEVICE ? 'opacity-60' : 'opacity-0 group-hover:opacity-100'}`}
                style={{
                  width: '16px',
                  height: '16px',
                  color: 'var(--text-secondary)',
                }}
                onClick={(e) => handleDelete(e, tab.id)}
                title="Close tab"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                >
                  <line x1="2" y1="2" x2="8" y2="8" />
                  <line x1="8" y1="2" x2="2" y2="8" />
                </svg>
              </button>
            </div>
          );
        }}
      </For>

      {/* Add tab button */}
      <button
        class="flex items-center justify-center shrink-0 px-2 transition-colors"
        style={{
          height: '100%',
          color: 'var(--text-secondary)',
        }}
        onClick={handleAdd}
        title="New tab"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        >
          <line x1="7" y1="2" x2="7" y2="12" />
          <line x1="2" y1="7" x2="12" y2="7" />
        </svg>
      </button>
    </div>
  );
}
