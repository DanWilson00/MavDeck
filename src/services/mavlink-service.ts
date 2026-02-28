/**
 * MAVLink service — wires the data pipeline.
 *
 * ByteSource → FrameParser → Decoder → Tracker + TimeSeriesManager.
 * Runs inside the Web Worker (not on the main thread).
 */

import type { MavlinkMessage } from '../mavlink/decoder';
import { MavlinkMessageDecoder } from '../mavlink/decoder';
import { MavlinkFrameParser } from '../mavlink/frame-parser';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { IByteSource } from './byte-source';
import type { GenericMessageTracker } from './message-tracker';
import type { TimeSeriesDataManager } from './timeseries-manager';

type MessageCallback = (msg: MavlinkMessage) => void;

export class MavlinkService {
  private readonly parser: MavlinkFrameParser;
  private readonly decoder: MavlinkMessageDecoder;
  private readonly byteSource: IByteSource;
  private readonly tracker: GenericMessageTracker;
  private readonly timeseriesManager: TimeSeriesDataManager;
  private readonly callbacks = new Set<MessageCallback>();

  private unsubBytes: (() => void) | null = null;
  private unsubFrames: (() => void) | null = null;
  private _isPaused = false;

  constructor(
    registry: MavlinkMetadataRegistry,
    byteSource: IByteSource,
    tracker: GenericMessageTracker,
    timeseriesManager: TimeSeriesDataManager,
  ) {
    this.parser = new MavlinkFrameParser(registry);
    this.decoder = new MavlinkMessageDecoder(registry);
    this.byteSource = byteSource;
    this.tracker = tracker;
    this.timeseriesManager = timeseriesManager;
  }

  /** Connect and start receiving messages. */
  async connect(): Promise<void> {
    // Wire byte source → parser
    this.unsubBytes = this.byteSource.onData(data => {
      this.parser.parse(data);
    });

    // Wire parser → decoder → callbacks
    this.unsubFrames = this.parser.onFrame(frame => {
      const msg = this.decoder.decode(frame);
      if (!msg) return;

      // Always track for stats
      this.tracker.trackMessage(msg);

      // Only process/emit when not paused
      if (!this._isPaused) {
        this.timeseriesManager.processMessage(msg);
        for (const cb of this.callbacks) {
          cb(msg);
        }
      }
    });

    this.tracker.startTracking();
    await this.byteSource.connect();
  }

  /** Disconnect and stop all processing. */
  disconnect(): void {
    this.unsubBytes?.();
    this.unsubFrames?.();
    this.unsubBytes = null;
    this.unsubFrames = null;
    this.tracker.stopTracking();
    this.byteSource.disconnect();
    this._isPaused = false;
  }

  /** Pause message emission (tracker keeps running). */
  pause(): void {
    this._isPaused = true;
  }

  /** Resume message emission. */
  resume(): void {
    this._isPaused = false;
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  /** Subscribe to decoded messages. Returns unsubscribe function. */
  onMessage(callback: MessageCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }
}
