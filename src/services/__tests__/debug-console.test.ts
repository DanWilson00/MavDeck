import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEBUG_CONSOLE_SOURCE_LABELS,
  addDebugConsoleEntry,
  clearDebugConsoleEntries,
  getDebugConsoleEntries,
  logDebugError,
  logDebugInfo,
} from '../debug-console';

describe('debug-console helpers', () => {
  beforeEach(() => {
    clearDebugConsoleEntries();
  });

  it('stores helper-created entries with subsystem sources', () => {
    logDebugInfo('bootstrap', 'Loaded cached dialect');
    logDebugError('worker', 'Worker crashed');

    expect(getDebugConsoleEntries().map(entry => `${entry.source}:${entry.level}:${entry.message}`)).toEqual([
      'bootstrap:info:Loaded cached dialect',
      'worker:error:Worker crashed',
    ]);
  });

  it('caps retained entries at the maximum console size', () => {
    for (let i = 0; i < 405; i++) {
      addDebugConsoleEntry({
        source: 'app',
        level: 'debug',
        message: `entry-${i}`,
      });
    }

    const entries = getDebugConsoleEntries();
    expect(entries).toHaveLength(400);
    expect(entries[0]?.message).toBe('entry-5');
    expect(entries.at(-1)?.message).toBe('entry-404');
  });

  it('exports labels for the expanded subsystem sources', () => {
    expect(DEBUG_CONSOLE_SOURCE_LABELS.worker).toBe('Worker');
    expect(DEBUG_CONSOLE_SOURCE_LABELS.layout).toBe('Layout');
    expect(DEBUG_CONSOLE_SOURCE_LABELS.parameters).toBe('Parameters');
  });
});
