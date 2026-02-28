# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. Internalize this before writing a single line of code.

The **what** (task specs, phase details, acceptance criteria) lives in `PLAN.md`. Focus on your assigned task.

## Project

MavDeck — a high-performance, web-only PWA for real-time MAVLink telemetry visualization. Replaces the Flutter-based [js_dash](https://github.com/DanWilson00/js_dash) with a faster web architecture. Key feature: dynamic MAVLink message parsing driven by XML dialect definitions (no hardcoded message types).

**Reference code**: `/tmp/js_dash/` — the Flutter project being ported. Key source in `lib/mavlink/`, `lib/services/`, `lib/views/telemetry/`.

**Target**: GitHub Pages PWA, offline-capable, light/dark mode.

---

## Universal Protocol (Every Task)

1. Read your task assignment
2. Review the task's section in `PLAN.md` for specs and acceptance criteria
3. Check dependency tasks are complete (look for `[x]` markers in `PLAN.md`)
4. Implement per the conventions in this file
5. Write/run tests — all acceptance criteria must pass
6. Run existing tests — nothing previously passing may break
7. Commit with clear, descriptive message

**If you get stuck**, explain clearly what's blocking you. Don't thrash — stop and re-plan.

**Never commit code that fails its acceptance criteria or breaks existing tests.**

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
| Testing | Vitest |
| XML Parse | DOMParser (browser-native) |

---

## Build & Development

```bash
npm install          # Install dependencies
npm run dev          # Vite dev server
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
- **Abstraction**: ALWAYS use a common function or class for common functionality. We only want one implementation. This is particularly important for shared utilities in `src/core/`.
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

---

## Architecture

### Key Decisions

1. **Gridstack for layout** — 12-column Grafana-style grid with snap
2. **Float64Array ring buffers** — Struct-of-arrays `[timestamps, values]` for zero-GC and direct uPlot compatibility
3. **Callback-based services** — Simple callback Sets instead of Dart StreamControllers; SolidJS signals consume them
4. **uPlot sync** — All time-series charts share cursor via `uPlot.sync()`
5. **Leaflet map** — Vehicle position tracking with OpenStreetMap tiles

### Module Structure

- `src/mavlink/` — MAVLink engine (CRC, XML parser, frame parser, decoder, registry)
- `src/services/` — Data pipeline (byte sources, message tracker, timeseries manager, connection manager)
- `src/core/` — Shared utilities (ring buffer)
- `src/components/` — SolidJS UI components
- `src/store/` — Application state (SolidJS createStore)
- `src/models/` — TypeScript type definitions
- `public/dialects/` — MAVLink dialect JSON files

### Data Flow

```
ByteSource → FrameParser → Decoder → MessageTracker → TimeSeriesManager → uPlot
                                          ↓
                                    MessageMonitor (sidebar)
```

### MAVLink Protocol Notes

- **CRC**: X.25 CRC-16 (CRC-16-MCRF4XX) with per-message CRC extra byte from dialect
- **Frame v2**: STX(0xFD) → len → incompat → compat → seq → sysid → compid → msgid(3) → payload → crc(2)
- **Payload**: Little-endian, fields ordered by type size descending (for wire encoding), zero-trimmed in v2
- **Dialect**: XML defines messages, fields, enums. `<include>` for dialect hierarchy. CRC extra computed from field types/names.

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

---

## Git Workflow

Write clear, concise commit messages that describe the change. Commit after each logical unit of work completes successfully. If working from `PLAN.md` tasks, reference the phase in the commit message.

---

## Verification Commands

```bash
npx vitest run                        # All tests
npx vitest run src/mavlink/           # MAVLink engine tests
npx vitest run src/core/              # Core utility tests
npx vitest run src/services/          # Service layer tests
npm run build                         # Production build (catches type errors)
npm run dev                           # Dev server for manual verification
```

### Typical Verification Workflow

After any code change:
1. `npx vitest run` — all tests must pass
2. `npm run build` — no type errors, clean production build
3. `npm run dev` — manual smoke test if UI was changed

---

## Implementation Plan

See `PLAN.md` for the full phased implementation plan.
