import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FtpClient } from '../ftp-client';
import type { MavlinkMessage } from '../../mavlink/decoder';
import {
  encodeFtpPayload,
  decodeFtpPayload,
  FTP_OPCODE_OPEN_FILE_RO,
  FTP_OPCODE_READ_FILE,
  FTP_OPCODE_TERMINATE_SESSION,
  FTP_OPCODE_ACK,
  FTP_OPCODE_NAK,
  FTP_ERR_EOF,
  FTP_ERR_FILENOTFOUND,
  FTP_DATA_MAX_SIZE,
} from '../ftp-types';

describe('FtpClient', () => {
  let client: FtpClient;
  let sentFrames: Array<{ name: string; values: Record<string, number | string | number[]> }>;
  const vehicleId = { systemId: 1, componentId: 1 };

  beforeEach(() => {
    vi.useFakeTimers();
    sentFrames = [];
    client = new FtpClient(
      (name, values) => sentFrames.push({ name, values }),
      () => vehicleId,
    );
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  /** Build a mock FILE_TRANSFER_PROTOCOL message from an FTP payload. */
  function makeFtpMsg(payload: number[]): MavlinkMessage {
    return {
      id: 110,
      name: 'FILE_TRANSFER_PROTOCOL',
      values: { target_network: 0, target_system: 255, target_component: 190, payload },
      systemId: 1,
      componentId: 1,
      sequence: 0,
    };
  }

  /** Extract FTP payload from the last sent frame. */
  function lastSentFtp() {
    const frame = sentFrames[sentFrames.length - 1];
    return decodeFtpPayload(frame.values.payload as number[]);
  }

  it('sends OPENFILERO with correct path', () => {
    void client.downloadFile('/general.json');

    expect(sentFrames.length).toBe(1);
    const ftp = lastSentFtp();
    expect(ftp.opcode).toBe(FTP_OPCODE_OPEN_FILE_RO);
    expect(new TextDecoder().decode(ftp.data)).toBe('/general.json');
  });

  it('downloads a small file (single chunk)', async () => {
    const downloadPromise = client.downloadFile('/test.txt');
    const fileContent = new TextEncoder().encode('hello world');

    // Respond to OPENFILERO with ACK containing file size
    const openFtp = lastSentFtp();
    const sizeData = new Uint8Array(4);
    new DataView(sizeData.buffer).setUint32(0, fileContent.length, true);
    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: openFtp.seq + 1,
      session: 1,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_OPEN_FILE_RO,
      size: 4,
      data: sizeData,
    })));

    // Should now send READFILE
    expect(sentFrames.length).toBe(2);
    const readFtp = lastSentFtp();
    expect(readFtp.opcode).toBe(FTP_OPCODE_READ_FILE);
    expect(readFtp.offset).toBe(0);

    // Respond with file data
    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: readFtp.seq + 1,
      session: 1,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_READ_FILE,
      size: fileContent.length,
      data: fileContent,
    })));

    // Should request next chunk, respond with EOF
    const read2Ftp = lastSentFtp();
    expect(read2Ftp.opcode).toBe(FTP_OPCODE_READ_FILE);
    expect(read2Ftp.offset).toBe(fileContent.length);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: read2Ftp.seq + 1,
      session: 1,
      opcode: FTP_OPCODE_NAK,
      reqOpcode: FTP_OPCODE_READ_FILE,
      size: 1,
      data: new Uint8Array([FTP_ERR_EOF]),
    })));

    // Should send TERMINATESESSION
    const termFtp = lastSentFtp();
    expect(termFtp.opcode).toBe(FTP_OPCODE_TERMINATE_SESSION);

    // Respond with ACK
    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: termFtp.seq + 1,
      session: 1,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_TERMINATE_SESSION,
    })));

    const result = await downloadPromise;
    expect(new TextDecoder().decode(result)).toBe('hello world');
  });

  it('downloads a multi-chunk file', async () => {
    // Create file larger than FTP_DATA_MAX_SIZE
    const fileContent = new Uint8Array(500);
    for (let i = 0; i < fileContent.length; i++) fileContent[i] = i & 0xFF;

    const downloadPromise = client.downloadFile('/big.bin');

    // OPENFILERO ACK
    const openFtp = lastSentFtp();
    const sizeData = new Uint8Array(4);
    new DataView(sizeData.buffer).setUint32(0, fileContent.length, true);
    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: openFtp.seq + 1,
      session: 2,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_OPEN_FILE_RO,
      size: 4,
      data: sizeData,
    })));

    // Read chunks
    let offset = 0;
    while (offset < fileContent.length) {
      const readFtp = lastSentFtp();
      expect(readFtp.opcode).toBe(FTP_OPCODE_READ_FILE);
      expect(readFtp.offset).toBe(offset);

      const chunkSize = Math.min(FTP_DATA_MAX_SIZE, fileContent.length - offset);
      const chunk = fileContent.slice(offset, offset + chunkSize);
      offset += chunkSize;

      client.handleMessage(makeFtpMsg(encodeFtpPayload({
        seq: readFtp.seq + 1,
        session: 2,
        opcode: FTP_OPCODE_ACK,
        reqOpcode: FTP_OPCODE_READ_FILE,
        size: chunk.length,
        data: chunk,
      })));
    }

    // EOF on next read request
    const eofFtp = lastSentFtp();
    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: eofFtp.seq + 1,
      session: 2,
      opcode: FTP_OPCODE_NAK,
      reqOpcode: FTP_OPCODE_READ_FILE,
      size: 1,
      data: new Uint8Array([FTP_ERR_EOF]),
    })));

    // TERMINATE ACK
    const termFtp = lastSentFtp();
    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: termFtp.seq + 1,
      session: 2,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_TERMINATE_SESSION,
    })));

    const result = await downloadPromise;
    expect(result.length).toBe(500);
    expect(Array.from(result)).toEqual(Array.from(fileContent));
  });

  it('rejects on file not found', async () => {
    const downloadPromise = client.downloadFile('/missing.txt');

    const openFtp = lastSentFtp();
    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: openFtp.seq + 1,
      opcode: FTP_OPCODE_NAK,
      reqOpcode: FTP_OPCODE_OPEN_FILE_RO,
      size: 1,
      data: new Uint8Array([FTP_ERR_FILENOTFOUND]),
    })));

    await expect(downloadPromise).rejects.toThrow('FTP NAK');
  });

  it('retries on timeout and eventually rejects', async () => {
    const downloadPromise = client.downloadFile('/timeout.txt');

    // Advance time past 3 timeouts (2s each)
    vi.advanceTimersByTime(2000); // retry 1
    vi.advanceTimersByTime(2000); // retry 2
    vi.advanceTimersByTime(2000); // retry 3 → reject

    await expect(downloadPromise).rejects.toThrow('timeout');
    // Should have sent initial + 3 retries = 4 OPENFILERO
    // But retries increment after each timeout, and at MAX_RETRIES it rejects.
    // Initial send + 2 retries (retries 1 and 2 resend, retry 3 rejects)
    expect(sentFrames.length).toBe(3);
  });

  it('rejects concurrent downloads', async () => {
    void client.downloadFile('/first.txt');
    await expect(client.downloadFile('/second.txt')).rejects.toThrow('already in progress');
  });
});
