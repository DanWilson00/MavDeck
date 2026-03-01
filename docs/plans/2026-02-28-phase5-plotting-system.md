# Phase 5: Plotting System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the real-time plotting system — uPlot charts fed by ring buffer data from the MAVLink worker, with signal selection from the message monitor, all wired into a telemetry view layout.

**Architecture:** PlotChart wraps uPlot with a RAF loop reading Float64Array data from `workerBridge.onUpdate()`. PlotPanel adds a header/close/live-value shell around each chart. SignalSelector lets users pick fields. TelemetryView orchestrates the layout: MessageMonitor on left, plot grid on right. Phase 6 adds Gridstack — Phase 5 uses simple CSS grid for the plot area.

**Tech Stack:** SolidJS, TypeScript strict, uPlot 1.6, CSS variables (dark/light theme)

---

## Task 1: Plot Config Types (`src/models/plot-config.ts`)

Pure types file. No logic, no tests needed.

**Files:**
- Create: `src/models/plot-config.ts`
- Modify: `src/store/app-store.ts` (update `PlotTab` type)

**Step 1: Create the models directory and types file**

Create `src/models/plot-config.ts`:

```typescript
export type ScalingMode = 'auto' | 'unified' | 'independent';
export type TimeWindow = 5 | 10 | 30 | 60 | 120 | 300;

export interface PlotSignalConfig {
  id: string;
  messageType: string;
  fieldName: string;
  fieldKey: string;
  color: string;
  visible: boolean;
}

export interface PlotConfig {
  id: string;
  title: string;
  signals: PlotSignalConfig[];
  scalingMode: ScalingMode;
  timeWindow: TimeWindow;
  gridPos: { x: number; y: number; w: number; h: number };
}

export interface PlotTab {
  id: string;
  name: string;
  plots: PlotConfig[];
}

export const SIGNAL_COLORS = [
  '#00d4ff', '#00ff88', '#ff6b6b', '#ffd93d', '#c084fc',
  '#fb923c', '#38bdf8', '#4ade80', '#f472b6', '#a78bfa',
] as const;

export const DEFAULT_TIME_WINDOW: TimeWindow = 30;
```

**Step 2: Update app-store.ts**

Replace the `PlotTab` interface and import from models:

```typescript
// Remove the local PlotTab interface (lines 7-11)
// Add import:
import type { PlotTab, PlotConfig } from '../models/plot-config';

// Update initial state — plots becomes PlotConfig[] (empty):
plotTabs: [{ id: 'default', name: 'Tab 1', plots: [] }],
// (This line stays the same — empty array works for both string[] and PlotConfig[])
```

The key change: `plots: string[]` → `plots: PlotConfig[]` (from the imported type).

**Step 3: Build to verify types**

Run: `npm run build`
Expected: No type errors

**Step 4: Commit**

```
Phase 5.1: Add plot config types and update app store
```

---

## Task 2: PlotChart Component (`src/components/PlotChart.tsx`)

The core uPlot wrapper. Receives signal configs + data buffers, renders a live-scrolling chart.

**Files:**
- Create: `src/components/PlotChart.tsx`

**Step 1: Create PlotChart.tsx**

