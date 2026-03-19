import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ProgressCallback = (progress: {
  level: 'debug' | 'info' | 'warn' | 'error';
  stage: string;
  message: string;
  body?: string;
  details?: Record<string, string | number | boolean | null>;
}) => void;

type ResultCallback = (json: string, crcValid: boolean) => void;
type ErrorCallback = (error: string) => void;

let progressCallback: ProgressCallback | null = null;
let resultCallback: ResultCallback | null = null;
let errorCallback: ErrorCallback | null = null;

const mockBridge = {
  onParamState: vi.fn(() => () => {}),
  onParamSetResult: vi.fn(() => () => {}),
  requestAllParams: vi.fn(),
  setParam: vi.fn(),
  onFtpMetadataProgress: vi.fn((callback: ProgressCallback) => {
    progressCallback = callback;
    return () => {
      if (progressCallback === callback) progressCallback = null;
    };
  }),
  onFtpMetadataResult: vi.fn((callback: ResultCallback) => {
    resultCallback = callback;
    return () => {
      if (resultCallback === callback) resultCallback = null;
    };
  }),
  onFtpMetadataError: vi.fn((callback: ErrorCallback) => {
    errorCallback = callback;
    return () => {
      if (errorCallback === callback) errorCallback = null;
    };
  }),
  downloadFtpMetadata: vi.fn(() => {
    const json = '{"version":1,"parameters":[]}';
    progressCallback?.({
      level: 'debug',
      stage: 'metadata:json',
      message: 'Decoded metadata payload from /param/parameters.json.xz',
      body: '{\n  "version": 1,\n  "parameters": []\n}',
      details: { path: '/param/parameters.json.xz', compressed: true },
    });
    resultCallback?.(json, true);
  }),
};

vi.mock('../../services', async () => {
  const actual = await vi.importActual<typeof import('../../services')>('../../services');
  return {
    ...actual,
    useWorkerBridge: () => mockBridge,
  };
});

import { clearDebugConsoleEntries, getDebugConsoleEntries } from '../../services';
import { useParameters } from '../use-parameters';

describe('useParameters device metadata logging', () => {
  beforeEach(() => {
    clearDebugConsoleEntries();
    progressCallback = null;
    resultCallback = null;
    errorCallback = null;
    mockBridge.onParamState.mockClear();
    mockBridge.onParamSetResult.mockClear();
    mockBridge.requestAllParams.mockClear();
    mockBridge.setParam.mockClear();
    mockBridge.onFtpMetadataProgress.mockClear();
    mockBridge.onFtpMetadataResult.mockClear();
    mockBridge.onFtpMetadataError.mockClear();
    mockBridge.downloadFtpMetadata.mockClear();
  });

  it('adds a pretty-printed metadata JSON entry when loading from device', async () => {
    await createRoot(async dispose => {
      const params = useParameters();
      params.downloadMetadataFromDevice();
      await Promise.resolve();

      const entry = getDebugConsoleEntries().find(item => item.message === 'metadata:json: Decoded metadata payload from /param/parameters.json.xz');
      expect(entry).toBeDefined();
      expect(entry?.level).toBe('debug');
      expect(entry?.body).toBe('{\n  "version": 1,\n  "parameters": []\n}');

      dispose();
    });
  });
});
