import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetadataFtpDownloader } from '../metadata-ftp-downloader';
import { SpoofFtpResponder } from '../spoof-ftp-responder';
import { MavlinkMetadataRegistry } from '../../mavlink/registry';
import { MavlinkFrameBuilder } from '../../mavlink/frame-builder';
import { MavlinkFrameParser } from '../../mavlink/frame-parser';
import { MavlinkMessageDecoder } from '../../mavlink/decoder';
import { loadCommonDialectJson } from '../../test-helpers/load-dialect';
import { clearMetadataCache } from '../metadata-cache';

const commonJson = loadCommonDialectJson();

const testMetadata = JSON.stringify({
  version: 1,
  groups: [{
    name: 'Test',
    parameters: [{
      mavlink_id: 'TEST_PARAM',
      config_key: 'test.param',
      type: 'Float',
      default: 1.0,
      min: 0.0,
      max: 10.0,
      description: 'Test parameter',
    }],
  }],
});

describe('MetadataFtpDownloader integration', () => {
  let registry: MavlinkMetadataRegistry;
  let frameBuilder: MavlinkFrameBuilder;
  let responder: SpoofFtpResponder;
  let downloader: MetadataFtpDownloader;
  let outboundParser: MavlinkFrameParser;
  let outboundDecoder: MavlinkMessageDecoder;
  let outboundFrameCount: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    await clearMetadataCache();
    registry = new MavlinkMetadataRegistry();
    registry.loadFromJsonString(commonJson);
    frameBuilder = new MavlinkFrameBuilder(registry);
    responder = new SpoofFtpResponder(registry, testMetadata);
    outboundFrameCount = 0;

    // Wire up the loopback: downloader sends → responder handles → response fed back
    outboundParser = new MavlinkFrameParser(registry);
    outboundDecoder = new MavlinkMessageDecoder(registry);

    downloader = new MetadataFtpDownloader(
      (name, values) => {
        outboundFrameCount++;
        // Build a MAVLink frame from the downloader's send call
        const frame = frameBuilder.buildFrame({
          messageName: name,
          values,
          systemId: 255,
          componentId: 190,
          sequence: 0,
        });

        // Feed to responder via parser/decoder
        outboundParser.parse(frame);
      },
      () => ({ systemId: 1, componentId: 1 }),
    );

    // When the outbound parser decodes a frame, route through responder
    outboundParser.onFrame(frame => {
      const msg = outboundDecoder.decode(frame);
      if (!msg) return;

      const responses = responder.handleMessage(msg);
      for (const responseFrame of responses) {
        // Parse response frame back to message, then feed to downloader
        const respParser = new MavlinkFrameParser(registry);
        const respDecoder = new MavlinkMessageDecoder(registry);
        respParser.onFrame(f => {
          const respMsg = respDecoder.decode(f);
          if (respMsg) {
            // Use setTimeout to avoid synchronous re-entry (matches real flow)
            setTimeout(() => downloader.handleMessage(respMsg), 0);
          }
        });
        respParser.parse(responseFrame);
      }
    });
  });

  afterEach(async () => {
    downloader.dispose();
    await clearMetadataCache();
    vi.useRealTimers();
  });

  it('downloads metadata via two-step FTP flow', async () => {
    const downloadPromise = downloader.download();

    // Pump fake timers to process all setTimeouts
    // Each FTP request/response cycle uses setTimeout(0) for re-entry avoidance
    // general.json: open → read → (maybe more reads) → EOF → terminate = ~5 cycles
    // parameters.json: open → read → EOF → terminate = ~4 cycles
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(1);
    }

    const result = await downloadPromise;
    expect(result.crcValid).toBe(true);

    const parsed = JSON.parse(result.json);
    expect(parsed.version).toBe(1);
    expect(parsed.groups[0].name).toBe('Test');
    expect(parsed.groups[0].parameters[0].mavlink_id).toBe('TEST_PARAM');
  });

  it('uses cached metadata on repeated download when CRC matches', async () => {
    const firstDownloadPromise = downloader.download();
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(1);
    }
    const firstResult = await firstDownloadPromise;
    const firstFrameCount = outboundFrameCount;

    outboundFrameCount = 0;

    const secondDownloadPromise = downloader.download();
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(1);
    }
    const secondResult = await secondDownloadPromise;

    expect(secondResult.json).toBe(firstResult.json);
    expect(secondResult.crcValid).toBe(true);
    expect(outboundFrameCount).toBeLessThan(firstFrameCount);
  });
});
