/**
 * Simulated MAVLink FTP server for spoof/demo mode.
 *
 * Holds a virtual filesystem and responds to FTP requests inside
 * FILE_TRANSFER_PROTOCOL messages. Same pattern as SpoofParamResponder.
 */

import { MavlinkFrameBuilder } from '../mavlink/frame-builder';
import type { MavlinkMetadataRegistry } from '../mavlink/registry';
import type { MavlinkMessage } from '../mavlink/decoder';
import { crc32 } from '../core/crc32';
import {
  decodeFtpPayload,
  encodeFtpPayload,
  FTP_OPCODE_OPEN_FILE_RO,
  FTP_OPCODE_READ_FILE,
  FTP_OPCODE_TERMINATE_SESSION,
  FTP_OPCODE_ACK,
  FTP_OPCODE_NAK,
  FTP_ERR_EOF,
  FTP_ERR_FILENOTFOUND,
  FTP_DATA_MAX_SIZE,
} from './ftp-types';

/** Virtual file in the spoof filesystem. */
interface VirtualFile {
  data: Uint8Array;
}

/** Open session tracking. */
interface OpenSession {
  fileData: Uint8Array;
}

export class SpoofFtpResponder {
  private readonly frameBuilder: MavlinkFrameBuilder;
  private readonly systemId: number;
  private readonly componentId: number;
  private readonly files = new Map<string, VirtualFile>();
  private readonly sessions = new Map<number, OpenSession>();
  private nextSession = 1;

  constructor(
    registry: MavlinkMetadataRegistry,
    metadataJson: string,
    systemId = 1,
    componentId = 1,
  ) {
    this.frameBuilder = new MavlinkFrameBuilder(registry);
    this.systemId = systemId;
    this.componentId = componentId;
    this.initVirtualFilesystem(metadataJson);
  }

  /** Handle decoded outbound FTP message. Returns response frames. */
  handleMessage(msg: MavlinkMessage): Uint8Array[] {
    if (msg.name !== 'FILE_TRANSFER_PROTOCOL') return [];

    const payloadArr = msg.values.payload as number[];
    const ftp = decodeFtpPayload(payloadArr);

    switch (ftp.opcode) {
      case FTP_OPCODE_OPEN_FILE_RO: return this.handleOpenFileRO(ftp);
      case FTP_OPCODE_READ_FILE: return this.handleReadFile(ftp);
      case FTP_OPCODE_TERMINATE_SESSION: return this.handleTerminate(ftp);
      default: return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private: request handlers
  // ---------------------------------------------------------------------------

  private handleOpenFileRO(ftp: ReturnType<typeof decodeFtpPayload>): Uint8Array[] {
    const path = new TextDecoder().decode(ftp.data);
    const file = this.files.get(path);

    if (!file) {
      return [this.buildResponse(ftp.seq, {
        opcode: FTP_OPCODE_NAK,
        reqOpcode: FTP_OPCODE_OPEN_FILE_RO,
        size: 1,
        data: new Uint8Array([FTP_ERR_FILENOTFOUND]),
      })];
    }

    const sessionId = this.nextSession++;
    this.sessions.set(sessionId, { fileData: file.data });

    // ACK with file size in data
    const sizeData = new Uint8Array(4);
    new DataView(sizeData.buffer).setUint32(0, file.data.length, true);

    return [this.buildResponse(ftp.seq, {
      session: sessionId,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_OPEN_FILE_RO,
      size: 4,
      data: sizeData,
    })];
  }

  private handleReadFile(ftp: ReturnType<typeof decodeFtpPayload>): Uint8Array[] {
    const session = this.sessions.get(ftp.session);
    if (!session) {
      return [this.buildResponse(ftp.seq, {
        session: ftp.session,
        opcode: FTP_OPCODE_NAK,
        reqOpcode: FTP_OPCODE_READ_FILE,
        size: 1,
        data: new Uint8Array([FTP_ERR_EOF]),
      })];
    }

    if (ftp.offset >= session.fileData.length) {
      return [this.buildResponse(ftp.seq, {
        session: ftp.session,
        opcode: FTP_OPCODE_NAK,
        reqOpcode: FTP_OPCODE_READ_FILE,
        size: 1,
        data: new Uint8Array([FTP_ERR_EOF]),
      })];
    }

    const end = Math.min(ftp.offset + FTP_DATA_MAX_SIZE, session.fileData.length);
    const chunk = session.fileData.slice(ftp.offset, end);

    return [this.buildResponse(ftp.seq, {
      session: ftp.session,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_READ_FILE,
      size: chunk.length,
      offset: ftp.offset,
      data: chunk,
    })];
  }

  private handleTerminate(ftp: ReturnType<typeof decodeFtpPayload>): Uint8Array[] {
    this.sessions.delete(ftp.session);

    return [this.buildResponse(ftp.seq, {
      session: ftp.session,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_TERMINATE_SESSION,
    })];
  }

  // ---------------------------------------------------------------------------
  // Private: frame building
  // ---------------------------------------------------------------------------

  private buildResponse(
    requestSeq: number,
    payload: Partial<ReturnType<typeof decodeFtpPayload>>,
  ): Uint8Array {
    const ftpPayload = encodeFtpPayload({
      seq: requestSeq + 1,
      ...payload,
    });

    return this.frameBuilder.buildFrame({
      messageName: 'FILE_TRANSFER_PROTOCOL',
      values: {
        target_network: 0,
        target_system: 255,     // GCS
        target_component: 190,  // GCS component
        payload: ftpPayload,
      },
      systemId: this.systemId,
      componentId: this.componentId,
      sequence: 0,
    });
  }

  // ---------------------------------------------------------------------------
  // Private: virtual filesystem init
  // ---------------------------------------------------------------------------

  private initVirtualFilesystem(metadataJson: string): void {
    const metadataBytes = new TextEncoder().encode(metadataJson);
    const metadataCrc = crc32(metadataBytes);

    // general.json — component metadata manifest
    // In spoof mode, serve uncompressed JSON (no .xz) to avoid needing XZ compression
    const generalJson = JSON.stringify({
      version: 1,
      metadataTypes: [{
        type: 1,
        uri: 'mftp:///param/parameters.json',
        fileCrc: metadataCrc,
      }],
    });

    this.files.set('/general.json', {
      data: new TextEncoder().encode(generalJson),
    });

    // /param/parameters.json — the actual metadata file (uncompressed for spoof)
    this.files.set('/param/parameters.json', {
      data: metadataBytes,
    });
  }
}
