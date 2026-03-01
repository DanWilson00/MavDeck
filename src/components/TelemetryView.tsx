import { createSignal, For, Show } from 'solid-js';
import { appState, setAppState } from '../store/app-store';
import MessageMonitor from './MessageMonitor';
import GridLayout from './GridLayout';
import SignalSelector from './SignalSelector';
import type { PlotConfig, PlotSignalConfig, TimeWindow } from '../models/plot-config';
import { SIGNAL_COLORS, DEFAULT_TIME_WINDOW } from '../models/plot-config';

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

  const TIME_WINDOW_OPTIONS: TimeWindow[] = [5, 10, 30, 60, 120, 300];

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

  // Create a new plot with a signal
  function createPlotWithSignal(messageName: string, fieldName: string): void {
    const fieldKey = `${messageName}.${fieldName}`;
    const existingPlots = currentPlots();

    // Check if signal already exists in any plot
    for (const plot of existingPlots) {
      if (plot.signals.some(s => s.fieldKey === fieldKey)) return;
    }

    const colorIdx = existingPlots.reduce((n, p) => n + p.signals.length, 0) % SIGNAL_COLORS.length;

    const signal: PlotSignalConfig = {
      id: nextSignalId(),
      messageType: messageName,
      fieldName,
      fieldKey,
      color: SIGNAL_COLORS[colorIdx],
      visible: true,
    };

    const gridCol = existingPlots.length % 2;
    const gridRow = Math.floor(existingPlots.length / 2);

    const plot: PlotConfig = {
      id: nextPlotId(),
      title: fieldKey,
      signals: [signal],
      scalingMode: 'auto',
      timeWindow: timeWindow(),
      gridPos: { x: gridCol * 6, y: gridRow * 4, w: 6, h: 4 },
    };

    updatePlots(plots => [...plots, plot]);
  }

  function handleFieldSelected(messageName: string, fieldName: string) {
    createPlotWithSignal(messageName, fieldName);
  }

  function handleClosePlot(plotId: string) {
    updatePlots(plots => plots.filter(p => p.id !== plotId));
  }

  function handleOpenSignalSelector(plotId: string) {
    setSelectorPlotId(plotId);
  }

  function handleGridChange(positions: Map<string, { x: number; y: number; w: number; h: number }>) {
    const tabIdx = appState.plotTabs.findIndex(t => t.id === appState.activeSubTab);
    if (tabIdx === -1) return;
    for (const [plotId, pos] of positions) {
      const plotIdx = appState.plotTabs[tabIdx].plots.findIndex(p => p.id === plotId);
      if (plotIdx !== -1) {
        setAppState('plotTabs', tabIdx, 'plots', plotIdx, 'gridPos', pos);
      }
    }
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
      const colorIdx = plot.signals.length % SIGNAL_COLORS.length;

      const newSignal: PlotSignalConfig = {
        id: nextSignalId(),
        messageType,
        fieldName,
        fieldKey,
        color: SIGNAL_COLORS[colorIdx],
        visible: true,
      };

      setAppState('plotTabs', tabIdx, 'plots', plotIdx, 'signals',
        sigs => [...sigs, newSignal]);
    }
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
    setSelectorPlotId(plot.id);
  }

  function selectorPlot(): PlotConfig | undefined {
    return currentPlots().find(p => p.id === selectorPlotId());
  }

  return (
    <div class="flex h-full">
      {/* Left: Message Monitor */}
      <MessageMonitor onFieldSelected={handleFieldSelected} />

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
                    Click a field in the message monitor or use "+ Add Plot"
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
