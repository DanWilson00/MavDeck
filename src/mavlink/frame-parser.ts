/**
 * MAVLink frame parser state machine.
 *
 * Processes incoming bytes and emits complete MavlinkFrame objects.
 * Supports both v1 and v2 protocol versions.
 *
 * Hot-path optimized: pre-allocated buffers, no per-frame allocations
 * in the parsing loop.
 */

import { MavlinkCrc } from './crc';
import {
  type MavlinkFrame,
  MavlinkVersion,
  MAVLINK_V1_STX,
  MAVLINK_V2_STX,
  MAVLINK_V2_HEADER_LEN,
  MAVLINK_MAX_PAYLOAD_LEN,
} from './frame';
import type { MavlinkMetadataRegistry } from './registry';

const enum ParserState {
  WaitingForStx,
  ReadingLength,
  ReadingIncompatFlags,
  ReadingCompatFlags,
  ReadingSequence,
  ReadingSystemId,
  ReadingComponentId,
  ReadingMessageIdLow,
  ReadingMessageIdMid,
  ReadingMessageIdHigh,
  ReadingPayload,
  ReadingCrcLow,
  ReadingCrcHigh,
}

type FrameCallback = (frame: MavlinkFrame) => void;

export class MavlinkFrameParser {
  private readonly registry: MavlinkMetadataRegistry;
  private readonly callbacks = new Set<FrameCallback>();
  private readonly crc = new MavlinkCrc();

  // Pre-allocated buffers — reset indices instead of creating new arrays
  private readonly headerBuffer = new Uint8Array(MAVLINK_V2_HEADER_LEN);
  private readonly payloadBuffer = new Uint8Array(MAVLINK_MAX_PAYLOAD_LEN);
  private headerIndex = 0;
  private payloadIndex = 0;

  // Parser state
  private state: ParserState = ParserState.WaitingForStx;
  private version: MavlinkVersion = MavlinkVersion.V2;
  private payloadLength = 0;
  private incompatFlags = 0;
  private compatFlags = 0;
  private sequence = 0;
  private systemId = 0;
  private componentId = 0;
  private messageId = 0;
  private crcLow = 0;

  // Statistics
  private _framesReceived = 0;
  private _crcErrors = 0;
  private _unknownMessages = 0;

  constructor(registry: MavlinkMetadataRegistry) {
    this.registry = registry;
  }

  /** Subscribe to parsed frames. Returns an unsubscribe function. */
  onFrame(callback: FrameCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /** Number of frames successfully received. */
  get framesReceived(): number { return this._framesReceived; }

  /** Number of CRC errors encountered. */
  get crcErrors(): number { return this._crcErrors; }

  /** Number of unknown message IDs encountered. */
  get unknownMessages(): number { return this._unknownMessages; }

  /** Feed bytes into the parser. */
  parse(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      this.processByte(data[i]);
    }
  }

  /** Reset parser to initial state and clear statistics. */
  reset(): void {
    this.state = ParserState.WaitingForStx;
    this.resetFrame();
    this._framesReceived = 0;
    this._crcErrors = 0;
    this._unknownMessages = 0;
  }

