import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import Toolbar from '../Toolbar';
import { setAppState } from '../../store';

let backend: 'native' | 'webusb' = 'native';

const serialSessionController = {
  backend: 'native' as 'native' | 'webusb',
  connectManual: vi.fn(),
  disconnectLiveSession: vi.fn(),
  grantAccess: vi.fn(),
};

vi.mock('../../services', async () => {
  const actual = await vi.importActual<typeof import('../../services')>('../../services');
  return {
    ...actual,
    useSerialSessionController: () => serialSessionController,
    useLogViewerService: () => ({ unload: vi.fn() }),
    isSerialSupported: () => true,
    isWebSerialSupported: () => backend === 'native',
  };
});

vi.mock('../SettingsModal', () => ({
  default: () => null,
}));

vi.mock('../InstallPrompt', () => ({
  default: () => null,
}));

describe('Toolbar', () => {
  beforeEach(() => {
    backend = 'native';
    serialSessionController.backend = 'native';
    serialSessionController.connectManual.mockClear();
    serialSessionController.disconnectLiveSession.mockClear();
    serialSessionController.grantAccess.mockClear();

    document.body.innerHTML = '';

    setAppState('isReady', true);
    setAppState('autoConnect', false);
    setAppState('autoDetectBaud', true);
    setAppState('connectionStatus', 'disconnected');
    setAppState('logViewerState', {
      isActive: false,
      sourceName: '',
      durationSec: 0,
      recordCount: 0,
    });
    setAppState('probeStatus', null);
  });

  it('shows Connect USB in manual mode on Android WebUSB', () => {
    backend = 'webusb';
    serialSessionController.backend = 'webusb';

    const dispose = render(() => <Toolbar onSelectTab={() => {}} />, document.body);

    expect(document.body.textContent).toContain('Connect USB');

    dispose();
  });

  it('shows Grant USB Access in auto-connect mode on Android WebUSB', () => {
    backend = 'webusb';
    serialSessionController.backend = 'webusb';
    setAppState('autoConnect', true);

    const dispose = render(() => <Toolbar onSelectTab={() => {}} />, document.body);

    expect(document.body.textContent).toContain('Grant USB Access');

    dispose();
  });
});
