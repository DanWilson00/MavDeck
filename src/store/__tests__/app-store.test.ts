import { describe, it, expect } from 'vitest';
import { appState, setAppState } from '../app-store';

describe('appStore', () => {
  it('initializes with default values', () => {
    expect(appState.connectionStatus).toBe('disconnected');
    expect(appState.theme).toBe('dark');
    expect(appState.uiScale).toBe(1);
    expect(appState.activeTab).toBe('telemetry');
    expect(appState.activeSubTab).toBe('default');
    expect(appState.plotTabs).toEqual([{ id: 'default', name: 'Tab 1', plots: [] }]);
    expect(appState.isPaused).toBe(false);
    expect(appState.isReady).toBe(false);
    expect(appState.isSettingsOpen).toBe(false);
  });

  it('setAppState updates theme reactively', () => {
    setAppState('theme', 'light');
    expect(appState.theme).toBe('light');
    // Reset for other tests
    setAppState('theme', 'dark');
  });

  it('setAppState updates connectionStatus', () => {
    setAppState('connectionStatus', 'connected');
    expect(appState.connectionStatus).toBe('connected');
    setAppState('connectionStatus', 'disconnected');
  });
});
