import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FtpClient } from '../ftp-client';
import type { MavlinkMessage } from '../../mavlink/decoder';
import {
  encodeFtpPayload,
  decodeFtpPayload,
  FTP_OPCODE_OPEN_FILE_RO,
  FTP_OPCODE_READ_FILE,
  FTP_OPCODE_BURST_READ_FILE,
  FTP_OPCODE_TERMINATE_SESSION,
  FTP_OPCODE_ACK,
  FTP_OPCODE_NAK,
  FTP_ERR_EOF,
  FTP_ERR_FILENOTFOUND,
  FTP_ERR_UNKNOWN_COMMAND,
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

  function lastSentFtp() {
    const frame = sentFrames[sentFrames.length - 1];
    return decodeFtpPayload(frame.values.payload as number[]);
  }

  function ackOpen(fileLength: number, session = 1) {
    const openFtp = lastSentFtp();
    const sizeData = new Uint8Array(4);
    new DataView(sizeData.buffer).setUint32(0, fileLength, true);
    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: openFtp.seq + 1,
      session,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_OPEN_FILE_RO,
      size: 4,
      data: sizeData,
    })));
  }

  it('sends OPENFILERO with correct path', () => {
    void client.downloadFile('/general.json');

    expect(sentFrames.length).toBe(1);
    const ftp = lastSentFtp();
    expect(ftp.opcode).toBe(FTP_OPCODE_OPEN_FILE_RO);
    expect(new TextDecoder().decode(ftp.data)).toBe('/general.json');
  });

  it('downloads a small file through burst mode and terminates the session', async () => {
    const downloadPromise = client.downloadFile('/test.txt');
    const fileContent = new TextEncoder().encode('hello world');

    ackOpen(fileContent.length, 7);

    const burstFtp = lastSentFtp();
    expect(burstFtp.opcode).toBe(FTP_OPCODE_BURST_READ_FILE);
    expect(burstFtp.offset).toBe(0);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: burstFtp.seq + 1,
      session: 7,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_BURST_READ_FILE,
      offset: 0,
      burstComplete: 1,
      size: fileContent.length,
      data: fileContent,
    })));

    const cleanupFtp = lastSentFtp();
    expect(cleanupFtp.opcode).toBe(FTP_OPCODE_TERMINATE_SESSION);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: cleanupFtp.seq + 1,
      session: 7,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_TERMINATE_SESSION,
    })));

    const result = await downloadPromise;
    expect(new TextDecoder().decode(result)).toBe('hello world');
  });

  it('repairs missing blocks after burst EOF', async () => {
    const fileContent = new Uint8Array(500);
    for (let i = 0; i < fileContent.length; i++) fileContent[i] = i & 0xff;

    const downloadPromise = client.downloadFile('/big.bin');
    ackOpen(fileContent.length, 2);

    const firstBurst = lastSentFtp();
    expect(firstBurst.opcode).toBe(FTP_OPCODE_BURST_READ_FILE);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: firstBurst.seq + 1,
      session: 2,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_BURST_READ_FILE,
      offset: 0,
      burstComplete: 0,
      size: FTP_DATA_MAX_SIZE,
      data: fileContent.slice(0, FTP_DATA_MAX_SIZE),
    })));

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: firstBurst.seq + 2,
      session: 2,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_BURST_READ_FILE,
      offset: FTP_DATA_MAX_SIZE * 2,
      burstComplete: 1,
      size: fileContent.length - (FTP_DATA_MAX_SIZE * 2),
      data: fileContent.slice(FTP_DATA_MAX_SIZE * 2),
    })));

    const secondBurst = lastSentFtp();
    expect(secondBurst.opcode).toBe(FTP_OPCODE_BURST_READ_FILE);
    expect(secondBurst.offset).toBe(FTP_DATA_MAX_SIZE);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: secondBurst.seq + 1,
      session: 2,
      opcode: FTP_OPCODE_NAK,
      reqOpcode: FTP_OPCODE_BURST_READ_FILE,
      size: 1,
      data: new Uint8Array([FTP_ERR_EOF]),
    })));

    const fillFtp = lastSentFtp();
    expect(fillFtp.opcode).toBe(FTP_OPCODE_READ_FILE);
    expect(fillFtp.offset).toBe(FTP_DATA_MAX_SIZE);

    const missingChunk = fileContent.slice(FTP_DATA_MAX_SIZE, FTP_DATA_MAX_SIZE * 2);
    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: fillFtp.seq + 1,
      session: 2,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_READ_FILE,
      offset: FTP_DATA_MAX_SIZE,
      size: missingChunk.length,
      data: missingChunk,
    })));

    const cleanupFtp = lastSentFtp();
    expect(cleanupFtp.opcode).toBe(FTP_OPCODE_TERMINATE_SESSION);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: cleanupFtp.seq + 1,
      session: 2,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_TERMINATE_SESSION,
    })));

    const result = await downloadPromise;
    expect(Array.from(result)).toEqual(Array.from(fileContent));
  });

  it('falls back to sequential reads when burst mode is unsupported', async () => {
    const fileContent = new TextEncoder().encode('sequential fallback works');
    const downloadPromise = client.downloadFile('/fallback.txt');
    ackOpen(fileContent.length, 3);

    const burstFtp = lastSentFtp();
    expect(burstFtp.opcode).toBe(FTP_OPCODE_BURST_READ_FILE);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: burstFtp.seq + 1,
      session: 3,
      opcode: FTP_OPCODE_NAK,
      reqOpcode: FTP_OPCODE_BURST_READ_FILE,
      size: 1,
      data: new Uint8Array([FTP_ERR_UNKNOWN_COMMAND]),
    })));

    const readFtp = lastSentFtp();
    expect(readFtp.opcode).toBe(FTP_OPCODE_READ_FILE);
    expect(readFtp.offset).toBe(0);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: readFtp.seq + 1,
      session: 3,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_READ_FILE,
      offset: 0,
      size: fileContent.length,
      data: fileContent,
    })));

    const cleanupFtp = lastSentFtp();
    expect(cleanupFtp.opcode).toBe(FTP_OPCODE_TERMINATE_SESSION);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: cleanupFtp.seq + 1,
      session: 3,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_TERMINATE_SESSION,
    })));

    const result = await downloadPromise;
    expect(new TextDecoder().decode(result)).toBe('sequential fallback works');
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

  it('retries burst startup timeouts and falls back to sequential mode', async () => {
    void client.downloadFile('/timeout.txt');
    ackOpen(10, 4);

    expect(lastSentFtp().opcode).toBe(FTP_OPCODE_BURST_READ_FILE);

    vi.advanceTimersByTime(1000);
    expect(lastSentFtp().opcode).toBe(FTP_OPCODE_BURST_READ_FILE);

    vi.advanceTimersByTime(1000);
    expect(lastSentFtp().opcode).toBe(FTP_OPCODE_BURST_READ_FILE);

    vi.advanceTimersByTime(1000);
    expect(lastSentFtp().opcode).toBe(FTP_OPCODE_READ_FILE);
  });

  it('downgrades degenerate burst transfers and reuses sequential mode for the next file', async () => {
    const fileContent = new Uint8Array(800);
    for (let i = 0; i < fileContent.length; i++) fileContent[i] = (i * 7) & 0xff;

    const downloadPromise = client.downloadFile('/slow-burst.bin');
    ackOpen(fileContent.length, 9);

    for (const offset of [0, FTP_DATA_MAX_SIZE, FTP_DATA_MAX_SIZE * 2]) {
      const burstFtp = lastSentFtp();
      expect(burstFtp.opcode).toBe(FTP_OPCODE_BURST_READ_FILE);
      client.handleMessage(makeFtpMsg(encodeFtpPayload({
        seq: burstFtp.seq + 1,
        session: 9,
        opcode: FTP_OPCODE_ACK,
        reqOpcode: FTP_OPCODE_BURST_READ_FILE,
        offset,
        burstComplete: 1,
        size: Math.min(FTP_DATA_MAX_SIZE, fileContent.length - offset),
        data: fileContent.slice(offset, offset + FTP_DATA_MAX_SIZE),
      })));
    }

    const fourthBurst = lastSentFtp();
    expect(fourthBurst.opcode).toBe(FTP_OPCODE_BURST_READ_FILE);

    vi.advanceTimersByTime(1000);

    const fallbackRead = lastSentFtp();
    expect(fallbackRead.opcode).toBe(FTP_OPCODE_READ_FILE);
    expect(fallbackRead.offset).toBe(FTP_DATA_MAX_SIZE * 3);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: fallbackRead.seq + 1,
      session: 9,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_READ_FILE,
      offset: fallbackRead.offset,
      size: fileContent.length - fallbackRead.offset,
      data: fileContent.slice(fallbackRead.offset),
    })));

    const cleanupFtp = lastSentFtp();
    expect(cleanupFtp.opcode).toBe(FTP_OPCODE_TERMINATE_SESSION);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: cleanupFtp.seq + 1,
      session: 9,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_TERMINATE_SESSION,
    })));

    await expect(downloadPromise).resolves.toEqual(fileContent);

    void client.downloadFile('/next.json');
    ackOpen(20, 10);

    const firstRead = lastSentFtp();
    expect(firstRead.opcode).toBe(FTP_OPCODE_READ_FILE);
    expect(firstRead.offset).toBe(0);
  });

  it('ignores stale cleanup replies with the wrong sequence number', async () => {
    let resolved = false;
    const downloadPromise = client.downloadFile('/cleanup.txt').then(() => {
      resolved = true;
    });
    const fileContent = new TextEncoder().encode('cleanup');

    ackOpen(fileContent.length, 11);

    const burstFtp = lastSentFtp();
    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: burstFtp.seq + 1,
      session: 11,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_BURST_READ_FILE,
      offset: 0,
      burstComplete: 1,
      size: fileContent.length,
      data: fileContent,
    })));

    const cleanupFtp = lastSentFtp();
    expect(cleanupFtp.opcode).toBe(FTP_OPCODE_TERMINATE_SESSION);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: cleanupFtp.seq,
      session: 11,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_TERMINATE_SESSION,
    })));

    await Promise.resolve();
    expect(resolved).toBe(false);

    client.handleMessage(makeFtpMsg(encodeFtpPayload({
      seq: cleanupFtp.seq + 1,
      session: 11,
      opcode: FTP_OPCODE_ACK,
      reqOpcode: FTP_OPCODE_TERMINATE_SESSION,
    })));

    await downloadPromise;
    expect(resolved).toBe(true);
  });

  it('rejects concurrent downloads', async () => {
    void client.downloadFile('/first.txt');
    await expect(client.downloadFile('/second.txt')).rejects.toThrow('already in progress');
  });
});
