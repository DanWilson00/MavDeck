import { batch, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { get, set } from 'idb-keyval';
import { appState, setAppState } from '../store/app-store';
import MessageMonitor from './MessageMonitor';
import GridLayout from './GridLayout';
import SignalSelector from './SignalSelector';
import type { PlotConfig, PlotSignalConfig, TimeWindow } from '../models/plot-config';
import { SIGNAL_COLORS, DEFAULT_TIME_WINDOW } from '../models/plot-config';

/** Pick the first SIGNAL_COLORS entry not already used by existing signals. */
function pickNextColor(existingSignals: PlotSignalConfig[]): string {
  const usedColors = new Set(existingSignals.map(s => s.color));
  for (const color of SIGNAL_COLORS) {
    if (!usedColors.has(color)) return color;
  }
  // All 10 used — fall back to modulo
  return SIGNAL_COLORS[existingSignals.length % SIGNAL_COLORS.length];
}

const LAYOUT_KEY = 'mavdeck-layout-v1';

interface SavedLayout {
  [tabId: string]: PlotConfig[];
}

let plotIdCounter = 0;
function nextPlotId(): string {
  return `plot-${++plotIdCounter}`;
}

function nextSignalId(): string {
  return `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export default function TelemetryView() {
  const [selectorPlotId, setSelectorPlotId] = createSignal<string | null>(null);
  const [timeWindow, setTimeWindow] = createSignal<TimeWindow>(DEFAULT_TIME_WINDOW);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [selectedPlotId, setSelectedPlotId] = createSignal<string | null>(null);

  const TIME_WINDOW_OPTIONS: TimeWindow[] = [5, 10, 30, 60, 120, 300];
  let layoutCache: SavedLayout = {};
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveQueue: Promise<void> = Promise.resolve();

  // Get current tab's plots
  function currentPlots(): PlotConfig[] {
    const tab = appState.plotTabs.find(t => t.id === appState.activeSubTab);
    return tab?.plots ?? [];
  }

  function updatePlots(fn: (plots: PlotConfig[]) => PlotConfig[]) {
    const tabIdx = appState.plotTabs.findIndex(t => t.id === appState.activeSubTab);
    if (tabIdx === -1) return;
    setAppState('plotTabs', tabIdx, 'plots', prev => fn(prev));
  }

  function snapshotCurrentPlots(): PlotConfig[] {
    // JSON round-trip strips SolidJS store proxies so IndexedDB can serialize
    return JSON.parse(JSON.stringify(currentPlots())) as PlotConfig[];
  }

  function queueLayoutSave(tabId: string, plots: PlotConfig[]): void {
    saveQueue = saveQueue
      .then(async () => {
        layoutCache[tabId] = plots;
        await set(LAYOUT_KEY, layoutCache);
      })
      .catch(err => {
        console.error('[TelemetryView] Failed to save layout:', err);
      });
  }

  function scheduleLayoutSave(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      queueLayoutSave(appState.activeSubTab, snapshotCurrentPlots());
      saveTimer = undefined;
    }, 300);
  }

  function flushLayoutSave(): void {
    clearTimeout(saveTimer);
    queueLayoutSave(appState.activeSubTab, snapshotCurrentPlots());
    saveTimer = undefined;
  }

  onMount(async () => {
    const saved = await get<SavedLayout>(LAYOUT_KEY);
    if (!saved) return;
    layoutCache = saved;
    const tabId = appState.activeSubTab;
    const plots = saved[tabId];
    if (!plots || plots.length === 0) return;

    const tabIdx = appState.plotTabs.findIndex(t => t.id === tabId);
    if (tabIdx === -1) return;

    // Restore plot ID counter to avoid collisions
    for (const p of plots) {
      const num = parseInt(p.id.replace('plot-', ''), 10);
      if (!isNaN(num) && num >= plotIdCounter) {
        plotIdCounter = num;
      }
    }

    setAppState('plotTabs', tabIdx, 'plots', plots);
  });

  onCleanup(() => {
    flushLayoutSave();
  });

  function handleFieldSelected(messageName: string, fieldName: string) {
    const plotId = selectedPlotId();
    if (!plotId) return;
    const fieldKey = `${messageName}.${fieldName}`;
    handleToggleSignal(plotId, fieldKey);
  }

  function handleClosePlot(plotId: string) {
    updatePlots(plots => plots.filter(p => p.id !== plotId));
    scheduleLayoutSave();
  }

  function handleOpenSignalSelector(plotId: string) {
    setSelectorPlotId(plotId);
  }

  function handleGridChange(positions: Map<string, { x: number; y: number; w: number; h: number }>) {
    const tabIdx = appState.plotTabs.findIndex(t => t.id === appState.activeSubTab);
    if (tabIdx === -1) return;
    batch(() => {
      for (const [plotId, pos] of positions) {
        const plotIdx = appState.plotTabs[tabIdx].plots.findIndex(p => p.id === plotId);
        if (plotIdx !== -1) {
          setAppState('plotTabs', tabIdx, 'plots', plotIdx, 'gridPos', pos);
        }
      }
    });
    scheduleLayoutSave();
  }

  function handleToggleSignal(plotId: string, fieldKey: string) {
    const tabIdx = appState.plotTabs.findIndex(t => t.id === appState.activeSubTab);
    if (tabIdx === -1) return;
    const plotIdx = appState.plotTabs[tabIdx].plots.findIndex(p => p.id === plotId);
    if (plotIdx === -1) return;

    const plot = appState.plotTabs[tabIdx].plots[plotIdx];
    const existingIdx = plot.signals.findIndex(s => s.fieldKey === fieldKey);

    if (existingIdx >= 0) {
      // Remove signal
      setAppState('plotTabs', tabIdx, 'plots', plotIdx, 'signals',
        sigs => sigs.filter(s => s.fieldKey !== fieldKey));
    } else {
      // Add signal
      const dotIdx = fieldKey.indexOf('.');
      const messageType = fieldKey.substring(0, dotIdx);
      const fieldName = fieldKey.substring(dotIdx + 1);
      const newSignal: PlotSignalConfig = {
        id: nextSignalId(),
        messageType,
        fieldName,
        fieldKey,
        color: pickNextColor([...plot.signals]),
        visible: true,
      };

      setAppState('plotTabs', tabIdx, 'plots', plotIdx, 'signals',
        sigs => [...sigs, newSignal]);
    }
    scheduleLayoutSave();
  }

  function handleSelectPlot(plotId: string) {
    setSelectedPlotId(prev => prev === plotId ? null : plotId);
  }

  function handleClearSignals(plotId: string) {
    const tabIdx = appState.plotTabs.findIndex(t => t.id === appState.activeSubTab);
    if (tabIdx === -1) return;
    const plotIdx = appState.plotTabs[tabIdx].plots.findIndex(p => p.id === plotId);
    if (plotIdx === -1) return;
    setAppState('plotTabs', tabIdx, 'plots', plotIdx, 'signals', []);
    scheduleLayoutSave();
  }

  function handleAddPlot() {
    const plot: PlotConfig = {
      id: nextPlotId(),
      title: 'New Plot',
      signals: [],
      scalingMode: 'auto',
      timeWindow: timeWindow(),
      gridPos: { x: 0, y: 0, w: 6, h: 4 },
    };
    updatePlots(plots => [...plots, plot]);
    setSelectedPlotId(plot.id);
    scheduleLayoutSave();
  }

  function selectorPlot(): PlotConfig | undefined {
    return currentPlots().find(p => p.id === selectorPlotId());
  }

  /** Map<fieldKey, color> of visible signals on the selected plot. */
  const activeSignals = createMemo(() => {
    const plotId = selectedPlotId();
    if (!plotId) return new Map<string, string>();
    const plot = currentPlots().find(p => p.id === plotId);
    if (!plot) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const sig of plot.signals) {
      if (sig.visible) {
        map.set(sig.fieldKey, sig.color);
      }
    }
    return map;
  });

  return (
    <div class="flex h-full">
      {/* Left: Message Monitor */}
      <MessageMonitor
        onFieldSelected={handleFieldSelected}
        collapsed={sidebarCollapsed()}
        onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
        activeSignals={activeSignals()}
      />

      {/* Right: Plot area */}
      <div class="flex-1 flex flex-col min-w-0">
        {/* Plot toolbar */}
        <div
          class="flex items-center gap-3 px-3 py-2 border-b"
          style={{ 'border-color': 'var(--border)', 'background-color': 'var(--bg-panel)' }}
        >
          <button
            class="px-2 py-1 rounded text-xs font-medium transition-colors"
            style={{
              'background-color': 'var(--accent)',
              color: '#000',
            }}
            onClick={handleAddPlot}
          >
            + Add Plot
          </button>

          {/* Time window selector */}
          <div class="flex items-center gap-1">
            <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>Window:</span>
            <select
              class="text-xs rounded px-1 py-0.5"
              style={{
                'background-color': 'var(--bg-hover)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
              }}
              value={timeWindow()}
              onChange={(e) => {
                const val = Number(e.currentTarget.value) as TimeWindow;
                setTimeWindow(val);
                // Update all existing plots' time window
                updatePlots(plots => plots.map(p => ({ ...p, timeWindow: val })));
                scheduleLayoutSave();
              }}
            >
              <For each={TIME_WINDOW_OPTIONS}>
                {(tw) => (
                  <option value={tw}>
                    {tw >= 60 ? `${tw / 60}m` : `${tw}s`}
                  </option>
                )}
              </For>
            </select>
          </div>
        </div>

        {/* Plot grid */}
        <div class="flex-1 min-h-0">
          <Show
            when={currentPlots().length > 0}
            fallback={
              <div class="flex items-center justify-center h-full">
                <div class="text-center">
                  <p class="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    No plots yet
                  </p>
                  <p class="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                    Click "+ Add Plot", select a plot, then click fields to add signals
                  </p>
                </div>
              </div>
            }
          >
            <GridLayout
              plots={currentPlots()}
              onClose={handleClosePlot}
              onOpenSignalSelector={handleOpenSignalSelector}
              onGridChange={handleGridChange}
              selectedPlotId={selectedPlotId()}
              onSelectPlot={handleSelectPlot}
              onClearSignals={handleClearSignals}
            />
          </Show>
        </div>
      </div>

      {/* Signal selector modal */}
      <Show when={selectorPlotId() !== null && selectorPlot()}>
        <SignalSelector
          plotConfig={selectorPlot()!}
          onToggleSignal={handleToggleSignal}
          onClose={() => setSelectorPlotId(null)}
        />
      </Show>
    </div>
  );
}
