/**
 * MAVLink service — wires the data pipeline.
 *
 * ByteSource → FrameParser → Decoder → Tracker + TimeSeriesManager.
 * Runs inside the Web Worker (not on the main thread).
 */

import { EventEmitter } from '../core/event-emitter';
import type { MavlinkMessage } from '../mavlink/decoder';
import { MavlinkMessageDecoder } from '../mavlink/decoder';
import { MavlinkFrameParser } from '../mavlink/frame-parser';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { IByteSource } from './byte-source';
import type { GenericMessageTracker } from './message-tracker';
import type { TimeSeriesDataManager } from './timeseries-manager';

type MessageCallback = (msg: MavlinkMessage) => void;
type PacketCallback = (packet: Uint8Array, timestampUs: number) => void;

export class MavlinkService {
  private readonly parser: MavlinkFrameParser;
  private readonly decoder: MavlinkMessageDecoder;
  private readonly byteSource: IByteSource;
  private readonly tracker: GenericMessageTracker;
  private readonly timeseriesManager: TimeSeriesDataManager;
  private readonly messageEmitter = new EventEmitter<MessageCallback>();
  private readonly packetEmitter = new EventEmitter<PacketCallback>();

  private unsubBytes: (() => void) | null = null;
  private unsubFrames: (() => void) | null = null;

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
      const nowUs = Date.now() * 1000;
      this.packetEmitter.emit(frame.rawPacket, nowUs);

      const msg = this.decoder.decode(frame);
      if (!msg) return;

      this.tracker.trackMessage(msg);
      this.timeseriesManager.processMessage(msg);
      this.messageEmitter.emit(msg);
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
  }

  /** Subscribe to decoded messages. Returns unsubscribe function. */
  onMessage(callback: MessageCallback): () => void {
    return this.messageEmitter.on(callback);
  }

  /** Subscribe to CRC-valid raw MAVLink packets (wire bytes + timestampUs). */
  onPacket(callback: PacketCallback): () => void {
    return this.packetEmitter.on(callback);
  }
}
