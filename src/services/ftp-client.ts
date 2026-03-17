/**
 * MAVLink FTP client state machine.
 *
 * Downloads a single file via the FTP sub-protocol inside FILE_TRANSFER_PROTOCOL
 * messages. Follows the ParameterManager pattern: constructor takes sendFrame +
 * getVehicleId, processes incoming messages via handleMessage().
 */

import type { MavlinkMessage } from '../mavlink/decoder';
import {
  FTP_OPCODE_TERMINATE_SESSION,
  FTP_OPCODE_OPEN_FILE_RO,
  FTP_OPCODE_READ_FILE,
  FTP_OPCODE_ACK,
  FTP_OPCODE_NAK,
  FTP_ERR_EOF,
  FTP_DATA_MAX_SIZE,
  encodeFtpPayload,
  decodeFtpPayload,
} from './ftp-types';

/** Timeout per FTP request in ms. */
const REQUEST_TIMEOUT_MS = 2000;

/** Maximum retries per request. */
const MAX_RETRIES = 3;

type FtpState = 'idle' | 'waitOpenAck' | 'reading' | 'waitTermAck';

interface PendingDownload {
  path: string;
  state: FtpState;
  session: number;
  fileSize: number;
  offset: number;
  chunks: Uint8Array[];
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class FtpClient {
  private seq = 0;
  private pending: PendingDownload | null = null;

  constructor(
    private readonly sendFrame: (name: string, values: Record<string, number | string | number[]>) => void,
    private readonly getVehicleId: () => { systemId: number; componentId: number },
  ) {}

  /** Download a file by path. Resolves with file bytes. */
  downloadFile(path: string): Promise<Uint8Array> {
    if (this.pending) {
      return Promise.reject(new Error('Another download is already in progress'));
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      this.pending = {
        path,
        state: 'idle',
        session: 0,
        fileSize: 0,
        offset: 0,
        chunks: [],
        resolve,
        reject,
        retries: 0,
        timer: null,
      };
      this.sendOpenFileRO(path);
    });
  }

  /** Feed decoded FILE_TRANSFER_PROTOCOL messages from the wire. */
  handleMessage(msg: MavlinkMessage): void {
    if (msg.name !== 'FILE_TRANSFER_PROTOCOL') return;
    if (!this.pending) return;

    const payloadArr = msg.values.payload as number[];
    const ftp = decodeFtpPayload(payloadArr);

    // Only process responses (ACK/NAK)
    if (ftp.opcode === FTP_OPCODE_ACK) {
      this.handleAck(ftp);
    } else if (ftp.opcode === FTP_OPCODE_NAK) {
      this.handleNak(ftp);
    }
  }

  /** Clean up timers. Silently cancels any in-progress download. */
  dispose(): void {
    if (this.pending?.timer) {
      clearTimeout(this.pending.timer);
    }
    this.pending = null;
  }

  // ---------------------------------------------------------------------------
  // Private: send helpers
  // ---------------------------------------------------------------------------

  private nextSeq(): number {
    const s = this.seq;
    this.seq = (this.seq + 1) & 0xFFFF;
    return s;
  }

  private sendFtp(payload: number[]): void {
    const vehicle = this.getVehicleId();
    this.sendFrame('FILE_TRANSFER_PROTOCOL', {
      target_network: 0,
      target_system: vehicle.systemId,
      target_component: vehicle.componentId,
      payload,
    });
  }

  private sendOpenFileRO(path: string): void {
    if (!this.pending) return;
    this.pending.state = 'waitOpenAck';

    const pathBytes = new TextEncoder().encode(path);
    const seq = this.nextSeq();
    const payload = encodeFtpPayload({
      seq,
      opcode: FTP_OPCODE_OPEN_FILE_RO,
      size: pathBytes.length,
      data: pathBytes,
    });

    this.sendFtp(payload);
    this.startTimeout();
  }

