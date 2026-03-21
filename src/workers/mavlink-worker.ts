/**
 * MAVLink Web Worker — thin shell.
 *
 * All logic lives in WorkerController, which is testable without a Worker env.
 * This file only wires postMessage and onmessage.
 */

/// <reference lib="webworker" />

import type { WorkerCommand, WorkerEvent } from './worker-protocol';
import { WorkerController } from './worker-controller';

declare const self: DedicatedWorkerGlobalScope;

function postEvent(event: WorkerEvent, transfer?: Transferable[]): void {
  if (transfer) {
    self.postMessage(event, transfer);
  } else {
    self.postMessage(event);
  }
}

const controller = new WorkerController(postEvent);

self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  void controller.handleCommand(e.data);
};
