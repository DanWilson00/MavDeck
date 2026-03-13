import type { ConnectionStatus } from '../services';

export const STATUS_COLORS: Record<ConnectionStatus, string> = {
  disconnected: '#71717a',
  connecting: '#eab308',
  connected: '#00d4ff',
  error: '#ef4444',
};

export {
  SIGNAL_COLORS,
  DEFAULT_TIME_WINDOW,
  getThemeColor,
  type ScalingMode,
  type TimeWindow,
  type PlotSignalConfig,
  type PlotConfig,
  type PlotTab,
} from './plot-config';
