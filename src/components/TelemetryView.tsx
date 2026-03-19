import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { get, set, del } from 'idb-keyval';
import { appState, setAppState } from '../store';
import MessageMonitor from './MessageMonitor';
import LogLibraryPane from './LogLibraryPane';
import GridLayout from './GridLayout';
import SignalSelector from './SignalSelector';
import PlotTabBar from './PlotTabBar';
import type { PlotConfig, PlotSignalConfig, PlotTab } from '../models';
import { SIGNAL_COLORS, getThemeColor } from '../models';
import { createPlotInteractionController } from '../core';
import { deserializePlotTabs, serializePlotTabs, logDebugError, type PersistedPlotTabV1 } from '../services';

/** Pick the first SIGNAL_COLORS entry not already used by existing signals. */
function pickNextColor(existingSignals: PlotSignalConfig[]): string {
  const usedColors = new Set(existingSignals.map(s => s.color));
  for (const color of SIGNAL_COLORS) {
    if (!usedColors.has(color)) return color;
  }
  // All 10 used — fall back to modulo
  return SIGNAL_COLORS[existingSignals.length % SIGNAL_COLORS.length];
}

const LAYOUT_KEY_V2 = 'mavdeck-layout-v2';
const LAYOUT_KEY_V1 = 'mavdeck-layout-v1';
const ACTIVE_SUBTAB_KEY = 'mavdeck-active-subtab';

let plotIdCounter = 0;
function nextPlotId(): string {
  return `plot-${++plotIdCounter}`;
}

