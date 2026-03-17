import { render } from 'solid-js/web';
import App from './App';
import './global.css';
import { registerSW } from 'virtual:pwa-register';
import { setAppState } from './store';

/** Stored reference to the SW update function. Call with `true` to activate new SW and reload. */
export let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;

if ('serviceWorker' in navigator) {
  updateSW = registerSW({
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
  });
} else {
  setAppState('offlineStatus', 'unsupported');
}

render(() => <App />, document.getElementById('root')!);
