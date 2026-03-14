import type { PlotConfig, PlotSignalConfig, PlotTab, TimeWindow } from '../models';

export interface PersistedPlotSignalV1 {
  id: string;
  messageType: string;
  fieldName: string;
  fieldKey: string;
  color: string;
  visible: boolean;
}

export interface PersistedPlotV1 {
  id: string;
  title: string;
  signals: PersistedPlotSignalV1[];
  scalingMode: PlotConfig['scalingMode'];
  timeWindow: TimeWindow;
  gridPos: PlotConfig['gridPos'];
}

export interface PersistedPlotTabV1 {
  id: string;
  name: string;
  plots: PersistedPlotV1[];
}

function cloneSignal(signal: PlotSignalConfig): PersistedPlotSignalV1 {
  return {
    id: signal.id,
    messageType: signal.messageType,
    fieldName: signal.fieldName,
    fieldKey: signal.fieldKey,
    color: signal.color,
    visible: signal.visible,
  };
}

function clonePlot(plot: PlotConfig): PersistedPlotV1 {
  return {
    id: plot.id,
    title: plot.title,
    signals: plot.signals.map(cloneSignal),
    scalingMode: plot.scalingMode,
    timeWindow: plot.timeWindow,
    gridPos: { ...plot.gridPos },
  };
}

export function serializePlotTabs(tabs: PlotTab[]): PersistedPlotTabV1[] {
  return tabs.map(tab => ({
    id: tab.id,
    name: tab.name,
    plots: tab.plots.map(clonePlot),
  }));
}

export function deserializePlotTabs(tabs: PersistedPlotTabV1[]): PlotTab[] {
  return tabs.map(tab => ({
    id: tab.id,
    name: tab.name,
    plots: tab.plots.map(plot => ({
      id: plot.id,
      title: plot.title,
      signals: plot.signals.map(cloneSignal),
      scalingMode: plot.scalingMode,
      timeWindow: plot.timeWindow,
      gridPos: { ...plot.gridPos },
    })),
  }));
}
