import { describe, it, expect } from 'vitest';
import { appState, setAppState } from '../app-store';

describe('appStore', () => {
  it('initializes with default values', () => {
    expect(appState.connectionStatus).toBe('disconnected');
    expect(appState.theme).toBe('dark');
    expect(appState.uiScale).toBe(1);
    expect(appState.unitProfile).toBe('raw');
    expect(appState.activeTab).toBe('telemetry');
    expect(appState.activeSubTab).toBe('default');
    expect(appState.plotTabs).toEqual([{ id: 'default', name: 'Tab 1', plots: [] }]);
    expect(appState.isPaused).toBe(false);
    expect(appState.isReady).toBe(false);
    expect(appState.bufferCapacity).toBe(2000);
    expect(appState.isSettingsOpen).toBe(false);
    expect(appState.timeWindow).toBe(30);
    expect(appState.addPlotCounter).toBe(0);
    expect(appState.mapShowPath).toBe(true);
    expect(appState.mapTrailLength).toBe(500);
    expect(appState.mapLayer).toBe('street');
    expect(appState.mapZoom).toBe(15);
    expect(appState.mapAutoCenter).toBe(true);
    expect(appState.sidebarCollapsed).toBe(false);
    expect(appState.sidebarWidth).toBe(350);
    expect(appState.dialectName).toBe('');
    expect(appState.connectionSourceType).toBeNull();
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
