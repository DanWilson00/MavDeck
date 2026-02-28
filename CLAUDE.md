# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MavDeck — a high-performance, web-only PWA for real-time MAVLink telemetry visualization. Replaces the Flutter-based [js_dash](https://github.com/DanWilson00/js_dash) with a faster web architecture. Key feature: dynamic MAVLink message parsing driven by XML dialect definitions (no hardcoded message types).

**Reference code**: `/tmp/js_dash/` — the Flutter project being ported. Key source in `lib/mavlink/`, `lib/services/`, `lib/views/telemetry/`.

**Target**: GitHub Pages PWA, offline-capable, light/dark mode.

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

## Build & Development

```bash
npm install          # Install dependencies
npm run dev          # Vite dev server
npm run build        # Production build
npm run preview      # Preview production build
npx vitest run       # Run all tests
npx vitest run src/mavlink/  # Run MAVLink engine tests only
```

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

## Implementation Plan

See `PLAN.md` for the full phased implementation plan.
