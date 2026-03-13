# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. Internalize this before writing a single line of code.

## Project

MavDeck — a high-performance, web-only PWA for real-time MAVLink telemetry visualization. Dynamic MAVLink message parsing driven by XML dialect definitions (no hardcoded message types).

**Target**: GitHub Pages PWA, offline-capable, light/dark mode.

---

## Environment Prerequisites

- **Node.js**: v20+ (LTS)
- **npm**: v10+
- **Browser**: Chrome or Edge (Web Serial API requires Chromium). Firefox/Safari work for everything except serial.
- **OS**: Any (Linux, macOS, Windows)

---

## Development Workflow

1. Understand the change — read relevant code and existing tests
2. Implement per the conventions in this file
3. Write/run tests — nothing previously passing may break
4. For UI work: verify with Playwright MCP (see Testing Strategy below)
5. Commit with clear, descriptive message

**If you get stuck**, explain clearly what's blocking you. Don't thrash — stop and re-plan.

**Never commit code that breaks existing tests.**

---

## Workflow & Task Management

- **Planning**: Use plan mode for non-trivial tasks. If your approach isn't working, stop and re-plan rather than thrashing.
- **Subagents**: Offload research and exploration to subagents. One focused task per subagent. Don't duplicate their work in the main context.
- **Self-improvement**: Record corrections and non-obvious learnings in `CLAUDE.md`. Review it at session start.
- **Verification before done**: Prove it works (run tests, check output) before claiming completion. Evidence before assertions.
- **Autonomous bug fixing**: When tests fail or behavior is wrong, debug systematically — read errors, form hypotheses, verify. Don't ask for help until you've genuinely tried.

---

## Tech Stack

| Concern | Choice |
|---------|--------|
| Framework | SolidJS + TypeScript (strict) |
| Build | Vite 6 + vite-plugin-pwa |
| Styling | Tailwind CSS v4 |
| Serial | Web Serial API |
| Plotting | uPlot (Float64Array native, sync crosshairs) |
| Layout | gridstack.js (12-column snap grid) |
| Map | Leaflet + OpenStreetMap |
| Storage | idb-keyval (IndexedDB) |
| Testing | Vitest + Playwright MCP |
| XML Parse | DOMParser (browser-native) |

---

## Build & Development

```bash
npm install          # Install dependencies
npm run dev          # Vite dev server (default: http://localhost:5173)
npm run build        # Production build
npm run preview      # Preview production build
npx vitest run       # Run all tests
npx vitest run src/mavlink/  # Run MAVLink engine tests only
```

---

## Coding Standards

