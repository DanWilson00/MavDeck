# Phase 4: Message Monitor Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a left sidebar showing all received MAVLink messages with live stats, expandable field details with enum resolution, and a collapsible STATUSTEXT log panel.

**Architecture:** The worker posts a new `statustext` message type for every decoded STATUSTEXT. The main-thread bridge exposes `onStatusText()`. MessageMonitor subscribes to `workerBridge.onStats()` for live message cards; StatusTextLog subscribes to `workerBridge.onStatusText()` to accumulate history. Both gate on `appState.isReady`.

**Tech Stack:** SolidJS (createSignal, createEffect, For, Show, batch), CSS custom properties for theming, MavlinkMetadataRegistry for enum resolution.

---

### Task 1: Add STATUSTEXT forwarding to worker + bridge

**Files:**
- Modify: `src/workers/mavlink-worker.ts:46-111`
- Modify: `src/services/worker-bridge.ts:1-133`

**Step 1: Add statustext postMessage in the worker**

In `src/workers/mavlink-worker.ts`, add a `service.onMessage` subscription inside the `case 'connect'` block, right after the `updateUnsubscribe = ...` block (after line 101). Also add a variable to track its cleanup and clean it up on disconnect.

Add a new module-level variable after line 24:

```typescript
let statustextUnsubscribe: (() => void) | null = null;
```

Inside the `case 'connect'` block, after the `updateUnsubscribe = timeseriesManager.onUpdate(...)` block (after line 101), add:

```typescript
        // Forward STATUSTEXT messages to main thread individually
        statustextUnsubscribe = service.onMessage(msg => {
          if (msg.name === 'STATUSTEXT') {
            self.postMessage({
              type: 'statustext',
              severity: msg.values['severity'] as number,
              text: msg.values['text'] as string,
              timestamp: Date.now(),
            });
          }
        });
```

Inside `case 'disconnect'` (lines 114-127), add cleanup after `updateUnsubscribe?.()` (line 117):

```typescript
      statustextUnsubscribe?.();
```

And set to null after `updateUnsubscribe = null` (line 124):

```typescript
      statustextUnsubscribe = null;
```

Also add cleanup in the existing connection teardown inside `case 'connect'` (after line 57):

```typescript
        statustextUnsubscribe?.();
```

**Step 2: Add onStatusText to the bridge**

In `src/services/worker-bridge.ts`, add the new type and callback set.

After line 18 (`type StatusCallback = ...`), add:

```typescript

export interface StatusTextEntry {
  severity: number;
  text: string;
  timestamp: number;
}

type StatusTextCallback = (entry: StatusTextEntry) => void;
```

Add a new callback set in the class, after line 24:

```typescript
  private readonly statustextCallbacks = new Set<StatusTextCallback>();
```

Add subscription method after `onStatusChange` (after line 84):

```typescript

  /** Subscribe to STATUSTEXT message events. */
  onStatusText(callback: StatusTextCallback): () => void {
    this.statustextCallbacks.add(callback);
    return () => this.statustextCallbacks.delete(callback);
  }
```

Add handler in `handleMessage` switch, before the `case 'error'` block:

```typescript
      case 'statustext': {
        const entry: StatusTextEntry = {
          severity: e.data.severity as number,
          text: e.data.text as string,
          timestamp: e.data.timestamp as number,
        };
        for (const cb of this.statustextCallbacks) {
          cb(entry);
        }
        break;
      }
```

**Step 3: Run tests to verify nothing broke**

Run: `npx vitest run`
Expected: All 132 tests pass. No new tests needed — this is plumbing that will be verified by Playwright in later tasks.

**Step 4: Commit**

```bash
git add src/workers/mavlink-worker.ts src/services/worker-bridge.ts
git commit -m "Phase 4: Add STATUSTEXT forwarding from worker to main thread"
```

---

### Task 2: Create MessageMonitor component

**Files:**
- Create: `src/components/MessageMonitor.tsx`

**Step 1: Write the MessageMonitor component**

