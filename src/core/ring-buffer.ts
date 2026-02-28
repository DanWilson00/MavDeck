/**
 * Pre-allocated circular buffer backed by Float64Array for zero-GC
 * time-series storage. Stores timestamps (epoch-ms) and values in
 * struct-of-arrays layout. Designed for direct uPlot compatibility
 * via toUplotData().
 */
export class RingBuffer {
  private readonly timestamps: Float64Array; // epoch-ms, circular storage
  private readonly values: Float64Array; // circular storage
  private readonly viewTimestamps: Float64Array; // pre-allocated contiguous view for output
  private readonly viewValues: Float64Array; // pre-allocated contiguous view for output
  private head = 0; // next write position
  private count = 0; // number of valid entries (saturates at capacity)
  readonly capacity: number;

  constructor(capacity = 2000) {
    this.capacity = capacity;
    this.timestamps = new Float64Array(capacity);
    this.values = new Float64Array(capacity);
    this.viewTimestamps = new Float64Array(capacity);
    this.viewValues = new Float64Array(capacity);
  }

  /**
   * Write a timestamp/value pair at the head position.
   * Wraps around when capacity is reached, overwriting oldest data.
   */
  push(timestamp: number, value: number): void {
    this.timestamps[this.head] = timestamp;
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /** Number of valid entries (max = capacity). */
  get length(): number {
    return this.count;
  }

  /**
   * Returns [timestamps_in_seconds, values] as contiguous subarrays of the
   * pre-allocated view buffers.
   *
   * Timestamps are converted from internal epoch-ms to epoch-seconds (/ 1000)
   * for uPlot compatibility.
   *
   * CRITICAL: No new Float64Array allocation per call. Uses .set() to copy
   * wrapped data into pre-allocated views, then .subarray() for zero-alloc slices.
   */
  toUplotData(): [Float64Array, Float64Array] {
    const len = this.count;
    if (len === 0) {
      return [this.viewTimestamps.subarray(0, 0), this.viewValues.subarray(0, 0)];
    }

    if (len < this.capacity) {
      // Buffer hasn't wrapped yet: data is contiguous from index 0 to head
      // Copy and convert timestamps to seconds
      for (let i = 0; i < len; i++) {
        this.viewTimestamps[i] = this.timestamps[i] / 1000;
      }
      this.viewValues.set(this.timestamps.subarray(0, 0)); // no-op, just for clarity
      this.viewValues.set(this.values.subarray(0, len));
    } else {
      // Buffer has wrapped: oldest data starts at head, newest ends at head-1
      // First segment: from head to end of array (oldest data)
      const tailLen = this.capacity - this.head;

      // Copy timestamps (oldest segment), converting to seconds
      for (let i = 0; i < tailLen; i++) {
        this.viewTimestamps[i] = this.timestamps[this.head + i] / 1000;
      }
      // Copy timestamps (newest segment), converting to seconds
      for (let i = 0; i < this.head; i++) {
        this.viewTimestamps[tailLen + i] = this.timestamps[i] / 1000;
      }

      // Copy values (oldest segment)
      this.viewValues.set(this.values.subarray(this.head, this.capacity));
      // Copy values (newest segment)
      this.viewValues.set(this.values.subarray(0, this.head), tailLen);
    }

    return [
      this.viewTimestamps.subarray(0, len),
      this.viewValues.subarray(0, len),
    ];
  }

  /** Returns the most recently pushed value, or undefined if empty. */
  getLatestValue(): number | undefined {
    if (this.count === 0) return undefined;
    // head points to the *next* write position, so latest is at head-1
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.values[idx];
  }

  /** Returns the most recently pushed timestamp (epoch-ms), or undefined if empty. */
  getLatestTimestamp(): number | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.timestamps[idx];
  }

  /** Resets the buffer to empty state without reallocating. */
  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}
