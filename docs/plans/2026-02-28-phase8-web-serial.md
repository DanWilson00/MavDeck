# Phase 8: Web Serial Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect to real MAVLink hardware via USB serial port using the Web Serial API, with baud rate selection and feature detection.

**Architecture:** Web Serial API is main-thread only, so `WebSerialByteSource` lives on the main thread and forwards raw bytes to the worker via `bridge.sendBytes()`. A worker-side `ExternalByteSource` (implementing `IByteSource`) receives those bytes and plugs into the existing `MavlinkService` pipeline. The Toolbar gets a "Connect Serial" button with baud rate dropdown, gated by `navigator.serial` feature detection.

**Tech Stack:** Web Serial API, existing `IByteSource` interface, `MavlinkWorkerBridge.sendBytes()` (already stubbed).

---

## Task 1: Create ExternalByteSource (Worker-Side Receiver)

A minimal `IByteSource` that receives bytes via an `emitBytes()` method instead of generating them internally. This is what the worker instantiates for webserial connections — the main thread posts bytes in, and `ExternalByteSource` fans them out to `onData` callbacks.

**Files:**
- Create: `src/services/external-byte-source.ts`
- Create: `src/services/__tests__/external-byte-source.test.ts`

**Step 1: Write ExternalByteSource tests**

```typescript
// src/services/__tests__/external-byte-source.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ExternalByteSource } from '../external-byte-source';

describe('ExternalByteSource', () => {
  it('starts disconnected', () => {
    const source = new ExternalByteSource();
    expect(source.isConnected).toBe(false);
  });

  it('connect sets isConnected to true', async () => {
    const source = new ExternalByteSource();
    await source.connect();
    expect(source.isConnected).toBe(true);
  });

  it('disconnect sets isConnected to false', async () => {
    const source = new ExternalByteSource();
    await source.connect();
    source.disconnect();
    expect(source.isConnected).toBe(false);
  });

  it('emitBytes fans out to onData callbacks', async () => {
    const source = new ExternalByteSource();
    await source.connect();

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    source.onData(cb1);
    source.onData(cb2);

    const data = new Uint8Array([0xFD, 0x01, 0x02]);
    source.emitBytes(data);

    expect(cb1).toHaveBeenCalledWith(data);
    expect(cb2).toHaveBeenCalledWith(data);
  });

  it('emitBytes does nothing when disconnected', () => {
    const source = new ExternalByteSource();
    const cb = vi.fn();
    source.onData(cb);

    source.emitBytes(new Uint8Array([0x01]));
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe removes callback', async () => {
    const source = new ExternalByteSource();
    await source.connect();

    const cb = vi.fn();
    const unsub = source.onData(cb);
    unsub();

    source.emitBytes(new Uint8Array([0x01]));
    expect(cb).not.toHaveBeenCalled();
  });

  it('disconnect clears all callbacks', async () => {
    const source = new ExternalByteSource();
    await source.connect();

    const cb = vi.fn();
    source.onData(cb);
    source.disconnect();

    // Reconnect and emit — old callback should not fire
    await source.connect();
    source.emitBytes(new Uint8Array([0x01]));
    expect(cb).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/external-byte-source.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement ExternalByteSource**

```typescript
// src/services/external-byte-source.ts
/**
 * External byte source — receives bytes from outside the worker.
 *
 * Used for Web Serial: main thread reads serial port and posts bytes
 * to the worker, which calls emitBytes() to feed the MAVLink pipeline.
 */

import type { ByteCallback, IByteSource } from './byte-source';

