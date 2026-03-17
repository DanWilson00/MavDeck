import './services/install-prompt';
import { render } from 'solid-js/web';
import App from './App';
import './global.css';
import { registerSW } from 'virtual:pwa-register';
import { setAppState } from './store';
import { setUpdateSW } from './services/update-sw';

if ('serviceWorker' in navigator) {
  setUpdateSW(registerSW({
    immediate: true,
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
} else {
  setAppState('offlineStatus', 'unsupported');
}

render(() => <App />, document.getElementById('root')!);
