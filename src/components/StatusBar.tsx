import { Show } from 'solid-js';
import { appState } from '../store';
import { isSerialSupported } from '../services';
import { STATUS_COLORS } from '../models';

const STATUS_LABELS: Record<string, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  no_data: 'No Data',
  error: 'Error',
  probing: 'Probing',
};

function formatThroughput(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} KB/s`;
  return `${bps} B/s`;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function Divider() {
  return (
    <div
      style={{
        width: '1px',
        height: '14px',
        'background-color': 'var(--border)',
        'flex-shrink': '0',
      }}
    />
  );
}

function ConnectionSection() {
  return (
    <div class="flex items-center gap-1.5">
      <div
        style={{
          width: '7px',
          height: '7px',
          'border-radius': '50%',
          'background-color': STATUS_COLORS[appState.connectionStatus] ?? '#71717a',
          'flex-shrink': '0',
        }}
      />
      <span>{STATUS_LABELS[appState.connectionStatus] ?? 'Unknown'}</span>
    </div>
  );
}

function LogPlaybackSection() {
  return (
    <div class="flex items-center gap-1.5">
      <span style={{ color: '#22c55e' }}>&#9654;</span>
      <span>{appState.logViewerState.sourceName}</span>
      <Divider />
      <span>{formatDuration(appState.logViewerState.durationSec)}</span>
    </div>
  );
}

export default function StatusBar() {
  return (
    <footer
      class="flex items-center gap-2 px-3 shrink-0"
      style={{
        height: '24px',
        'background-color': 'var(--bg-panel)',
        'border-top': '1px solid var(--border)',
        'font-size': '11px',
        'font-family': 'monospace',
        color: 'var(--text-secondary)',
      }}
    >
      {/* Connection or Log Playback */}
      <Show when={appState.logViewerState.isActive} fallback={<ConnectionSection />}>
        <LogPlaybackSection />
      </Show>

      {/* Baud rate — only when connected via serial */}
      <Show when={!appState.logViewerState.isActive && appState.connectionSourceType === 'serial' && (appState.connectionStatus === 'connected' || appState.connectionStatus === 'no_data')}>
        <Divider />
        <span>{appState.connectedBaudRate ?? appState.baudRate} baud</span>
      </Show>

      {/* Spoof label — only when connected via spoof */}
      <Show when={!appState.logViewerState.isActive && appState.connectionSourceType === 'spoof' && appState.connectionStatus === 'connected'}>
        <Divider />
        <span>Spoof</span>
      </Show>

      {/* Data throughput — only when connected and data is flowing */}
      <Show when={!appState.logViewerState.isActive && appState.connectionStatus === 'connected' && appState.throughputBytesPerSec > 0}>
        <Divider />
        <span>{formatThroughput(appState.throughputBytesPerSec)}</span>
      </Show>

      {/* Dialect name — always shown */}
      <Show when={appState.dialectName}>
        <Divider />
        <span>{appState.dialectName}</span>
      </Show>

      {/* Browser warning — no Web Serial */}
      <Show when={!isSerialSupported()}>
        <Divider />
        <span style={{ color: '#eab308' }}>&#9888; Serial unavailable</span>
      </Show>
    </footer>
  );
}
