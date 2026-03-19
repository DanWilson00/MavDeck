import { createEffect, onCleanup } from 'solid-js';
import { appState } from '../store';
import { addStatusTextEntry, clearStatusTextEntries, useWorkerBridge } from '../services';

export function useStatusTextCapture(): void {
  const workerBridge = useWorkerBridge();

  createEffect(() => {
    appState.logViewerState.sourceName;
    clearStatusTextEntries();
  });

  createEffect(() => {
    if (!appState.isReady) return;
    const unsub = workerBridge.onStatusText(entry => {
      addStatusTextEntry(entry);
    });
    onCleanup(unsub);
  });
}