```tsx
import { onMount, onCleanup, createEffect } from 'solid-js';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { PlotSignalConfig, TimeWindow } from '../models/plot-config';
import { appState, workerBridge } from '../store/app-store';

interface PlotChartProps {
  signals: PlotSignalConfig[];
  timeWindow: TimeWindow;
  isPaused: boolean;
}

export default function PlotChart(props: PlotChartProps) {
  let containerRef: HTMLDivElement | undefined;
  let chart: uPlot | undefined;
  let rafId: number | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let unsubUpdate: (() => void) | undefined;

  // Store latest buffer data received from worker
  let latestBuffers: Map<string, { timestamps: Float64Array; values: Float64Array }> = new Map();

  onMount(() => {
    if (!containerRef) return;

    const rect = containerRef.getBoundingClientRect();

    const series: uPlot.Series[] = [
      { label: 'Time' }, // x-axis
      ...props.signals.filter(s => s.visible).map(sig => ({
        label: sig.fieldKey,
        stroke: sig.color,
        width: 1.5,
      })),
    ];

    const opts: uPlot.Options = {
      width: Math.max(rect.width, 100),
      height: Math.max(rect.height, 100),
      cursor: {
        sync: { key: 'telemetry' },
      },
      series,
      axes: [
        {
          stroke: 'var(--text-secondary)',
          grid: { stroke: 'var(--border)', width: 1 },
        },
        {
          stroke: 'var(--text-secondary)',
          grid: { stroke: 'var(--border)', width: 1 },
        },
      ],
      scales: {
        x: { time: true },
      },
    };

    // Initialize with empty data
    const emptyData: uPlot.AlignedData = [
      new Float64Array(0),
      ...props.signals.filter(s => s.visible).map(() => new Float64Array(0)),
    ];

    chart = new uPlot(opts, emptyData, containerRef);

    // Subscribe to worker updates
    if (appState.isReady) {
      unsubUpdate = workerBridge.onUpdate(buffers => {
        latestBuffers = buffers;
      });
    }

    // RAF loop for live chart updates
    function tick() {
      if (chart && !props.isPaused) {
        updateChart();
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    // ResizeObserver for responsive sizing
    let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
    resizeObserver = new ResizeObserver(entries => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const entry = entries[0];
        if (entry && chart) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            chart.setSize({ width, height });
          }
        }
      }, 100);
    });
    resizeObserver.observe(containerRef);
  });

  function updateChart() {
    if (!chart) return;

    const visibleSignals = props.signals.filter(s => s.visible);
    if (visibleSignals.length === 0) return;

    // Find the first signal with data to use as the time axis
    let timestamps: Float64Array | null = null;
    const seriesData: (Float64Array | null)[] = [];

    for (const sig of visibleSignals) {
      const buf = latestBuffers.get(sig.fieldKey);
      if (buf && buf.timestamps.length > 0) {
        if (!timestamps) {
          timestamps = buf.timestamps;
        }
        seriesData.push(buf.values);
      } else {
        seriesData.push(null);
      }
    }

    if (!timestamps || timestamps.length === 0) return;

    // Build uPlot data array: [timestamps, series1, series2, ...]
    // All series must be same length — pad missing with nulls
    const len = timestamps.length;
    const data: uPlot.AlignedData = [timestamps];

    for (const sd of seriesData) {
      if (sd && sd.length === len) {
        data.push(sd);
      } else if (sd && sd.length !== len) {
        // Different lengths — use the shorter one padded
        const padded = new Float64Array(len);
        padded.set(sd.subarray(0, Math.min(sd.length, len)));
        data.push(padded);
      } else {
        // No data for this signal
        const empty = new Float64Array(len);
        empty.fill(NaN);
        data.push(empty);
      }
    }

    const now = Date.now() / 1000;
    chart.setData(data, false);
    chart.setScale('x', {
      min: now - props.timeWindow,
      max: now,
    });
  }

  // React to isPaused changes — when un-paused, jump to live
  createEffect(() => {
    if (!props.isPaused && chart) {
      updateChart();
    }
  });

  onCleanup(() => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    resizeObserver?.disconnect();
    unsubUpdate?.();
    chart?.destroy();
  });

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', 'min-height': '80px' }}
    />
  );
}
```

**Key design decisions:**
- `workerBridge.onUpdate()` fires at 60Hz from the worker. We store latest buffers and read them in the RAF loop. This decouples data arrival from rendering.
- `setData(data, false)` — the `false` prevents uPlot from auto-ranging axes, so we control the X window.
- `setScale('x', { min, max })` implements the live-scrolling time window.
- `ResizeObserver` with 100ms debounce handles container resize.
- All subscriptions cleaned up in `onCleanup`.

**Step 2: Build to verify types**

Run: `npm run build`
Expected: No type errors

**Step 3: Commit**

```
Phase 5.2: Add PlotChart component with uPlot live scrolling
```

---

## Task 3: PlotPanel Component (`src/components/PlotPanel.tsx`)

Wraps PlotChart with a header bar, live value display, and close button.

**Files:**
- Create: `src/components/PlotPanel.tsx`

**Step 1: Create PlotPanel.tsx**

