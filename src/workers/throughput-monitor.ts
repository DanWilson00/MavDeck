/**
 * Measures byte throughput at 1Hz intervals.
 *
 * Subscribes to a data source's onData callback, accumulates byte counts,
 * and emits the total every second via a provided callback. Designed to be
 * testable outside the worker by accepting dependencies via constructor.
 */

export interface DataSource {
  onData(cb: (data: Uint8Array) => void): () => void;
}

export class ThroughputMonitor {
  private bytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private readonly onThroughput: (bytesPerSec: number) => void;

  constructor(onThroughput: (bytesPerSec: number) => void) {
    this.onThroughput = onThroughput;
  }

  start(source: DataSource): void {
    this.stop();
    this.bytes = 0;
    this.unsub = source.onData(data => { this.bytes += data.byteLength; });
    this.timer = setInterval(() => {
      this.onThroughput(this.bytes);
      this.bytes = 0;
    }, 1000);
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.bytes = 0;
    this.onThroughput(0);
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }
}
