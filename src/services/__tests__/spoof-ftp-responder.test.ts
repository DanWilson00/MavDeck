import { describe, it, expect, beforeEach } from 'vitest';
import { SpoofFtpResponder } from '../spoof-ftp-responder';
import { MavlinkMetadataRegistry } from '../../mavlink/registry';
import { MavlinkFrameParser } from '../../mavlink/frame-parser';
import { MavlinkMessageDecoder, type MavlinkMessage } from '../../mavlink/decoder';
import { MavlinkFrameBuilder } from '../../mavlink/frame-builder';
import { loadCommonDialectJson } from '../../test-helpers/load-dialect';
import {
  decodeFtpPayload,
  encodeFtpPayload,
  FTP_OPCODE_RESET_SESSIONS,
  FTP_OPCODE_OPEN_FILE_RO,
  FTP_OPCODE_READ_FILE,
  FTP_OPCODE_BURST_READ_FILE,
  FTP_OPCODE_TERMINATE_SESSION,
  FTP_OPCODE_ACK,
  FTP_OPCODE_NAK,
  FTP_ERR_EOF,
  FTP_ERR_FILENOTFOUND,
} from '../ftp-types';

const commonJson = loadCommonDialectJson();
const testMetadata = JSON.stringify({ version: 1, groups: [{ name: 'Test', parameters: [] }] });

