/**
 * Types for the MAVLink parameter protocol.
 *
 * Used by ParameterManager (worker-side) and the main-thread bridge/store.
 */

export interface ParameterValue {
  paramId: string;
  value: number;          // Raw float from PARAM_VALUE
  paramType: number;      // MAV_PARAM_TYPE from wire (authoritative)
  paramIndex: number;
}

export type ParamFetchStatus = 'idle' | 'fetching' | 'done' | 'error';

export interface ParameterStateSnapshot {
  params: Record<string, ParameterValue>;
  totalCount: number;
  receivedCount: number;
  fetchStatus: ParamFetchStatus;
  error: string | null;
}

export interface ParamSetResult {
  paramId: string;
  success: boolean;
  requestedValue: number;
  actualValue: number;
  error?: string;
}
