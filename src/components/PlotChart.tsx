import { onMount, onCleanup, createEffect, createMemo } from 'solid-js';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { PlotSignalConfig, TimeWindow } from '../models';
import { getThemeColor } from '../models';
import {
  convertDisplayValues,
  formatDisplayValue,
  formatSignalDisplayLabel,
  getSignalDisplayUnit,
  getSignalRawUnit,
  useRegistry,
  useWorkerBridge,
} from '../services';
import { appState } from '../store';
import type { PlotInteractionController } from '../core';

/**
 * Resample `src` onto `target` timestamps using sample-and-hold (zero-order hold).
 * Both arrays must be sorted ascending. O(n) linear walk.
 * Returns NaN for target timestamps before the first source sample.
 */
function resampleSampleAndHold(
  srcTimestamps: Float64Array,
  srcValues: Float64Array,
  targetTimestamps: Float64Array,
): Float64Array {
  const out = new Float64Array(targetTimestamps.length);
  let si = 0;
  const srcLen = srcTimestamps.length;

  for (let ti = 0; ti < targetTimestamps.length; ti++) {
    const t = targetTimestamps[ti];
    while (si < srcLen - 1 && srcTimestamps[si + 1] <= t) {
      si++;
    }
    if (srcTimestamps[si] <= t) {
      out[ti] = srcValues[si];
    } else {
      out[ti] = NaN;
    }
  }
  return out;
}

function getChartColors(): { grid: string; axis: string } {
  const style = getComputedStyle(document.documentElement);
  return {
    grid: style.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,0.06)',
    axis: style.getPropertyValue('--chart-axis').trim() || '#888',
  };
}

function safeYRange(_u: uPlot, min: number | null, max: number | null): [number, number] {
  if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 1];
  }
  if (min === max) {
    const pad = Math.abs(min) > 1 ? Math.abs(min) * 0.1 : 1;
    return [min - pad, max + pad];
  }
  return [min, max];
}

function formatValue(v: number, displayUnit: string, fieldName?: string): string {
  if (Number.isNaN(v)) return '--';
  return formatDisplayValue(v, displayUnit, 'plot', { fieldName });
}

function cursorTooltipPlugin(
  isActive: () => boolean,
  getSignals: () => PlotSignalConfig[],
  getSignalUnit: (signal: PlotSignalConfig) => string,
): uPlot.Plugin {
  let tooltip: HTMLDivElement;

  function init(u: uPlot) {
    tooltip = document.createElement('div');
    tooltip.style.cssText =
      'display:none;position:absolute;pointer-events:none;z-index:10;' +
      'background:rgba(0,0,0,0.78);color:#e4e4e7;font:11px/1.4 ui-monospace,monospace;' +
      'padding:4px 8px;border-radius:4px;white-space:nowrap;';
    u.over.appendChild(tooltip);
  }

  function setCursor(u: uPlot) {
    const idx = u.cursor.idx;
    if (idx == null || !isActive()) {
      tooltip.style.display = 'none';
      return;
    }

    let html = '';
    const signals = getSignals();
    for (let i = 1; i < u.series.length; i++) {
      const s = u.series[i];
      if (!s.show) continue;
      const val = u.data[i]?.[idx];
      const color = typeof s.stroke === 'function' ? s.stroke(u, i) : s.stroke;
      const sig = signals[i - 1];
      const displayUnit = sig ? getSignalUnit(sig) : '';
      html += `<span style="color:${color as string}">\u25CF ${s.label}: ${val != null ? formatValue(val, displayUnit, sig?.fieldName) : '--'}</span><br>`;
    }

    if (!html) {
      tooltip.style.display = 'none';
      return;
    }

    tooltip.innerHTML = html;
    tooltip.style.display = 'block';

    const left = u.cursor.left!;
    const top = u.cursor.top!;
    const overW = u.over.clientWidth;
    const pad = 12;

    if (left + pad + tooltip.offsetWidth > overW) {
      tooltip.style.left = `${left - tooltip.offsetWidth - pad}px`;
    } else {
      tooltip.style.left = `${left + pad}px`;
    }
    tooltip.style.top = `${Math.max(0, top - tooltip.offsetHeight - 4)}px`;
  }

  return { hooks: { init: [init], setCursor: [setCursor] } };
}

