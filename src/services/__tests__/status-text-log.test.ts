import { beforeEach, describe, expect, it } from 'vitest';
import {
  addStatusTextEntry,
  clearStatusTextEntries,
  getStatusTextEntries,
} from '../status-text-log';

describe('status-text-log', () => {
  beforeEach(() => {
    clearStatusTextEntries();
  });

  it('retains appended entries in shared state', () => {
    addStatusTextEntry({ severity: 4, text: 'GPS warning', timestamp: 1000 });
    addStatusTextEntry({ severity: 6, text: 'EKF healthy', timestamp: 2000 });

    const entries = getStatusTextEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('GPS warning');
    expect(entries[1].text).toBe('EKF healthy');
  });
});
