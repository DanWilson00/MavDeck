import { onMount, onCleanup, createEffect, createMemo } from 'solid-js';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { PlotSignalConfig, TimeWindow } from '../models/plot-config';
import { appState, workerBridge } from '../store/app-store';

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
    // Advance source index to the last sample at or before target time
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

/** Format a numeric value for display. */
function formatValue(v: number): string {
  if (Number.isNaN(v)) return '--';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4);
}

/** uPlot plugin: tooltip near crosshair showing signal values. */
function cursorTooltipPlugin(isActive: () => boolean): uPlot.Plugin {
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
    for (let i = 1; i < u.series.length; i++) {
      const s = u.series[i];
      if (!s.show) continue;
      const val = u.data[i]?.[idx];
      const color = typeof s.stroke === 'function' ? s.stroke(u, i) : s.stroke;
      html += `<span style="color:${color as string}">\u25CF ${s.label}: ${val != null ? formatValue(val) : '--'}</span><br>`;
    }

    if (!html) {
      tooltip.style.display = 'none';
      return;
    }

    tooltip.innerHTML = html;
    tooltip.style.display = 'block';

    // Position near cursor, offset to the right; flip left if near right edge
    const left = u.cursor.left!;
    const top = u.cursor.top!;
    const overW = u.over.clientWidth;

    const pad = 12;
    if (left + pad + tooltip.offsetWidth > overW) {
      tooltip.style.left = (left - tooltip.offsetWidth - pad) + 'px';
    } else {
      tooltip.style.left = (left + pad) + 'px';
    }
    tooltip.style.top = Math.max(0, top - tooltip.offsetHeight - 4) + 'px';
  }

  return { hooks: { init: [init], setCursor: [setCursor] } };
}

// Module-level flag: true only during an explicit user wheel-zoom.
// Shared across all instances so synced charts can also detect user zoom.
let userWheelZooming = false;

/** uPlot plugin: mouse-wheel zoom on the X axis. */
function wheelZoomPlugin(): uPlot.Plugin {
  return {
    hooks: {
      init(u: uPlot) {
        u.over.addEventListener('wheel', (e: WheelEvent) => {
          e.preventDefault();
          const rect = u.over.getBoundingClientRect();
          const cursorFrac = (e.clientX - rect.left) / rect.width;

          const xMin = u.scales.x.min!;
          const xMax = u.scales.x.max!;
          const range = xMax - xMin;
          const factor = e.deltaY > 0 ? 1 / 0.75 : 0.75; // scroll down = zoom out
          const newRange = range * factor;
          const delta = newRange - range;

          userWheelZooming = true;
          u.setScale('x', {
            min: xMin - delta * cursorFrac,
            max: xMax + delta * (1 - cursorFrac),
          });
          userWheelZooming = false;
        }, { passive: false });
      },
    },
  };
}

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
  let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
  let mounted = false;
  let hasNewBuffers = false;
  let isZoomed = false;

  // Store latest buffer data received from worker
  let latestBuffers: Map<string, { timestamps: Float64Array; values: Float64Array }> = new Map();

  function getVisibleSignals(): PlotSignalConfig[] {
    return props.signals.filter(s => s.visible);
  }

  function recreateChart() {
    if (!containerRef) return;

    const rect = containerRef.getBoundingClientRect();
    const series: uPlot.Series[] = [
      { label: 'Time' },
      ...getVisibleSignals().map(sig => ({
        label: sig.fieldKey,
        stroke: sig.color,
        width: 1.5,
      })),
    ];

    const colors = getChartColors();
    const opts: uPlot.Options = {
      width: Math.max(rect.width, 100),
      height: Math.max(rect.height, 80),
      legend: { show: false },
      cursor: {
        sync: { key: 'telemetry' },
        drag: { x: true, y: false },
        bind: {
          dblclick: () => () => {
            isZoomed = false;
            hasNewBuffers = true;
            updateChart();
            return null;
          },
        },
      },
      plugins: [wheelZoomPlugin(), cursorTooltipPlugin(() => isZoomed || props.isPaused)],
      series,
      axes: [
        {
          stroke: colors.axis,
          grid: { stroke: colors.grid, width: 1 },
        },
        {
          stroke: colors.axis,
          grid: { stroke: colors.grid, width: 1 },
        },
      ],
      scales: {
        x: { time: true },
      },
      hooks: {
        setScale: [
          (_u: uPlot, scaleKey: string) => {
            // Only set isZoomed from explicit user zoom actions:
            // wheel zoom (userWheelZooming flag) — NOT from programmatic
            // updates, cursor sync, or click interactions.
            if (scaleKey === 'x' && userWheelZooming) {
              isZoomed = true;
            }
          },
        ],
        setSelect: [
          (u: uPlot) => {
            // Drag-select zoom: user dragged a range selection
            if (u.select.width > 2) {
              isZoomed = true;
            }
          },
        ],
      },
    };

    const emptyData: uPlot.AlignedData = [
      new Float64Array(0),
      ...getVisibleSignals().map(() => new Float64Array(0)),
    ];

    isZoomed = false;
    chart?.destroy();
    chart = new uPlot(opts, emptyData, containerRef);
  }

  onMount(() => {
    if (!containerRef) return;

    // Subscribe to worker updates
    if (appState.isReady) {
      unsubUpdate = workerBridge.onUpdate(buffers => {
        latestBuffers = buffers;
        hasNewBuffers = true;
      });
    }

    // RAF loop for live chart updates
    function tick() {
      if (chart && !props.isPaused && hasNewBuffers) {
        updateChart();
        hasNewBuffers = false;
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    // ResizeObserver for responsive sizing
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
  });

  function updateChart() {
    if (!chart) return;

    const visibleSignals = getVisibleSignals();
    if (visibleSignals.length === 0) return;

    // Collect buffers for each visible signal
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

    // Build uPlot data: use longest timestamp array as shared x-axis,
    // resample lower-rate signals via sample-and-hold
    const len = longestTimestamps.length;
    const data: uPlot.AlignedData = [longestTimestamps];

    for (const buf of buffers) {
      if (!buf) {
        const empty = new Float64Array(len);
        empty.fill(NaN);
        data.push(empty);
      } else if (buf.timestamps === longestTimestamps) {
        // Same buffer — use directly
        data.push(buf.values);
      } else {
        // Different rate — resample onto the longest timestamps
        data.push(resampleSampleAndHold(buf.timestamps, buf.values, longestTimestamps));
      }
    }

    chart.batch(() => {
      chart!.setData(data, false);
      if (!isZoomed) {
        const now = Date.now() / 1000;
        chart!.setScale('x', {
          min: now - props.timeWindow,
          max: now,
        });
      }
    });
  }

  // Memoize signal identity to prevent spurious chart recreations
  const signalKey = createMemo(() =>
    getVisibleSignals().map(s => `${s.fieldKey}:${s.color}`).join('|')
  );

  // Recreate chart when theme or visible signal set changes.
  createEffect(() => {
    appState.theme;
    signalKey();
    if (!mounted || !containerRef) return;
    recreateChart();
    hasNewBuffers = true;
  });

  // React to pause/window changes — on resume or window change, redraw immediately.
  createEffect(() => {
    props.timeWindow;
    if (!props.isPaused && chart) {
      isZoomed = false;
      hasNewBuffers = true;
      updateChart();
    }
  });

  onCleanup(() => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    clearTimeout(resizeTimeout);
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
