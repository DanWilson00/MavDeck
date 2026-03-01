import { onMount, onCleanup, createEffect } from 'solid-js';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { PlotSignalConfig, TimeWindow } from '../models/plot-config';
import { appState, workerBridge } from '../store/app-store';

function getChartColors(): { grid: string; axis: string } {
  const style = getComputedStyle(document.documentElement);
  return {
    grid: style.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,0.06)',
    axis: style.getPropertyValue('--chart-axis').trim() || '#888',
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

    const colors = getChartColors();
    const opts: uPlot.Options = {
      width: Math.max(rect.width, 100),
      height: Math.max(rect.height, 100),
      cursor: {
        sync: { key: 'telemetry' },
      },
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

  // Recreate chart when theme changes (uPlot doesn't support dynamic option updates)
  createEffect(() => {
    const _theme = appState.theme; // track theme
    if (!chart || !containerRef) return;

    const colors = getChartColors();
    const rect = containerRef.getBoundingClientRect();

    const visibleSignals = props.signals.filter(s => s.visible);
    const series: uPlot.Series[] = [
      { label: 'Time' },
      ...visibleSignals.map(sig => ({
        label: sig.fieldKey,
        stroke: sig.color,
        width: 1.5,
      })),
    ];

    const opts: uPlot.Options = {
      width: Math.max(rect.width, 100),
      height: Math.max(rect.height, 100),
      cursor: { sync: { key: 'telemetry' } },
      series,
      axes: [
        { stroke: colors.axis, grid: { stroke: colors.grid, width: 1 } },
        { stroke: colors.axis, grid: { stroke: colors.grid, width: 1 } },
      ],
      scales: { x: { time: true } },
    };

    const emptyData: uPlot.AlignedData = [
      new Float64Array(0),
      ...visibleSignals.map(() => new Float64Array(0)),
    ];

    chart.destroy();
    chart = new uPlot(opts, emptyData, containerRef);
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
