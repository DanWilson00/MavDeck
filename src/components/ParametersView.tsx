import { Show, For, createSignal, createMemo, createEffect, createRoot } from 'solid-js';
import { appState } from '../store';
import { useParameters } from '../hooks';
import type { ParamWithMeta, ArrayParamGroup } from '../hooks/use-parameters';
import ParameterGroup from './ParameterGroup';
import ParameterDetail from './ParameterDetail';
import ParameterArrayDetail from './ParameterArrayDetail';
import { getArrayDisplayName, getParameterDisplayName } from '../services/parameter-display';

// Module-level state survives component unmount/remount (tab switches)
const [expandedGroups, setExpandedGroups] = createSignal(new Set<string>());

function toggleGroup(name: string) {
  setExpandedGroups(prev => {
    const next = new Set(prev);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    return next;
  });
}

export default function ParametersView() {
  const {
    paramState, metadata, metadataLoading, metadataStatus, lastSetResult,
    groupedParams, requestAll, setParam, loadMetadataFromFile, downloadMetadataFromDevice,
  } = useParameters();

  const [searchQuery, setSearchQuery] = createSignal('');
  const [selectedParamId, setSelectedParamId] = createSignal<string | null>(null);
  const [selectedArrayPrefix, setSelectedArrayPrefix] = createSignal<string | null>(null);
  const [pendingEdits, setPendingEdits] = createSignal<Map<string, number>>(new Map());
  const [isSavingAll, setIsSavingAll] = createSignal(false);
  let fileInputRef: HTMLInputElement | undefined;

  const modifiedParamIds = createMemo(() => new Set(pendingEdits().keys()));

  function updatePendingEdit(paramId: string, value: number | null) {
    setPendingEdits(prev => {
      const next = new Map(prev);
      if (value === null) {
        next.delete(paramId);
      } else {
        next.set(paramId, value);
      }
      return next;
    });
  }

  // Clear pending edit on successful set
  createEffect(() => {
    const result = lastSetResult();
    if (result?.success) {
      updatePendingEdit(result.paramId, null);
    }
  });

  async function saveAllPending() {
    const edits = Array.from(pendingEdits().entries());
    if (edits.length === 0) return;
    setIsSavingAll(true);
    for (const [paramId, value] of edits) {
      setParam(paramId, value);
      // Wait for this param's result before sending next
      await new Promise<void>(resolve => {
        createRoot(dispose => {
          createEffect(() => {
            const result = lastSetResult();
            if (result && result.paramId === paramId) {
              dispose();
              resolve();
            }
          });
        });
      });
    }
    setIsSavingAll(false);
  }

  const isConnected = () => appState.connectionStatus === 'connected' || appState.connectionStatus === 'no_data';
  const state = () => paramState();

  // Filter groups by search
  const filteredGroups = () => {
    const query = searchQuery().toLowerCase().trim();
    const groups = groupedParams();
    if (!query) return groups;

    return groups
      .map(g => ({
        name: g.name,
        params: g.params.filter(p => {
          const configKey = p.meta?.config_key ?? '';
          const desc = p.meta?.description ?? '';
          const longDesc = p.meta?.long_description ?? '';
          const groupName = p.meta?.group_name ?? '';
          const displayName = getParameterDisplayName(p.meta, p.paramId);
          const idMatches = !p.meta && p.paramId.toLowerCase().includes(query);
          return idMatches
            || displayName.toLowerCase().includes(query)
            || configKey.toLowerCase().includes(query)
            || desc.toLowerCase().includes(query)
            || longDesc.toLowerCase().includes(query)
            || groupName.toLowerCase().includes(query);
        }),
        arrays: g.arrays.filter(a => {
          // Include entire array if description or any element matches
          if (a.description.toLowerCase().includes(query)) return true;
          if (a.label.toLowerCase().includes(query)) return true;
          return a.elements.some(el => {
            const configKey = el.meta?.config_key ?? '';
            const desc = el.meta?.description ?? '';
            const longDesc = el.meta?.long_description ?? '';
            const groupName = el.meta?.group_name ?? '';
            const displayName = getParameterDisplayName(el.meta, el.paramId);
            const idMatches = !el.meta && el.paramId.toLowerCase().includes(query);
            return idMatches
              || displayName.toLowerCase().includes(query)
              || configKey.toLowerCase().includes(query)
              || desc.toLowerCase().includes(query)
              || longDesc.toLowerCase().includes(query)
              || groupName.toLowerCase().includes(query);
          });
        }),
      }))
      .filter(g => g.params.length > 0 || g.arrays.length > 0);
  };

  function handleSelectParam(paramId: string) {
    setSelectedParamId(paramId);
    setSelectedArrayPrefix(null);
  }

  function handleSelectArray(prefix: string) {
    setSelectedArrayPrefix(prefix);
    setSelectedParamId(null);
  }

  // Find selected param object (scalars only now)
  const selectedParam = createMemo((): ParamWithMeta | null => {
    const id = selectedParamId();
    if (!id) return null;
    for (const group of groupedParams()) {
      for (const param of group.params) {
        if (param.paramId === id) return param;
      }
    }
    return null;
  });

  // Find selected array group
  const selectedArray = createMemo((): ArrayParamGroup | null => {
    const prefix = selectedArrayPrefix();
    if (!prefix) return null;
    for (const group of groupedParams()) {
      for (const array of group.arrays) {
        if (array.prefix === prefix) return array;
      }
    }
    return null;
  });

  function handleFileUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.[0]) {
      void loadMetadataFromFile(input.files[0]);
    }
  }

  const pendingCount = () => pendingEdits().size;

  const [leftPanelWidth, setLeftPanelWidth] = createSignal(400);
  let containerRef: HTMLDivElement | undefined;

  function startResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftPanelWidth();

    function onMouseMove(e: MouseEvent) {
      const maxWidth = containerRef ? containerRef.clientWidth * 0.7 : 800;
      const newWidth = Math.max(250, Math.min(maxWidth, startWidth + e.clientX - startX));
      setLeftPanelWidth(newWidth);
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  return (
    <div class="h-full flex flex-col" style={{ 'background-color': 'var(--bg-primary)' }}>
      {/* Two-panel layout */}
      <div ref={containerRef} class="flex-1 flex overflow-hidden">
        {/* Left panel: list */}
        <div
          class="flex flex-col overflow-hidden"
          style={{ width: `${leftPanelWidth()}px`, 'min-width': '250px', 'border-right': '1px solid var(--border)' }}
        >
          {/* Header bar */}
          <div
            class="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0"
            style={{ 'background-color': 'var(--bg-panel)', 'border-color': 'var(--border)' }}
          >
            <button
              onClick={() => requestAll()}
              disabled={!isConnected()}
              class="px-3 py-1 rounded text-sm font-medium transition-colors"
              style={{
                'background-color': isConnected() ? 'var(--accent)' : 'var(--bg-hover)',
                color: isConnected() ? '#000' : 'var(--text-secondary)',
                opacity: isConnected() ? '1' : '0.5',
                cursor: isConnected() ? 'pointer' : 'not-allowed',
              }}
            >
              Refresh All
            </button>

            <Show when={pendingCount() > 0}>
              <button
                onClick={() => void saveAllPending()}
                disabled={isSavingAll()}
                class="px-3 py-1 rounded text-sm font-medium transition-colors"
                style={{
                  'background-color': isSavingAll() ? 'var(--bg-hover)' : 'var(--accent)',
                  color: isSavingAll() ? 'var(--text-secondary)' : '#000',
                  opacity: isSavingAll() ? '0.5' : '1',
                  cursor: isSavingAll() ? 'not-allowed' : 'pointer',
                }}
              >
                {isSavingAll() ? 'Saving...' : `Save All (${pendingCount()})`}
              </button>
            </Show>

            <button
              onClick={() => downloadMetadataFromDevice()}
              disabled={!isConnected() || metadataLoading()}
              class="px-2 py-1 rounded text-sm transition-colors"
              style={{
                'background-color': 'var(--bg-hover)',
                color: 'var(--text-secondary)',
                opacity: isConnected() && !metadataLoading() ? '1' : '0.5',
                cursor: isConnected() && !metadataLoading() ? 'pointer' : 'not-allowed',
              }}
            >
              {metadataLoading() ? 'Loading...' : 'From Device'}
            </button>
            <button
              onClick={() => fileInputRef?.click()}
              class="px-2 py-1 rounded text-sm transition-colors"
              style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-secondary)' }}
            >
              Upload
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              class="hidden"
              onChange={handleFileUpload}
            />

            <div class="flex-1" />

            {/* Search */}
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              class="px-2 py-1 rounded text-sm w-36"
              style={{
                'background-color': 'var(--bg-hover)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
              }}
            />
          </div>

          <Show when={metadataStatus().kind !== 'idle' && metadataStatus().message}>
            <div
              class="px-3 py-2 text-sm border-b flex-shrink-0"
              style={{
                'background-color': metadataStatus().kind === 'error'
                  ? 'color-mix(in srgb, var(--accent-red) 10%, transparent)'
                  : metadataStatus().kind === 'success'
                    ? 'color-mix(in srgb, var(--accent-green) 10%, transparent)'
                    : 'var(--bg-hover)',
                color: metadataStatus().kind === 'error'
                  ? 'var(--accent-red)'
                  : metadataStatus().kind === 'success'
                    ? 'var(--accent-green)'
                    : 'var(--text-secondary)',
                'border-color': 'var(--border)',
              }}
            >
              {metadataStatus().message}
            </div>
          </Show>

          {/* Progress bar */}
          <Show when={state().fetchStatus === 'fetching' && state().totalCount > 0}>
            <div class="h-0.5 flex-shrink-0" style={{ 'background-color': 'var(--bg-hover)' }}>
              <div
                class="h-full transition-all"
                style={{
                  width: `${(state().receivedCount / state().totalCount) * 100}%`,
                  'background-color': 'var(--accent)',
                }}
              />
            </div>
          </Show>

          {/* Scrollable list */}
          <div class="flex-1 overflow-y-auto">
            <Show when={isConnected()} fallback={
              <div class="flex items-center justify-center h-full">
                <span class="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Connect to view parameters
                </span>
              </div>
            }>
              <Show when={filteredGroups().length > 0} fallback={
                <div class="flex items-center justify-center h-32">
                  <span class="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {state().fetchStatus === 'idle'
                      ? 'Click "Refresh All" to load parameters'
                      : 'No parameters match your search'}
                  </span>
                </div>
              }>
                <For each={filteredGroups()}>
                  {(group) => (
                    <ParameterGroup
                      group={group}
                      selectedParamId={selectedParamId()}
                      selectedArrayPrefix={selectedArrayPrefix()}
                      modifiedParamIds={modifiedParamIds()}
                      pendingEdits={pendingEdits()}
                      expanded={expandedGroups().has(group.name)}
                      onToggle={() => toggleGroup(group.name)}
                      onSelectParam={handleSelectParam}
                      onSelectArray={handleSelectArray}
                    />
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </div>

        {/* Resize handle */}
        <div
          onMouseDown={startResize}
          class="flex-shrink-0 hover:bg-[var(--accent)] transition-colors"
          style={{
            width: '4px',
            cursor: 'col-resize',
            'background-color': 'var(--border)',
          }}
        />

        {/* Right panel: detail */}
        <div class="flex-1 overflow-hidden" style={{ 'background-color': 'var(--bg-panel)' }}>
          <Show when={selectedArray()} fallback={
            <Show when={selectedParam()} fallback={
              <div class="flex items-center justify-center h-full">
                <span class="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Select a parameter to view details
                </span>
              </div>
            }>
              {(param) => (
                <ParameterDetail
                  param={param()}
                  onSetParam={setParam}
                  lastSetResult={lastSetResult()}
                  pendingValue={pendingEdits().get(param().paramId) ?? null}
                  onLocalChange={(value) => updatePendingEdit(param().paramId, value)}
                />
              )}
            </Show>
          }>
            {(array) => (
              <ParameterArrayDetail
                array={array()}
                pendingEdits={pendingEdits()}
                onLocalChange={(paramId, value) => updatePendingEdit(paramId, value)}
                onSetParam={setParam}
                lastSetResult={lastSetResult()}
              />
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
