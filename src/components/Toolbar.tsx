import { Show, createSignal, createEffect, onCleanup, batch, For } from 'solid-js';
import { appState, setAppState, connectionManager } from '../store/app-store';
import { toggleTheme } from './ThemeProvider';
import type { ConnectionStatus } from '../services/worker-bridge';
import { isWebSerialSupported, BAUD_RATES } from '../services/webserial-byte-source';
import type { BaudRate } from '../services/webserial-byte-source';

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  disconnected: '#71717a', // gray
  connecting: '#eab308',   // yellow
  connected: '#22c55e',    // green
  error: '#ef4444',        // red
};

export default function Toolbar() {
  const [status, setStatus] = createSignal<ConnectionStatus>('disconnected');

  // Subscribe to connection status once services are ready
  createEffect(() => {
    if (!appState.isReady) return;
    const unsub = connectionManager.onStatusChange(s => {
      batch(() => {
        setStatus(s);
        setAppState('connectionStatus', s);
        if (s === 'disconnected') {
          setAppState('isPaused', false);
        }
      });
    });
    onCleanup(unsub);
  });

  function handleConnect() {
    if (!appState.isReady) return;
    if (status() === 'connected' || status() === 'connecting') {
      connectionManager.disconnect();
    } else {
      connectionManager.connect({ type: 'spoof' });
    }
  }

  function handleConnectSerial() {
    if (!appState.isReady) return;
    if (status() === 'connected' || status() === 'connecting') {
      connectionManager.disconnect();
    } else {
      connectionManager.connect({ type: 'webserial', baudRate: appState.baudRate });
    }
  }

  function handlePause() {
    if (!appState.isReady) return;
    if (appState.isPaused) {
      connectionManager.resume();
      setAppState('isPaused', false);
    } else {
      connectionManager.pause();
      setAppState('isPaused', true);
    }
  }

  const isConnected = () => status() === 'connected' || status() === 'connecting';

  return (
    <header
      class="flex items-center justify-between px-4 h-12 border-b"
      style={{
        'background-color': 'var(--bg-panel)',
        'border-color': 'var(--border)',
      }}
    >
      {/* Left: Logo */}
      <span
        class="text-lg font-bold tracking-tight"
        style={{ color: 'var(--accent)' }}
      >
        MavDeck
      </span>

      {/* Right: Controls */}
      <div class="flex items-center gap-3">
        {/* Connection button */}
        <button
          onClick={handleConnect}
          class="px-3 py-1 rounded text-sm font-medium transition-colors"
          style={{
            'background-color': 'var(--bg-hover)',
            color: 'var(--text-primary)',
          }}
        >
          {isConnected() ? 'Disconnect' : 'Connect Spoof'}
        </button>

        {/* Serial connection — only when Web Serial is supported and not connected */}
        <Show when={isWebSerialSupported() && !isConnected()}>
          <button
            onClick={handleConnectSerial}
            class="px-3 py-1 rounded text-sm font-medium transition-colors"
            style={{
              'background-color': 'var(--bg-hover)',
              color: 'var(--text-primary)',
            }}
          >
            Connect Serial
          </button>
        </Show>

        <Show when={isWebSerialSupported() && !isConnected()}>
          <select
            class="text-sm rounded px-1 py-1"
            style={{
              'background-color': 'var(--bg-hover)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
            }}
            value={appState.baudRate}
            onChange={(e) => {
              setAppState('baudRate', Number(e.currentTarget.value) as BaudRate);
            }}
          >
            <For each={[...BAUD_RATES]}>
              {(rate) => <option value={rate}>{rate}</option>}
            </For>
          </select>
        </Show>

        {/* Status dot */}
        <div
          class="w-2.5 h-2.5 rounded-full transition-colors"
          title={status()}
          style={{ 'background-color': STATUS_COLORS[status()] }}
        />

        {/* Pause/Resume — only when connected */}
        <Show when={status() === 'connected'}>
          <button
            onClick={handlePause}
            class="px-3 py-1 rounded text-sm font-medium transition-colors"
            style={{
              'background-color': 'var(--bg-hover)',
              color: 'var(--text-primary)',
            }}
          >
            {appState.isPaused ? 'Resume' : 'Pause'}
          </button>
        </Show>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          class="p-1.5 rounded transition-colors"
          style={{
            'background-color': 'var(--bg-hover)',
            color: 'var(--text-secondary)',
          }}
          title={`Switch to ${appState.theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          <Show when={appState.theme === 'dark'} fallback={<MoonIcon />}>
            <SunIcon />
          </Show>
        </button>
      </div>
    </header>
  );
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
