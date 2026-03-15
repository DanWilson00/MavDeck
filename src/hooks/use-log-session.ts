import { createEffect, onCleanup } from 'solid-js';
import { appState, setAppState } from '../store';
import { useWorkerBridge, stageSessionStart, stageSessionChunk, finalizeSession } from '../services';

export function useLogSession(): void {
  const workerBridge = useWorkerBridge();

  createEffect(() => {
    if (!appState.isReady) return;

    // Chain all chunk operations so finalization waits for them
    let chunkChain = Promise.resolve();
    let sessionFailed = false;

    const unsubLogStart = workerBridge.onLogSessionStart(meta => {
      sessionFailed = false;
      chunkChain = stageSessionStart(meta).catch(err => {
        sessionFailed = true;
        console.error('[Tlog] Failed to stage session start — all chunks will be dropped:', err);
      });
    });

    const unsubLogChunk = workerBridge.onLogChunk(chunk => {
      if (sessionFailed) return;
      chunkChain = chunkChain.then(() => stageSessionChunk(chunk)).catch(err => {
        console.error('[Tlog] Failed to stage log chunk:', err);
      });
    });

    const unsubLogEnd = workerBridge.onLogSessionEnd(meta => {
      if (sessionFailed) {
        console.warn('[Tlog] Skipping finalization — session start failed');
        sessionFailed = false;
        return;
      }
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
