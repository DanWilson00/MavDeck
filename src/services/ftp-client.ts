/**
 * MAVLink FTP client state machine.
 *
 * Downloads a single file via the FTP sub-protocol inside FILE_TRANSFER_PROTOCOL
 * messages. Prefers burst reads with hole repair and falls back to sequential
 * reads if the target does not support burst mode.
 */

import type { MavlinkMessage } from '../mavlink/decoder';
import type { MetadataFtpProgressReporter } from './metadata-ftp-downloader';
import {
  FTP_OPCODE_TERMINATE_SESSION,
  FTP_OPCODE_RESET_SESSIONS,
  FTP_OPCODE_OPEN_FILE_RO,
  FTP_OPCODE_READ_FILE,
  FTP_OPCODE_BURST_READ_FILE,
  FTP_OPCODE_ACK,
  FTP_OPCODE_NAK,
  FTP_ERR_EOF,
  FTP_ERR_UNKNOWN_COMMAND,
  FTP_DATA_MAX_SIZE,
  encodeFtpPayload,
  decodeFtpPayload,
} from './ftp-types';

const REQUEST_TIMEOUT_MS = 1000;
const MAX_RETRIES = 3;
const DEGENERATE_BURST_THRESHOLD = 3;

type FtpState = 'idle' | 'waitOpenAck' | 'bursting' | 'reading' | 'fillMissing' | 'waitCleanupAck';
type CleanupMode = 'reset-sessions' | 'terminate-session';
type ReadMode = 'burst' | 'sequential';

interface MissingBlock {
  offset: number;
  length: number;
}

interface PendingDownload {
  path: string;
  state: FtpState;
  readMode: ReadMode;
  session: number;
  fileSize: number;
  expectedOffset: number;
  bytesReceived: number;
  data: Uint8Array | null;
  coverage: Uint8Array | null;
  missingBlocks: MissingBlock[];
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastRequest: number[] | null;
  lastRequestSeq: number | null;
  lastRequestState: FtpState | null;
  lastRequestStage: string | null;
  expectedReplySeq: number | null;
  cleanupMode: CleanupMode | null;
  burstModeSupported: boolean | null;
  burstBytesReceived: number;
  burstSingleChunkResponses: number;
  burstTimeouts: number;
}

export class FtpClient {
  private seq = 0;
  private pending: PendingDownload | null = null;
  private preferredReadMode: ReadMode = 'burst';

  constructor(
    private readonly sendFrame: (name: string, values: Record<string, number | string | number[]>) => void,
    private readonly getVehicleId: () => { systemId: number; componentId: number },
    private readonly onProgress?: MetadataFtpProgressReporter,
  ) {}

  downloadFile(path: string): Promise<Uint8Array> {
    if (this.pending) {
      return Promise.reject(new Error('Another download is already in progress'));
    }

    this.report({
      level: 'info',
      stage: 'ftp:download:start',
      message: `Starting FTP download for ${path}`,
      details: { path },
    });

    return new Promise<Uint8Array>((resolve, reject) => {
      this.pending = {
        path,
        state: 'idle',
        readMode: this.preferredReadMode,
        session: 0,
        fileSize: 0,
        expectedOffset: 0,
        bytesReceived: 0,
        data: null,
        coverage: null,
        missingBlocks: [],
        resolve,
        reject,
        retries: 0,
        timer: null,
        lastRequest: null,
        lastRequestSeq: null,
        lastRequestState: null,
        lastRequestStage: null,
        expectedReplySeq: null,
        cleanupMode: null,
        burstModeSupported: null,
        burstBytesReceived: 0,
        burstSingleChunkResponses: 0,
        burstTimeouts: 0,
      };
      this.sendOpenFileRO(path);
    });
  }

  handleMessage(msg: MavlinkMessage): void {
    if (msg.name !== 'FILE_TRANSFER_PROTOCOL' || !this.pending) return;

    const payloadArr = msg.values.payload as number[];
    const ftp = decodeFtpPayload(payloadArr);

    if (ftp.opcode === FTP_OPCODE_ACK) {
      this.handleAck(ftp);
    } else if (ftp.opcode === FTP_OPCODE_NAK) {
      this.handleNak(ftp);
    }
  }

