import { createEffect, onCleanup } from 'solid-js';
import { appState, setAppState } from '../store';
import { useWorkerBridge, stageSessionStart, stageSessionChunk, finalizeSession } from '../services';

export function useLogSession(): void {
  const workerBridge = useWorkerBridge();

  createEffect(() => {
    if (!appState.isReady) return;

    // Chain all chunk operations so finalization waits for them
    let chunkChain = Promise.resolve();

    const unsubLogStart = workerBridge.onLogSessionStart(meta => {
      chunkChain = stageSessionStart(meta).catch(err => {
        console.error('[Tlog] Failed to stage session start:', err);
      });
    });

    const unsubLogChunk = workerBridge.onLogChunk(chunk => {
      chunkChain = chunkChain.then(() => stageSessionChunk(chunk)).catch(err => {
        console.error('[Tlog] Failed to stage log chunk:', err);
      });
    });

    const unsubLogEnd = workerBridge.onLogSessionEnd(meta => {
      chunkChain.then(() => finalizeSession(meta)).then((fileName) => {
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
