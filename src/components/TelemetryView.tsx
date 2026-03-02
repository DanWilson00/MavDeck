import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { get, set } from 'idb-keyval';
import { appState, setAppState } from '../store/app-store';
import MessageMonitor from './MessageMonitor';
import LogLibraryPane from './LogLibraryPane';
import GridLayout from './GridLayout';
import SignalSelector from './SignalSelector';
import type { PlotConfig, PlotSignalConfig } from '../models/plot-config';
import { SIGNAL_COLORS, getThemeColor } from '../models/plot-config';
import { createPlotInteractionController } from '../core/plot-interactions';

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
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [selectedPlotId, setSelectedPlotId] = createSignal<string | null>(null);

  const interactionController = createPlotInteractionController();
  const interactionGroupId = 'telemetry-linked';

  // Bridge isPaused store flag ↔ interaction controller so pause freezes charts
  // while data keeps flowing in the worker.
  createEffect(on(() => appState.isPaused, (paused) => {
    const snap = interactionController.getSnapshot();
    if (paused && snap.mode === 'live') {
      // Don't emit zoom for loaded logs — let fitToLogRange() handle it
      if (!appState.logViewerState.isActive) {
        const now = Date.now() / 1000;
        interactionController.emitZoom({ min: now - appState.timeWindow, max: now }, '__pause__');
      }
    } else if (!paused) {
      interactionController.emitReset('__pause__');
    }
  }));

  // Sync store isPaused when user scroll-zooms or double-click-resets a chart.
  // Skip events from the pause button itself ('__pause__') to avoid loops.
  const unsubInteraction = interactionController.subscribe(snapshot => {
    if (snapshot.lastSourcePlotId === '__pause__') return;
    if (snapshot.mode === 'zoomed' && !appState.isPaused) {
      setAppState('isPaused', true);
    } else if (snapshot.mode === 'live' && appState.isPaused) {
      setAppState('isPaused', false);
    }
  });
  onCleanup(unsubInteraction);

  // Toolbar "+" button increments addPlotCounter → trigger handleAddPlot.
  createEffect(on(() => appState.addPlotCounter, (count) => {
    if (count > 0) handleAddPlot();
  }));

  // Toolbar window selector writes appState.timeWindow → update all plots.
  createEffect(on(() => appState.timeWindow, (tw) => {
    updatePlots(plots => plots.map(p => ({ ...p, timeWindow: tw })));
    scheduleLayoutSave();
  }));

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
      timeWindow: appState.timeWindow,
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
        map.set(sig.fieldKey, getThemeColor(sig.color, appState.theme));
      }
    }
    return map;
  });

  return (
    <div class="flex h-full">
      {/* Left pane: log library + message monitor */}
      <div
        class="flex flex-col h-full"
        style={{
          'background-color': 'var(--bg-panel)',
          'border-right': '1px solid var(--border)',
          width: '350px',
          'min-width': '280px',
        }}
      >
        <div class="min-h-0 flex-1">
          <MessageMonitor
            onFieldSelected={handleFieldSelected}
            collapsed={sidebarCollapsed()}
            onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
            activeSignals={activeSignals()}
          />
        </div>
        <Show when={!appState.isLogPaneCollapsed}>
          <div style={{ height: '1px', 'background-color': 'var(--border)' }} />
        </Show>
        <LogLibraryPane />
      </div>

      {/* Right: Plot area */}
      <div class="flex-1 flex flex-col min-w-0">
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
                    Use the "+" button in the toolbar, select a plot, then click fields to add signals
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
              interactionGroupId={interactionGroupId}
              interactionController={interactionController}
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
