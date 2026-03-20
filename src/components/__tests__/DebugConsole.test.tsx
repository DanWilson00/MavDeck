import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import DebugConsole from '../DebugConsole';
import { addDebugConsoleEntry, clearDebugConsoleEntries } from '../../services';
import { setAppState } from '../../store';

describe('DebugConsole', () => {
  beforeEach(() => {
    clearDebugConsoleEntries();
    document.body.innerHTML = '';
    setAppState('debugConsoleEnabled', true);
  });

  it('renders multiline entry bodies with preserved formatting', () => {
    addDebugConsoleEntry({
      source: 'metadata-ftp',
      level: 'debug',
      message: 'Received device metadata JSON',
      body: '{\n  "version": 1,\n  "groups": []\n}',
    });

    const dispose = render(() => <DebugConsole />, document.body);
    document.body.querySelector('div[class*="cursor-pointer"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const pre = document.body.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe('{\n  "version": 1,\n  "groups": []\n}');
    expect(pre?.style.whiteSpace).toBe('pre-wrap');

    dispose();
  });

  it('shows expanded subsystem source labels in the filter and entries', () => {
    addDebugConsoleEntry({
      source: 'worker',
      level: 'error',
      message: 'Worker pipeline failed',
    });

    const dispose = render(() => <DebugConsole />, document.body);
    const header = Array.from(document.body.querySelectorAll('div'))
      .find((el) => el.textContent?.includes('Debug Console'));
    header?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const sourceSelect = document.body.querySelector('select');
    expect(sourceSelect).not.toBeNull();
    expect(sourceSelect!.textContent).toContain('Worker');
    expect(sourceSelect!.textContent).toContain('Bootstrap');
    expect(document.body.textContent).toContain('[Worker]');

    dispose();
  });
});