```tsx
import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import PlotChart from './PlotChart';
import type { PlotConfig, TimeWindow } from '../models/plot-config';
import { appState, workerBridge } from '../store/app-store';

interface PlotPanelProps {
  config: PlotConfig;
  onClose: (plotId: string) => void;
  onOpenSignalSelector: (plotId: string) => void;
}

export default function PlotPanel(props: PlotPanelProps) {
  const [liveValues, setLiveValues] = createSignal<Map<string, number>>(new Map());

  // Track live values for display
  createEffect(() => {
    if (!appState.isReady) return;
    const unsub = workerBridge.onUpdate(buffers => {
      const vals = new Map<string, number>();
      for (const sig of props.config.signals) {
        if (!sig.visible) continue;
        const buf = buffers.get(sig.fieldKey);
        if (buf && buf.values.length > 0) {
          vals.set(sig.fieldKey, buf.values[buf.values.length - 1]);
        }
      }
      setLiveValues(vals);
    });
    onCleanup(unsub);
  });

  function formatLiveValue(val: number | undefined): string {
    if (val === undefined) return '—';
    if (Number.isInteger(val)) return String(val);
    return val.toFixed(4);
  }

  return (
    <div
      class="flex flex-col h-full rounded"
      style={{
        'background-color': 'var(--bg-panel)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        class="flex items-center justify-between px-2 py-1 border-b cursor-grab"
        style={{ 'border-color': 'var(--border)', 'min-height': '32px' }}
        onDblClick={() => props.onOpenSignalSelector(props.config.id)}
      >
        {/* Signal names */}
        <div class="flex items-center gap-2 flex-1 overflow-hidden">
          <For each={props.config.signals.filter(s => s.visible)}>
            {(sig) => (
              <span
                class="text-xs font-mono truncate"
                style={{ color: sig.color }}
              >
                {sig.fieldKey}
              </span>
            )}
          </For>
          <Show when={props.config.signals.filter(s => s.visible).length === 0}>
            <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>
              No signals
            </span>
          </Show>
        </div>
        {/* Close button */}
        <button
          class="p-0.5 rounded transition-colors flex-shrink-0"
          style={{ color: 'var(--text-secondary)' }}
          onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
          onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-secondary)'}
          onClick={(e) => {
            e.stopPropagation();
            props.onClose(props.config.id);
          }}
          title="Remove plot"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Live values bar */}
      <Show when={props.config.signals.filter(s => s.visible).length > 0}>
        <div
          class="flex items-center gap-3 px-2 py-1 border-b"
          style={{ 'border-color': 'var(--border)' }}
        >
          <For each={props.config.signals.filter(s => s.visible)}>
            {(sig) => (
              <span class="text-sm font-mono" style={{ color: sig.color }}>
                {formatLiveValue(liveValues().get(sig.fieldKey))}
              </span>
            )}
          </For>
        </div>
      </Show>

      {/* Chart area */}
      <div class="flex-1 min-h-0">
        <PlotChart
          signals={props.config.signals}
          timeWindow={props.config.timeWindow}
          isPaused={appState.isPaused}
        />
      </div>
    </div>
  );
}
```

**Step 2: Build to verify types**

Run: `npm run build`
Expected: No type errors

**Step 3: Commit**

```
Phase 5.3: Add PlotPanel component with header and live values
```

---

## Task 4: SignalSelector Component (`src/components/SignalSelector.tsx`)

A modal/dropdown for selecting which signals to add to a plot.

**Files:**
- Create: `src/components/SignalSelector.tsx`

**Step 1: Create SignalSelector.tsx**

