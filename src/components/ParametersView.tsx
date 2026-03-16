import { Show, For, createSignal, onMount } from 'solid-js';
import { appState } from '../store';
import { useParameters } from '../hooks';
import ParameterGroup from './ParameterGroup';

export default function ParametersView() {
  const {
    paramState, metadata, lastSetResult,
    groupedParams, requestAll, setParam, loadMetadataFromUrl, loadMetadataFromFile,
  } = useParameters();

  const [searchQuery, setSearchQuery] = createSignal('');
  let fileInputRef: HTMLInputElement | undefined;

  // Auto-load bundled metadata on mount
  onMount(() => {
    if (!metadata()) {
      void loadMetadataFromUrl('/parameters.json');
    }
  });

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
          return p.paramId.toLowerCase().includes(query)
            || configKey.toLowerCase().includes(query)
            || desc.toLowerCase().includes(query)
            || longDesc.toLowerCase().includes(query);
        }),
      }))
      .filter(g => g.params.length > 0);
  };

  function handleFileUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.[0]) {
      void loadMetadataFromFile(input.files[0]);
    }
  }

  return (
    <div class="h-full flex flex-col" style={{ 'background-color': 'var(--bg-primary)' }}>
      {/* Header bar */}
      <div
        class="flex items-center gap-3 px-4 py-2 border-b"
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

        <button
          onClick={() => fileInputRef?.click()}
          class="px-3 py-1 rounded text-sm transition-colors"
          style={{ 'background-color': 'var(--bg-hover)', color: 'var(--text-secondary)' }}
        >
          Upload Metadata
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
          placeholder="Search parameters..."
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
          class="px-2 py-1 rounded text-sm w-64"
          style={{
            'background-color': 'var(--bg-hover)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
          }}
        />

        {/* Status */}
        <Show when={state().fetchStatus === 'fetching'}>
          <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {state().receivedCount}/{state().totalCount || '?'}
          </span>
        </Show>
        <Show when={state().fetchStatus === 'done'}>
          <span class="text-xs" style={{ color: 'var(--accent-green)' }}>
            {state().receivedCount} params loaded
          </span>
        </Show>
        <Show when={state().fetchStatus === 'error'}>
          <span class="text-xs" style={{ color: 'var(--accent-red)' }}>
            {state().error}
          </span>
        </Show>
      </div>

      {/* Progress bar */}
      <Show when={state().fetchStatus === 'fetching' && state().totalCount > 0}>
        <div class="h-0.5" style={{ 'background-color': 'var(--bg-hover)' }}>
          <div
            class="h-full transition-all"
            style={{
              width: `${(state().receivedCount / state().totalCount) * 100}%`,
              'background-color': 'var(--accent)',
            }}
          />
        </div>
      </Show>

      {/* Content */}
      <div class="flex-1 overflow-y-auto">
        <Show when={isConnected()} fallback={
          <div class="flex items-center justify-center h-full">
            <span class="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Connect to view parameters
            </span>
          </div>
        }>
          <Show when={filteredGroups().length > 0} fallback={
            <div class="flex items-center justify-center h-64">
              <span class="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {state().fetchStatus === 'idle'
                  ? 'Click "Refresh All" to load parameters'
                  : 'No parameters match your search'}
              </span>
            </div>
          }>
            <div class="p-4 space-y-2">
              <For each={filteredGroups()}>
                {(group) => (
                  <ParameterGroup
                    group={group}
                    onSetParam={setParam}
                    lastSetResult={lastSetResult()}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
