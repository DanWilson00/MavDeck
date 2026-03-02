/**
 * Typed message protocol for the MAVLink worker ↔ bridge communication.
 *
 * Both sides use discriminated unions keyed on `type` so that a `switch`
 * on `e.data.type` narrows the payload to the correct variant — no `as`
 * casts needed.
 */

import type { MessageStats } from '../services/message-tracker';

// ---------------------------------------------------------------------------
// Shared types used by both directions
// ---------------------------------------------------------------------------

export type ConnectionConfig =
  | { type: 'spoof' }
  | { type: 'webserial'; baudRate: number };

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// ---------------------------------------------------------------------------
// Main thread → Worker commands
// ---------------------------------------------------------------------------

export type WorkerCommand =
  | { type: 'init'; dialectJson: string }
  | { type: 'connect'; config: ConnectionConfig }
  | { type: 'disconnect' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'bytes'; data: Uint8Array }
  | { type: 'setInterestedFields'; fields: string[] }
  | { type: 'setBufferCapacity'; bufferCapacity: number }
  | { type: 'loadLog'; packets: Uint8Array[]; timestamps: number[]; bufferCapacity: number };

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
  | { type: 'logChunk'; sessionId: string; seq: number; startUs: number; endUs: number; packetCount: number; chunkPacketCount: number; bytes: ArrayBuffer }
  | { type: 'logSessionEnded'; sessionId: string; endedAtMs: number; firstPacketUs?: number; lastPacketUs?: number; packetCount: number }
  | { type: 'loadComplete'; stats: Record<string, MessageStats>; durationSec: number }
  | { type: 'error'; message: string };
