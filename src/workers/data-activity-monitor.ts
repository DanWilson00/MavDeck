/**
 * Monitors serial data activity and detects "no data" idle timeouts.
 *
 * When no packets arrive within the timeout window, emits a status change
 * callback. When data resumes after idle, emits a recovery callback.
 * Designed to be testable by accepting timeout duration and callbacks.
 */

export interface DataActivityCallbacks {
  onNoData: () => void;
  onDataResumed: () => void;
}

export class DataActivityMonitor {
  private noDataTimer: ReturnType<typeof setTimeout> | null = null;
  private _isIdle = false;
  private readonly timeoutMs: number;
  private readonly callbacks: DataActivityCallbacks;

  constructor(timeoutMs: number, callbacks: DataActivityCallbacks) {
    this.timeoutMs = timeoutMs;
    this.callbacks = callbacks;
  }

  /** Start or restart the no-data countdown. */
  resetTimer(): void {
    this.clearTimer();
    this.noDataTimer = setTimeout(() => {
      this.noDataTimer = null;
      this._isIdle = true;
      this.callbacks.onNoData();
    }, this.timeoutMs);
  }

  /** Clear the no-data timer without triggering idle. */
  clearTimer(): void {
    if (this.noDataTimer !== null) {
      clearTimeout(this.noDataTimer);
      this.noDataTimer = null;
    }
  }

  /** Record that a packet was received. Resets timer and recovers from idle. */
  recordActivity(): void {
    this.resetTimer();
    if (this._isIdle) {
      this._isIdle = false;
      this.callbacks.onDataResumed();
    }
  }

  /** Full reset — clears timer and idle state without emitting callbacks. */
  reset(): void {
    this.clearTimer();
    this._isIdle = false;
  }

  get isIdle(): boolean {
    return this._isIdle;
  }

  set idle(value: boolean) {
    this._isIdle = value;
  }
}