```typescript
import { createSignal, createEffect, onCleanup, For, Show, batch } from 'solid-js';
import { appState } from '../store/app-store';
import { workerBridge, registry } from '../store/app-store';
import type { MessageStats } from '../services/message-tracker';
import type { MavlinkFieldMetadata } from '../mavlink/metadata';

interface MessageMonitorProps {
  onFieldSelected?: (messageName: string, fieldName: string) => void;
}

export default function MessageMonitor(props: MessageMonitorProps) {
  const [messageStats, setMessageStats] = createSignal<Map<string, MessageStats>>(new Map());
  const [expandedMessages, setExpandedMessages] = createSignal<Set<string>>(new Set());

  // Subscribe to stats from worker bridge
  createEffect(() => {
    if (!appState.isReady) return;
    const unsub = workerBridge.onStats(stats => {
      setMessageStats(stats);
    });
    onCleanup(unsub);
  });

  function toggleExpanded(name: string) {
    setExpandedMessages(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  function sortedEntries() {
    return Array.from(messageStats().entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }

  function formatValue(value: number | string | number[], field: MavlinkFieldMetadata): string {
    // Enum resolution
    if (field.enumType && typeof value === 'number') {
      const resolved = registry.resolveEnumValue(field.enumType, value);
      if (resolved) return resolved;
    }
    // Float formatting
    if (typeof value === 'number') {
      if (field.baseType === 'float' || field.baseType === 'double') {
        return value.toFixed(4);
      }
      return String(value);
    }
    // Arrays
    if (Array.isArray(value)) {
      return `[${value.map(v => typeof v === 'number' && (field.baseType === 'float' || field.baseType === 'double') ? v.toFixed(4) : String(v)).join(', ')}]`;
    }
    // Strings
    return String(value);
  }

  function isNumericField(value: unknown): boolean {
    return typeof value === 'number';
  }

  return (
    <div
      class="flex flex-col h-full"
      style={{
        'background-color': 'var(--bg-panel)',
        'border-right': '1px solid var(--border)',
        width: '350px',
        'min-width': '280px',
      }}
    >
      {/* Header */}
      <div
        class="flex items-center justify-between px-3 py-2 border-b"
        style={{ 'border-color': 'var(--border)' }}
      >
        <span
          class="text-sm font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          Messages
        </span>
        <span
          class="text-xs px-2 py-0.5 rounded-full"
          style={{
            'background-color': 'var(--bg-hover)',
            color: 'var(--text-secondary)',
          }}
        >
          {messageStats().size}
        </span>
      </div>

      {/* Message list */}
      <div class="flex-1 overflow-y-auto">
        <For each={sortedEntries()}>
          {([name, stats]) => {
            const meta = () => registry.getMessageByName(name);
            const isExpanded = () => expandedMessages().has(name);

            return (
              <div
                class="border-b"
                style={{ 'border-color': 'var(--border)' }}
              >
                {/* Collapsed header */}
                <button
                  class="flex items-center justify-between w-full px-3 py-2 text-left transition-colors"
                  style={{ 'background-color': 'transparent' }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-hover)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  onClick={() => toggleExpanded(name)}
                >
                  <div class="flex items-center gap-2">
                    {/* Expand chevron */}
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      style={{
                        color: 'var(--text-secondary)',
                        transform: isExpanded() ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.15s',
                      }}
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <span
                      class="text-xs font-mono"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {name}
                    </span>
                  </div>
                  {/* Frequency badge */}
                  <span
                    class="text-xs px-1.5 py-0.5 rounded font-mono"
                    style={{
                      'background-color': 'color-mix(in srgb, var(--accent-green) 15%, transparent)',
                      color: 'var(--accent-green)',
                    }}
                  >
                    {stats.frequency.toFixed(1)} Hz
                  </span>
                </button>

                {/* Expanded fields */}
                <Show when={isExpanded() && meta()}>
                  <div class="px-3 pb-2">
                    <For each={meta()!.fields}>
                      {(field) => {
                        const value = () => stats.lastMessage.values[field.name];
                        const clickable = () => isNumericField(value()) && props.onFieldSelected;

                        return (
                          <div
                            class="flex items-baseline justify-between py-0.5 text-xs"
                            style={{
                              cursor: clickable() ? 'pointer' : 'default',
                            }}
                            onClick={() => {
                              if (clickable()) {
                                props.onFieldSelected!(name, field.name);
                              }
                            }}
                            onMouseEnter={(e) => {
                              if (clickable()) {
                                e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                              }
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.backgroundColor = 'transparent';
                            }}
                          >
                            <span
                              class="font-mono"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              {field.name}
                            </span>
                            <span
                              class="font-mono ml-2 text-right"
                              style={{ color: 'var(--text-primary)' }}
                            >
                              {value() !== undefined ? formatValue(value(), field) : '—'}
                              <Show when={field.units && !field.enumType}>
                                <span style={{ color: 'var(--text-secondary)' }}>
                                  {' '}{field.units}
                                </span>
                              </Show>
                            </span>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
```