export class ExternalByteSource implements IByteSource {
  private readonly callbacks = new Set<ByteCallback>();
  private _isConnected = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  onData(callback: ByteCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  async connect(): Promise<void> {
    this._isConnected = true;
  }

  disconnect(): void {
    this._isConnected = false;
    this.callbacks.clear();
  }

  /** Feed bytes from outside (called by worker message handler). */
  emitBytes(data: Uint8Array): void {
    if (!this._isConnected) return;
    for (const cb of this.callbacks) {
      cb(data);
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/external-byte-source.test.ts`
Expected: All 7 tests PASS.

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All 139+ tests pass. No regressions.

**Step 6: Commit**

```
Phase 8.1: Add ExternalByteSource with tests
```

---

## Task 2: Wire ExternalByteSource into Worker

Update the worker to handle `config.type === 'webserial'` by creating an `ExternalByteSource` and wiring the same pipeline. Wire the existing `'bytes'` message case to call `emitBytes()`.

**Files:**
- Modify: `src/workers/mavlink-worker.ts`

**Step 1: Update worker to support webserial config**

In `src/workers/mavlink-worker.ts`:

Add import at top:
```typescript
import { ExternalByteSource } from '../services/external-byte-source';
```

Add module-level variable alongside existing ones (after line 19):
```typescript
let externalSource: ExternalByteSource | null = null;
```

Inside the `case 'connect':` block (after the `if (config.type === 'spoof') { ... }` block, before `break;`), add the webserial handler. The pipeline setup (tracker, timeseriesManager, stats/update/statustext subscriptions) is identical to spoof — the only difference is the byte source:

```typescript
      } else if (config.type === 'webserial') {
        externalSource = new ExternalByteSource();
        tracker = new GenericMessageTracker();
        timeseriesManager = new TimeSeriesDataManager();
        service = new MavlinkService(registry, externalSource, tracker, timeseriesManager);

        // Forward stats to main thread every 100ms
        statsUnsubscribe = tracker.onStats(stats => {
          self.postMessage({
            type: 'stats',
            stats: serializeStats(stats),
          });
        });

        // Forward buffer updates to main thread
        updateUnsubscribe = timeseriesManager.onUpdate(() => {
          const fields = timeseriesManager!.getAvailableFields();
          const buffers: Record<string, { timestamps: Float64Array; values: Float64Array }> = {};

          for (const key of fields) {
            const buffer = timeseriesManager!.getBuffer(key);
            if (buffer && buffer.length > 0) {
              const [timestamps, values] = buffer.toUplotData();
              const tsBuf = new Float64Array(timestamps.length);
              tsBuf.set(timestamps);
              const valBuf = new Float64Array(values.length);
              valBuf.set(values);
              buffers[key] = { timestamps: tsBuf, values: valBuf };
            }
          }

          const transferables: ArrayBuffer[] = [];
          for (const buf of Object.values(buffers)) {
            transferables.push(buf.timestamps.buffer);
            transferables.push(buf.values.buffer);
          }

          self.postMessage({ type: 'update', buffers }, transferables);
        });

        // Forward STATUSTEXT messages
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

        self.postMessage({ type: 'statusChange', status: 'connecting' });
        service.connect().then(() => {
          self.postMessage({ type: 'statusChange', status: 'connected' });
        }).catch((err: Error) => {
          self.postMessage({ type: 'error', message: err.message });
          self.postMessage({ type: 'statusChange', status: 'error' });
        });
      }
```

**Important refactoring note:** The pipeline setup code (tracker, timeseriesManager, stats/update/statustext subscriptions) is now duplicated between spoof and webserial. Per CLAUDE.md's "3+ call sites" rule, we don't extract yet (only 2 call sites). If a third source type is added later, extract a `setupPipeline(byteSource)` helper.

Update the `'bytes'` case to forward to `externalSource`:

```typescript
    case 'bytes': {
      const { data } = e.data as { type: string; data: Uint8Array };
      externalSource?.emitBytes(data);
      break;
    }
```

Update the `'disconnect'` case to clean up `externalSource` (add after `spoofSource = null;`):

```typescript
      externalSource = null;
```

**Step 2: Verify build**

Run: `npm run build`
Expected: No type errors.

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. No regressions.

**Step 4: Commit**

```
Phase 8.2: Wire ExternalByteSource into worker for webserial connections
```

---

## Task 3: Create WebSerialByteSource (Main-Thread)

This class lives on the main thread. It uses the Web Serial API to open a port, reads bytes in a loop, and forwards them to the worker via `bridge.sendBytes()`. It does NOT implement `IByteSource` (that's `ExternalByteSource`'s job) — it's a standalone class that the `ConnectionManager` manages.

**Files:**
- Create: `src/services/webserial-byte-source.ts`

**Step 1: Create WebSerialByteSource**

```typescript
// src/services/webserial-byte-source.ts
/**
 * Web Serial byte source — reads from a USB serial port on the main thread.
 *
 * Forwards raw bytes to the worker via a callback. The worker feeds them
 * into ExternalByteSource → MavlinkService pipeline.
 *
 * Web Serial API is main-thread only — cannot run in a Web Worker.
 */

export type SerialBytesCallback = (data: Uint8Array) => void;

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600] as const;
export type BaudRate = (typeof BAUD_RATES)[number];
export const DEFAULT_BAUD_RATE: BaudRate = 115200;

/** Check if the browser supports Web Serial. */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export class WebSerialByteSource {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _isConnected = false;
  private _isReading = false;
  private readonly baudRate: number;
  private readonly onBytes: SerialBytesCallback;

  constructor(baudRate: number, onBytes: SerialBytesCallback) {
    this.baudRate = baudRate;
    this.onBytes = onBytes;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Request a serial port (triggers browser picker dialog) and connect.
   * Must be called from a user gesture (click handler).
   */
  async connect(): Promise<void> {
    if (!isWebSerialSupported()) {
      throw new Error('Web Serial API is not supported in this browser');
    }

    // Request port — browser shows device picker
    this.port = await navigator.serial.requestPort();

    // Open with 8N1 configuration (Web Serial defaults)
    await this.port.open({ baudRate: this.baudRate });

    this._isConnected = true;

    // Start read loop
    this.readLoop();
  }

  /** Disconnect and clean up. */
  async disconnect(): Promise<void> {
    this._isConnected = false;
    this._isReading = false;

    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
        this.reader = null;
      }
    } catch {
      // Reader may already be released
    }

    try {
      if (this.port) {
        await this.port.close();
        this.port = null;
      }
    } catch {
      // Port may already be closed
    }
  }

  private async readLoop(): Promise<void> {
    if (!this.port?.readable || this._isReading) return;

    this._isReading = true;

    try {
      while (this._isConnected && this.port.readable) {
        this.reader = this.port.readable.getReader();

        try {
          while (this._isConnected) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) {
              this.onBytes(value);
            }
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (err) {
      // Port disconnected or read error — clean up silently
      // The connection manager handles status via the disconnect path
    } finally {
      this._isReading = false;
      if (this._isConnected) {
        // Unexpected disconnect — clean up
        this._isConnected = false;
      }
    }
  }
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: No type errors. If Web Serial types are missing, install `@types/w3c-web-serial` as a dev dependency (check if already available via TypeScript's DOM lib first).

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. No regressions.

**Step 4: Commit**

```
Phase 8.3: Add WebSerialByteSource for main-thread serial port reading
```

**Note on testing:** `WebSerialByteSource` uses `navigator.serial` which isn't available in happy-dom. It's verified via build (TypeScript compiles) and Playwright MCP (Task 5). No unit tests for this class.

---

## Task 4: Update Toolbar with Serial Connect and Baud Rate

Add a "Connect Serial" button and baud rate dropdown to the toolbar. The spoof button stays. Feature-detect `navigator.serial` to show/hide the serial button.

**Files:**
- Modify: `src/components/Toolbar.tsx`
- Modify: `src/services/connection-manager.ts`
- Modify: `src/store/app-store.ts`

**Step 1: Add serial source management to ConnectionManager**

The `ConnectionManager` needs to manage the `WebSerialByteSource` lifecycle on the main thread. When the user clicks "Connect Serial", the manager:
1. Creates a `WebSerialByteSource` with `bridge.sendBytes` as the byte callback
2. Calls `bridge.connect({ type: 'webserial', baudRate })` to set up the worker pipeline
3. Calls `serialSource.connect()` to open the port and start reading

Update `src/services/connection-manager.ts`:

```typescript
// Add import at top
import { WebSerialByteSource } from './webserial-byte-source';

// Add to class:
  private serialSource: WebSerialByteSource | null = null;

  /** Connect with the given configuration. Disconnects first if already connected. */
  connect(config: ConnectionConfig): void {
    if (this._status === 'connected' || this._status === 'connecting') {
      this.disconnect();
    }

    if (config.type === 'webserial') {
      // Web Serial reads on main thread, forwards bytes to worker
      this.serialSource = new WebSerialByteSource(config.baudRate, (data) => {
        this.bridge.sendBytes(data);
      });

      // Tell worker to set up ExternalByteSource pipeline
      this.bridge.connect(config);

      // Open serial port (triggers browser dialog)
      this.serialSource.connect().catch(() => {
        // User cancelled dialog or port error — disconnect
        this.bridge.disconnect();
        this.serialSource = null;
      });
    } else {
      this.bridge.connect(config);
    }
  }

  /** Disconnect and clean up. */
  disconnect(): void {
    this.serialSource?.disconnect();
    this.serialSource = null;
    this.bridge.disconnect();
  }
```

**Step 2: Add baudRate to app store**

In `src/store/app-store.ts`, add `baudRate` to the `AppState` interface:

```typescript
import type { BaudRate } from '../services/webserial-byte-source';
import { DEFAULT_BAUD_RATE } from '../services/webserial-byte-source';

// Add to AppState interface:
  baudRate: BaudRate;

// Add to createStore initial state:
  baudRate: DEFAULT_BAUD_RATE,
```

**Step 3: Update Toolbar with serial button and baud rate dropdown**

In `src/components/Toolbar.tsx`:

Add imports:
```typescript
import { isWebSerialSupported, BAUD_RATES } from '../services/webserial-byte-source';
import type { BaudRate } from '../services/webserial-byte-source';
```

Add serial connect handler alongside `handleConnect`:
```typescript
  function handleConnectSerial() {
    if (!appState.isReady) return;
    if (status() === 'connected' || status() === 'connecting') {
      connectionManager.disconnect();
    } else {
      connectionManager.connect({ type: 'webserial', baudRate: appState.baudRate });
    }
  }
```

Replace the connection button section in the JSX (the existing "Connect Spoof" button) with:

```tsx
        {/* Connection buttons */}
        <button
          onClick={handleConnect}
          class="px-3 py-1 rounded text-sm font-medium transition-colors"
          style={{
            'background-color': 'var(--bg-hover)',
            color: 'var(--text-primary)',
          }}
        >
          {isConnected() ? 'Disconnect' : 'Connect Spoof'}
        </button>

        <Show when={isWebSerialSupported() && !isConnected()}>
          <button
            onClick={handleConnectSerial}
            class="px-3 py-1 rounded text-sm font-medium transition-colors"
            style={{
              'background-color': 'var(--bg-hover)',
              color: 'var(--text-primary)',
            }}
          >
            Connect Serial
          </button>
        </Show>

        {/* Baud rate selector — only when disconnected and serial supported */}
        <Show when={isWebSerialSupported() && !isConnected()}>
          <select
            class="text-sm rounded px-1 py-1"
            style={{
              'background-color': 'var(--bg-hover)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
            }}
            value={appState.baudRate}
            onChange={(e) => {
              setAppState('baudRate', Number(e.currentTarget.value) as BaudRate);
            }}
          >
            <For each={[...BAUD_RATES]}>
              {(rate) => <option value={rate}>{rate}</option>}
            </For>
          </select>
        </Show>
```

Add `For` to the imports from `solid-js`:
```typescript
import { Show, createSignal, createEffect, onCleanup, batch, For } from 'solid-js';
```

**Step 4: Verify build**

Run: `npm run build`
Expected: No type errors.

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. No regressions.

**Step 6: Commit**

```
Phase 8.4: Add serial connect button and baud rate selector to Toolbar
```

---

## Task 5: Playwright Visual Verification

Verify all acceptance criteria using the Playwright MCP tools against the running dev server.

**Files:** None (verification only)

**Step 1: Start dev server**

Run: `npm run dev` (background)

**Step 2: Navigate and take snapshot**

```
browser_navigate → http://localhost:5173
browser_snapshot → verify toolbar elements
```

**Step 3: Verify serial button and baud rate selector**

The Chromium instance used by Playwright supports Web Serial, so:
```
browser_snapshot → verify "Connect Serial" button exists
browser_snapshot → verify baud rate dropdown exists with 115200 selected
```

**Step 4: Verify baud rate dropdown options**

```
browser_click → baud rate dropdown
browser_snapshot → verify all 8 baud rate options (9600 through 921600)
```

**Step 5: Verify spoof still works**

```
browser_click → "Connect Spoof"
browser_wait_for → time=2
browser_snapshot → verify "Disconnect" button, status "connected", messages appearing
browser_click → "Disconnect"
```

**Step 6: Verify serial button hidden when connected**

```
browser_click → "Connect Spoof"
browser_snapshot → verify "Connect Serial" and baud rate are hidden
browser_click → "Disconnect"
browser_snapshot → verify "Connect Serial" and baud rate reappear
```

**Step 7: Check console for errors**

```
browser_console_messages(level="error") → no JS errors
```

**Acceptance criteria checklist:**

| Criterion | Verification method |
|-----------|-------------------|
| TypeScript compiles (Web Serial types) | `npm run build` passes |
| `navigator.serial` feature detection | Serial button visible in Chromium |
| Baud rate configurable | Dropdown with all 8 rates |
| Spoof still works | Connect/disconnect cycle |
| Serial button hidden when connected | Snapshot after connect |
| ExternalByteSource unit tests pass | `npx vitest run` |
| No JS errors | Console messages check |

**Step 8: Commit any fixes**

If visual verification reveals issues, fix and commit:
```
Phase 8: Fix [issue] found during verification
```

---

## Notes

- **No unit tests for WebSerialByteSource**: Requires real `navigator.serial` which isn't available in happy-dom. Verified via build + Playwright.
- **ExternalByteSource IS unit tested**: It's a simple callback fanout with no browser dependencies.
- **Duplicate pipeline code in worker**: The stats/update/statustext subscription setup is duplicated between spoof and webserial handlers. Per CLAUDE.md's 3-call-site rule, don't extract yet.
- **Web Serial types**: TypeScript 5.x includes Web Serial types in `lib.dom.d.ts`. If types are missing, the `@anthropic-ai/tool-use` package or `@types/w3c-web-serial` may be needed as a dev dependency — check during build.
- **User gesture requirement**: `navigator.serial.requestPort()` must be called from a user gesture (click). The "Connect Serial" button's click handler satisfies this.
- **Async disconnect**: `WebSerialByteSource.disconnect()` is async (port.close() returns Promise) but `ConnectionManager.disconnect()` is sync. Fire-and-forget is fine — the worker pipeline is cleaned up synchronously via `bridge.disconnect()`.