```tsx
import { createSignal, createEffect, onCleanup, For, Show, batch } from 'solid-js';
import { appState, workerBridge } from '../store/app-store';
import { SIGNAL_COLORS } from '../models/plot-config';
import type { PlotConfig, PlotSignalConfig } from '../models/plot-config';

interface SignalSelectorProps {
  plotConfig: PlotConfig;
  onToggleSignal: (plotId: string, fieldKey: string) => void;
  onClose: () => void;
}

export default function SignalSelector(props: SignalSelectorProps) {
  const [availableFields, setAvailableFields] = createSignal<string[]>([]);
  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(new Set());

  // Get available fields from worker updates
  createEffect(() => {
    if (!appState.isReady) return;
    const unsub = workerBridge.onUpdate(buffers => {
      setAvailableFields(Array.from(buffers.keys()).sort());
    });
    onCleanup(unsub);
  });

  // Group fields by message type: { "ATTITUDE": ["roll", "pitch", ...], ... }
  function groupedFields(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const key of availableFields()) {
      const dotIdx = key.indexOf('.');
      if (dotIdx === -1) continue;
      const msgType = key.substring(0, dotIdx);
      const fieldName = key.substring(dotIdx + 1);
      if (!groups.has(msgType)) groups.set(msgType, []);
      groups.get(msgType)!.push(fieldName);
    }
    return groups;
  }

  function isSelected(fieldKey: string): boolean {
    return props.plotConfig.signals.some(s => s.fieldKey === fieldKey);
  }

  function getSignalColor(fieldKey: string): string | undefined {
    const sig = props.plotConfig.signals.find(s => s.fieldKey === fieldKey);
    return sig?.color;
  }

  function toggleGroup(msgType: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(msgType)) next.delete(msgType);
      else next.add(msgType);
      return next;
    });
  }

  return (
    <div
      class="fixed inset-0 flex items-center justify-center z-50"
      style={{ 'background-color': 'rgba(0,0,0,0.5)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        class="rounded-lg shadow-xl max-h-[70vh] w-[400px] flex flex-col"
        style={{
          'background-color': 'var(--bg-panel)',
          border: '1px solid var(--border)',
        }}
      >
        {/* Header */}
        <div
          class="flex items-center justify-between px-4 py-3 border-b"
          style={{ 'border-color': 'var(--border)' }}
        >
          <span class="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Select Signals
          </span>
          <button
            class="p-1 rounded transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            onClick={() => props.onClose()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Field list */}
        <div class="flex-1 overflow-y-auto p-2">
          <For each={Array.from(groupedFields().entries())}>
            {([msgType, fields]) => (
              <div class="mb-1">
                {/* Group header */}
                <button
                  class="flex items-center gap-2 w-full px-2 py-1.5 rounded text-left transition-colors"
                  style={{ color: 'var(--text-primary)' }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-hover)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  onClick={() => toggleGroup(msgType)}
                >
                  <svg
                    width="10" height="10" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2"
                    style={{
                      transform: expandedGroups().has(msgType) ? 'rotate(90deg)' : 'rotate(0deg)',
                      transition: 'transform 0.15s',
                    }}
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span class="text-xs font-mono font-semibold">{msgType}</span>
                  <span class="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    ({fields.length})
                  </span>
                </button>

                {/* Fields */}
                <Show when={expandedGroups().has(msgType)}>
                  <div class="ml-4">
                    <For each={fields}>
                      {(fieldName) => {
                        const fieldKey = `${msgType}.${fieldName}`;
                        const selected = () => isSelected(fieldKey);
                        const color = () => getSignalColor(fieldKey);

                        return (
                          <button
                            class="flex items-center gap-2 w-full px-2 py-1 rounded text-left transition-colors"
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-hover)'}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                            onClick={() => props.onToggleSignal(props.plotConfig.id, fieldKey)}
                          >
                            {/* Color dot or checkbox */}
                            <div
                              class="w-3 h-3 rounded-sm border flex-shrink-0"
                              style={{
                                'background-color': selected() ? (color() ?? 'var(--accent)') : 'transparent',
                                'border-color': selected() ? (color() ?? 'var(--accent)') : 'var(--text-secondary)',
                              }}
                            />
                            <span
                              class="text-xs font-mono"
                              style={{ color: selected() ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                            >
                              {fieldName}
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>

          <Show when={availableFields().length === 0}>
            <div class="text-center py-4 text-xs" style={{ color: 'var(--text-secondary)' }}>
              No data received yet. Connect to start seeing fields.
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Build to verify types**

Run: `npm run build`
Expected: No type errors

**Step 3: Commit**

```
Phase 5.4: Add SignalSelector modal for field selection
```

---

## Task 5: TelemetryView Component + App.tsx Wiring (`src/components/TelemetryView.tsx`)

This is the integration task. TelemetryView manages the plot state, wires MessageMonitor's `onFieldSelected` to plot creation, and renders the plot grid.

**Files:**
- Create: `src/components/TelemetryView.tsx`
- Modify: `src/App.tsx` (replace placeholder with TelemetryView)

**Step 1: Create TelemetryView.tsx**

```tsx
import { createSignal, For, Show, batch } from 'solid-js';
import { appState, setAppState } from '../store/app-store';
import MessageMonitor from './MessageMonitor';
import PlotPanel from './PlotPanel';
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
        <div class="flex-1 overflow-auto p-2">
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
            <div
              class="grid gap-2"
              style={{
                'grid-template-columns': 'repeat(auto-fill, minmax(400px, 1fr))',
              }}
            >
              <For each={currentPlots()}>
                {(plot) => (
                  <div style={{ height: '300px' }}>
                    <PlotPanel
                      config={plot}
                      onClose={handleClosePlot}
                      onOpenSignalSelector={handleOpenSignalSelector}
                    />
                  </div>
                )}
              </For>
            </div>
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
```

**Step 2: Update App.tsx**

Replace the placeholder telemetry section in `App.tsx`:

```tsx
// Add import at top:
import TelemetryView from './components/TelemetryView';

