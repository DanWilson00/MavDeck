/**
 * MAVLink parameter protocol state machine.
 *
 * Runs inside the Web Worker. Handles PARAM_REQUEST_LIST, PARAM_REQUEST_READ,
 * PARAM_SET, and incoming PARAM_VALUE messages.
 */

import { EventEmitter } from '../core/event-emitter';
import type { MavlinkMessage } from '../mavlink/decoder';
import type {
  ParameterValue,
  ParamFetchStatus,
  ParameterStateSnapshot,
  ParamSetResult,
} from './parameter-types';

/** Default MAV_PARAM_TYPE_REAL32 */
const MAV_PARAM_TYPE_REAL32 = 9;

/** Gap fill timer interval in ms. */
const GAP_FILL_INTERVAL_MS = 2000;

/** Max gap fill rounds before giving up. */
const MAX_GAP_FILL_ROUNDS = 3;

/** Set value retry interval in ms. */
const SET_RETRY_INTERVAL_MS = 1000;

/** Max set value retries. */
const MAX_SET_RETRIES = 3;

/** Minimum interval between state emissions in ms. */
const STATE_EMIT_THROTTLE_MS = 100;

interface PendingSet {
  paramId: string;
  requestedValue: number;
  retries: number;
  timer: ReturnType<typeof setTimeout>;
}

export class ParameterManager {
  private readonly params = new Map<string, ParameterValue>();
  private readonly receivedIndices = new Set<number>();
  private totalCount = 0;
  private fetchStatus: ParamFetchStatus = 'idle';
  private error: string | null = null;
  private pendingSet: PendingSet | null = null;
  private gapFillTimer: ReturnType<typeof setTimeout> | null = null;
  private gapFillRound = 0;

  private dirty = false;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitMs = 0;

  private readonly stateEmitter = new EventEmitter<(state: ParameterStateSnapshot) => void>();
  private readonly setResultEmitter = new EventEmitter<(result: ParamSetResult) => void>();

  constructor(
    private readonly sendFrame: (messageName: string, values: Record<string, number | string | number[]>) => void,
    private readonly getVehicleId: () => { systemId: number; componentId: number },
  ) {}

  /** Subscribe to state change events (throttled to 10Hz). */
  onStateChange(cb: (state: ParameterStateSnapshot) => void): () => void {
    return this.stateEmitter.on(cb);
  }

  /** Subscribe to set-value result events. */
  onSetResult(cb: (result: ParamSetResult) => void): () => void {
    return this.setResultEmitter.on(cb);
  }

  /** Process a decoded MAVLink message. Only acts on PARAM_VALUE. */
  handleMessage(msg: MavlinkMessage): void {
    if (msg.name !== 'PARAM_VALUE') return;

    const paramId = (msg.values.param_id as string).replace(/\0/g, '');
    const paramValue = msg.values.param_value as number;
    const paramType = msg.values.param_type as number;
    const paramCount = msg.values.param_count as number;
    const paramIndex = msg.values.param_index as number;

    // Store parameter
    this.params.set(paramId, {
      paramId,
      value: paramValue,
      paramType,
      paramIndex,
    });
    this.receivedIndices.add(paramIndex);

    // Handle fetch-all state
    if (this.fetchStatus === 'fetching') {
      this.totalCount = paramCount;
      this.checkFetchCompletion();
      this.resetGapFillTimer();
    }

    // Handle pending set response
    if (this.pendingSet && paramId === this.pendingSet.paramId) {
      this.resolvePendingSet(paramValue);
    }

    this.scheduleStateEmit();
  }

  /** Request all parameters from the vehicle. */
  requestAll(): void {
    this.params.clear();
    this.receivedIndices.clear();
    this.totalCount = 0;
    this.fetchStatus = 'fetching';
    this.error = null;
    this.gapFillRound = 0;

    const vehicle = this.getVehicleId();
    this.sendFrame('PARAM_REQUEST_LIST', {
      target_system: vehicle.systemId,
      target_component: vehicle.componentId,
    });

    this.startGapFillTimer();
    this.scheduleStateEmit();
  }

  /** Set a parameter value on the vehicle. */
  setValue(paramId: string, value: number): void {
    if (this.pendingSet) {
      this.setResultEmitter.emit({
        paramId,
        success: false,
        requestedValue: value,
        actualValue: 0,
        error: 'Another parameter set is already in progress',
      });
      return;
    }

    const vehicle = this.getVehicleId();
    const cached = this.params.get(paramId);
    const paramType = cached?.paramType ?? MAV_PARAM_TYPE_REAL32;

    this.sendFrame('PARAM_SET', {
      target_system: vehicle.systemId,
      target_component: vehicle.componentId,
      param_id: paramId,
      param_value: value,
      param_type: paramType,
    });

    this.pendingSet = {
      paramId,
      requestedValue: value,
      retries: 0,
      timer: setTimeout(() => this.handleSetTimeout(), SET_RETRY_INTERVAL_MS),
    };
  }

  /** Get a serializable snapshot of the current state. */
  getSnapshot(): ParameterStateSnapshot {
    const params: Record<string, ParameterValue> = {};
    for (const [key, val] of this.params) {
      params[key] = val;
    }
    return {
      params,
      totalCount: this.totalCount,
      receivedCount: this.receivedIndices.size,
      fetchStatus: this.fetchStatus,
      error: this.error,
    };
  }

