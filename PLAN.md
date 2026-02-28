# MavDeck Implementation Plan

## Context

MavDeck is a high-performance, web-only PWA for real-time MAVLink telemetry visualization. It replaces the Flutter-based [js_dash](https://github.com/DanWilson00/js_dash) with a slicker, faster web architecture. The key feature is dynamic MAVLink message parsing driven by XML dialect definitions — no hardcoded message types.

**Reference code**: `/tmp/js_dash/` — cloned Flutter project to port from. Key files in `lib/mavlink/`, `lib/services/`, `lib/views/telemetry/`.

**Target**: GitHub Pages PWA, offline-capable, light/dark mode.

---

## Technology Stack

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

## Architecture Decisions

1. **Gridstack for layout** — 12-column Grafana-style grid with snap. Heavier than custom but gives polished UX out of the box.
2. **Float64Array ring buffers** — Replace js_dash `ListQueue<TimeSeriesPoint>` with struct-of-arrays `[timestamps, values]` for zero-GC and direct uPlot compatibility.
3. **Callback-based services** — Replace Dart StreamControllers with simple callback Sets. SolidJS signals consume them.
4. **No 3D initially** — Skip Three.js attitude widget. Can add later.
5. **Include map view** — Leaflet + OSM for vehicle position tracking, like js_dash.
6. **uPlot sync** — All time-series charts in the same tab share cursor via `uPlot.sync()`.

---

## Phase 0: CLAUDE.md and Project Setup

- [x] Update CLAUDE.md with reference to `/tmp/js_dash/`, tech stack, build commands, architecture
- [ ] Create `package.json`, `tsconfig.json`, `vite.config.ts`
- [ ] Create `index.html`, `src/index.tsx`, `src/App.tsx`, `src/global.css`
- [ ] Install dependencies: solid-js, idb-keyval, uplot, gridstack, leaflet
- [ ] Install dev deps: typescript, vite, vite-plugin-solid, vite-plugin-pwa, @tailwindcss/vite, tailwindcss, vitest

---

## Phase 1: Core MAVLink Engine

Port from `js_dash/lib/mavlink/`. Every file gets a corresponding test.

### Files

- [ ] `src/mavlink/crc.ts` — Port `mavlink_crc.dart`. X.25 CRC-16 (CRC-16-MCRF4XX). `accumulate(byte)`, `accumulateBytes()`, `accumulateString()`, `calculateFrameCrc()`.
- [ ] `src/mavlink/metadata.ts` — Port `mavlink_metadata.dart`. TypeScript interfaces: `MavlinkFieldMetadata`, `MavlinkMessageMetadata`, `MavlinkEnumMetadata`, `MavlinkEnumEntry`, `MavlinkDialectInfo`. Factory functions.
- [ ] `src/mavlink/registry.ts` — Port `metadata_registry.dart`. `MavlinkMetadataRegistry` with O(1) lookups by ID/name. `loadFromJsonString()`, `getMessageById()`, `getMessageByName()`, `getEnum()`, `resolveEnumValue()`.
- [ ] `src/mavlink/xml-parser.ts` — Port `mavlink_xml_parser.dart` (critical). Browser `DOMParser`. `parseFromFileMap(files, mainFile)`. Handles `<include>`, `<extensions>`, field ordering, CRC extra, offsets. Returns JSON string.
- [ ] `src/mavlink/frame.ts` — Port `mavlink_frame.dart`. `MavlinkFrame` interface, `MavlinkVersion` enum, `MavlinkConstants`.
- [ ] `src/mavlink/frame-parser.ts` — Port `mavlink_frame_parser.dart`. State machine: `WaitingForStx` → ... → `ReadingCrcHigh`. Callback-based. Validates CRC.
- [ ] `src/mavlink/decoder.ts` — Port `message_decoder.dart`. `MavlinkMessageDecoder` — decodes payload bytes using `DataView` with little-endian. Returns `MavlinkMessage`.
- [ ] `src/mavlink/frame-builder.ts` — Port `frame_builder.dart`. Builds v2 frames from message name + values.
- [ ] `src/mavlink/index.ts` — Barrel exports.
- [ ] `public/dialects/common.json` — Copy from js_dash.

### Tests

- [ ] `src/mavlink/__tests__/crc.test.ts` — Known CRC values
- [ ] `src/mavlink/__tests__/registry.test.ts` — Load common.json, lookup HEARTBEAT
- [ ] `src/mavlink/__tests__/xml-parser.test.ts` — Parse XML, verify CRC extras match
- [ ] `src/mavlink/__tests__/frame-parser.test.ts` — Build frame, feed through parser
- [ ] `src/mavlink/__tests__/decoder.test.ts` — Decode payload, verify field values

---

## Phase 2: Data Pipeline

Port from `js_dash/lib/services/`.

- [ ] `src/services/byte-source.ts` — `IByteSource` interface with `onData(callback)`, `connect()`, `disconnect()`.
- [ ] `src/services/spoof-byte-source.ts` — Port `spoof_byte_source.dart`. 10Hz ATTITUDE/GLOBAL_POSITION_INT/VFR_HUD, 1Hz SYS_STATUS/HEARTBEAT, periodic STATUSTEXT.
- [ ] `src/core/ring-buffer.ts` — Two parallel `Float64Array` (timestamps, values). `push()`, `toUplotData()`. Handles wrap-around.
- [ ] `src/services/message-tracker.ts` — Port `generic_message_tracker.dart`. 100ms stats timer, 5s frequency window, decay, stale removal.
- [ ] `src/services/timeseries-manager.ts` — Port `timeseries_data_manager.dart`. `MessageName.FieldName` → RingBuffer. 60Hz throttle. Max 500 fields.
- [ ] `src/services/mavlink-service.ts` — Wires byte source → frame parser → decoder → tracker.
- [ ] `src/services/connection-manager.ts` — `ConnectionConfig` union type (spoof | webserial). Status management.

### Tests

- [ ] `src/core/__tests__/ring-buffer.test.ts` — Wrap-around, uPlot data alignment
- [ ] `src/services/__tests__/spoof-byte-source.test.ts` — Emits valid frames
- [ ] `src/services/__tests__/message-tracker.test.ts` — Frequency calculation
- [ ] `src/services/__tests__/timeseries-manager.test.ts` — Field extraction, throttling

---

## Phase 3: Core UI Shell

- [ ] `src/store/app-store.ts` — SolidJS `createStore` for connection status, message stats, theme, active tab, settings.
- [ ] `src/App.tsx` — Root layout: toolbar, tabbed body (Telemetry, Map), status bar.
- [ ] `src/components/Toolbar.tsx` — Connection button, status indicator, dialect selector, settings.
- [ ] `src/components/ThemeProvider.tsx` — CSS custom properties dark/light. Persist to IndexedDB.
- [ ] `src/components/TabBar.tsx` — Horizontal tabs for views.

---

## Phase 4: Message Monitor Sidebar

- [ ] `src/components/MessageMonitor.tsx` — Left sidebar (~350px). Messages sorted alphabetically. Frequency badges. Click to expand fields. Click field to add to plot.
- [ ] `src/components/StatusTextLog.tsx` — STATUSTEXT messages with severity coloring.

---

## Phase 5: Plotting System

- [ ] `src/components/TelemetryView.tsx` — MessageMonitor + plot grid. Add plot, clear all, time window, pause/resume.
- [ ] `src/components/PlotPanel.tsx` — uPlot wrapper in gridstack item. Header, close button, live numeric value.
- [ ] `src/components/PlotChart.tsx` — uPlot integration with `uPlot.sync("telemetry")`, auto-scrolling, pause/resume.
- [ ] `src/components/SignalSelector.tsx` — Browse signals by message type. Toggle on/off.
- [ ] `src/models/plot-config.ts` — `PlotConfiguration`, `PlotSignalConfiguration`, `PlotTab` types.

---

## Phase 6: Layout Management (Gridstack)

- [ ] `src/components/GridLayout.tsx` — 12-column grid, serialize/deserialize to IndexedDB, tab system.

---

## Phase 7: Map View

- [ ] `src/components/MapView.tsx` — Leaflet + OSM. Vehicle marker, trail line, heading indicator, auto-center, coordinate display.

---

## Phase 8: Web Serial Integration

- [ ] `src/services/webserial-byte-source.ts` — Port `serial_byte_source_web.dart`. `navigator.serial`, configurable baud rate, reconnect.
- [ ] `src/components/SerialSettings.tsx` — Port picker, baud rate selector.

---

## Phase 9: Settings & PWA

- [ ] `src/services/settings-service.ts` — `idb-keyval` persistence for layout, tabs, baud, theme, dialect, performance settings.
- [ ] `vite.config.ts` PWA config — VitePWA with workbox, manifest, GitHub Pages base.

---

## Phase 10: Polish

- [ ] D-DIN font for numeric readouts
- [ ] Dark mode neon cyan/green glows
- [ ] Light mode clean palette
- [ ] Loading skeleton while dialect loads
- [ ] Responsive design (sidebar collapses)
- [ ] Keyboard shortcuts (Space = pause/resume, Escape = deselect)
- [ ] Custom MAVLink XML dialect import

---

## Verification Plan

| Phase | Verification |
|-------|-------------|
| 1 | `npx vitest run src/mavlink/` — all MAVLink engine tests pass |
| 2 | `npx vitest run` — all tests pass; spoof source generates parseable frames |
| 3 | `npx vite dev` — app renders, theme toggle works |
| 4 | Spoof → messages appear in sidebar with Hz rates, fields expand |
| 5 | Click field → plot appears → live updating trace |
| 6 | Drag/resize panels, layout persists across reload |
| 7 | GPS from spoof appears on map, trail draws |
| 8 | Real hardware via Web Serial streams data |
| 9 | Settings persist, PWA installs, works offline |
| 10 | Visual polish matches aerospace aesthetic |

### End-to-end smoke test

1. `npm run dev` → app loads
2. Click "Spoof" → messages stream in sidebar
3. Expand ATTITUDE → see roll/pitch/yaw values updating
4. Click roll field → plot appears with live trace
5. Add GLOBAL_POSITION_INT.lat to another plot → crosshairs sync
6. Switch to Map tab → see vehicle moving
7. Pause → drag-zoom on plot → resume
8. Toggle theme → light/dark works
9. Refresh → layout and settings persist