**Step 2: Run tests and build**

Run: `npx vitest run && npm run build`
Expected: All 132 tests pass, build succeeds with no type errors.

**Step 3: Commit**

```bash
git add src/components/MessageMonitor.tsx
git commit -m "Phase 4: Add MessageMonitor component with live stats and field display"
```

---

### Task 3: Create StatusTextLog component

**Files:**
- Create: `src/components/StatusTextLog.tsx`

**Step 1: Write the StatusTextLog component**

```typescript
import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { appState, workerBridge } from '../store/app-store';
import type { StatusTextEntry } from '../services/worker-bridge';

const MAX_ENTRIES = 100;

const SEVERITY_LABELS: Record<number, string> = {
  0: 'EMERGENCY',
  1: 'ALERT',
  2: 'CRITICAL',
  3: 'ERROR',
  4: 'WARNING',
  5: 'NOTICE',
  6: 'INFO',
  7: 'DEBUG',
};

const SEVERITY_COLORS: Record<number, string> = {
  0: '#ef4444', // red
  1: '#ef4444',
  2: '#ef4444',
  3: '#f97316', // orange
  4: '#eab308', // amber
  5: '#00d4ff', // cyan
  6: '#94a3b8', // blue-gray
  7: '#6b7280', // gray
};

interface LogEntry extends StatusTextEntry {
  id: number;
}

let nextId = 0;

export default function StatusTextLog() {
  const [entries, setEntries] = createSignal<LogEntry[]>([]);
  const [isExpanded, setIsExpanded] = createSignal(false);
  let scrollRef: HTMLDivElement | undefined;

  // Subscribe to STATUSTEXT messages from worker
  createEffect(() => {
    if (!appState.isReady) return;
    const unsub = workerBridge.onStatusText(entry => {
      setEntries(prev => {
        const next = [...prev, { ...entry, id: nextId++ }];
        if (next.length > MAX_ENTRIES) {
          return next.slice(next.length - MAX_ENTRIES);
        }
        return next;
      });
      // Auto-scroll after DOM update
      requestAnimationFrame(() => {
        if (scrollRef && isExpanded()) {
          scrollRef.scrollTop = scrollRef.scrollHeight;
        }
      });
    });
    onCleanup(unsub);
  });

  function formatTime(timestamp: number): string {
    const d = new Date(timestamp);
    return d.toTimeString().slice(0, 8); // HH:MM:SS
  }

  return (
    <div
      class="border-t"
      style={{
        'border-color': 'var(--border)',
        'background-color': 'var(--bg-panel)',
      }}
    >
      {/* Header */}
      <button
        class="flex items-center justify-between w-full px-3 transition-colors"
        style={{
          height: '36px',
          'background-color': 'transparent',
        }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-hover)'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        onClick={() => setIsExpanded(prev => !prev)}
      >
        <div class="flex items-center gap-2">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            style={{
              color: 'var(--text-secondary)',
              transform: isExpanded() ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s',
            }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span class="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            Status
          </span>
          <Show when={entries().length > 0}>
            <span
              class="text-xs px-1.5 py-0.5 rounded-full"
              style={{
                'background-color': 'var(--bg-hover)',
                color: 'var(--text-secondary)',
              }}
            >
              {entries().length}
            </span>
          </Show>
        </div>
      </button>

      {/* Expanded log */}
      <Show when={isExpanded()}>
        <div
          ref={scrollRef}
          class="overflow-y-auto px-2 pb-2"
          style={{ 'max-height': '180px' }}
        >
          <For each={entries()}>
            {(entry) => (
              <div
                class="text-xs font-mono py-0.5 flex gap-2"
                style={{ color: SEVERITY_COLORS[entry.severity] ?? 'var(--text-secondary)' }}
              >
                <span style={{ color: 'var(--text-secondary)', 'flex-shrink': '0' }}>
                  [{formatTime(entry.timestamp)}]
                </span>
                <span style={{ 'flex-shrink': '0' }}>
                  [{SEVERITY_LABELS[entry.severity] ?? `SEV${entry.severity}`}]
                </span>
                <span>{entry.text}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
```

**Step 2: Run tests and build**