  /** Clean up all timers. */
  dispose(): void {
    this.clearGapFillTimer();
    if (this.pendingSet) {
      clearTimeout(this.pendingSet.timer);
      this.pendingSet = null;
    }
    if (this.emitTimer !== null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.stateEmitter.clear();
    this.setResultEmitter.clear();
  }

  // ---------------------------------------------------------------------------
  // Private: fetch-all state machine
  // ---------------------------------------------------------------------------

  private checkFetchCompletion(): void {
    if (this.totalCount > 0 && this.receivedIndices.size >= this.totalCount) {
      this.fetchStatus = 'done';
      this.error = null;
      this.clearGapFillTimer();
    }
  }

  private startGapFillTimer(): void {
    this.clearGapFillTimer();
    this.gapFillTimer = setTimeout(() => this.handleGapFill(), GAP_FILL_INTERVAL_MS);
  }

  private resetGapFillTimer(): void {
    if (this.fetchStatus !== 'fetching') return;
    this.startGapFillTimer();
  }

  private clearGapFillTimer(): void {
    if (this.gapFillTimer !== null) {
      clearTimeout(this.gapFillTimer);
      this.gapFillTimer = null;
    }
  }

  private handleGapFill(): void {
    this.gapFillTimer = null;

    if (this.fetchStatus !== 'fetching') return;
    if (this.totalCount === 0) {
      // Haven't received any PARAM_VALUE yet
      this.gapFillRound++;
      if (this.gapFillRound >= MAX_GAP_FILL_ROUNDS) {
        this.fetchStatus = 'error';
        this.error = 'No parameter response received from vehicle';
        this.scheduleStateEmit();
        return;
      }
      // Retry the full list request
      const vehicle = this.getVehicleId();
      this.sendFrame('PARAM_REQUEST_LIST', {
        target_system: vehicle.systemId,
        target_component: vehicle.componentId,
      });
      this.startGapFillTimer();
      return;
    }

    if (this.receivedIndices.size >= this.totalCount) {
      this.checkFetchCompletion();
      this.scheduleStateEmit();
      return;
    }

    this.gapFillRound++;
    if (this.gapFillRound >= MAX_GAP_FILL_ROUNDS) {
      this.fetchStatus = 'error';
      this.error = `Missing ${this.totalCount - this.receivedIndices.size} of ${this.totalCount} parameters after ${MAX_GAP_FILL_ROUNDS} gap fill rounds`;
      this.scheduleStateEmit();
      return;
    }

    // Request missing indices
    const vehicle = this.getVehicleId();
    for (let i = 0; i < this.totalCount; i++) {
      if (!this.receivedIndices.has(i)) {
        this.sendFrame('PARAM_REQUEST_READ', {
          target_system: vehicle.systemId,
          target_component: vehicle.componentId,
          param_id: '',
          param_index: i,
        });
      }
    }

    this.startGapFillTimer();
  }

  // ---------------------------------------------------------------------------
  // Private: set value state machine
  // ---------------------------------------------------------------------------

  private resolvePendingSet(actualValue: number): void {
    if (!this.pendingSet) return;

    clearTimeout(this.pendingSet.timer);
    const { paramId, requestedValue } = this.pendingSet;
    this.pendingSet = null;

    const success = Math.abs(requestedValue - actualValue) < 1e-6;
    this.setResultEmitter.emit({
      paramId,
      success,
      requestedValue,
      actualValue,
      error: success ? undefined : `Value mismatch: requested ${requestedValue}, got ${actualValue}`,
    });
  }

  private handleSetTimeout(): void {
    if (!this.pendingSet) return;

    this.pendingSet.retries++;
    if (this.pendingSet.retries >= MAX_SET_RETRIES) {
      const { paramId, requestedValue } = this.pendingSet;
      this.pendingSet = null;
      this.setResultEmitter.emit({
        paramId,
        success: false,
        requestedValue,
        actualValue: 0,
        error: `Timeout after ${MAX_SET_RETRIES} retries`,
      });
      return;
    }

    // Retry
    const vehicle = this.getVehicleId();
    const cached = this.params.get(this.pendingSet.paramId);
    const paramType = cached?.paramType ?? MAV_PARAM_TYPE_REAL32;

    this.sendFrame('PARAM_SET', {
      target_system: vehicle.systemId,
      target_component: vehicle.componentId,
      param_id: this.pendingSet.paramId,
      param_value: this.pendingSet.requestedValue,
      param_type: paramType,
    });

    this.pendingSet.timer = setTimeout(() => this.handleSetTimeout(), SET_RETRY_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Private: throttled state emission
  // ---------------------------------------------------------------------------

  private scheduleStateEmit(): void {
    if (this.emitTimer !== null) {
      this.dirty = true;
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastEmitMs;

    if (elapsed >= STATE_EMIT_THROTTLE_MS) {
      this.emitState();
    } else {
      this.dirty = true;
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        if (this.dirty) {
          this.emitState();
        }
      }, STATE_EMIT_THROTTLE_MS - elapsed);
    }
  }

  private emitState(): void {
    this.dirty = false;
    this.lastEmitMs = Date.now();
    this.stateEmitter.emit(this.getSnapshot());
  }
}