### TypeScript
- **Target**: TypeScript strict mode. No `any` unless absolutely unavoidable (and document why).
- **Modules**: Organize under `src/` by concern (`mavlink/`, `services/`, `core/`, `components/`, `store/`, `models/`). Barrel exports via `index.ts` per module.
- **Simplicity first**: Keep the codebase clean, minimal, and as simple as possible — the best part is no part. Reduce coupling. Make minimal-impact changes: touch only what's needed, don't reorganize unrelated code.
- **No laziness**: Fix root causes, not symptoms. No temporary workarounds, no "fix later" comments. Hold yourself to senior engineer standards — if you wouldn't ship it in production, don't commit it.
- **Single source of truth**: One source for configuration. Don't duplicate constants, types, or config across files. If a value exists in one place, reference it — don't copy it.
- **Abstraction**: When 3+ call sites share the same logic, extract a common function or class — we only want one implementation. This is particularly important for shared utilities in `src/core/`. Don't pre-abstract for fewer than 3 uses.
- **Demand elegance**: For non-trivial changes, pause and ask "is there a cleaner way?" Step back from hacky fixes. (Skip this for simple/obvious changes — don't over-engineer.)

### Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Interfaces/Types | PascalCase | `MavlinkFrame`, `PlotConfiguration` |
| Classes | PascalCase | `MavlinkMetadataRegistry`, `RingBuffer` |
| Functions | camelCase | `parseFromFileMap`, `accumulateBytes` |
| Constants | UPPER_SNAKE | `MAVLINK_V2_STX`, `MAX_PAYLOAD_LEN` |
| Variables | camelCase | `frameParser`, `crcExtra` |
| Files | kebab-case | `frame-parser.ts`, `ring-buffer.ts` |
| Test files | `__tests__/<name>.test.ts` | `__tests__/crc.test.ts` |
| Components | PascalCase files | `PlotPanel.tsx`, `MessageMonitor.tsx` |

### Error Handling
- TypeScript strict mode for type safety
- Explicit error types — no bare `throw "string"`
- Validate at system boundaries (serial input, XML parsing, user file imports)
- Trust internal code and framework guarantees — don't over-validate
- Never silently swallow errors

### No Shortcuts Policy
- Do not hardcode MAVLink message IDs or field offsets — everything comes from the dialect registry
- Do not skip CRC validation on incoming frames
- Do not use `as any` to silence type errors — fix the types
- Do not create memory leaks — clean up callbacks, timers, and observers in `onCleanup`
- Do not allocate in hot paths — pre-allocate buffers, reuse TypedArrays
- Do not call rendering functions inside data processing loops (process and batch-update)

### Performance
- **Pre-allocate**: Use `Float64Array` with fixed capacity for ring buffers. Never grow arrays in hot paths.
- **Zero-copy where possible**: Pass TypedArray views, not copies.
- **Batch updates**: Throttle UI updates (60Hz max). Buffer data writes and flush on animation frame.
- **No GC pressure in hot paths**: Avoid object creation in the frame parser / decoder inner loops.

### SolidJS Gotchas
- **Never destructure props**: `const { name } = props` kills reactivity. Use `props.name` or `splitProps()`/`mergeProps()`.
- **`createEffect` cleanup**: Return a cleanup function or use `onCleanup` inside effects that create subscriptions/timers.
- **`batch` for multiple updates**: When updating multiple signals or store fields in one handler, wrap in `batch(() => { ... })` to avoid intermediate renders.
- **`For` vs `Index`**: Use `<For each={list}>` for keyed lists (items can reorder). Use `<Index each={list}>` for indexed access (items are positionally stable).
- **Store updates must be immutable-style**: `setStore('plotTabs', tabs => [...tabs, newTab])`, not `appState.plotTabs.push(newTab)`.
- **`Show` vs ternary**: Prefer `<Show when={cond}>` over `{cond && <Comp/>}` — Show properly handles cleanup.
- **Store constraints**: ONLY put plain JSON-serializable data (strings, numbers, booleans, plain arrays/objects) inside `createStore`. NEVER put class instances (`RingBuffer`, `ConnectionManager`, `MavlinkMetadataRegistry`), `TypedArray`s, or third-party library instances (`uPlot`) in a SolidJS store. The store's deep proxy will wrap their internal properties, destroying zero-GC performance and breaking class methods. Use module-level variables or `createSignal(instance, { equals: false })` for complex objects.
- **Gridstack integration**: Do NOT use `<For>` loops to render Gridstack items. Gridstack mutates the DOM directly, which conflicts with SolidJS's DOM ownership. Instead: use Gridstack's vanilla JS API (`grid.addWidget(containerDiv)`) to create the DOM node, then use SolidJS's `render(() => <PlotPanel />, containerDiv)` to mount the reactive component inside that unmanaged node. Handle cleanup with the `dispose` function returned by `render()`.

### .gitignore

Ensure these are gitignored:
```
node_modules/
dist/
*.local
.env
```

Do NOT gitignore: `public/dialects/common.xml`, `public/dialects/standard.xml`, and `public/dialects/minimal.xml` (ship with the app).

---

## Architecture

### Key Decisions

1. **Web Worker for MAVLink engine** — All parsing, CRC validation, decoding, and ring buffer writes run in a background Web Worker. The main thread is exclusively for rendering. Data is transferred via `postMessage` with Transferable `ArrayBuffer`s to avoid copies.
2. **Typed worker protocol** — Discriminated unions (`WorkerCommand`/`WorkerEvent`) for type-safe worker communication (`src/workers/worker-protocol.ts`)
3. **Gridstack for layout** — 12-column Grafana-style grid with snap
4. **Float64Array ring buffers** — Struct-of-arrays `[timestamps, values]` for zero-GC and direct uPlot compatibility
5. **EventEmitter-based services** — `EventEmitter<T>` utility in `src/core/event-emitter.ts` for typed pub/sub; SolidJS signals consume them
6. **Interested-fields optimization** — Worker only streams ring buffer data for fields the UI currently needs
7. **uPlot sync** — All time-series charts share cursor via `uPlot.sync()`
8. **Leaflet map** — Vehicle position tracking with OpenStreetMap tiles
9. **Tlog recording to OPFS** — Binary MAVLink session recording via Origin Private File System with crash recovery (`src/services/tlog-service.ts`)

### Module Structure

- `src/mavlink/` — MAVLink engine (CRC, XML parser, frame parser, decoder, registry)
- `src/services/` — Data pipeline (byte sources, connection manager, message tracker, timeseries manager, tlog recording, log viewer)
- `src/workers/` — Web Worker (MAVLink pipeline) + typed message protocol
- `src/core/` — Shared utilities (ring buffer, event emitter)
- `src/components/` — SolidJS UI components
- `src/store/` — Application state (SolidJS createStore)
- `src/models/` — TypeScript type definitions
- `public/dialects/` — MAVLink dialect XML files (parsed to JSON on first load)

### Data Flow

```
┌─── Web Worker ──────────────────────────────────────────────┐
│ ByteSource → FrameParser → Decoder → Tracker → RingBuffers  │
│                                    ↘ TlogEncoder → chunks    │
└──────────────────────────┬─────────────────┬────────────────┘
                           │                 │ postMessage
                           ↓                 ↓
┌─── Main Thread ──────────────────────────────────────────────┐
│ WorkerBridge → AppStore → MessageMonitor (sidebar)           │
│                         → uPlot charts (Float64Array direct) │
│                         → Map view (lat/lon)                 │
│              → TlogService → OPFS (session recording)        │
│              → LogViewerService (tlog playback)              │
└──────────────────────────────────────────────────────────────┘
```

### MAVLink Protocol Notes

- **CRC**: X.25 CRC-16 (CRC-16-MCRF4XX), seed `0xFFFF`, per-message CRC extra byte from dialect
- **Frame v2**: `STX(0xFD) | len | incompat | compat | seq | sysid | compid | msgid_lo | msgid_mid | msgid_hi | payload | crc_lo | crc_hi`
- **Frame v1**: `STX(0xFE) | len | seq | sysid | compid | msgid | payload | crc_lo | crc_hi`
- **Payload**: Little-endian, fields ordered by type size descending (for wire encoding), zero-trimmed in v2
- **Dialect**: XML defines messages, fields, enums. `<include>` for dialect hierarchy. CRC extra computed from field types/names.

---

## Testing Strategy

### Three-Tier Testing

**Vitest environment**: Configured with `environment: 'happy-dom'` in `vite.config.ts`. This provides `DOMParser`, `XMLSerializer`, and other browser APIs in Node.js. Without this, tests using `DOMParser` (XML parser) will throw `ReferenceError`.

**Tier 1 — Vitest Unit Tests (fast, run always)**
Pure logic with no DOM or browser dependencies. Target: <5 seconds total.

| What to test | How | Example |
|-------------|-----|---------|
| CRC computation | Golden values — known inputs → known outputs | `crc.test.ts`: HEARTBEAT CRC extra = 50 |
| Frame parsing | Build a frame with FrameBuilder, feed to FrameParser, verify round-trip | `frame-parser.test.ts` |
| Payload decoding | Hand-craft payloads, decode, verify field values | `decoder.test.ts` |
| Ring buffer | Push past capacity, verify wrap-around and data integrity | `ring-buffer.test.ts` |
| Registry | Load `common.json`, verify lookups by ID and name | `registry.test.ts` |
| Message tracker | Feed messages with known timestamps, verify frequency math | `message-tracker.test.ts` |

**Golden data tests are the highest-value tests.** They lock down correctness with zero ambiguity.

**Tier 2 — Vitest Integration Tests (medium, run always)**
Tests that verify multi-module data flow without a browser.

| What to test | How |
|-------------|-----|
| Spoof → Parser → Decoder | Create SpoofByteSource, connect to FrameParser + Decoder, verify decoded messages have correct names and field types |
| TimeSeriesManager | Feed decoded messages, verify ring buffers are populated with correct `MessageName.FieldName` keys |

**Tier 3 — Playwright MCP Visual Verification (targeted, UI work only)**
Use the Playwright MCP tools to autonomously verify UI behavior in the running dev server. This is NOT a test suite — it's an agent-driven verification loop.

### Playwright MCP Autonomous Iteration

For UI work, use the Playwright MCP tools in an edit→verify loop:

1. Start dev server in background: `npm run dev`
2. `browser_navigate` → `browser_snapshot` → verify elements exist
3. If wrong: edit code → Vite HMR reloads → `browser_snapshot` again
4. `browser_click` / `browser_type` → test interactions
5. `browser_console_messages(level="error")` → catch JS errors
6. `browser_take_screenshot` → verify visual appearance
7. Repeat until correct

**Use Playwright MCP for**: UI rendering, data flow to UI, styling, live-update features, "looks wrong" debugging.
**Don't use for**: Pure logic (use Vitest), type checking (use `npm run build`), performance profiling.

### Test File Conventions

```
src/
  mavlink/__tests__/     crc, decoder, frame-parser, registry, xml-parser
  core/__tests__/        ring-buffer, event-emitter
  services/__tests__/    spoof-byte-source, message-tracker, timeseries-manager,
                         mavlink-service, external-byte-source, settings-service, tlog-codec
  store/__tests__/       app-store
```

Tests import from the module under test. Use `describe`/`it` blocks. Prefer `expect` assertions over manual checks. Use `beforeEach` for setup, not shared mutable state.

---

## Troubleshooting Guide

### Frame parser stuck / no messages
Check CRC extra values match between XML parser output and the frames being received. Verify the dialect JSON loaded correctly into the registry.

### Memory growing unbounded
Ring buffers must wrap — verify `push()` overwrites oldest data when full. Check that removed plot panels clean up their signal subscriptions.

### uPlot not updating
Verify data array references change on each update (uPlot detects by reference). Check that `setData()` is called with the correct format: `[timestamps, ...series]`.

### Serial port won't connect
Web Serial requires HTTPS or localhost. Verify baud rate matches the device. Check that the port isn't already claimed by another tab.

### Stale message frequencies
Message tracker needs periodic cleanup. Verify the 5s decay window and stale-removal timer are running.

### Gridstack items overlap or misbehave
Ensure gridstack widget lifecycle is tied to SolidJS `onMount`/`onCleanup`. Don't manipulate DOM directly — use gridstack API.

### Vite HMR not reflecting changes
Check browser console for HMR errors. SolidJS HMR requires `vite-plugin-solid`. If state is stale, full-reload the page.

### Playwright snapshot shows empty page
Dev server may not be running. Check with `browser_console_messages(level="error")`. Ensure `npm run dev` is running in background.

---

## Git Workflow

Write clear, concise commit messages that describe the change. Commit after each logical unit of work completes successfully.

---

## Verification Commands

```bash
npx vitest run                        # All tests
npx vitest run src/mavlink/           # MAVLink engine tests
npx vitest run src/core/              # Core utility tests
npx vitest run src/services/          # Service layer tests
npm run build                         # Production build (catches type errors)
npm run dev                           # Dev server for manual/Playwright verification
```

### Typical Verification Workflow

**For logic changes:**
1. `npx vitest run` — all tests must pass
2. `npm run build` — no type errors

**For UI changes:**
1. `npx vitest run` — all tests must pass
2. `npm run build` — no type errors
3. Start dev server → Playwright MCP: `browser_navigate` → `browser_snapshot` → verify
4. `browser_console_messages(level="error")` — no JS errors
5. `browser_take_screenshot` — visual check if needed

