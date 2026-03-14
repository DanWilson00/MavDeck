import { createEffect, onCleanup } from 'solid-js';
import { appState, setAppState } from '../store';
import { getWorkerBridge, stageSessionStart, stageSessionChunk, finalizeSession } from '../services';

export function useLogSession(): void {
  createEffect(() => {
    if (!appState.isReady) return;
    const workerBridge = getWorkerBridge();

    const unsubLogStart = workerBridge.onLogSessionStart(meta => {
      stageSessionStart(meta).catch(err => {
        console.error('[Tlog] Failed to stage session start:', err);
      });
    });

    const unsubLogChunk = workerBridge.onLogChunk(chunk => {
      stageSessionChunk(chunk).catch(err => {
        console.error('[Tlog] Failed to stage log chunk:', err);
      });
    });

    const unsubLogEnd = workerBridge.onLogSessionEnd(meta => {
      finalizeSession(meta).then((fileName) => {
        if (fileName) {
          setAppState('logsVersion', v => v + 1);
        }
      }).catch(err => {
        console.error('[Tlog] Failed to finalize session log:', err);
      });
    });

    onCleanup(() => {
      unsubLogStart();
      unsubLogChunk();
      unsubLogEnd();
    });
  });
}
