import type { AppState } from './app-store';

export type StatusTone = 'neutral' | 'accent' | 'good' | 'warn' | 'error';

export interface StatusBadgeModel {
  label: string;
  tone: StatusTone;
}

export interface StatusBarModel {
  headline: string;
  headlineTone: StatusTone;
  badges: StatusBadgeModel[];
  details: string[];
}

const CONNECTION_LABELS: Record<AppState['connectionStatus'], string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  no_data: 'No Data',
  error: 'Error',
  probing: 'Probing',
};

export function formatStatusDuration(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatStatusThroughput(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} KB/s`;
  return `${bps} B/s`;
}

export function selectStatusBarModel(state: AppState, serialSupported: boolean): StatusBarModel {
  if (state.logViewerState.isActive) {
    const details = [
      formatStatusDuration(state.logViewerState.durationSec),
      `${state.logViewerState.recordCount.toLocaleString()} records`,
    ];
    if (state.dialectName) {
      details.push(state.dialectName);
    }

    return {
      headline: state.logViewerState.sourceName || 'Log Playback',
      headlineTone: 'accent',
      badges: [
        { label: 'Log', tone: 'accent' },
        { label: 'Playback', tone: 'good' },
      ],
      details,
    };
  }

  const badges: StatusBadgeModel[] = [];
  const details: string[] = [];
  const headline = CONNECTION_LABELS[state.connectionStatus] ?? 'Unknown';
  const headlineTone = connectionTone(state.connectionStatus);

  if (state.connectionSourceType === 'spoof') {
    badges.push({ label: 'Simulator', tone: 'accent' });
  }

  if (state.isPaused && (state.connectionStatus === 'connected' || state.connectionStatus === 'no_data')) {
    badges.push({ label: 'Paused', tone: 'warn' });
  }

  if (state.connectionStatus === 'no_data') {
    badges.push({ label: 'Waiting for Data', tone: 'warn' });
  } else if (state.connectionStatus === 'probing') {
    badges.push({ label: 'Probing', tone: 'warn' });
  } else if (state.connectionStatus === 'error') {
    badges.push({ label: 'Attention', tone: 'error' });
  }

  if (state.connectionSourceType === 'serial' && (state.connectionStatus === 'connected' || state.connectionStatus === 'no_data')) {
    details.push(`${state.connectedBaudRate ?? state.baudRate} baud`);
  }

  if (state.connectionStatus === 'connected' && state.throughputBytesPerSec > 0) {
    details.push(formatStatusThroughput(state.throughputBytesPerSec));
  }

  if (state.dialectName) {
    details.push(state.dialectName);
  }

  if (!serialSupported) {
    badges.push({ label: 'Serial Unavailable', tone: 'warn' });
  }

  return { headline, headlineTone, badges, details };
}

function connectionTone(status: AppState['connectionStatus']): StatusTone {
  switch (status) {
    case 'connected':
      return 'good';
    case 'connecting':
    case 'probing':
    case 'no_data':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'neutral';
  }
}