describe('SpoofFtpResponder', () => {
  let registry: MavlinkMetadataRegistry;
  let responder: SpoofFtpResponder;
  let frameBuilder: MavlinkFrameBuilder;
  let parser: MavlinkFrameParser;
  let decoder: MavlinkMessageDecoder;

  beforeEach(() => {
    registry = new MavlinkMetadataRegistry();
    registry.loadFromJsonString(commonJson);
    responder = new SpoofFtpResponder(registry, testMetadata);
    frameBuilder = new MavlinkFrameBuilder(registry);
    parser = new MavlinkFrameParser(registry);
    decoder = new MavlinkMessageDecoder(registry);
  });

  /** Build an outbound FTP message (as if from the GCS). */
  function buildFtpMsg(payload: Partial<ReturnType<typeof decodeFtpPayload>>): MavlinkMessage {
    return {
      id: 110,
      name: 'FILE_TRANSFER_PROTOCOL',
      values: {
        target_network: 0,
        target_system: 1,
        target_component: 1,
        payload: encodeFtpPayload(payload),
      },
      systemId: 255,
      componentId: 190,
      sequence: 0,
    };
  }

  /** Decode response frames back to FTP payloads. */
  function decodeResponses(frames: Uint8Array[]): Array<ReturnType<typeof decodeFtpPayload>> {
    const results: Array<ReturnType<typeof decodeFtpPayload>> = [];
    for (const frame of frames) {
      parser.parse(frame);
    }
    // Collect from parser
    const decoded: MavlinkMessage[] = [];
    parser.onFrame(f => {
      const msg = decoder.decode(f);
      if (msg) decoded.push(msg);
    });
    // Re-parse to trigger the callback
    for (const frame of frames) {
      parser.parse(frame);
    }
    return decoded.map(msg => decodeFtpPayload(msg.values.payload as number[]));
  }

  it('responds to OPENFILERO with ACK and file size for /general.json', () => {
    const msg = buildFtpMsg({
      seq: 0,
      opcode: FTP_OPCODE_OPEN_FILE_RO,
      size: '/general.json'.length,
      data: new TextEncoder().encode('/general.json'),
    });

    const responses = responder.handleMessage(msg);
    expect(responses.length).toBe(1);

    const ftpResponses = decodeResponses(responses);
    expect(ftpResponses.length).toBe(1);
    expect(ftpResponses[0].opcode).toBe(FTP_OPCODE_ACK);
    expect(ftpResponses[0].reqOpcode).toBe(FTP_OPCODE_OPEN_FILE_RO);
    // File size in data
    const size = new DataView(ftpResponses[0].data.buffer, ftpResponses[0].data.byteOffset).getUint32(0, true);
    expect(size).toBeGreaterThan(0);
  });

  it('responds with NAK(FILENOTFOUND) for unknown path', () => {
    const msg = buildFtpMsg({
      seq: 0,
      opcode: FTP_OPCODE_OPEN_FILE_RO,
      size: '/unknown.txt'.length,
      data: new TextEncoder().encode('/unknown.txt'),
    });

    const responses = responder.handleMessage(msg);
    const ftpResponses = decodeResponses(responses);
    expect(ftpResponses[0].opcode).toBe(FTP_OPCODE_NAK);
    expect(ftpResponses[0].data[0]).toBe(FTP_ERR_FILENOTFOUND);
  });

  it('reads file chunks and returns EOF at end', () => {
    // Open the file
    const openMsg = buildFtpMsg({
      seq: 0,
      opcode: FTP_OPCODE_OPEN_FILE_RO,
      size: '/general.json'.length,
      data: new TextEncoder().encode('/general.json'),
    });
    const openResp = decodeResponses(responder.handleMessage(openMsg));
    const sessionId = openResp[0].session;
    const fileSize = new DataView(openResp[0].data.buffer, openResp[0].data.byteOffset).getUint32(0, true);

    // Read first chunk
    const readMsg = buildFtpMsg({
      seq: 1,
      session: sessionId,
      opcode: FTP_OPCODE_READ_FILE,
      offset: 0,
      size: 239,
    });
    const readResp = decodeResponses(responder.handleMessage(readMsg));
    expect(readResp[0].opcode).toBe(FTP_OPCODE_ACK);
    expect(readResp[0].data.length).toBeGreaterThan(0);

    // Read past end → EOF
    const eofMsg = buildFtpMsg({
      seq: 2,
      session: sessionId,
      opcode: FTP_OPCODE_READ_FILE,
      offset: fileSize,
      size: 239,
    });
    const eofResp = decodeResponses(responder.handleMessage(eofMsg));
    expect(eofResp[0].opcode).toBe(FTP_OPCODE_NAK);
    expect(eofResp[0].data[0]).toBe(FTP_ERR_EOF);
  });

  it('responds to TERMINATESESSION with ACK', () => {
    // Open first
    const openMsg = buildFtpMsg({
      seq: 0,
      opcode: FTP_OPCODE_OPEN_FILE_RO,
      size: '/general.json'.length,
      data: new TextEncoder().encode('/general.json'),
    });
    const openResp = decodeResponses(responder.handleMessage(openMsg));
    const sessionId = openResp[0].session;

    // Terminate
    const termMsg = buildFtpMsg({
      seq: 1,
      session: sessionId,
      opcode: FTP_OPCODE_TERMINATE_SESSION,
    });
    const termResp = decodeResponses(responder.handleMessage(termMsg));
    expect(termResp[0].opcode).toBe(FTP_OPCODE_ACK);
    expect(termResp[0].reqOpcode).toBe(FTP_OPCODE_TERMINATE_SESSION);
  });

  it('streams file data with BURST_READ_FILE and marks the final packet complete', () => {
    const openMsg = buildFtpMsg({
      seq: 0,
      opcode: FTP_OPCODE_OPEN_FILE_RO,
      size: '/general.json'.length,
      data: new TextEncoder().encode('/general.json'),
    });
    const openResp = decodeResponses(responder.handleMessage(openMsg));
    const sessionId = openResp[0].session;

    const burstMsg = buildFtpMsg({
      seq: 1,
      session: sessionId,
      opcode: FTP_OPCODE_BURST_READ_FILE,
      offset: 0,
      size: 239,
    });
    const burstResp = decodeResponses(responder.handleMessage(burstMsg));
    expect(burstResp[0].opcode).toBe(FTP_OPCODE_ACK);
    expect(burstResp.at(-1)?.reqOpcode).toBe(FTP_OPCODE_BURST_READ_FILE);
    expect(burstResp.at(-1)?.burstComplete).toBe(1);
  });

  it('responds to RESET_SESSIONS with ACK', () => {
    const resetMsg = buildFtpMsg({
      seq: 0,
      opcode: FTP_OPCODE_RESET_SESSIONS,
    });
    const resetResp = decodeResponses(responder.handleMessage(resetMsg));
    expect(resetResp[0].opcode).toBe(FTP_OPCODE_ACK);
    expect(resetResp[0].reqOpcode).toBe(FTP_OPCODE_RESET_SESSIONS);
  });

  it('ignores non-FTP messages', () => {
    const msg: MavlinkMessage = {
      id: 0,
      name: 'HEARTBEAT',
      values: {},
      systemId: 1,
      componentId: 1,
      sequence: 0,
    };
    expect(responder.handleMessage(msg)).toEqual([]);
  });

  it('serves /param/parameters.json with correct content', () => {
    // Open
    const openMsg = buildFtpMsg({
      seq: 0,
      opcode: FTP_OPCODE_OPEN_FILE_RO,
      size: '/param/parameters.json'.length,
      data: new TextEncoder().encode('/param/parameters.json'),
    });
    const openResp = decodeResponses(responder.handleMessage(openMsg));
    expect(openResp[0].opcode).toBe(FTP_OPCODE_ACK);
    const sessionId = openResp[0].session;

    // Read all data
    const readMsg = buildFtpMsg({
      seq: 1,
      session: sessionId,
      opcode: FTP_OPCODE_READ_FILE,
      offset: 0,
      size: 239,
    });
    const readResp = decodeResponses(responder.handleMessage(readMsg));
    const content = new TextDecoder().decode(readResp[0].data);
    expect(content).toContain('"version"');
    expect(content).toContain('Test');
  });
});