function nextSignalId(): string {
  return `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export default function TelemetryView() {
  const [selectorPlotId, setSelectorPlotId] = createSignal<string | null>(null);
  const [selectedPlotId, setSelectedPlotId] = createSignal<string | null>(null);
  const [layoutRestored, setLayoutRestored] = createSignal(false);

  const interactionController = createPlotInteractionController();
  const interactionGroupId = 'telemetry-linked';

  // Bridge isPaused store flag <-> interaction controller so pause freezes charts
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

  // Toolbar "+" button increments addPlotCounter -> trigger handleAddPlot.
  createEffect(on(() => appState.addPlotCounter, (count) => {
    if (count > 0) handleAddPlot();
  }));

  // Persist activeSubTab when user switches tabs (only after layout restore completes).
  createEffect(on(() => appState.activeSubTab, () => {
    if (!layoutRestored()) return;
    set(ACTIVE_SUBTAB_KEY, appState.activeSubTab).catch(err => {
      logDebugError('layout', `Failed to save active telemetry subtab: ${err instanceof Error ? err.message : String(err)}`, {
        activeSubTab: appState.activeSubTab,
      });
      console.error('[TelemetryView] Failed to save active subtab:', err);
    });
  }));

  // Toolbar window selector writes appState.timeWindow -> update all plots.
  createEffect(on(() => appState.timeWindow, (tw) => {
    updatePlots(plots => plots.map(p => ({ ...p, timeWindow: tw })));
    scheduleLayoutSave();
  }));

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

  function persistLayout(): void {
    const snapshot = serializePlotTabs(appState.plotTabs);
    saveQueue = saveQueue
      .then(() => Promise.all([
        set(LAYOUT_KEY_V2, snapshot),
        set(ACTIVE_SUBTAB_KEY, appState.activeSubTab),
      ]).then(() => {}))
      .catch(err => {
        logDebugError('layout', `Failed to save telemetry layout: ${err instanceof Error ? err.message : String(err)}`, {
          tabCount: appState.plotTabs.length,
        });
        console.error('[TelemetryView] Failed to save layout:', err);
      });
  }

  function scheduleLayoutSave(): void {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistLayout();
      saveTimer = undefined;
    }, 300);
  }

  function flushLayoutSave(): void {
    clearTimeout(saveTimer);
    persistLayout();
    saveTimer = undefined;
  }

  onMount(async () => {
    // Try v2 first
    let savedTabs = await get<PersistedPlotTabV1[]>(LAYOUT_KEY_V2);

    if (!savedTabs) {
      // Try v1 migration
      const v1 = await get<{ [tabId: string]: PlotConfig[] }>(LAYOUT_KEY_V1);
      if (v1) {
        savedTabs = Object.entries(v1).map(([tabId, plots], i) => ({
          id: tabId,
          name: `Tab ${i + 1}`,
          plots: serializePlotTabs([{ id: tabId, name: `Tab ${i + 1}`, plots }])[0].plots,
        }));
        // Save as v2 and remove v1
        await set(LAYOUT_KEY_V2, savedTabs);
        await del(LAYOUT_KEY_V1);
      }
    }

    if (!savedTabs || savedTabs.length === 0) { setLayoutRestored(true); return; }
    const restoredTabs = deserializePlotTabs(savedTabs);

    // Restore plotIdCounter from ALL tabs' plots
    for (const tab of restoredTabs) {
      for (const p of tab.plots) {
        const num = parseInt(p.id.replace('plot-', ''), 10);
        if (!isNaN(num) && num >= plotIdCounter) {
          plotIdCounter = num;
        }
      }
    }

    const savedSubTab = await get<string>(ACTIVE_SUBTAB_KEY);
    const restoredSubTab = savedSubTab && restoredTabs.some(t => t.id === savedSubTab)
      ? savedSubTab
      : restoredTabs[0].id;

    batch(() => {
      setAppState('plotTabs', restoredTabs);
      setAppState('activeSubTab', restoredSubTab);
    });
    setLayoutRestored(true);
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

  function handleClosePlot(plotId: string, tabId: string) {
    const tabIdx = appState.plotTabs.findIndex(t => t.id === tabId);
    if (tabIdx === -1) return;
    setAppState('plotTabs', tabIdx, 'plots', prev => prev.filter(p => p.id !== plotId));
    scheduleLayoutSave();
  }

  function handleOpenSignalSelector(plotId: string) {
    setSelectorPlotId(plotId);
  }

  function handleGridChange(positions: Map<string, { x: number; y: number; w: number; h: number }>, tabId: string) {
    const tabIdx = appState.plotTabs.findIndex(t => t.id === tabId);
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

  function handleClearSignals(plotId: string, tabId: string) {
    const tabIdx = appState.plotTabs.findIndex(t => t.id === tabId);
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

  function handleResizeStart(e: MouseEvent) {
    const startX = e.clientX;
    const startWidth = appState.sidebarWidth;

    function onMove(ev: MouseEvent) {
      const newWidth = Math.min(600, Math.max(200, startWidth + (ev.clientX - startX)));
      setAppState('sidebarWidth', newWidth);
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return (
    <div class="flex h-full">
        {/* Left pane: collapsible sidebar */}
        <Show
          when={!appState.sidebarCollapsed}
          fallback={
            <div
              class="flex flex-col items-center py-2"
              style={{
              width: '32px',
              'min-width': '32px',
              'background-color': 'var(--bg-panel-2)',
              'border-right': '1px solid var(--border-subtle)',
            }}
          >
              <button
                onClick={() => setAppState('sidebarCollapsed', false)}
                class="p-1 rounded transition-colors interactive-hover"
                style={{ color: 'var(--text-secondary)' }}
                title="Expand sidebar"
                aria-label="Expand sidebar"
              >
                <ChevronRightIcon />
              </button>
            </div>
          }
        >
          <div
            class="flex flex-col h-full relative"
            style={{
              'background-color': 'var(--bg-panel-2)',
              'border-right': '1px solid var(--border-subtle)',
              width: `${appState.sidebarWidth}px`,
              'min-width': '200px',
              'max-width': '600px',
            }}
          >
            <div
              class="flex items-center justify-between px-3 py-2 border-b"
              style={{ 'border-color': 'var(--border-subtle)' }}
            >
              <div>
                <div
                  class="text-[10px] uppercase tracking-[0.14em]"
                  style={{
                    color: 'var(--text-quiet)',
                    'font-family': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  }}
                >
                  Signals
                </div>
              </div>
              <button
                onClick={() => setAppState('sidebarCollapsed', true)}
                class="p-1 rounded transition-colors interactive-hover"
                style={{ color: 'var(--text-secondary)' }}
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
              >
                <ChevronLeftIcon />
              </button>
            </div>

            <div class="min-h-0 flex-1">
              <MessageMonitor
                onFieldSelected={handleFieldSelected}
                activeSignals={activeSignals()}
              />
            </div>

            <Show when={!appState.isLogPaneCollapsed}>
              <div style={{ height: '1px', 'background-color': 'var(--border-subtle)' }} />
            </Show>
            <LogLibraryPane />

            <div
              style={{
                position: 'absolute',
                top: '0',
                right: '0',
                width: '4px',
                height: '100%',
                cursor: 'col-resize',
              }}
              onMouseDown={handleResizeStart}
            />
          </div>
        </Show>

        {/* Right: Plot area */}
        <div class="flex-1 flex flex-col min-w-0">
          <PlotTabBar onLayoutDirty={scheduleLayoutSave} />
          <div class="flex-1 min-h-0 relative">
            <For each={appState.plotTabs}>
              {(tab) => {
                const isActive = () => appState.activeSubTab === tab.id;
                const tabPlots = () => tab.plots;
                return (
                  <div
                    class="absolute inset-0"
                    style={{
                      visibility: isActive() ? 'visible' : 'hidden',
                      'z-index': isActive() ? 1 : 0,
                      'overflow-y': 'auto',
                    }}
                  >
                    <Show
                      when={tabPlots().length > 0}
                      fallback={
                        <div class="flex h-full items-center justify-center px-6">
                          <button
                            class="console-button rounded px-3 py-1.5 text-sm font-medium"
                            onClick={() => handleAddPlot()}
                          >
                            Add plot
                          </button>
                        </div>
                      }
                    >
                      <GridLayout
                        plots={tabPlots()}
                        onClose={(plotId) => handleClosePlot(plotId, tab.id)}
                        onOpenSignalSelector={handleOpenSignalSelector}
                        onGridChange={(positions) => handleGridChange(positions, tab.id)}
                        selectedPlotId={selectedPlotId()}
                        onSelectPlot={handleSelectPlot}
                        onClearSignals={(plotId) => handleClearSignals(plotId, tab.id)}
                        interactionGroupId={interactionGroupId}
                        interactionController={interactionController}
                      />
                    </Show>
                  </div>
                );
              }}
            </For>
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

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
