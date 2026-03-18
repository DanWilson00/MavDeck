import './services/install-prompt';
import { render } from 'solid-js/web';
import App from './App';
import './global.css';
import { registerSW } from 'virtual:pwa-register';
import { setAppState } from './store';
import { setUpdateSW } from './services/update-sw';

if ('serviceWorker' in navigator) {
  let swUrl: string | undefined;
  let lastUpdateCheck = 0;
  const UPDATE_THROTTLE_MS = 60_000;

  setUpdateSW(registerSW({
    immediate: true,
    onRegisteredSW(url: string) {
      swUrl = url;
    },
    onNeedRefresh() {
      setAppState('updateAvailable', true);
    },
    onOfflineReady() {
      setAppState('offlineReady', true);
      setAppState('offlineStatus', 'ready');
      setAppState('offlineError', null);
    },
    onRegisterError(error: unknown) {
      setAppState('offlineStatus', 'error');
      setAppState('offlineError', error instanceof Error ? error.message : String(error));
    },
  }));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !swUrl) return;
    const now = Date.now();
    if (now - lastUpdateCheck < UPDATE_THROTTLE_MS) return;
    lastUpdateCheck = now;
    navigator.serviceWorker.getRegistration(swUrl).then(r => r?.update());
  });
} else {
  setAppState('offlineStatus', 'unsupported');
}

render(() => <App />, document.getElementById('root')!);