// Replace the Show when={appState.activeTab === 'telemetry'} block:
<Show when={appState.activeTab === 'telemetry'}>
  <TelemetryView />
</Show>
```

Remove the `MessageMonitor` import from App.tsx since TelemetryView now manages it.

**Step 3: Build and run tests**

Run: `npm run build`
Expected: No type errors

Run: `npx vitest run`
Expected: All existing tests pass

**Step 4: Commit**

```
Phase 5.5: Add TelemetryView with plot management and wire into App
```

---

## Task 6: Playwright Visual Verification

Start the dev server and verify end-to-end with Playwright MCP.

**Step 1: Start dev server**

Run in background: `npm run dev`

**Step 2: Verify the full flow**

1. `browser_navigate` → `http://localhost:5173`
2. `browser_snapshot` → verify Toolbar, TabBar, MessageMonitor, empty plot area visible
3. `browser_click` → "Connect Spoof" button
4. `browser_wait_for` → text "ATTITUDE" (messages should appear in monitor)
5. `browser_click` → expand ATTITUDE in the message monitor
6. `browser_click` → click "roll" field
7. `browser_wait_for` → time=2 (let plot render with live data)
8. `browser_snapshot` → verify a PlotPanel exists with "ATTITUDE.roll" signal label
9. `browser_take_screenshot` → verify chart has a visible trace
10. `browser_click` → expand ATTITUDE again if collapsed, click "pitch" field
11. `browser_snapshot` → verify second plot panel appeared
12. `browser_console_messages(level="error")` → no JS errors
13. `browser_click` → "+ Add Plot" button
14. `browser_snapshot` → verify empty plot appeared, signal selector opened

**Step 3: Fix any issues found, re-verify**

Iterate on Playwright → fix → snapshot loop until all acceptance criteria pass.

**Step 4: Final commit if fixes were needed**

```
Phase 5: Fix visual issues found during Playwright verification
```

---

## Acceptance Criteria Checklist

From PLAN.md Phase 5 tasks:

**Task 5.2 (PlotChart):**
- [ ] Renders a uPlot chart with live data from ring buffer
- [ ] Multiple series render with different colors
- [ ] Auto-scrolls in live mode
- [ ] Pause stops scrolling, resume jumps to live
- [ ] Crosshair sync works between multiple PlotChart instances
- [ ] Resizes correctly when container changes size

**Task 5.3 (PlotPanel):**
- [ ] Renders header + chart
- [ ] Close button removes the panel
- [ ] Drag handle works with gridstack (deferred to Phase 6)
- [ ] Live value updates in real-time

**Task 5.4 (SignalSelector):**
- [ ] Shows all available fields grouped by message
- [ ] Toggle adds/removes signal from the plot
- [ ] Only numeric fields appear (worker only sends numeric fields)
- [ ] Color assignment from palette

**Task 5.5 (TelemetryView):**
- [ ] MessageMonitor + plot area render side by side
- [ ] "Add Plot" creates a new empty plot panel
- [ ] Click field in monitor → signal appears in a plot
- [ ] Time window selector changes all plots' X range
- [ ] Pause/resume affects all plots (via appState.isPaused)
