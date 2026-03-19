import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import StatusBar from '../StatusBar';
import { setAppState } from '../../store';

vi.mock('../../services', async () => {
  const actual = await vi.importActual<typeof import('../../services')>('../../services');
  return {
    ...actual,
    isSerialSupported: () => true,
  };
});

describe('StatusBar', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setAppState('connectionStatus', 'disconnected');
    setAppState('connectionSourceType', null);
    setAppState('connectedBaudRate', null);
    setAppState('baudRate', 115200);
    setAppState('isPaused', false);
    setAppState('throughputBytesPerSec', 0);
    setAppState('dialectName', '');
    setAppState('logViewerState', {
      isActive: false,
      sourceName: '',
      durationSec: 0,
      recordCount: 0,
    });
  });

  it('shows the current live session context in chip form', () => {
    setAppState('connectionStatus', 'connected');
    setAppState('connectionSourceType', 'serial');
    setAppState('connectedBaudRate', 500000);
    setAppState('isPaused', true);
    setAppState('throughputBytesPerSec', 24500);
    setAppState('dialectName', 'ardupilotmega');

    const dispose = render(() => <StatusBar />, document.body);

    expect(document.body.textContent).toContain('Connected');
    expect(document.body.textContent).toContain('Paused');
    expect(document.body.textContent).toContain('500000 baud');
    expect(document.body.textContent).toContain('24.5 KB/s');
    expect(document.body.textContent).toContain('ardupilotmega');

    dispose();
  });

  it('switches to playback context when a log is loaded', () => {
    setAppState('dialectName', 'common');
    setAppState('logViewerState', {
      isActive: true,
      sourceName: 'session.tlog',
      durationSec: 92,
      recordCount: 4567,
    });

    const dispose = render(() => <StatusBar />, document.body);

    expect(document.body.textContent).toContain('session.tlog');
    expect(document.body.textContent).toContain('Log');
    expect(document.body.textContent).toContain('Playback');
    expect(document.body.textContent).toContain('1:32');
    expect(document.body.textContent).toContain('4,567 records');

    dispose();
  });
});
