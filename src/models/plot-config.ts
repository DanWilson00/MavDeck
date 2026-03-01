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

/** Darker variants of SIGNAL_COLORS for legibility on light backgrounds. */
const SIGNAL_COLORS_LIGHT: readonly string[] = [
  '#0099bb', '#00b85e', '#d93636', '#c9a200', '#8b4fcf',
  '#d06e1a', '#1a8fc2', '#2da05e', '#d14a8b', '#7c5fd6',
];

const DARK_TO_LIGHT = new Map<string, string>(
  SIGNAL_COLORS.map((dark, i) => [dark, SIGNAL_COLORS_LIGHT[i]]),
);

/** Return the theme-appropriate color for a canonical (dark-palette) signal color. */
export function getThemeColor(canonicalColor: string, theme: 'dark' | 'light'): string {
  if (theme === 'dark') return canonicalColor;
  return DARK_TO_LIGHT.get(canonicalColor) ?? canonicalColor;
}

export const DEFAULT_TIME_WINDOW: TimeWindow = 30;