  private sendReadFile(): void {
    if (!this.pending) return;
    this.pending.state = 'reading';

    const seq = this.nextSeq();
    const payload = encodeFtpPayload({
      seq,
      session: this.pending.session,
      opcode: FTP_OPCODE_READ_FILE,
      size: FTP_DATA_MAX_SIZE,
      offset: this.pending.offset,
    });

    this.sendFtp(payload);
    this.startTimeout();
  }

  private sendTerminate(): void {
    if (!this.pending) return;
    this.pending.state = 'waitTermAck';

    const seq = this.nextSeq();
    const payload = encodeFtpPayload({
      seq,
      session: this.pending.session,
      opcode: FTP_OPCODE_TERMINATE_SESSION,
    });

    this.sendFtp(payload);
    this.startTimeout();
  }

  // ---------------------------------------------------------------------------
  // Private: response handlers
  // ---------------------------------------------------------------------------

  private handleAck(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending) return;
    this.clearTimeout();
    this.pending.retries = 0;

    switch (this.pending.state) {
      case 'waitOpenAck': {
        // ACK to OPENFILERO — data contains file size as uint32 LE
        if (ftp.reqOpcode === FTP_OPCODE_OPEN_FILE_RO && ftp.data.length >= 4) {
          const view = new DataView(ftp.data.buffer, ftp.data.byteOffset, ftp.data.byteLength);
          this.pending.fileSize = view.getUint32(0, true);
          this.pending.session = ftp.session;
          this.pending.offset = 0;
          this.sendReadFile();
        }
        break;
      }

      case 'reading': {
        // ACK to READFILE — data contains file chunk
        if (ftp.reqOpcode === FTP_OPCODE_READ_FILE && ftp.data.length > 0) {
          this.pending.chunks.push(ftp.data.slice());
          this.pending.offset += ftp.data.length;
          this.sendReadFile();
        }
        break;
      }

      case 'waitTermAck': {
        // Session terminated — resolve with assembled file
        this.resolveDownload();
        break;
      }
    }
  }

  private handleNak(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending) return;
    this.clearTimeout();

    const errorCode = ftp.data.length > 0 ? ftp.data[0] : 0;

    if (this.pending.state === 'reading' && errorCode === FTP_ERR_EOF) {
      // EOF — file download complete, terminate session
      this.sendTerminate();
      return;
    }

    // Any other NAK is an error
    const download = this.pending;
    this.pending = null;
    download.reject(new Error(`FTP NAK: error code ${errorCode} in state ${download.state}`));
  }

  // ---------------------------------------------------------------------------
  // Private: timeout / retry
  // ---------------------------------------------------------------------------

  private startTimeout(): void {
    if (!this.pending) return;
    this.clearTimeout();
    this.pending.timer = setTimeout(() => this.handleTimeout(), REQUEST_TIMEOUT_MS);
  }

  private clearTimeout(): void {
    if (this.pending?.timer) {
      globalThis.clearTimeout(this.pending.timer);
      this.pending.timer = null;
    }
  }

  private handleTimeout(): void {
    if (!this.pending) return;
    this.pending.timer = null;

    this.pending.retries++;
    if (this.pending.retries >= MAX_RETRIES) {
      const download = this.pending;
      this.pending = null;
      download.reject(new Error(`FTP timeout after ${MAX_RETRIES} retries in state ${download.state}`));
      return;
    }

    // Retry the current request
    switch (this.pending.state) {
      case 'waitOpenAck':
        this.sendOpenFileRO(this.pending.path);
        break;
      case 'reading':
        this.sendReadFile();
        break;
      case 'waitTermAck':
        this.sendTerminate();
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: completion
  // ---------------------------------------------------------------------------

  private resolveDownload(): void {
    if (!this.pending) return;

    const totalSize = this.pending.chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of this.pending.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    const download = this.pending;
    this.pending = null;
    download.resolve(result);
  }
}