Run: `npx vitest run && npm run build`
Expected: All 132 tests pass, build succeeds.

**Step 3: Commit**

```bash
git add src/components/StatusTextLog.tsx
git commit -m "Phase 4: Add StatusTextLog component with severity coloring"
```

---

### Task 4: Wire components into App.tsx layout

**Files:**
- Modify: `src/App.tsx:1-70`
- Modify: `src/components/MessageMonitor.tsx` (add StatusTextLog import)

**Step 1: Add StatusTextLog into MessageMonitor**

In `src/components/MessageMonitor.tsx`, import StatusTextLog and add it at the bottom of the component's outer `<div>`, after the scrollable message list `</div>` (before the component's closing `</div>`):

Add import at top:
```typescript
import StatusTextLog from './StatusTextLog';
```

Add the component right before the final closing `</div>` of the return, after the message list div:

```tsx
      {/* Status text log at bottom */}
      <StatusTextLog />
```

**Step 2: Update App.tsx telemetry view**

Replace the telemetry placeholder in `src/App.tsx`. The current code (lines 56-59):

```tsx
          <Show when={appState.activeTab === 'telemetry'}>
            <div class="flex items-center justify-center h-full" style={{ color: 'var(--text-secondary)' }}>
              Telemetry view — Phase 4+
            </div>
          </Show>
```

Replace with:

```tsx
          <Show when={appState.activeTab === 'telemetry'}>
            <div class="flex h-full">
              <MessageMonitor />
              <div class="flex-1 flex items-center justify-center" style={{ color: 'var(--text-secondary)' }}>
                Plot area — Phase 5
              </div>
            </div>
          </Show>
```

Add the MessageMonitor import at the top of `src/App.tsx`:

```typescript
import MessageMonitor from './components/MessageMonitor';
```

**Step 3: Run tests and build**

Run: `npx vitest run && npm run build`
Expected: All 132 tests pass, build succeeds.

**Step 4: Commit**

```bash
git add src/App.tsx src/components/MessageMonitor.tsx
git commit -m "Phase 4: Wire MessageMonitor + StatusTextLog into telemetry layout"
```

---

### Task 5: Playwright verification

**No files to modify.** This task uses Playwright MCP tools to visually verify the implementation.

**Step 1: Start the dev server**

Run: `npm run dev` (in background)

**Step 2: Verify initial render**

1. `browser_navigate` → `http://localhost:5173`
2. `browser_snapshot` → verify "Messages" header visible, count badge shows "0"
3. `browser_console_messages(level="error")` → no JS errors

**Step 3: Connect spoof and verify messages**

1. `browser_click` → "Connect Spoof" button
2. `browser_wait_for` → text "HEARTBEAT" (wait for messages to appear)
3. `browser_snapshot` → verify:
   - Message names visible: HEARTBEAT, ATTITUDE, GLOBAL_POSITION_INT, VFR_HUD, SYS_STATUS
   - Hz badges next to each message
   - Messages sorted alphabetically
   - Count badge shows 5+

**Step 4: Verify expand/collapse**

1. `browser_click` → the ATTITUDE message card
2. `browser_snapshot` → verify:
   - roll, pitch, yaw fields visible with numeric values
   - time_boot_ms field visible
   - Fields have units displayed (e.g., "rad")

**Step 5: Verify enum resolution**

1. `browser_click` → the HEARTBEAT message card
2. `browser_snapshot` → verify:
   - `type` field shows "MAV_TYPE_QUADROTOR" (not raw "2")
   - `autopilot` field shows resolved enum name
   - `system_status` field shows resolved enum name

**Step 6: Verify StatusTextLog**

1. `browser_wait_for` → time=10 (let STATUSTEXT messages accumulate)
2. `browser_click` → "Status" panel header to expand it
3. `browser_snapshot` → verify:
   - Status text entries visible with timestamps
   - Severity labels (INFO, WARNING, etc.) visible
   - Count badge shows number of entries

**Step 7: Verify theme toggle**

1. `browser_click` → theme toggle button
2. `browser_snapshot` → verify MessageMonitor colors adapt to light theme
3. `browser_click` → theme toggle again to restore dark

**Step 8: Take final screenshot**

1. `browser_take_screenshot` → verify visual layout looks correct
2. `browser_console_messages(level="error")` → confirm no JS errors

**Step 9: Stop dev server**

Kill the background dev server process.

If any verification fails, fix the code, wait for HMR, and re-verify before moving on.