interface PlotChartProps {
  plotId: string;
  interactionGroupId: string;
  interactionController: PlotInteractionController;
  signals: PlotSignalConfig[];
  timeWindow: TimeWindow;
  isPaused: boolean;
}

export default function PlotChart(props: PlotChartProps) {
  const registry = useRegistry();
  const workerBridge = useWorkerBridge();
  let containerRef: HTMLDivElement | undefined;
  let chart: uPlot | undefined;
  let rafId: number | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let unsubUpdate: (() => void) | undefined;
  let unsubInteraction: (() => void) | undefined;
  let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
  let mounted = false;
  let hasNewBuffers = false;
  let interactionMode: 'live' | 'zoomed' = 'live';
  let currentZoomRange: { min: number; max: number } | null = null;

  let latestBuffers: Map<string, { timestamps: Float64Array; values: Float64Array }> = new Map();

  function getVisibleSignals(): PlotSignalConfig[] {
    return props.signals.filter(s => s.visible);
  }

  function applyZoomRange(range: { min: number; max: number } | null) {
    if (!chart) return;
    if (!range) return;
    chart.setScale('x', range);
  }

  function resetToDefaultRange() {
    if (!chart) return;
    if (appState.logViewerState.isActive) {
      fitToLogRange();
    } else {
      const now = Date.now() / 1000;
      chart.setScale('x', {
        min: now - props.timeWindow,
        max: now,
      });
    }
  }

  function fitToLogRange() {
    if (!chart || !chart.data[0] || chart.data[0].length === 0) return;
    const ts = chart.data[0];
    const min = ts[0];
    const max = ts[ts.length - 1];
    if (min === max) {
      chart.setScale('x', { min: min - 1, max: max + 1 });
    } else {
      const pad = (max - min) * 0.02;
      chart.setScale('x', { min: min - pad, max: max + pad });
    }
  }

  function recreateChart() {
    if (!containerRef) return;

    const rect = containerRef.getBoundingClientRect();
    const colors = getChartColors();
    const series: uPlot.Series[] = [
      { label: 'Time' },
      ...getVisibleSignals().map(sig => ({
        label: formatSignalDisplayLabel(registry, sig, appState.unitProfile),
        stroke: getThemeColor(sig.color, appState.theme),
        width: 1.5,
        points: { show: false },
      })),
    ];

    const opts: uPlot.Options = {
      width: Math.max(rect.width, 100),
      height: Math.max(rect.height, 80),
      legend: { show: false },
      cursor: {
        sync: { key: props.interactionGroupId },
        drag: { x: false, y: false, setScale: false },
        bind: {
          dblclick: (_u, _target, handler) => (e: MouseEvent) => {
            handler(e);
            props.interactionController.emitReset(props.plotId);
            return null;
          },
        },
      },
      plugins: [cursorTooltipPlugin(
        () => interactionMode === 'zoomed' || props.isPaused,
        getVisibleSignals,
        signal => getSignalDisplayUnit(registry, signal, appState.unitProfile),
      )],
      series,
      axes: [
        { stroke: colors.axis, grid: { stroke: colors.grid, width: 1 } },
        { stroke: colors.axis, grid: { stroke: colors.grid, width: 1 } },
      ],
      scales: {
        x: { time: true },
        y: { auto: true, range: safeYRange },
      },
    };

    const emptyData: uPlot.AlignedData = [
      new Float64Array(0),
      ...getVisibleSignals().map(() => new Float64Array(0)),
    ];

    chart?.destroy();
    chart = new uPlot(opts, emptyData, containerRef);

    chart.over.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      if (!chart) return;
      const xMin = chart.scales.x.min;
      const xMax = chart.scales.x.max;
      if (xMin == null || xMax == null) return;

      const rectOver = chart.over.getBoundingClientRect();
      const cursorFrac = (e.clientX - rectOver.left) / rectOver.width;
      const range = xMax - xMin;
      const factor = e.deltaY > 0 ? 1 / 0.75 : 0.75;
      const newRange = range * factor;
      const delta = newRange - range;
      let nextMin = xMin - delta * cursorFrac;
      let nextMax = xMax + delta * (1 - cursorFrac);

      // On zoom-out, clamp to data bounds with 5% padding
      if (factor > 1 && chart.data[0] && chart.data[0].length > 0) {
        const ts = chart.data[0];
        const dataMin = ts[0];
        const dataMax = ts[ts.length - 1];
        const pad = (dataMax - dataMin) * 0.05 || 1;
        nextMin = Math.max(nextMin, dataMin - pad);
        nextMax = Math.min(nextMax, dataMax + pad);
      }

      if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax) || nextMax <= nextMin) return;
      props.interactionController.emitZoom({ min: nextMin, max: nextMax }, props.plotId);
    }, { passive: false });
  }

  onMount(() => {
    if (!containerRef) return;

    if (appState.isReady) {
      unsubUpdate = workerBridge.onUpdate(buffers => {
        latestBuffers = buffers;
        hasNewBuffers = true;
      });
    }

    const initialSnapshot = props.interactionController.getSnapshot();
    interactionMode = initialSnapshot.mode;
    currentZoomRange = initialSnapshot.zoomRange;
    unsubInteraction = props.interactionController.subscribe(snapshot => {
      interactionMode = snapshot.mode;
      currentZoomRange = snapshot.zoomRange;
      if (!chart) return;
      if (snapshot.mode === 'zoomed' && snapshot.zoomRange) {
        applyZoomRange(snapshot.zoomRange);
      } else {
        hasNewBuffers = true;
        resetToDefaultRange();
      }
    });

    function tick() {
      if (chart && hasNewBuffers) {
        updateChart();
        hasNewBuffers = false;
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

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

    mounted = true;
    recreateChart();
    hasNewBuffers = true;
    updateChart();
  });

  function updateChart() {
    if (!chart) return;
    const visibleSignals = getVisibleSignals();
    if (visibleSignals.length === 0) return;

    const buffers: ({ timestamps: Float64Array; values: Float64Array } | null)[] = [];
    let longestTimestamps: Float64Array | null = null;

    for (const sig of visibleSignals) {
      const buf = latestBuffers.get(sig.fieldKey);
      if (buf && buf.timestamps.length > 0) {
        buffers.push(buf);
        if (!longestTimestamps || buf.timestamps.length > longestTimestamps.length) {
          longestTimestamps = buf.timestamps;
        }
      } else {
        buffers.push(null);
      }
    }

    if (!longestTimestamps || longestTimestamps.length === 0) return;
    const len = longestTimestamps.length;
    const data: uPlot.AlignedData = [longestTimestamps];

    for (const buf of buffers) {
      if (!buf) {
        const empty = new Float64Array(len);
        empty.fill(NaN);
        data.push(empty);
      } else {
        const sig = visibleSignals[data.length - 1];
        const rawValues = buf.timestamps === longestTimestamps
          ? buf.values
          : resampleSampleAndHold(buf.timestamps, buf.values, longestTimestamps);
        const rawUnit = getSignalRawUnit(registry, sig);
        data.push(convertDisplayValues(
          rawValues,
          rawUnit,
          appState.unitProfile,
          { messageType: sig.messageType, fieldName: sig.fieldName },
        ));
      }
    }

    chart.batch(() => {
      chart!.setData(data, false);
      if (interactionMode === 'zoomed' && currentZoomRange) {
        applyZoomRange(currentZoomRange);
      } else {
        resetToDefaultRange();
      }
    });
  }

  const signalKey = createMemo(() =>
    getVisibleSignals().map(s => `${s.fieldKey}:${s.color}`).join('|'),
  );

  createEffect(() => {
    appState.theme;
    appState.unitProfile;
    signalKey();
    if (!mounted || !containerRef) return;
    recreateChart();
    hasNewBuffers = true;
    updateChart();
  });

  createEffect(() => {
    props.timeWindow;
    if (!chart) return;
    if (interactionMode === 'live') {
      hasNewBuffers = true;
      updateChart();
    }
  });

  onCleanup(() => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    clearTimeout(resizeTimeout);
    resizeObserver?.disconnect();
    unsubUpdate?.();
    unsubInteraction?.();
    chart?.destroy();
  });

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', 'min-height': '80px' }}
    />
  );
}
