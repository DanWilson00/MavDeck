/**
 * Time-series data manager for MAVLink telemetry.
 *
 * Extracts numeric fields from decoded messages and stores them in
 * pre-allocated RingBuffers (struct-of-arrays layout) for zero-GC
 * time-series visualization. All field keys follow the format
 * "MESSAGE_NAME.field_name".
 *
 * Throttles update notifications to 60Hz (16ms) to avoid overwhelming
 * the rendering thread.
 */

import { EventEmitter } from '../core/event-emitter';
import { RingBuffer } from '../core/ring-buffer';
import type { MavlinkMessage } from '../mavlink/decoder';

/** Default ring buffer capacity per field (number of samples). */
const DEFAULT_BUFFER_CAPACITY = 2000;

/** Default maximum number of unique field keys to prevent unbounded growth. */
const DEFAULT_MAX_FIELDS = 500;

/** Minimum interval between update notifications (ms). 60Hz = ~16ms. */
const THROTTLE_INTERVAL_MS = 16;

export interface TimeSeriesManagerOptions {
  bufferCapacity?: number;
  maxFields?: number;
}

export class TimeSeriesDataManager {
  private readonly buffers = new Map<string, RingBuffer>();
  private readonly updateEmitter = new EventEmitter<() => void>();
  private readonly bufferCapacity: number;
  private readonly maxFields: number;

  private pendingUpdate = false;
  private throttleTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: TimeSeriesManagerOptions) {
    this.bufferCapacity = options?.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
    this.maxFields = options?.maxFields ?? DEFAULT_MAX_FIELDS;
  }

  /**
   * Extract numeric fields from a decoded MAVLink message and push
   * their values into per-field ring buffers.
   *
   * Field extraction rules:
   * - `number` → push directly with timestamp = Date.now()
   * - `number[]` → expand to indexed sub-keys: "MSG.field[0]", "MSG.field[1]", ...
   * - `string` → skip (not numeric)
   */
  processMessage(msg: MavlinkMessage): void {
    this.processMessageWithTimestamp(msg, Date.now());
  }

  /**
   * Same as processMessage but uses the provided timestamp instead of Date.now().
   * Used for bulk-loading tlog files where each record has its own timestamp.
   */
  processMessageWithTimestamp(msg: MavlinkMessage, timestampMs: number): void {
    const prefix = msg.name;

    for (const [fieldName, value] of Object.entries(msg.values)) {
      if (typeof value === 'number') {
        const key = `${prefix}.${fieldName}`;
        this.pushValue(key, timestampMs, value);
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const key = `${prefix}.${fieldName}[${i}]`;
          this.pushValue(key, timestampMs, value[i]);
        }
      }
      // string values are silently skipped
    }

    this.scheduleUpdate();
  }

  /** Returns the ring buffer for a given field key, or undefined if not tracked. */
  getBuffer(fieldKey: string): RingBuffer | undefined {
    return this.buffers.get(fieldKey);
  }

  /** Returns all known field keys (sorted for deterministic output). */
  getAvailableFields(): string[] {
    return Array.from(this.buffers.keys()).sort();
  }

  /**
   * Subscribe to throttled update notifications. The callback is invoked
   * at most once every 16ms (60Hz) when new data has been processed.
   * Returns an unsubscribe function.
   */
  onUpdate(callback: () => void): () => void {
    return this.updateEmitter.on(callback);
  }

  /** Clean up timers and release callbacks. */
  dispose(): void {
    if (this.throttleTimerId !== null) {
      clearTimeout(this.throttleTimerId);
      this.throttleTimerId = null;
    }
    this.pendingUpdate = false;
    this.updateEmitter.clear();
  }

  /** Push a value into the ring buffer for the given key, creating it if needed. */
  private pushValue(key: string, timestamp: number, value: number): void {
    let buffer = this.buffers.get(key);
    if (!buffer) {
      if (this.buffers.size >= this.maxFields) return;
      buffer = new RingBuffer(this.bufferCapacity);
      this.buffers.set(key, buffer);
    }
    buffer.push(timestamp, value);
  }

  /**
   * Schedule a throttled update notification. Uses a pending flag + setTimeout
   * to coalesce rapid processMessage calls into a single callback at 60Hz.
   */
  private scheduleUpdate(): void {
    if (this.pendingUpdate) return;
    this.pendingUpdate = true;

    this.throttleTimerId = setTimeout(() => {
      this.throttleTimerId = null;
      this.pendingUpdate = false;
      this.updateEmitter.emit();
    }, THROTTLE_INTERVAL_MS);
  }
}