  dispose(): void {
    if (this.pending?.timer) {
      clearTimeout(this.pending.timer);
    }
    this.pending = null;
  }

  private nextSeq(): number {
    const s = this.seq;
    this.seq = (this.seq + 1) & 0xffff;
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

  private sendRequest(
    payload: number[],
    state: FtpState,
    stage: string,
    message: string,
    details?: Record<string, string | number | boolean | null>,
  ): void {
    if (!this.pending) return;
    const ftp = decodeFtpPayload(payload);
    this.pending.state = state;
    this.pending.lastRequest = [...payload];
    this.pending.lastRequestSeq = ftp.seq;
    this.pending.lastRequestState = state;
    this.pending.lastRequestStage = stage;
    this.pending.expectedReplySeq = (ftp.seq + 1) & 0xffff;
    this.report({
      level: 'debug',
      stage,
      message,
      details: {
        ...details,
        requestSeq: ftp.seq,
        expectedReplySeq: this.pending.expectedReplySeq,
      },
    });
    this.sendFtp(payload);
    this.startTimeout();
  }

  private sendOpenFileRO(path: string): void {
    const pathBytes = new TextEncoder().encode(path);
    const payload = encodeFtpPayload({
      seq: this.nextSeq(),
      opcode: FTP_OPCODE_OPEN_FILE_RO,
      size: pathBytes.length,
      data: pathBytes,
    });
    this.sendRequest(payload, 'waitOpenAck', 'ftp:open:request', `Sending OPEN_FILE_RO for ${path}`, { path });
  }

  private sendBurstRead(offset: number): void {
    if (!this.pending) return;
    const payload = encodeFtpPayload({
      seq: this.nextSeq(),
      session: this.pending.session,
      opcode: FTP_OPCODE_BURST_READ_FILE,
      size: FTP_DATA_MAX_SIZE,
      offset,
    });
    this.sendRequest(
      payload,
      'bursting',
      'ftp:burst:request',
      `Requesting burst read at offset ${offset}`,
      { path: this.pending.path, offset, size: FTP_DATA_MAX_SIZE },
    );
  }

  private sendReadFile(offset: number, size: number, state: Extract<FtpState, 'reading' | 'fillMissing'>): void {
    if (!this.pending) return;
    const payload = encodeFtpPayload({
      seq: this.nextSeq(),
      session: this.pending.session,
      opcode: FTP_OPCODE_READ_FILE,
      size,
      offset,
    });
    const stage = state === 'reading' ? 'ftp:read:request' : 'ftp:fill-missing:request';
    const message = state === 'reading'
      ? `Requesting sequential read at offset ${offset}`
      : `Requesting missing block at offset ${offset}`;
    this.sendRequest(payload, state, stage, message, { path: this.pending.path, offset, size });
  }

  private sendCleanup(mode: CleanupMode): void {
    if (!this.pending) return;
    this.pending.cleanupMode = mode;
    const opcode = mode === 'reset-sessions' ? FTP_OPCODE_RESET_SESSIONS : FTP_OPCODE_TERMINATE_SESSION;
    const payload = encodeFtpPayload({
      seq: this.nextSeq(),
      session: mode === 'terminate-session' ? this.pending.session : 0,
      opcode,
    });
    const stage = mode === 'reset-sessions' ? 'ftp:reset:request' : 'ftp:terminate:request';
    const message = mode === 'reset-sessions' ? 'Sending reset sessions request' : 'Sending terminate session request';
    this.sendRequest(payload, 'waitCleanupAck', stage, message, {
      path: this.pending.path,
      session: mode === 'terminate-session' ? this.pending.session : null,
    });
  }

  private handleAck(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending) return;

    switch (this.pending.state) {
      case 'waitOpenAck':
        this.handleOpenAck(ftp);
        break;
      case 'bursting':
        this.handleBurstAck(ftp);
        break;
      case 'reading':
      case 'fillMissing':
        this.handleReadAck(ftp);
        break;
      case 'waitCleanupAck':
        this.handleCleanupAck(ftp);
        break;
    }
  }

  private handleNak(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending) return;

