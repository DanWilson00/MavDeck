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
