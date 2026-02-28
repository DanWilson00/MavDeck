/**
 * Generic message tracker for MAVLink messages.
 *
 * Tracks per-message-name statistics including count, rolling frequency,
 * and last received timestamp. Uses a sliding window algorithm with
 * decay for frequency calculation.
 */

import type { MavlinkMessage } from '../mavlink/decoder';

export interface MessageStats {
  count: number;
  frequency: number;      // Hz, rolling 5s window
  lastMessage: MavlinkMessage;
  lastReceived: number;   // timestamp ms
}

/** Duration of the sliding window for frequency calculation (ms). */
const FREQUENCY_WINDOW_MS = 5000;

/** Stats update interval (ms). */
const UPDATE_INTERVAL_MS = 100;

/** Time after last message before decay begins (ms). */
const DECAY_START_MS = 2000;

/** Duration over which frequency decays to zero (ms). */
const DECAY_DURATION_MS = 3000;

/** Time after last message before entry is removed (ms). */
const STALE_THRESHOLD_MS = 10000;

/** Minimum frequency threshold — values below this are clamped to 0. */
const MIN_FREQUENCY_HZ = 0.01;

type StatsCallback = (stats: Map<string, MessageStats>) => void;

export class GenericMessageTracker {
  private readonly recentTimestamps = new Map<string, number[]>();
  private readonly stats = new Map<string, MessageStats>();
  private readonly callbacks = new Set<StatsCallback>();
  private timerId: ReturnType<typeof setInterval> | null = null;

  /** Record an incoming message. Call this for every decoded MAVLink message. */
  trackMessage(msg: MavlinkMessage): void {
    const name = msg.name;
    const now = Date.now();

    // Update or create timestamps array
    let timestamps = this.recentTimestamps.get(name);
    if (!timestamps) {
      timestamps = [];
      this.recentTimestamps.set(name, timestamps);
    }
    timestamps.push(now);

    // Update stats entry
    const existing = this.stats.get(name);
    this.stats.set(name, {
      count: existing ? existing.count + 1 : 1,
      frequency: existing ? existing.frequency : 0,
      lastMessage: msg,
      lastReceived: now,
    });
  }

  /** Start the periodic stats update timer (100ms interval). */
  startTracking(): void {
    if (this.timerId !== null) return;
    this.timerId = setInterval(() => this.updateStats(), UPDATE_INTERVAL_MS);
  }

  /** Stop the periodic stats update timer. */
  stopTracking(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Subscribe to stats updates. Callback fires every 100ms with current stats.
   * Returns an unsubscribe function.
   */
  onStats(callback: StatsCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /** Returns a snapshot of current stats (deep copy to prevent mutation). */
  getStats(): Map<string, MessageStats> {
    const snapshot = new Map<string, MessageStats>();
    for (const [name, entry] of this.stats) {
      snapshot.set(name, { ...entry });
    }
    return snapshot;
  }

  private updateStats(): void {
    const now = Date.now();
    const cutoff = now - FREQUENCY_WINDOW_MS;
    const staleNames: string[] = [];

    for (const [name, timestamps] of this.recentTimestamps) {
      const entry = this.stats.get(name);
      if (!entry) continue;

      // Remove stale entries (no message for 10+ seconds)
      const timeSinceLast = now - entry.lastReceived;
      if (timeSinceLast >= STALE_THRESHOLD_MS) {
        staleNames.push(name);
        continue;
      }

      // Remove timestamps older than the sliding window
      let firstValid = 0;
      while (firstValid < timestamps.length && timestamps[firstValid] < cutoff) {
        firstValid++;
      }
      if (firstValid > 0) {
        timestamps.splice(0, firstValid);
      }

      // Calculate base frequency from timestamps in the window
      let frequency = 0;
      if (timestamps.length > 1) {
        const oldest = timestamps[0];
        const newest = timestamps[timestamps.length - 1];
        const spanMs = newest - oldest;
        if (spanMs > 0) {
          frequency = (timestamps.length - 1) / (spanMs / 1000);
        }
      }

      // Apply decay when no new messages received recently
      if (timeSinceLast > DECAY_START_MS) {
        const decay = 1.0 - (timeSinceLast - DECAY_START_MS) / DECAY_DURATION_MS;
        const clampedDecay = Math.max(0, Math.min(1, decay));
        frequency *= clampedDecay;
      }

      // Clamp near-zero frequencies to exactly 0
      if (frequency < MIN_FREQUENCY_HZ) {
        frequency = 0;
      }

      entry.frequency = frequency;
    }

    // Remove stale entries
    for (const name of staleNames) {
      this.recentTimestamps.delete(name);
      this.stats.delete(name);
    }

    // Notify subscribers with a snapshot
    if (this.callbacks.size > 0) {
      const snapshot = this.getStats();
      for (const callback of this.callbacks) {
        callback(snapshot);
      }
    }
  }
}
