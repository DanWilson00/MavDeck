import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import SettingsModal from '../SettingsModal';
import { setAppState } from '../../store';

const serialSessionController = {
  backend: 'native' as 'native' | 'webusb',
  connectSpoof: vi.fn(),
  disconnectLiveSession: vi.fn(),
  forgetAllPorts: vi.fn(async () => {}),
};

vi.mock('../../services', async () => {
  const actual = await vi.importActual<typeof import('../../services')>('../../services');
  return {
    ...actual,
    useRegistry: () => ({}),
    useWorkerBridge: () => ({}),
    useSerialSessionController: () => serialSessionController,
    isSerialSupported: () => true,
    loadSettings: vi.fn(async () => ({ ...actual.DEFAULT_SETTINGS })),
    saveSettings: vi.fn(async () => {}),
    saveDialect: vi.fn(async () => {}),
    clearDialect: vi.fn(async () => {}),
    loadBundledDialect: vi.fn(async () => '{}'),
    initDialect: vi.fn(async () => {}),
    resolveIncludes: vi.fn(async () => {}),
    detectMainDialect: vi.fn(() => 'common.xml'),
    loadRemoteDialect: vi.fn(async () => ({ name: 'common', json: '{}' })),
    validateDialectUrl: vi.fn(() => null),
    normalizeGithubUrl: vi.fn((value: string) => value),
    logDebugError: vi.fn(),
  };
});

function clickButton(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return button;
}

describe('SettingsModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    serialSessionController.connectSpoof.mockClear();
    serialSessionController.disconnectLiveSession.mockClear();
    serialSessionController.forgetAllPorts.mockClear();

    setAppState('isReady', true);
    setAppState('connectionStatus', 'disconnected');
    setAppState('connectionSourceType', null);
    setAppState('pendingConnectionSourceType', null);
    setAppState('logViewerState', {
      isActive: false,
      sourceName: '',
      durationSec: 0,
      recordCount: 0,
    });
  });

  it('starts the simulator from settings when idle', () => {
    const dispose = render(() => <SettingsModal onClose={() => {}} />, document.body);

    clickButton('Advanced');
    clickButton('Start Simulator');

    expect(serialSessionController.connectSpoof).toHaveBeenCalledWith({ unloadLog: false });

    dispose();
  });

  it('stops the simulator from settings when spoof is active', () => {
    setAppState('connectionStatus', 'no_data');
    setAppState('connectionSourceType', 'spoof');

    const dispose = render(() => <SettingsModal onClose={() => {}} />, document.body);

    clickButton('Advanced');
    clickButton('Stop Simulator');

    expect(serialSessionController.disconnectLiveSession).toHaveBeenCalledTimes(1);

    dispose();
  });

  it('shows a starting state while spoof connection is pending', () => {
    setAppState('connectionStatus', 'connecting');
    setAppState('pendingConnectionSourceType', 'spoof');

    const dispose = render(() => <SettingsModal onClose={() => {}} />, document.body);

    clickButton('Advanced');

    expect(document.body.textContent).toContain('Starting Simulator...');

    clickButton('Starting Simulator...');

    expect(serialSessionController.disconnectLiveSession).toHaveBeenCalledTimes(1);

    dispose();
  });
});