  private processByte(byte: number): void {
    switch (this.state) {
      case ParserState.WaitingForStx:
        if (byte === MAVLINK_V1_STX) {
          this.version = MavlinkVersion.V1;
          this.resetFrame();
          this.state = ParserState.ReadingLength;
        } else if (byte === MAVLINK_V2_STX) {
          this.version = MavlinkVersion.V2;
          this.resetFrame();
          this.state = ParserState.ReadingLength;
        }
        break;

      case ParserState.ReadingLength:
        this.payloadLength = byte;
        this.headerBuffer[this.headerIndex++] = byte;
        this.state = this.version === MavlinkVersion.V2
          ? ParserState.ReadingIncompatFlags
          : ParserState.ReadingSequence;
        break;

      case ParserState.ReadingIncompatFlags:
        this.incompatFlags = byte;
        this.headerBuffer[this.headerIndex++] = byte;
        this.state = ParserState.ReadingCompatFlags;
        break;

      case ParserState.ReadingCompatFlags:
        this.compatFlags = byte;
        this.headerBuffer[this.headerIndex++] = byte;
        this.state = ParserState.ReadingSequence;
        break;

      case ParserState.ReadingSequence:
        this.sequence = byte;
        this.headerBuffer[this.headerIndex++] = byte;
        this.state = ParserState.ReadingSystemId;
        break;

      case ParserState.ReadingSystemId:
        this.systemId = byte;
        this.headerBuffer[this.headerIndex++] = byte;
        this.state = ParserState.ReadingComponentId;
        break;

      case ParserState.ReadingComponentId:
        this.componentId = byte;
        this.headerBuffer[this.headerIndex++] = byte;
        this.state = ParserState.ReadingMessageIdLow;
        break;

      case ParserState.ReadingMessageIdLow:
        this.messageId = byte;
        this.headerBuffer[this.headerIndex++] = byte;
        if (this.version === MavlinkVersion.V2) {
          this.state = ParserState.ReadingMessageIdMid;
        } else {
          this.state = this.payloadLength > 0
            ? ParserState.ReadingPayload
            : ParserState.ReadingCrcLow;
        }
        break;

      case ParserState.ReadingMessageIdMid:
        this.messageId |= (byte << 8);
        this.headerBuffer[this.headerIndex++] = byte;
        this.state = ParserState.ReadingMessageIdHigh;
        break;

      case ParserState.ReadingMessageIdHigh:
        this.messageId |= (byte << 16);
        this.headerBuffer[this.headerIndex++] = byte;
        this.state = this.payloadLength > 0
          ? ParserState.ReadingPayload
          : ParserState.ReadingCrcLow;
        break;

      case ParserState.ReadingPayload:
        this.payloadBuffer[this.payloadIndex++] = byte;
        if (this.payloadIndex >= this.payloadLength) {
          this.state = ParserState.ReadingCrcLow;
        }
        break;

      case ParserState.ReadingCrcLow:
        this.crcLow = byte;
        this.state = ParserState.ReadingCrcHigh;
        break;

      case ParserState.ReadingCrcHigh: {
        const receivedCrc = this.crcLow | (byte << 8);
        this.emitFrame(receivedCrc);
        this.state = ParserState.WaitingForStx;
        break;
      }
    }
  }

  private emitFrame(receivedCrc: number): void {
    const msgMeta = this.registry.getMessageById(this.messageId);
    if (!msgMeta) {
      this._unknownMessages++;
      return;
    }

    // Calculate CRC using reusable instance — no allocation
    this.crc.reset();
    for (let i = 0; i < this.headerIndex; i++) {
      this.crc.accumulate(this.headerBuffer[i]);
    }
    for (let i = 0; i < this.payloadIndex; i++) {
      this.crc.accumulate(this.payloadBuffer[i]);
    }
    this.crc.accumulate(msgMeta.crcExtra);

    if (receivedCrc !== this.crc.value) {
      this._crcErrors++;
      return;
    }

    this._framesReceived++;
    // Copy payload out — the caller owns this data, our buffer gets reused
    const payload = new Uint8Array(this.payloadIndex);
    payload.set(this.payloadBuffer.subarray(0, this.payloadIndex));

    const frame: MavlinkFrame = {
      version: this.version,
      payloadLength: this.payloadLength,
      incompatFlags: this.incompatFlags,
      compatFlags: this.compatFlags,
      sequence: this.sequence,
      systemId: this.systemId,
      componentId: this.componentId,
      messageId: this.messageId,
      payload,
      crcValid: true,
    };
    for (const cb of this.callbacks) {
      cb(frame);
    }
  }

  private resetFrame(): void {
    this.payloadLength = 0;
    this.incompatFlags = 0;
    this.compatFlags = 0;
    this.sequence = 0;
    this.systemId = 0;
    this.componentId = 0;
    this.messageId = 0;
    this.payloadIndex = 0;
    this.headerIndex = 0;
    this.crcLow = 0;
  }
}
