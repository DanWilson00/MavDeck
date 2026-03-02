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

export default function PlotTabBar(props: PlotTabBarProps) {
  const [editingTabId, setEditingTabId] = createSignal<string | null>(null);
  const [editingValue, setEditingValue] = createSignal('');
  const [dragSourceIdx, setDragSourceIdx] = createSignal<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = createSignal<number | null>(null);

  function handleTabClick(tabId: string) {
    // Don't switch tabs when clicking during a rename
    if (editingTabId() !== null) return;
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
        'background-color': 'var(--bg-panel)',
        'border-color': 'var(--border)',
        height: '32px',
        'min-height': '32px',
      }}
    >
      <For each={appState.plotTabs}>
        {(tab, idx) => {
          const isActive = () => appState.activeSubTab === tab.id;
          const isEditing = () => editingTabId() === tab.id;
          const showDropIndicator = () =>
            dragOverIdx() === idx() && dragSourceIdx() !== null && dragSourceIdx() !== idx();

          return (
            <div
              class="group relative flex items-center gap-1 px-3 shrink-0 cursor-pointer select-none"
              style={{
                height: '100%',
                'background-color': isActive() ? 'var(--bg-hover)' : 'transparent',
                color: isActive() ? 'var(--accent)' : 'var(--text-secondary)',
                'border-right': '1px solid var(--border)',
              }}
              draggable={!isEditing()}
              onClick={() => handleTabClick(tab.id)}
              onDblClick={() => handleDoubleClick(tab.id, tab.name)}
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
                    color: 'var(--accent)',
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
                class="flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity"
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