    switch (this.pending.state) {
      case 'waitOpenAck':
        this.handleOpenNak(ftp);
        break;
      case 'bursting':
        this.handleBurstNak(ftp);
        break;
      case 'reading':
        this.handleReadNak(ftp);
        break;
      case 'fillMissing':
        this.handleFillMissingNak(ftp);
        break;
      case 'waitCleanupAck':
        this.handleCleanupNak(ftp);
        break;
      default:
        this.failWithNak(ftp);
        break;
    }
  }

  private handleOpenAck(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending || ftp.reqOpcode !== FTP_OPCODE_OPEN_FILE_RO || ftp.data.length < 4 || !this.validateExactReply(ftp, FTP_OPCODE_OPEN_FILE_RO)) return;

    this.clearTimeout();
    this.pending.retries = 0;
    this.pending.fileSize = new DataView(ftp.data.buffer, ftp.data.byteOffset, ftp.data.byteLength).getUint32(0, true);
    this.pending.session = ftp.session;
    this.pending.expectedOffset = 0;
    this.pending.bytesReceived = 0;
    this.pending.data = new Uint8Array(this.pending.fileSize);
    this.pending.coverage = new Uint8Array(this.pending.fileSize);
    this.pending.missingBlocks = [];
    this.pending.burstBytesReceived = 0;

    this.report({
      level: 'info',
      stage: 'ftp:open:ack',
      message: `Opened ${this.pending.path}`,
      details: {
        path: this.pending.path,
        fileSize: this.pending.fileSize,
        session: this.pending.session,
        seq: ftp.seq,
      },
    });

    if (this.pending.fileSize === 0) {
      this.sendCleanup('terminate-session');
      return;
    }

    this.pending.burstModeSupported = null;
    if (this.pending.readMode === 'sequential') {
      this.sendReadFile(0, FTP_DATA_MAX_SIZE, 'reading');
    } else {
      this.sendBurstRead(0);
    }
  }

  private handleOpenNak(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending || ftp.reqOpcode !== FTP_OPCODE_OPEN_FILE_RO || !this.validateExactReply(ftp, FTP_OPCODE_OPEN_FILE_RO)) return;
    this.failWithNak(ftp);
  }

  private handleBurstAck(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending || ftp.reqOpcode !== FTP_OPCODE_BURST_READ_FILE) return;
    if (!this.validateBurstReply(ftp)) return;

    this.clearTimeout();
    this.pending.retries = 0;
    this.pending.burstModeSupported = true;
    this.pending.burstBytesReceived += ftp.data.length;
    const priorExpectedOffset = this.pending.expectedOffset;

    this.writeData(ftp.offset, ftp.data);
    this.report({
      level: 'debug',
      stage: 'ftp:burst:ack',
      message: `Received burst chunk at offset ${ftp.offset}`,
      details: {
        path: this.pending.path,
        seq: ftp.seq,
        expectedReplySeq: this.pending.expectedReplySeq,
        offset: ftp.offset,
        bytesRead: ftp.data.length,
        burstComplete: ftp.burstComplete,
        expectedOffset: this.pending.expectedOffset,
        fileSize: this.pending.fileSize,
      },
    });

    if (ftp.offset < priorExpectedOffset && this.hasCoverageAtOffset(ftp.offset, ftp.data.length)) {
      this.pending.expectedReplySeq = (ftp.seq + 1) & 0xffff;
      this.reportIgnoredPacket('ftp:burst:duplicate', ftp, 'Ignoring duplicate burst chunk');
      this.startTimeout();
      return;
    }

    if (this.isDownloadComplete()) {
      this.pending.missingBlocks = [];
      this.sendCleanup('terminate-session');
      return;
    }

    if (ftp.burstComplete) {
      this.pending.expectedReplySeq = ftp.seq;
      this.pending.burstSingleChunkResponses++;
      if (this.shouldDowngradeDegenerateBurst()) {
        this.downgradeToSequential('degenerate single-chunk burst');
        return;
      }
      this.sendBurstRead(this.pending.expectedOffset);
    } else {
      this.pending.expectedReplySeq = (ftp.seq + 1) & 0xffff;
      this.startTimeout();
    }
  }

  private handleBurstNak(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending || ftp.reqOpcode !== FTP_OPCODE_BURST_READ_FILE) return;
    if (!this.validateBurstReply(ftp)) return;

    this.clearTimeout();
    const errorCode = ftp.data.length > 0 ? ftp.data[0] : 0;

    if (errorCode === FTP_ERR_EOF) {
      this.pending.burstModeSupported = true;
      this.pending.missingBlocks = this.computeMissingBlocks();
      this.report({
        level: 'info',
        stage: 'ftp:burst:eof',
        message: `Burst download reached EOF for ${this.pending.path}`,
        details: {
          path: this.pending.path,
          seq: ftp.seq,
          missingBlocks: this.pending.missingBlocks.length,
          bytesReceived: this.pending.bytesReceived,
          fileSize: this.pending.fileSize,
        },
      });
      if (this.pending.missingBlocks.length === 0 && this.isDownloadComplete()) {
        this.sendCleanup('terminate-session');
      } else {
        this.requestNextMissingBlock();
      }
      return;
    }

    if (this.shouldFallbackToSequential(errorCode)) {
      this.downgradeToSequential('unsupported burst command', errorCode, 0);
      return;
    }

    this.failWithNak(ftp);
  }

  private handleReadAck(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending || ftp.reqOpcode !== FTP_OPCODE_READ_FILE || !this.validateExactReply(ftp, FTP_OPCODE_READ_FILE)) return;

    this.clearTimeout();
    this.pending.retries = 0;

    this.writeData(ftp.offset, ftp.data);
    this.report({
      level: 'debug',
      stage: this.pending.state === 'reading' ? 'ftp:read:ack' : 'ftp:fill-missing:ack',
      message: `Received ${ftp.data.length} bytes at offset ${ftp.offset}`,
      details: {
        path: this.pending.path,
        seq: ftp.seq,
        offset: ftp.offset,
        bytesRead: ftp.data.length,
        expectedOffset: this.pending.expectedOffset,
        fileSize: this.pending.fileSize,
      },
    });

    if (this.pending.state === 'reading') {
      if (this.isDownloadComplete()) {
        this.sendCleanup('terminate-session');
      } else {
        this.sendReadFile(this.pending.expectedOffset, FTP_DATA_MAX_SIZE, 'reading');
      }
      return;
    }

    if (this.pending.missingBlocks.length > 0) {
      const current = this.pending.missingBlocks[0];
      if (ftp.offset === current.offset) {
        current.offset += ftp.data.length;
        current.length -= ftp.data.length;
        if (current.length <= 0) {
          this.pending.missingBlocks.shift();
        }
      } else {
        this.pending.missingBlocks = this.computeMissingBlocks();
      }
    }

    if (this.pending.missingBlocks.length === 0 && this.isDownloadComplete()) {
      this.sendCleanup('terminate-session');
    } else {
      this.requestNextMissingBlock();
    }
  }

  private handleReadNak(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending || ftp.reqOpcode !== FTP_OPCODE_READ_FILE || !this.validateExactReply(ftp, FTP_OPCODE_READ_FILE)) return;

    this.clearTimeout();
    const errorCode = ftp.data.length > 0 ? ftp.data[0] : 0;
    if (errorCode === FTP_ERR_EOF) {
      this.report({
        level: 'info',
        stage: 'ftp:read:eof',
        message: `Reached EOF for ${this.pending.path}`,
        details: { path: this.pending.path, bytes: this.pending.bytesReceived, fileSize: this.pending.fileSize },
      });
      if (this.isDownloadComplete()) {
        this.sendCleanup('terminate-session');
      } else {
        this.pending.missingBlocks = this.computeMissingBlocks();
        if (this.pending.missingBlocks.length > 0) {
          this.requestNextMissingBlock();
        } else {
          this.fail(new Error(`FTP read ended before ${this.pending.path} was fully received`));
        }
      }
      return;
    }

    this.failWithNak(ftp);
  }

  private handleFillMissingNak(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending || ftp.reqOpcode !== FTP_OPCODE_READ_FILE || !this.validateExactReply(ftp, FTP_OPCODE_READ_FILE)) return;

    this.clearTimeout();
    const errorCode = ftp.data.length > 0 ? ftp.data[0] : 0;
    if (errorCode === FTP_ERR_EOF) {
      this.pending.missingBlocks = this.computeMissingBlocks();
      if (this.pending.missingBlocks.length === 0 && this.isDownloadComplete()) {
        this.sendCleanup('terminate-session');
      } else {
        this.fail(new Error(`FTP missing-block repair failed for ${this.pending.path}`));
      }
      return;
    }

    this.failWithNak(ftp);
  }

  private handleCleanupAck(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending) return;
    const expectedReq = this.pending.cleanupMode === 'reset-sessions' ? FTP_OPCODE_RESET_SESSIONS : FTP_OPCODE_TERMINATE_SESSION;
    if (ftp.reqOpcode !== expectedReq || !this.validateExactReply(ftp, expectedReq)) return;

    this.clearTimeout();
    this.pending.retries = 0;
    this.report({
      level: 'info',
      stage: this.pending.cleanupMode === 'reset-sessions' ? 'ftp:reset:ack' : 'ftp:terminate:ack',
      message: this.pending.cleanupMode === 'reset-sessions'
        ? `FTP sessions reset for ${this.pending.path}`
        : `FTP session closed for ${this.pending.path}`,
      details: { path: this.pending.path, session: this.pending.session, seq: ftp.seq },
    });
    this.resolveDownload();
  }

  private handleCleanupNak(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending) return;
    const expectedReq = this.pending.cleanupMode === 'reset-sessions' ? FTP_OPCODE_RESET_SESSIONS : FTP_OPCODE_TERMINATE_SESSION;
    if (ftp.reqOpcode !== expectedReq || !this.validateExactReply(ftp, expectedReq)) return;
    this.clearTimeout();
    this.report({
      level: 'warn',
      stage: this.pending.cleanupMode === 'reset-sessions' ? 'ftp:reset:nak' : 'ftp:terminate:nak',
      message: `Cleanup received NAK for ${this.pending.path}; completing anyway`,
      details: {
        path: this.pending.path,
        seq: ftp.seq,
        errorCode: ftp.data.length > 0 ? ftp.data[0] : 0,
        cleanupMode: this.pending.cleanupMode,
      },
    });
    this.resolveDownload();
  }

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

    if (this.pending.state === 'bursting'
      && this.pending.burstBytesReceived === 0
      && this.pending.burstModeSupported !== true
      && this.pending.retries >= MAX_RETRIES) {
      this.downgradeToSequential('burst startup timeout', undefined, this.pending.retries);
      return;
    }

    if (this.pending.state === 'bursting') {
      this.pending.burstTimeouts++;
      if (this.shouldDowngradeDegenerateBurst()) {
        this.downgradeToSequential('late-ack drift risk', undefined, this.pending.retries);
        return;
      }
    }

    if (this.pending.state === 'waitCleanupAck' && this.pending.retries >= MAX_RETRIES) {
      this.report({
        level: 'warn',
        stage: 'ftp:cleanup:timeout',
        message: `Cleanup timed out for ${this.pending.path}; completing anyway`,
        details: {
          path: this.pending.path,
          cleanupMode: this.pending.cleanupMode,
          timeoutMs: REQUEST_TIMEOUT_MS,
          expectedReplySeq: this.pending.expectedReplySeq,
        },
      });
      this.resolveDownload();
      return;
    }

    if (this.pending.retries >= MAX_RETRIES) {
      this.report({
        level: 'error',
        stage: 'ftp:timeout:failed',
        message: `FTP timed out after ${MAX_RETRIES} retries for ${this.pending.path}`,
        details: {
          path: this.pending.path,
          state: this.pending.state,
          timeoutMs: REQUEST_TIMEOUT_MS,
          expectedReplySeq: this.pending.expectedReplySeq,
        },
      });
      this.fail(new Error(`FTP timeout after ${MAX_RETRIES} retries in state ${this.pending.state}`));
      return;
    }

    this.report({
      level: 'warn',
      stage: 'ftp:timeout:retry',
      message: `FTP timeout while ${this.pending.path} was in state ${this.pending.state}; retrying`,
      details: {
        path: this.pending.path,
        state: this.pending.state,
        retry: this.pending.retries,
        timeoutMs: REQUEST_TIMEOUT_MS,
        requestSeq: this.pending.lastRequestSeq,
        expectedReplySeq: this.pending.expectedReplySeq,
      },
    });
    this.resendLastRequest();
  }

  private resendLastRequest(): void {
    if (!this.pending?.lastRequest || !this.pending.lastRequestState) {
      this.fail(new Error(`FTP retry failed for ${this.pending?.path ?? 'unknown path'}: no previous request`));
      return;
    }
    this.pending.state = this.pending.lastRequestState;
    this.sendFtp(this.pending.lastRequest);
    this.startTimeout();
  }

  private writeData(offset: number, chunk: Uint8Array): void {
    if (!this.pending?.data || !this.pending.coverage) return;
    const maxLength = Math.max(0, Math.min(chunk.length, this.pending.fileSize - offset));
    for (let i = 0; i < maxLength; i++) {
      const absolute = offset + i;
      this.pending.data[absolute] = chunk[i];
      if (this.pending.coverage[absolute] === 0) {
        this.pending.coverage[absolute] = 1;
        this.pending.bytesReceived++;
      }
    }
    while (
      this.pending.expectedOffset < this.pending.fileSize
      && this.pending.coverage[this.pending.expectedOffset] === 1
    ) {
      this.pending.expectedOffset++;
    }
  }

  private computeMissingBlocks(): MissingBlock[] {
    if (!this.pending?.coverage) return [];
    const missing: MissingBlock[] = [];
    let index = 0;
    while (index < this.pending.fileSize) {
      if (this.pending.coverage[index] === 1) {
        index++;
        continue;
      }
      const start = index;
      while (index < this.pending.fileSize && this.pending.coverage[index] === 0) {
        index++;
      }
      missing.push({ offset: start, length: index - start });
    }
    return missing;
  }

  private requestNextMissingBlock(): void {
    if (!this.pending) return;
    this.pending.missingBlocks = this.computeMissingBlocks();
    const missing = this.pending.missingBlocks[0];
    if (!missing) {
      if (this.isDownloadComplete()) {
        this.sendCleanup('terminate-session');
      } else {
        this.fail(new Error(`FTP repair finished without a complete file for ${this.pending.path}`));
      }
      return;
    }
    this.sendReadFile(missing.offset, Math.min(FTP_DATA_MAX_SIZE, missing.length), 'fillMissing');
  }

  private isDownloadComplete(): boolean {
    return !!this.pending && this.pending.fileSize > 0 && this.pending.bytesReceived >= this.pending.fileSize;
  }

  private shouldFallbackToSequential(errorCode: number): boolean {
    return !!this.pending
      && this.pending.burstBytesReceived === 0
      && this.pending.burstModeSupported !== true
      && errorCode === FTP_ERR_UNKNOWN_COMMAND;
  }

  private validateExactReply(
    ftp: ReturnType<typeof decodeFtpPayload>,
    expectedReqOpcode: number,
  ): boolean {
    if (!this.pending) return false;
    if (ftp.reqOpcode !== expectedReqOpcode) return false;
    if (!this.matchesExpectedSeq(ftp.seq)) {
      this.reportIgnoredPacket('ftp:packet:stale', ftp, 'Ignoring stale FTP reply');
      return false;
    }
    if (!this.matchesPendingSession(ftp, expectedReqOpcode)) {
      this.reportIgnoredPacket('ftp:packet:session-mismatch', ftp, 'Ignoring FTP reply with wrong session');
      return false;
    }
    return true;
  }

  private validateBurstReply(ftp: ReturnType<typeof decodeFtpPayload>): boolean {
    if (!this.pending) return false;
    if (!this.matchesPendingSession(ftp, FTP_OPCODE_BURST_READ_FILE)) {
      this.reportIgnoredPacket('ftp:burst:session-mismatch', ftp, 'Ignoring burst reply with wrong session');
      return false;
    }
    if (this.pending.expectedReplySeq === null) return false;
    if (this.isOlderSeq(ftp.seq, this.pending.expectedReplySeq)) {
      this.reportIgnoredPacket('ftp:burst:stale', ftp, 'Ignoring stale burst reply');
      return false;
    }
    return true;
  }

  private matchesExpectedSeq(seq: number): boolean {
    if (!this.pending || this.pending.expectedReplySeq === null) return false;
    return seq === this.pending.expectedReplySeq;
  }

  private matchesPendingSession(ftp: ReturnType<typeof decodeFtpPayload>, opcode: number): boolean {
    if (!this.pending) return false;
    if (opcode === FTP_OPCODE_OPEN_FILE_RO || opcode === FTP_OPCODE_RESET_SESSIONS) {
      return true;
    }
    return ftp.session === this.pending.session;
  }

  private isOlderSeq(actual: number, expected: number): boolean {
    return actual !== expected && (((expected - actual) & 0xffff) < 0x8000);
  }

  private hasCoverageAtOffset(offset: number, length: number): boolean {
    if (!this.pending?.coverage) return false;
    const limit = Math.min(offset + length, this.pending.fileSize);
    for (let index = offset; index < limit; index++) {
      if (this.pending.coverage[index] === 0) {
        return false;
      }
    }
    return true;
  }

  private shouldDowngradeDegenerateBurst(): boolean {
    return !!this.pending
      && this.pending.burstModeSupported === true
      && this.pending.burstSingleChunkResponses >= DEGENERATE_BURST_THRESHOLD
      && this.pending.burstTimeouts > 0;
  }

  private downgradeToSequential(reason: string, errorCode?: number, retries?: number): void {
    if (!this.pending) return;
    this.clearTimeout();
    this.preferredReadMode = 'sequential';
    this.pending.readMode = 'sequential';
    this.pending.burstModeSupported = false;
    this.pending.retries = 0;
    this.report({
      level: 'warn',
      stage: 'ftp:burst:fallback',
      message: `Falling back to sequential reads for ${this.pending.path}`,
      details: {
        path: this.pending.path,
        reason,
        errorCode: errorCode ?? null,
        retries: retries ?? null,
        burstSingleChunkResponses: this.pending.burstSingleChunkResponses,
        burstTimeouts: this.pending.burstTimeouts,
        expectedOffset: this.pending.expectedOffset,
      },
    });
    this.sendReadFile(this.pending.expectedOffset, FTP_DATA_MAX_SIZE, 'reading');
  }

  private reportIgnoredPacket(
    stage: string,
    ftp: ReturnType<typeof decodeFtpPayload>,
    message: string,
  ): void {
    if (!this.pending) return;
    this.report({
      level: 'debug',
      stage,
      message,
      details: {
        path: this.pending.path,
        state: this.pending.state,
        seq: ftp.seq,
        expectedReplySeq: this.pending.expectedReplySeq,
        reqOpcode: ftp.reqOpcode,
        session: ftp.session,
        expectedSession: this.pending.session,
        offset: ftp.offset,
      },
    });
  }

  private resolveDownload(): void {
    if (!this.pending || !this.pending.data) return;
    const download = this.pending;
    const data = download.data;
    if (!data) return;
    this.pending = null;
    this.report({
      level: 'info',
      stage: 'ftp:download:complete',
      message: `Completed FTP download for ${download.path}`,
      details: {
        path: download.path,
        bytes: data.byteLength,
        transport: download.readMode === 'sequential'
          ? (download.burstBytesReceived > 0 ? 'adaptive-sequential' : 'sequential')
          : 'burst',
      },
    });
    download.resolve(data);
  }

  private failWithNak(ftp: ReturnType<typeof decodeFtpPayload>): void {
    if (!this.pending) return;
    const errorCode = ftp.data.length > 0 ? ftp.data[0] : 0;
    this.report({
      level: 'error',
      stage: 'ftp:nak',
      message: `FTP NAK ${errorCode} while ${this.pending.path} was in state ${this.pending.state}`,
      details: {
        path: this.pending.path,
        errorCode,
        state: this.pending.state,
        seq: ftp.seq,
        expectedReplySeq: this.pending.expectedReplySeq,
      },
    });
    this.fail(new Error(`FTP NAK: error code ${errorCode} in state ${this.pending.state}`));
  }

  private fail(error: Error): void {
    if (!this.pending) return;
    const download = this.pending;
    this.pending = null;
    download.reject(error);
  }

  private report(progress: Parameters<MetadataFtpProgressReporter>[0]): void {
    this.onProgress?.(progress);
  }
}
