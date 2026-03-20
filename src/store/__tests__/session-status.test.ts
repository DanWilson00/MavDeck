import { describe, expect, it } from 'vitest';
import { createInitialAppState } from '../app-store';
import { selectStatusBarModel } from '../session-status';

describe('selectStatusBarModel', () => {
  it('builds a detailed live-session model for a paused serial link', () => {
    const state = createInitialAppState();
    state.connectionStatus = 'no_data';
    state.connectionSourceType = 'serial';
    state.connectedBaudRate = 500000;
    state.isPaused = true;
    state.dialectName = 'ardupilotmega';

    const model = selectStatusBarModel(state, true);

    expect(model.headline).toBe('No Data');
    expect(model.badges.map(b => b.label)).toEqual(['Paused', 'Waiting for Data']);
    expect(model.details).toContain('500000 baud');
    expect(model.details).toContain('ardupilotmega');
  });

  it('builds a playback model when a log is active', () => {
    const state = createInitialAppState();
    state.logViewerState = {
      isActive: true,
      sourceName: 'flight-042.tlog',
      durationSec: 125,
      recordCount: 9876,
    };
    state.dialectName = 'common';

    const model = selectStatusBarModel(state, true);

    expect(model.headline).toBe('flight-042.tlog');
    expect(model.badges.map(b => b.label)).toEqual(['Log', 'Playback']);
    expect(model.details).toEqual(['2:05', '9,876 records', 'common']);
  });
});
