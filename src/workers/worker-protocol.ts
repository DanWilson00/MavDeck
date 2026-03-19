/**
 * Typed message protocol for the MAVLink worker ↔ bridge communication.
 *
 * Both sides use discriminated unions keyed on `type` so that a `switch`
 * on `e.data.type` narrows the payload to the correct variant — no `as`
 * casts needed.
 */

import type { MessageStats } from '../services';
import type { SerialPortIdentity } from '../services/serial-probe-service';
import type { BaudRate } from '../services/baud-rates';
import type { ParameterStateSnapshot, ParamSetResult } from '../services/parameter-types';

// ---------------------------------------------------------------------------
// Shared types used by both directions
// ---------------------------------------------------------------------------

/** Worker-safe connection config (no DOM objects — must be cloneable via postMessage). */
export type ConnectionConfig =
  | { type: 'spoof' }
  | { type: 'webserial'; baudRate: number };

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'no_data' | 'error' | 'probing';

export type DebugLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface FtpMetadataProgressEvent {
  level: DebugLogLevel;
  stage: string;
  message: string;
  body?: string;
  details?: Record<string, string | number | boolean | null>;
}

// ---------------------------------------------------------------------------
// Main thread → Worker commands
// ---------------------------------------------------------------------------

export type WorkerCommand =
  | { type: 'init'; dialectJson: string }
  | { type: 'connect'; config: ConnectionConfig }
  | { type: 'disconnect' }
  | { type: 'unloadLog' }
  | { type: 'suspendLiveForLog' }
  | { type: 'resumeSuspendedLive' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'bytes'; data: Uint8Array }
  | { type: 'setInterestedFields'; fields: string[] }
  | { type: 'setBufferCapacity'; bufferCapacity: number }
  | { type: 'loadLog'; packets: Uint8Array[]; timestamps: number[]; bufferCapacity: number }
  | { type: 'connectSerial'; baudRate: BaudRate; autoDetectBaud: boolean; portIdentity: SerialPortIdentity | null; lastBaudRate: BaudRate | null }
  | { type: 'startAutoConnect'; autoBaud: boolean; manualBaudRate: BaudRate; lastPortIdentity: SerialPortIdentity | null; lastBaudRate: BaudRate | null }
  | { type: 'stopAutoConnect' }
  | { type: 'portsChanged' }
  | { type: 'paramRequestAll' }
  | { type: 'paramSet'; paramId: string; value: number }
  | { type: 'ftpDownloadMetadata' };

// ---------------------------------------------------------------------------
// Worker → Main thread events
// ---------------------------------------------------------------------------

export type WorkerEvent =
  | { type: 'initComplete' }
  | { type: 'stats'; stats: Record<string, MessageStats> }
  | { type: 'update'; buffers: Record<string, { timestamps: Float64Array; values: Float64Array }> }
  | { type: 'availableFields'; fields: string[] }
  | { type: 'statusChange'; status: ConnectionStatus }
  | { type: 'statustext'; severity: number; text: string; timestamp: number }
  | { type: 'logSessionStarted'; sessionId: string; startedAtMs: number }
  | { type: 'logChunk'; sessionId: string; seq: number; startUs: number; endUs: number; packetCount: number; sessionPacketCount: number; bytes: ArrayBuffer }
  | { type: 'logSessionEnded'; sessionId: string; endedAtMs: number; firstPacketUs?: number; lastPacketUs?: number; packetCount: number }
  | { type: 'loadComplete'; stats: Record<string, MessageStats>; durationSec: number }
  | { type: 'error'; message: string }
  | { type: 'probeStatus'; status: string | null }
  | { type: 'serialConnected'; baudRate: BaudRate; portIdentity: SerialPortIdentity | null }
  | { type: 'needPermission' }
  | { type: 'throughput'; bytesPerSec: number }
  | { type: 'paramState'; state: ParameterStateSnapshot }
  | { type: 'paramSetResult'; result: ParamSetResult }
  | { type: 'ftpMetadataProgress'; progress: FtpMetadataProgressEvent }
  | { type: 'ftpMetadataResult'; json: string; crcValid: boolean }
  | { type: 'ftpMetadataError'; error: string };
