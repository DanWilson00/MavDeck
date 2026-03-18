/**
 * Orchestrates the two-step MAVLink FTP metadata download:
 * 1. Download /general.json → parse to find metadata URI + CRC
 * 2. Download the metadata file → verify CRC → decompress if .xz → return JSON
 */

import { FtpClient } from './ftp-client';
import { crc32 } from '../core/crc32';
import { XzReadableStream } from 'xz-decompress';
import type { MavlinkMessage } from '../mavlink/decoder';
import type { DebugLogLevel } from '../workers/worker-protocol';
import { clearCachedMetadataByCrc, getCachedMetadataByCrc, putCachedMetadata } from './metadata-cache';
import { parseMetadataFile } from './param-metadata-service';

/** Result of a metadata download. */
export interface MetadataDownloadResult {
  json: string;
  crcValid: boolean;
}

export interface MetadataFtpProgress {
  level: DebugLogLevel;
  stage: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export type MetadataFtpProgressReporter = (progress: MetadataFtpProgress) => void;

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
    private readonly onProgress?: MetadataFtpProgressReporter,
  ) {
    this.ftpClient = new FtpClient(sendFrame, getVehicleId, progress => this.report(progress));
  }

  /**
   * Full flow: download general.json → parse URI → download metadata → decompress → return JSON.
   */
  async download(): Promise<MetadataDownloadResult> {
    this.report({ level: 'info', stage: 'download:start', message: 'Starting metadata download from device' });

    // Step 1: Download general.json
    this.report({ level: 'info', stage: 'manifest:request', message: 'Requesting /general.json' });
    const generalBytes = await this.ftpClient.downloadFile('/general.json');
    this.report({
      level: 'info',
      stage: 'manifest:received',
      message: 'Received /general.json',
      details: { bytes: generalBytes.byteLength },
    });
    const generalJson = new TextDecoder().decode(generalBytes);
    const manifest: GeneralManifest = JSON.parse(generalJson);
    this.report({
      level: 'info',
      stage: 'manifest:parsed',
      message: 'Parsed component metadata manifest',
      details: { metadataTypes: manifest.metadataTypes.length },
    });

    // Find parameter metadata entry (type 1)
    const paramEntry = manifest.metadataTypes.find(e => e.type === 1);
    if (!paramEntry) {
      this.report({
        level: 'error',
        stage: 'manifest:param-entry-missing',
        message: 'general.json does not contain parameter metadata (type=1)',
      });
      throw new Error('No parameter metadata entry (type=1) in general.json');
    }

    // Parse mftp:///path URI
    const path = parseMftpUri(paramEntry.uri);
    this.report({
      level: 'info',
      stage: 'metadata:path',
      message: `Selected metadata path ${path}`,
      details: { uri: paramEntry.uri, fileCrc: paramEntry.fileCrc >>> 0 },
    });

    const cachedJson = await getCachedMetadataByCrc(paramEntry.fileCrc);
    if (cachedJson) {
      try {
        parseMetadataFile(cachedJson);
        this.report({
          level: 'info',
          stage: 'metadata:cache:hit',
          message: 'Loaded metadata from cache',
          details: { fileCrc: paramEntry.fileCrc >>> 0 },
        });
        this.report({ level: 'info', stage: 'download:success', message: 'Metadata download completed successfully (cache)' });
        return { json: cachedJson, crcValid: true };
      } catch {
        await clearCachedMetadataByCrc(paramEntry.fileCrc);
        this.report({
          level: 'warn',
          stage: 'metadata:cache:invalid',
          message: 'Cached metadata was invalid and has been cleared',
          details: { fileCrc: paramEntry.fileCrc >>> 0 },
        });
      }
    }

    // Step 2: Download the metadata file
    this.report({ level: 'info', stage: 'metadata:request', message: `Requesting ${path}` });
    const rawBytes = await this.ftpClient.downloadFile(path);
    this.report({
      level: 'info',
      stage: 'metadata:received',
      message: `Received ${path}`,
      details: { bytes: rawBytes.byteLength },
    });

    // Check if file needs XZ decompression
    if (path.endsWith('.xz')) {
      // Verify CRC on compressed bytes
      const computedCrc = crc32(rawBytes);
      const crcValid = computedCrc === (paramEntry.fileCrc >>> 0);
      this.report({
        level: crcValid ? 'info' : 'warn',
        stage: 'metadata:crc',
        message: crcValid ? 'Compressed metadata CRC matched' : 'Compressed metadata CRC mismatch',
        details: { expected: paramEntry.fileCrc >>> 0, actual: computedCrc >>> 0 },
      });

      // XZ decompress
      this.report({ level: 'info', stage: 'metadata:decompress:start', message: 'Decompressing XZ metadata file' });
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
      this.report({
        level: 'info',
        stage: 'metadata:decompress:done',
        message: 'XZ decompression complete',
        details: { bytes: decompressed.byteLength },
      });

      const json = new TextDecoder().decode(decompressed);
      parseMetadataFile(json);
      await putCachedMetadata(paramEntry.fileCrc, json);
      this.report({
        level: 'info',
        stage: 'metadata:cache:store',
        message: 'Stored metadata in cache',
        details: { fileCrc: paramEntry.fileCrc >>> 0 },
      });
      this.report({ level: 'info', stage: 'download:success', message: 'Metadata download completed successfully' });
      return { json, crcValid };
    }

    // Uncompressed path (spoof mode): CRC check on raw bytes
    const computedCrc = crc32(rawBytes);
    const crcValid = computedCrc === (paramEntry.fileCrc >>> 0);
    this.report({
      level: crcValid ? 'info' : 'warn',
      stage: 'metadata:crc',
      message: crcValid ? 'Metadata CRC matched' : 'Metadata CRC mismatch',
      details: { expected: paramEntry.fileCrc >>> 0, actual: computedCrc >>> 0 },
    });
    const json = new TextDecoder().decode(rawBytes);
    parseMetadataFile(json);
    await putCachedMetadata(paramEntry.fileCrc, json);
    this.report({
      level: 'info',
      stage: 'metadata:cache:store',
      message: 'Stored metadata in cache',
      details: { fileCrc: paramEntry.fileCrc >>> 0 },
    });
    this.report({ level: 'info', stage: 'download:success', message: 'Metadata download completed successfully' });
    return { json, crcValid };
  }

  /** Feed decoded messages to the internal FTP client. */
  handleMessage(msg: MavlinkMessage): void {
    this.ftpClient.handleMessage(msg);
  }

  dispose(): void {
    this.ftpClient.dispose();
  }

  private report(progress: MetadataFtpProgress): void {
    this.onProgress?.(progress);
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
