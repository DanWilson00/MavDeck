import { EventEmitter } from '../core';
import type { MavlinkWorkerBridge } from './worker-bridge';
import type { SerialSessionController } from './serial-session-controller';
import type { TlogRecord } from './tlog-codec';

export interface LogViewerState {
  isActive: boolean;       // A log is loaded
  sourceName: string;      // Loaded log filename
  durationSec: number;     // Log time span
  recordCount: number;     // Number of records
}

type LogViewerStateCallback = (state: LogViewerState) => void;

const INITIAL_STATE: LogViewerState = {
  isActive: false,
  sourceName: '',
  durationSec: 0,
  recordCount: 0,
};

export class LogViewerService {
  private readonly bridge: MavlinkWorkerBridge;
  private readonly serialSessionController: SerialSessionController;
  private readonly stateEmitter = new EventEmitter<LogViewerStateCallback>();
  private state: LogViewerState = { ...INITIAL_STATE };
  private suspendedLiveSession = false;

  constructor(bridge: MavlinkWorkerBridge, serialSessionController: SerialSessionController) {
    this.bridge = bridge;
    this.serialSessionController = serialSessionController;
  }

  subscribe(cb: LogViewerStateCallback): () => void {
    const unsub = this.stateEmitter.on(cb);
    cb(this.state);
    return unsub;
  }

  private emitState(): void {
    this.stateEmitter.emit(this.state);
  }

  load(records: TlogRecord[], sourceName: string): void {
    const capacity = Math.max(2000, records.length);
    const packets = records.map(r => r.packet);
    const timestamps = records.map(r => r.timestampUs / 1000); // microseconds → milliseconds

    this.suspendedLiveSession = this.serialSessionController.suspendForLogPlayback();

    this.state = {
      isActive: true,
      sourceName,
      durationSec: 0,      // Updated by bridge.onLoadComplete
      recordCount: records.length,
    };
    this.emitState();

    this.bridge.loadLog(packets, timestamps, capacity);
  }

  unload(): void {
    this.bridge.unloadLog();

    if (this.suspendedLiveSession) {
      this.serialSessionController.resumeAfterLogPlayback();
      this.suspendedLiveSession = false;
    }

    this.state = { ...INITIAL_STATE };
    this.emitState();
  }
}
