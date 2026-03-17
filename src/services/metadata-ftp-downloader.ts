/**
 * Orchestrates the two-step MAVLink FTP metadata download:
 * 1. Download /general.json → parse to find metadata URI + CRC
 * 2. Download the metadata file → verify CRC → decompress if .xz → return JSON
 */

import { FtpClient } from './ftp-client';
import { crc32 } from '../core/crc32';
import { XzReadableStream } from 'xz-decompress';
import type { MavlinkMessage } from '../mavlink/decoder';

/** Result of a metadata download. */
export interface MetadataDownloadResult {
  json: string;
  crcValid: boolean;
}

/** Parsed general.json manifest entry. */
interface MetadataTypeEntry {
  type: number;
  uri: string;
  fileCrc: number;
}

/** Parsed general.json manifest. */
interface GeneralManifest {
  version: number;
  metadataTypes: MetadataTypeEntry[];
}

export class MetadataFtpDownloader {
  private readonly ftpClient: FtpClient;

  constructor(
    sendFrame: (name: string, values: Record<string, number | string | number[]>) => void,
    getVehicleId: () => { systemId: number; componentId: number },
  ) {
    this.ftpClient = new FtpClient(sendFrame, getVehicleId);
  }

  /**
   * Full flow: download general.json → parse URI → download metadata → decompress → return JSON.
   */
  async download(): Promise<MetadataDownloadResult> {
    // Step 1: Download general.json
    const generalBytes = await this.ftpClient.downloadFile('/general.json');
    const generalJson = new TextDecoder().decode(generalBytes);
    const manifest: GeneralManifest = JSON.parse(generalJson);

    // Find parameter metadata entry (type 1)
    const paramEntry = manifest.metadataTypes.find(e => e.type === 1);
    if (!paramEntry) {
      throw new Error('No parameter metadata entry (type=1) in general.json');
    }

    // Parse mftp:///path URI
    const path = parseMftpUri(paramEntry.uri);

    // Step 2: Download the metadata file
    const rawBytes = await this.ftpClient.downloadFile(path);

    // Check if file needs XZ decompression
    if (path.endsWith('.xz')) {
      // Verify CRC on compressed bytes
      const computedCrc = crc32(rawBytes);
      const crcValid = computedCrc === (paramEntry.fileCrc >>> 0);

      // XZ decompress
      const compressedStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(rawBytes);
          controller.close();
        },
      });
      const decompressedStream = new XzReadableStream(compressedStream);
      const reader = decompressedStream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const decompressed = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) {
        decompressed.set(c, off);
        off += c.length;
      }

      return { json: new TextDecoder().decode(decompressed), crcValid };
    }

    // Uncompressed path (spoof mode): CRC check on raw bytes
    const computedCrc = crc32(rawBytes);
    const crcValid = computedCrc === (paramEntry.fileCrc >>> 0);
    return { json: new TextDecoder().decode(rawBytes), crcValid };
  }

  /** Feed decoded messages to the internal FTP client. */
  handleMessage(msg: MavlinkMessage): void {
    this.ftpClient.handleMessage(msg);
  }

  dispose(): void {
    this.ftpClient.dispose();
  }
}

/** Parse an mftp:///path URI into the FTP file path. */
function parseMftpUri(uri: string): string {
  const match = uri.match(/^mftp:\/\/(.*)$/);
  if (!match) {
    throw new Error(`Invalid mftp URI: ${uri}`);
  }
  // mftp:///path → path starts with /
  return match[1];
}
