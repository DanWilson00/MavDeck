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

export class LogViewerService {
  private readonly bridge: MavlinkWorkerBridge;
  private readonly serialSessionController: SerialSessionController;
  private readonly callbacks = new Set<LogViewerStateCallback>();
  private state: LogViewerState = {
    isActive: false,
    sourceName: '',
    durationSec: 0,
    recordCount: 0,
  };

  constructor(bridge: MavlinkWorkerBridge, serialSessionController: SerialSessionController) {
    this.bridge = bridge;
    this.serialSessionController = serialSessionController;
  }

  subscribe(cb: LogViewerStateCallback): () => void {
    this.callbacks.add(cb);
    cb(this.state);
    return () => this.callbacks.delete(cb);
  }

  private emitState(): void {
    for (const cb of this.callbacks) cb(this.state);
  }

  load(records: TlogRecord[], sourceName: string): void {
    const capacity = Math.max(2000, records.length);
    const packets = records.map(r => r.packet);
    const timestamps = records.map(r => r.timestampUs / 1000); // microseconds → milliseconds

    this.serialSessionController.enterLogMode();

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
    this.state = {
      isActive: false,
      sourceName: '',
      durationSec: 0,
      recordCount: 0,
    };
    this.emitState();
    this.bridge.unloadLog();
  }
}
