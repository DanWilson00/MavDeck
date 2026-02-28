# MavDeck Implementation Plan

## Context

MavDeck is a high-performance, web-only PWA for real-time MAVLink telemetry visualization. It replaces the Flutter-based [js_dash](https://github.com/DanWilson00/js_dash) with a slicker, faster web architecture. The key feature is dynamic MAVLink message parsing driven by XML dialect definitions — no hardcoded message types.

**Reference code**: `/tmp/js_dash/` — cloned Flutter project to port from.

| Reference file | Porting to | Notes |
|---------------|-----------|-------|
| `lib/mavlink/parser/mavlink_crc.dart` | `src/mavlink/crc.ts` | Direct port, same algorithm |
| `lib/mavlink/metadata/mavlink_metadata.dart` | `src/mavlink/metadata.ts` | Dart classes → TS interfaces |
| `lib/mavlink/metadata/metadata_registry.dart` | `src/mavlink/registry.ts` | Direct port |
| `lib/mavlink/parser/mavlink_xml_parser.dart` | `src/mavlink/xml-parser.ts` | Dart XML → browser DOMParser |
| `lib/mavlink/parser/mavlink_frame.dart` | `src/mavlink/frame.ts` | Dart class → TS interface |
| `lib/mavlink/parser/mavlink_frame_parser.dart` | `src/mavlink/frame-parser.ts` | Dart Stream → callback Set |
| `lib/mavlink/parser/message_decoder.dart` | `src/mavlink/decoder.ts` | ByteData → DataView |
| `lib/mavlink/parser/frame_builder.dart` | `src/mavlink/frame-builder.ts` | ByteData → DataView |
| `lib/services/spoof_byte_source.dart` | `src/services/spoof-byte-source.ts` | Dart Stream → callback |
| `lib/services/generic_message_tracker.dart` | `src/services/message-tracker.ts` | Dart Stream → callback |
| `lib/services/timeseries_data_manager.dart` | `src/services/timeseries-manager.ts` | ListQueue → Float64Array ring buffer |
| `lib/services/mavlink_service.dart` | `src/services/mavlink-service.ts` | Direct port |
| `lib/services/connection_manager.dart` | `src/services/connection-manager.ts` | Dart sealed class → TS union |
| `lib/services/serial/serial_byte_source_web.dart` | `src/services/webserial-byte-source.ts` | JS interop → direct Web Serial API |
| `lib/views/telemetry/mavlink_message_monitor.dart` | `src/components/MessageMonitor.tsx` | Flutter → SolidJS |
| `lib/views/telemetry/statustext_log_panel.dart` | `src/components/StatusTextLog.tsx` | Flutter → SolidJS |
| `lib/views/telemetry/realtime_data_display.dart` | `src/components/TelemetryView.tsx` | Flutter → SolidJS |
| `lib/views/telemetry/interactive_plot.dart` | `src/components/PlotChart.tsx` | fl_chart → uPlot |
| `lib/views/telemetry/plot_grid.dart` | `src/components/GridLayout.tsx` | Custom canvas → gridstack |
| `lib/views/telemetry/signal_selector_panel.dart` | `src/components/SignalSelector.tsx` | Flutter → SolidJS |

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
| Testing | Vitest + Playwright MCP |
| XML Parse | DOMParser (browser-native) |

---

## Architecture Decisions

1. **Web Worker for MAVLink engine** — All parsing (FrameParser), CRC validation, decoding, message tracking, and ring buffer writes run in a background Web Worker. The main thread is exclusively for rendering. At 100Hz telemetry, parsing binary on the main thread causes micro-stutters in SolidJS and uPlot. Data is transferred via `postMessage` with Transferable `ArrayBuffer`s.
2. **Gridstack for layout** — 12-column Grafana-style grid with snap. Heavier than custom but gives polished UX out of the box.
3. **Float64Array ring buffers** — Replace js_dash `ListQueue<TimeSeriesPoint>` with struct-of-arrays `[timestamps, values]` for zero-GC and direct uPlot compatibility.
4. **Callback-based services** — Replace Dart StreamControllers with simple callback Sets. SolidJS signals consume them.
5. **No 3D initially** — Skip Three.js attitude widget. Can add later.
6. **Include map view** — Leaflet + OSM for vehicle position tracking, like js_dash.
7. **uPlot sync** — All time-series charts in the same tab share cursor via `uPlot.sync()`.

---

## Dependency Graph

```
Phase 0 (Setup)
  └→ Phase 1A (Binary Engine: CRC, Frame, Parser, Builder)
       └→ Phase 1B (Data Dictionary: Metadata, Registry, Decoder, XML Parser)
            └→ Phase 2 (Data Pipeline + Web Worker)
                 ├→ Phase 3 (UI Shell)
                 │    ├→ Phase 4 (Message Monitor)
                 │    │    └→ Phase 5 (Plotting) → Phase 6 (Layout)
                 │    └→ Phase 7 (Map View)
                 └→ Phase 8 (Web Serial)
Phase 9 (Settings/PWA) — can start after Phase 3, integrates with all later phases
Phase 10 (Polish) — after everything
```

**Why Phase 1 is split**: The MAVLink engine has 10 subtasks spanning binary math, state machines, and XML parsing. Splitting into 1A (binary/frame-level) and 1B (metadata/data-dictionary) forces a commit + test checkpoint in the middle, preventing context window exhaustion and ensuring the binary foundation is solid before building the data layer on top.

**Phase completion tracking**: Each phase is complete when ALL its task acceptance criteria checkboxes pass AND (if applicable) its Playwright verification block runs without failure. Agents should use TodoWrite/task tracking to mark phases done. The "Depends on Phase X" annotations at each phase header are **hard gates** — do not start a phase until its dependencies are complete (all tests passing, committed).

---

## Golden Test Data

These are known-good values that lock down correctness. Use them in unit tests.

### CRC-16-MCRF4XX

```
Algorithm: CRC-16-MCRF4XX (X.25)
Polynomial: 0x1021
Seed: 0xFFFF

Input: "123456789" (ASCII bytes)
Expected CRC: 0x6F91

Input: empty
Expected CRC: 0xFFFF (unchanged seed)
```

### HEARTBEAT Frame (v2)

HEARTBEAT is message ID 0, CRC extra = 50, encoded length = 9.

```
Field layout (wire order, sorted by type size):
  custom_mode:    uint32_t  offset=0  size=4
  type:           uint8_t   offset=4  size=1
  autopilot:      uint8_t   offset=5  size=1
  base_mode:      uint8_t   offset=6  size=1
  system_status:  uint8_t   offset=7  size=1
  mavlink_version: uint8_t  offset=8  size=1

Example payload (9 bytes):
  custom_mode=0    → [0x00, 0x00, 0x00, 0x00]
  type=2 (QUAD)    → [0x02]
  autopilot=3      → [0x03]
  base_mode=0x81   → [0x81]
  system_status=4  → [0x04]
  mavlink_version=3→ [0x03]
  = [0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x81, 0x04, 0x03]

Complete v2 frame (sysid=1, compid=1, seq=0):
  STX:        0xFD
  LEN:        0x09
  INCOMPAT:   0x00
  COMPAT:     0x00
  SEQ:        0x00
  SYSID:      0x01
  COMPID:     0x01
  MSGID:      0x00, 0x00, 0x00  (ID 0)
  PAYLOAD:    [9 bytes above]
  CRC:        calculate over header[1..9] + payload + crcExtra(50)
```

### ATTITUDE Frame (v2)

ATTITUDE is message ID 30, CRC extra = 39, encoded length = 28.

```
Field layout (wire order):
  time_boot_ms:  uint32_t  offset=0   size=4
  roll:          float     offset=4   size=4
  pitch:         float     offset=8   size=4
  yaw:           float     offset=12  size=4
  rollspeed:     float     offset=16  size=4
  pitchspeed:    float     offset=20  size=4
  yawspeed:      float     offset=24  size=4
```

### Dialect JSON Format

The registry loads JSON with this structure (from `common.json`):

```json
{
  "schema_version": "1.0.0",
  "dialect": { "name": "common", "version": 3 },
  "enums": {
    "MAV_TYPE": {
      "name": "MAV_TYPE",
      "description": "...",
      "bitmask": false,
      "entries": {
        "0": { "name": "MAV_TYPE_GENERIC", "value": 0, "description": "..." },
        "2": { "name": "MAV_TYPE_QUADROTOR", "value": 2, "description": "..." }
      }
    }
  },
  "messages": {
    "0": {
      "id": 0,
      "name": "HEARTBEAT",
      "description": "...",
      "crc_extra": 50,
      "encoded_length": 9,
      "fields": [
        {
          "name": "custom_mode",
          "type": "uint32_t",
          "base_type": "uint32_t",
          "offset": 0,
          "size": 4,
          "array_length": 1,
          "units": "",
          "enum": "",
          "description": "...",
          "extension": false
        }
      ]
    }
  }
}
```

Key points for the registry:
- Messages keyed by string ID (`"0"`, `"1"`, `"30"`, etc.)
- Fields include pre-computed `offset` and `size`
- `crc_extra` is pre-computed per message
- `enum` field links to enum name for value resolution
- `array_length` > 1 for array types (char arrays are strings)

### MAVLink Type Sizes

```
int8_t:   1 byte    uint8_t:  1 byte    char:    1 byte
int16_t:  2 bytes   uint16_t: 2 bytes
int32_t:  4 bytes   uint32_t: 4 bytes   float:   4 bytes
int64_t:  8 bytes   uint64_t: 8 bytes   double:  8 bytes
```

---

## Interface Contracts

These TypeScript interfaces define the API boundaries between modules. Implement them exactly — downstream modules depend on these shapes.

### `src/mavlink/frame.ts`

```typescript
export const enum MavlinkVersion { V1 = 1, V2 = 2 }

export interface MavlinkFrame {
  version: MavlinkVersion;
  payloadLength: number;       // 0-255
  incompatFlags: number;       // v2 only (0 for v1)
  compatFlags: number;         // v2 only (0 for v1)
  sequence: number;            // 0-255
  systemId: number;            // 1-255
  componentId: number;         // 0-255
  messageId: number;           // 0-255 (v1) or 0-16777215 (v2)
  payload: Uint8Array;         // raw payload bytes
  crcValid: boolean;           // receivedCrc === calculatedCrc
}

export const MAVLINK_V1_STX = 0xFE;
export const MAVLINK_V2_STX = 0xFD;
export const MAVLINK_V1_HEADER_LEN = 5;   // bytes after STX
export const MAVLINK_V2_HEADER_LEN = 9;   // bytes after STX
export const MAVLINK_CRC_LEN = 2;
export const MAVLINK_MAX_PAYLOAD_LEN = 255;
```

### `src/mavlink/metadata.ts`

```typescript
export interface MavlinkFieldMetadata {
  name: string;
  type: string;           // "uint32_t", "float", "char", etc.
  baseType: string;       // same as type for non-arrays
  offset: number;         // byte offset in payload
  size: number;           // type size in bytes (1, 2, 4, or 8)
  arrayLength: number;    // 1 for scalars, >1 for arrays
  units: string;          // "rad", "m/s", "degE7", etc.
  enumType: string;       // enum name or "" if none
  description: string;
  isExtension: boolean;
}

export interface MavlinkMessageMetadata {
  id: number;
  name: string;
  description: string;
  crcExtra: number;           // 0-255
  encodedLength: number;      // total non-extension payload bytes
  fields: MavlinkFieldMetadata[];
}

export interface MavlinkEnumEntry {
  name: string;
  value: number;
  description: string;
}

export interface MavlinkEnumMetadata {
  name: string;
  description: string;
  isBitmask: boolean;
  entries: Map<number, MavlinkEnumEntry>;
}
```

### `src/mavlink/decoder.ts`

```typescript
export interface MavlinkMessage {
  id: number;
  name: string;
  values: Record<string, number | string | number[]>;
  systemId: number;
  componentId: number;
  sequence: number;
}
```

`values` types by field base_type:
- `int8_t`, `uint8_t`, `int16_t`, `uint16_t`, `int32_t`, `uint32_t` → `number`
- `float`, `double` → `number`
- `int64_t`, `uint64_t` → `number` (loses precision beyond 2^53, acceptable for telemetry)
- `char[N]` → `string` (null-terminated, trailing nulls stripped)
- Other arrays (e.g., `uint16_t[4]`) → `number[]`

### `src/services/byte-source.ts`

```typescript
export type ByteCallback = (data: Uint8Array) => void;

export interface IByteSource {
  onData(callback: ByteCallback): () => void;  // returns unsubscribe function
  connect(): Promise<void>;
  disconnect(): void;
  readonly isConnected: boolean;
}
```

### `src/services/message-tracker.ts`

```typescript
export interface MessageStats {
  count: number;
  frequency: number;      // Hz, rolling 5s window
  lastMessage: MavlinkMessage;
  lastReceived: number;   // timestamp ms
}

// Tracker exposes:
// onStats(callback: (stats: Map<string, MessageStats>) => void): () => void
// trackMessage(msg: MavlinkMessage): void
// startTracking(): void
// stopTracking(): void
```

### `src/core/ring-buffer.ts`

```typescript
export class RingBuffer {
  constructor(capacity: number);  // default 2000
  push(timestamp: number, value: number): void;  // timestamp in epoch-ms
  readonly length: number;
  toUplotData(): [Float64Array, Float64Array];    // [timestamps_seconds, values]
  getLatestValue(): number | undefined;
  getLatestTimestamp(): number | undefined;
  clear(): void;
}
```

`toUplotData()` returns timestamps in **epoch-seconds** (uPlot's native format). Internally stored as epoch-ms for precision. The returned arrays must be contiguous (handle wrap-around by copying to fresh arrays).

### `src/services/connection-manager.ts`

```typescript
export type ConnectionConfig =
  | { type: 'spoof' }
  | { type: 'webserial'; baudRate: number };

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
```

### `src/models/plot-config.ts`

```typescript
export type ScalingMode = 'auto' | 'unified' | 'independent';
export type TimeWindow = 5 | 10 | 30 | 60 | 120 | 300;  // seconds

export interface PlotSignalConfig {
  id: string;
  messageType: string;    // "ATTITUDE"
  fieldName: string;      // "roll"
  fieldKey: string;       // "ATTITUDE.roll"
  color: string;          // hex color
  visible: boolean;
}

export interface PlotConfig {
  id: string;
  title: string;
  signals: PlotSignalConfig[];
  scalingMode: ScalingMode;
  timeWindow: TimeWindow;
  gridPos: { x: number; y: number; w: number; h: number };  // gridstack position
}

export interface PlotTab {
  id: string;
  name: string;
  plots: PlotConfig[];
}

export const SIGNAL_COLORS = [
  '#00d4ff', '#00ff88', '#ff6b6b', '#ffd93d', '#c084fc',
  '#fb923c', '#38bdf8', '#4ade80', '#f472b6', '#a78bfa',
];
```

---

## Phase 0: Project Setup

### Task 0.1: Scaffold project

**Create files:**
- `package.json` — name: "mavdeck", type: "module"
- `tsconfig.json` — strict: true, jsx: "preserve", jsxImportSource: "solid-js", target: "ES2022", module: "ESNext", moduleResolution: "bundler"
- `vite.config.ts` — plugins: [solidPlugin(), tailwindcss(), VitePWA(...)], base: process.env.GITHUB_ACTIONS ? "/MavDeck/" : "/", test: { environment: 'happy-dom' }
- `index.html` — minimal HTML shell with `<div id="root">`, links to `/src/index.tsx`
- `src/index.tsx` — `render(() => <App />, document.getElementById('root')!)`
- `src/App.tsx` — placeholder: `<div class="h-screen bg-gray-900 text-white">MavDeck</div>`
- `src/global.css` — `@import "tailwindcss";` plus CSS custom properties for theming

**Dependencies:**
```
solid-js, idb-keyval, uplot, gridstack, leaflet
```

**Dev dependencies:**
```
typescript, vite, vite-plugin-solid, vite-plugin-pwa, @tailwindcss/vite, tailwindcss,
vitest, happy-dom, @types/leaflet
```

**Critical: Vitest environment config** in `vite.config.ts`:
```typescript
export default defineConfig({
  // ...plugins, base, etc...
  test: {
    environment: 'happy-dom',  // Provides DOMParser, Canvas, etc. in Node.js
  },
});
```
Without this, any test using `DOMParser` (XML parser, Phase 1B) will throw `ReferenceError: DOMParser is not defined`. Do NOT install separate XML parsing libraries — `happy-dom` provides the browser-native APIs.

**Acceptance criteria:**
- [ ] `npm install` succeeds
- [ ] `npm run dev` starts server, page loads with "MavDeck" text
- [ ] `npm run build` produces clean production build with no type errors
- [ ] `npx vitest run --passWithNoTests` exits 0 (no tests yet, but config + environment works)

**Playwright verification:**
```
browser_navigate → http://localhost:5173
browser_snapshot → verify "MavDeck" text appears
browser_console_messages(level="error") → empty
```

---

## Phase 1A: Binary Engine (CRC, Frames, Parser, Builder)

Port from `/tmp/js_dash/lib/mavlink/parser/`. This phase covers the binary wire format: CRC math, frame structure, the byte-level state machine parser, and the frame builder. Commit and run tests after this phase before proceeding to Phase 1B.

### Task 1.1: `src/mavlink/crc.ts`

**Port from**: `lib/mavlink/parser/mavlink_crc.dart`

Implement CRC-16-MCRF4XX (X.25):

```typescript
export class MavlinkCrc {
  private crc = 0xFFFF;

  accumulate(byte: number): void {
    // X.25 CRC accumulate algorithm:
    // tmp = byte ^ (crc & 0xFF)
    // tmp = (tmp ^ ((tmp << 4) & 0xFF)) & 0xFF
    // crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF
  }

  accumulateBytes(bytes: Uint8Array): void;  // loop over accumulate()
  accumulateString(str: string): void;        // accumulate each charCode
  get value(): number;                        // return this.crc
  reset(): void;                              // this.crc = 0xFFFF
}

// Convenience: calculate CRC for a complete frame
export function calculateFrameCrc(
  header: Uint8Array,     // header bytes (NOT including STX)
  payload: Uint8Array,
  crcExtra: number
): number;
```

**Acceptance criteria:**
- [ ] `MavlinkCrc` on ASCII "123456789" returns `0x6F91`
- [ ] `MavlinkCrc` on empty input returns `0xFFFF`
- [ ] `calculateFrameCrc` on HEARTBEAT header + payload + crcExtra(50) matches known value
- [ ] Accumulating one byte at a time equals accumulating all at once

### Task 1.2: `src/mavlink/metadata.ts`

**Port from**: `lib/mavlink/metadata/mavlink_metadata.dart`

Define TypeScript interfaces (see Interface Contracts section above). Add factory functions:

```typescript
export function createFieldMetadata(json: Record<string, unknown>): MavlinkFieldMetadata;
export function createMessageMetadata(json: Record<string, unknown>): MavlinkMessageMetadata;
export function createEnumMetadata(json: Record<string, unknown>): MavlinkEnumMetadata;
```

Factory functions parse the JSON format from `common.json` into typed interfaces. Handle field name mapping: `crc_extra` → `crcExtra`, `encoded_length` → `encodedLength`, `array_length` → `arrayLength`, `base_type` → `baseType`.

**Acceptance criteria:**
- [ ] `createMessageMetadata` parses HEARTBEAT JSON, returns correct `crcExtra: 50`, `encodedLength: 9`, 6 fields
- [ ] `createFieldMetadata` correctly maps all JSON fields including `isExtension` from `extension`
- [ ] `createEnumMetadata` creates `entries` Map with correct number→entry mapping

### Task 1.3: `src/mavlink/registry.ts`

**Port from**: `lib/mavlink/metadata/metadata_registry.dart`

```typescript
export class MavlinkMetadataRegistry {
  loadFromJsonString(json: string): void;     // parse and populate maps
  getMessageById(id: number): MavlinkMessageMetadata | undefined;
  getMessageByName(name: string): MavlinkMessageMetadata | undefined;
  getEnum(name: string): MavlinkEnumMetadata | undefined;
  resolveEnumValue(enumName: string, value: number): string | undefined;
  get messageCount(): number;
  get enumCount(): number;
}
```

Internally: `Map<number, MavlinkMessageMetadata>` for ID lookup, `Map<string, MavlinkMessageMetadata>` for name lookup, `Map<string, MavlinkEnumMetadata>` for enums.

**Acceptance criteria (test with `common.json`):**
- [ ] `loadFromJsonString` loads 200+ messages without error
- [ ] `getMessageById(0)` returns HEARTBEAT with `crcExtra: 50`
- [ ] `getMessageById(30)` returns ATTITUDE with `crcExtra: 39`, 7 fields
- [ ] `getMessageByName("HEARTBEAT")` returns same as `getMessageById(0)`
- [ ] `getEnum("MAV_TYPE")` has entry for value 2 = "MAV_TYPE_QUADROTOR"
- [ ] `resolveEnumValue("MAV_TYPE", 2)` returns "MAV_TYPE_QUADROTOR"
- [ ] `getMessageById(99999)` returns undefined (not throws)

### Task 1.4: `src/mavlink/frame.ts`

**Port from**: `lib/mavlink/parser/mavlink_frame.dart`

Define `MavlinkFrame` interface and constants (see Interface Contracts). This is a pure types file — no logic.

**Acceptance criteria:**
- [ ] Types compile with no errors
- [ ] Constants are exported and correct (STX values, header lengths)

### Task 1.5: `src/mavlink/frame-parser.ts`

**Port from**: `lib/mavlink/parser/mavlink_frame_parser.dart`

State machine that processes raw bytes one at a time and emits complete `MavlinkFrame` objects.

**Parser states** (enum):
```
WaitingForStx → ReadingLength → ReadingIncompatFlags (v2) → ReadingCompatFlags (v2) →
ReadingSequence → ReadingSystemId → ReadingComponentId →
ReadingMessageIdLow → ReadingMessageIdMid (v2) → ReadingMessageIdHigh (v2) →
ReadingPayload → ReadingCrcLow → ReadingCrcHigh
```

For v1: skip IncompatFlags, CompatFlags, MessageIdMid, MessageIdHigh states.

**Key behaviors:**
- Byte-at-a-time processing (any chunk size input)
- CRC validation using registry's crcExtra for the messageId
- Unknown messageId → increment `unknownMessages` counter, discard frame
- CRC mismatch → increment `crcErrors` counter, discard frame
- CRC match → invoke `onFrame` callbacks with the `MavlinkFrame`

```typescript
export class MavlinkFrameParser {
  constructor(registry: MavlinkMetadataRegistry);
  parse(data: Uint8Array): void;           // feed bytes
  onFrame(callback: (frame: MavlinkFrame) => void): () => void;  // returns unsubscribe
  readonly framesReceived: number;
  readonly crcErrors: number;
  readonly unknownMessages: number;
  reset(): void;
}
```

**Acceptance criteria:**
- [ ] Feed a valid HEARTBEAT v2 frame byte-by-byte → `onFrame` called once with correct fields
- [ ] Feed the same frame in one chunk → same result
- [ ] Feed a frame with bad CRC → `onFrame` NOT called, `crcErrors` incremented
- [ ] Feed a frame with unknown messageId → `unknownMessages` incremented
- [ ] Feed two valid frames concatenated → `onFrame` called twice
- [ ] Feed garbage bytes then a valid frame → valid frame still parsed (re-syncs on STX)
- [ ] Round-trip: FrameBuilder → FrameParser → original values match

### Task 1.6: `src/mavlink/decoder.ts`

**Port from**: `lib/mavlink/parser/message_decoder.dart`

Decodes payload bytes into a `MavlinkMessage` using field metadata and `DataView`.

```typescript
export class MavlinkMessageDecoder {
  constructor(registry: MavlinkMetadataRegistry);
  decode(frame: MavlinkFrame): MavlinkMessage | null;
}
```

**Decoding rules:**
- Create `DataView` over payload `Uint8Array`
- For each field in metadata, read at `field.offset` with little-endian:
  - `uint8_t` / `int8_t` / `char` → `getUint8` / `getInt8`
  - `uint16_t` / `int16_t` → `getUint16(offset, true)` / `getInt16(offset, true)`
  - `uint32_t` / `int32_t` → `getUint32(offset, true)` / `getInt32(offset, true)`
  - `float` → `getFloat32(offset, true)`
  - `double` → `getFloat64(offset, true)`
  - `uint64_t` / `int64_t` → read as two 32-bit, combine (or use BigInt → Number)
- **Zero-padding**: If payload shorter than `encodedLength`, treat missing bytes as zero (MAVLink v2 zero-trimming)
- **char arrays** (`arrayLength > 1` and `type === "char"`): read bytes, convert to string, strip trailing nulls
- **Numeric arrays** (`arrayLength > 1`): read as `number[]`
- Unknown messageId → return `null`

**Acceptance criteria:**
- [ ] Decode HEARTBEAT payload → `values.type === 2`, `values.custom_mode === 0`, `values.mavlink_version === 3`
- [ ] Decode ATTITUDE payload → `values.roll` is a float, `values.time_boot_ms` is an integer
- [ ] Decode zero-trimmed payload (shorter than encodedLength) → missing fields default to 0
- [ ] Decode message with char array → `values.text` is a string with no null bytes
- [ ] Decode message with numeric array → `values.xyz` is `number[]` of correct length
- [ ] Unknown messageId → returns null

### Task 1.7: `src/mavlink/frame-builder.ts`

**Port from**: `lib/mavlink/parser/frame_builder.dart`

Builds complete MAVLink v2 frames from message name + values.

```typescript
export class MavlinkFrameBuilder {
  constructor(registry: MavlinkMetadataRegistry);
  buildFrame(options: {
    messageName: string;
    values: Record<string, number | string | number[]>;
    systemId?: number;     // default 1
    componentId?: number;  // default 1
    sequence?: number;     // default 0
  }): Uint8Array;          // complete frame bytes
}
```

**Encoding rules (reverse of decoder):**
- Allocate `Uint8Array(10 + encodedLength + 2)` — header(10) + payload + CRC(2)
- Write v2 header (STX=0xFD, len, flags=0, seq, sysid, compid, msgid 3 bytes LE)
- For each field, write value at field.offset in payload using DataView with little-endian
- Calculate CRC over header[1..9] + payload + crcExtra
- Append CRC as two bytes (low, high)

**Acceptance criteria:**
- [ ] Build HEARTBEAT frame → feed to FrameParser → decoded values match input
- [ ] Build ATTITUDE frame with known roll/pitch/yaw → round-trip matches
- [ ] Build frame with default sysid/compid → header bytes correct
- [ ] Built frame CRC validates in the parser

### Phase 1A Verification

```bash
npx vitest run src/mavlink/__tests__/crc.test.ts src/mavlink/__tests__/frame-parser.test.ts
```

At this point CRC, frame types, frame parser, and frame builder are complete and tested. The parser can parse frames and the builder can create them — verified via round-trip tests. **Commit this checkpoint before proceeding to Phase 1B.**

---

## Phase 1B: Data Dictionary (Metadata, Registry, Decoder, XML Parser)

Port from `/tmp/js_dash/lib/mavlink/metadata/` and the decoder/XML parser. This phase builds the data dictionary layer that gives meaning to the binary frames from Phase 1A.

### Task 1.8: `public/dialects/common.json`

Copy from `/tmp/js_dash/assets/mavlink/common.json`. This is a ~37K line pre-generated JSON file.

**Acceptance criteria:**
- [ ] File exists at `public/dialects/common.json`
- [ ] Parseable as JSON
- [ ] Contains `schema_version`, `dialect`, `enums`, `messages` keys
- [ ] `messages["0"]` is HEARTBEAT with `crc_extra: 50`

### Task 1.9: `src/mavlink/xml-parser.ts`

**Port from**: `lib/mavlink/parser/mavlink_xml_parser.dart`

Parses MAVLink XML dialect definitions using browser `DOMParser`. This is what allows users to import custom dialects.

```typescript
export function parseFromFileMap(
  files: Map<string, string>,  // filename → XML content
  mainFile: string
): string;                      // JSON string (same format as common.json)
```

**Key logic:**
1. Parse main XML file with `new DOMParser().parseFromString(xml, 'text/xml')`
2. Resolve `<include>` tags recursively from the `files` map
3. Extract `<enums>` with `<entry>` children
4. Extract `<messages>` with `<field>` children
5. Detect `<extensions/>` marker — fields after it are extension fields
6. **Field reordering**: Non-extension fields sorted by type size descending (largest first), extension fields keep original order
7. **CRC extra calculation** per message:
   ```
   crc = new MavlinkCrc()
   crc.accumulateString(messageName + " ")
   for each non-extension field (in ORIGINAL XML order, not reordered):
     crc.accumulateString(fieldType + " ")
     crc.accumulateString(fieldName + " ")
     if arrayLength > 1: crc.accumulate(arrayLength)
   crcExtra = (crc.value & 0xFF) ^ (crc.value >> 8)
   ```
8. **Offset calculation**: After reordering, compute byte offset for each field based on type sizes
9. Output JSON matching the `common.json` schema

**Acceptance criteria:**
- [ ] Parse a minimal XML with one message → JSON output matches expected structure
- [ ] CRC extra for HEARTBEAT definition matches 50
- [ ] Field reordering: uint32_t field sorts before uint8_t field
- [ ] Extension fields come after non-extension fields with correct offsets
- [ ] `<include>` resolution works (file A includes file B, both parsed)
- [ ] Parse result loadable by `MavlinkMetadataRegistry`

### Task 1.10: `src/mavlink/index.ts`

Barrel exports for all mavlink modules.

```typescript
export * from './crc';
export * from './metadata';
export * from './registry';
export * from './frame';
export * from './frame-parser';
export * from './decoder';
export * from './frame-builder';
export * from './xml-parser';
```

### Phase 1B Verification

```bash
npx vitest run src/mavlink/
```
All Phase 1A + 1B tests pass. Then integration check:

```typescript
// In a test: full round-trip
const registry = new MavlinkMetadataRegistry();
registry.loadFromJsonString(commonJson);
const builder = new MavlinkFrameBuilder(registry);
const parser = new MavlinkFrameParser(registry);
const decoder = new MavlinkMessageDecoder(registry);

const frame = builder.buildFrame({
  messageName: 'HEARTBEAT',
  values: { custom_mode: 0, type: 2, autopilot: 3, base_mode: 0x81, system_status: 4, mavlink_version: 3 }
});

let decoded: MavlinkMessage | null = null;
parser.onFrame(f => { decoded = decoder.decode(f); });
parser.parse(frame);

expect(decoded!.name).toBe('HEARTBEAT');
expect(decoded!.values.type).toBe(2);
```

---

## Phase 2: Data Pipeline

Port from `/tmp/js_dash/lib/services/`. Depends on Phase 1 being complete.

### Task 2.1: `src/services/byte-source.ts`

Interface definition (see Interface Contracts above). Pure types file.

### Task 2.2: `src/core/ring-buffer.ts`

**New design** (replaces js_dash `ListQueue<TimeSeriesPoint>`).

```typescript
export class RingBuffer {
  private timestamps: Float64Array;       // epoch-ms, circular storage
  private values: Float64Array;           // circular storage
  private viewTimestamps: Float64Array;   // pre-allocated contiguous view for output
  private viewValues: Float64Array;       // pre-allocated contiguous view for output
  private head = 0;                       // next write position
  private count = 0;                      // number of valid entries
  private readonly capacity: number;

  constructor(capacity = 2000);

  push(timestamp: number, value: number): void;
  // Write at head, increment head % capacity, increment count (max = capacity)

  get length(): number;  // min(count, capacity)

  toUplotData(): [Float64Array, Float64Array];
  // Returns [timestamps_in_seconds, values] as contiguous subarrays of the
  // pre-allocated view buffers. Uses Float64Array.set() to copy wrapped data
  // into the view buffers, then returns subarray(0, length) slices.
  // Timestamps converted from epoch-ms to epoch-seconds (divide by 1000).
  // CRITICAL: Do NOT allocate new Float64Array() on every call — that triggers
  // GC at 60Hz. The view buffers are allocated once in the constructor.

  getLatestValue(): number | undefined;
  getLatestTimestamp(): number | undefined;
  clear(): void;
}
```

**Why pre-allocated view buffers:**
- `toUplotData()` is called at 60Hz per signal. Allocating `new Float64Array()` each time would create massive GC pressure.
- Instead, allocate two "view" `Float64Array`s in the constructor (same capacity as the ring).
- On each call, use `.set()` to copy the wrapped circular data into the view buffers, then return `.subarray(0, length)` slices.
- `.subarray()` creates a view over the same underlying `ArrayBuffer` — no allocation.

**Why epoch-ms internally, epoch-seconds for uPlot:**
- Epoch-ms gives sub-millisecond timestamp precision for ordering
- uPlot expects epoch-seconds for its X axis
- Conversion is a simple `/ 1000` in `toUplotData()`

**Acceptance criteria:**
- [ ] Push 10 items → length is 10, toUplotData returns 10-element arrays
- [ ] Push capacity+5 items → length is capacity, oldest 5 are gone
- [ ] Wrap-around: timestamps in toUplotData are monotonically increasing
- [ ] toUplotData timestamps are in seconds (not ms)
- [ ] getLatestValue returns most recently pushed value
- [ ] clear() resets length to 0
- [ ] Empty buffer → toUplotData returns empty arrays

### Task 2.3: `src/services/spoof-byte-source.ts`

**Port from**: `lib/services/spoof_byte_source.dart`

Generates realistic MAVLink telemetry for testing without hardware.

```typescript
export class SpoofByteSource implements IByteSource {
  constructor(registry: MavlinkMetadataRegistry);
  // ... IByteSource implementation
}
```

**Message generation schedule:**

| Message | Rate | Fields |
|---------|------|--------|
| ATTITUDE (#30) | 10 Hz | time_boot_ms, roll, pitch, yaw, rollspeed, pitchspeed, yawspeed |
| GLOBAL_POSITION_INT (#33) | 10 Hz | time_boot_ms, lat, lon, alt, relative_alt, vx, vy, vz, hdg |
| VFR_HUD (#74) | 10 Hz | airspeed, groundspeed, heading, throttle, alt, climb |
| SYS_STATUS (#1) | 1 Hz | voltage_battery, current_battery, battery_remaining, load, errors_count* |
| HEARTBEAT (#0) | 1 Hz | type=2, autopilot=3, base_mode=0x81, system_status=4, mavlink_version=3 |
| STATUSTEXT (#253) | Every 3-8s | severity (random 0-7), text (random message) |

**Simulation model (from js_dash):**

```
Initial state:
  latitude   = 34.0522      (Los Angeles)
  longitude  = -118.2437
  altitude   ∈ [50, 100]    meters, random walk ±0.05/tick
  heading    = figure-8 pattern: baseHeading + 30° × sin(time × 0.5)
  groundSpeed ∈ [5, 25]     m/s, random walk ±0.3/tick
  roll       ∈ [-20°, 20°]  random walk ±0.05/tick (stored as radians)
  pitch      ∈ [-15°, 15°]  random walk ±0.05/tick (stored as radians)
  yaw        = heading in radians
  batteryV   ∈ [10.0, 13.0] slow drain ~0.001V/tick
  throttle   ∈ [0, 100]     %

GPS position update per 100ms tick:
  latitude  += groundSpeed × cos(heading_rad) × 0.1 / 111320
  longitude += groundSpeed × sin(heading_rad) × 0.1 / (111320 × cos(lat_rad))

GLOBAL_POSITION_INT encoding:
  lat, lon: degrees × 1e7 (int32)
  alt, relative_alt: meters × 1000 (int32, mm)
  vx, vy, vz: m/s × 100 (int16, cm/s)
  hdg: degrees × 100 (uint16, cdeg)

STATUSTEXT messages (random selection):
  "All systems nominal", "GPS lock acquired", "Battery voltage nominal",
  "Telemetry link stable", "Altitude hold active", "Navigation mode enabled",
  "Sensor calibration complete", "Low battery warning" (severity=4),
  "Engine temperature high" (severity=3), "Critical: IMU failure" (severity=2)
```

Uses `MavlinkFrameBuilder` to construct valid binary frames. Emits frames via `onData` callbacks as `Uint8Array`.

**Acceptance criteria:**
- [ ] Connect → bytes emitted at expected intervals
- [ ] Emitted bytes parse correctly through FrameParser + Decoder
- [ ] HEARTBEAT decoded: `type=2`, `mavlink_version=3`
- [ ] ATTITUDE decoded: roll, pitch, yaw are numbers in radian range
- [ ] GLOBAL_POSITION_INT decoded: lat ≈ 340522000 (34.0522 × 1e7)
- [ ] STATUSTEXT decoded: text is a non-empty string, severity is 0-7
- [ ] Disconnect stops emission, reconnect resumes

### Task 2.4: `src/services/message-tracker.ts`

**Port from**: `lib/services/generic_message_tracker.dart`

Tracks message statistics with rolling frequency calculation.

```typescript
export class GenericMessageTracker {
  startTracking(): void;   // starts 100ms stats update timer
  stopTracking(): void;    // stops timer
  trackMessage(msg: MavlinkMessage): void;
  onStats(callback: (stats: Map<string, MessageStats>) => void): () => void;
  getStats(): Map<string, MessageStats>;
}
```

**Frequency algorithm:**
1. Store timestamps of recent messages per message name (in `_recentTimestamps` array)
2. Every 100ms (stats update timer):
   - Remove timestamps older than 5 seconds (sliding window)
   - Timestamps stored in milliseconds (epoch-ms). Formula:
     `frequency = (timestamps.length - 1) / ((newestMs - oldestMs) / 1000)` → result in Hz
   - If only 1 timestamp or `newestMs === oldestMs`, frequency = 0
3. **Decay** (when no new messages received):
   - If last message > 2 seconds ago: `decay = 1.0 - (timeSinceLastMsg - 2000) / 3000`
   - `frequency *= clamp(decay, 0, 1)`
   - If frequency < 0.01, set to 0
4. **Stale removal**: Remove entries not received for 10+ seconds

**Acceptance criteria:**
- [ ] Track 10 messages at 100ms intervals → frequency ≈ 10 Hz (±1)
- [ ] Stop sending messages → frequency decays to 0 within ~5 seconds
- [ ] Track messages from two different types → both have independent frequencies
- [ ] Stale entry removed after 10s of no messages
- [ ] `getStats()` returns current snapshot without mutation risk

### Task 2.5: `src/services/timeseries-manager.ts`

**Port from**: `lib/services/timeseries_data_manager.dart`

Extracts numeric fields from decoded messages and stores in ring buffers.

```typescript
export class TimeSeriesDataManager {
  constructor(options?: { bufferCapacity?: number; maxFields?: number });
  processMessage(msg: MavlinkMessage): void;
  getBuffer(fieldKey: string): RingBuffer | undefined;  // "ATTITUDE.roll"
  getAvailableFields(): string[];                        // all known field keys
  onUpdate(callback: () => void): () => void;            // throttled at 60Hz
  dispose(): void;
}
```

**Field extraction rules:**
- Key format: `"MESSAGE_NAME.field_name"` (e.g., `"ATTITUDE.roll"`)
- `number` values → push directly to ring buffer
- `number[]` values → expand to `"MESSAGE_NAME.field_name[0]"`, `"field_name[1]"`, etc.
- `string` values → skip (not numeric)
- Max 500 unique field keys (prevent unbounded growth)

**Throttle**: Emit `onUpdate` callbacks at most every 16ms (60Hz). Use a pending flag + timer, not per-message emission.

**Cleanup**: Every 5 seconds, optionally prune buffers with no new data (configurable).

**Acceptance criteria:**
- [ ] Process ATTITUDE message → creates ring buffers for "ATTITUDE.roll", "ATTITUDE.pitch", etc.
- [ ] Process 100 ATTITUDE messages → ring buffer length is 100
- [ ] `getAvailableFields()` returns all created field keys
- [ ] `onUpdate` called at most 60 times/second under rapid input
- [ ] String fields (STATUSTEXT.text) do NOT create ring buffers
- [ ] Array fields create indexed sub-keys

### Task 2.6: `src/services/mavlink-service.ts`

**Port from**: `lib/services/mavlink_service.dart`

Wires the pipeline: byte source → frame parser → decoder → tracker. This class runs **inside the Web Worker** (imported by `mavlink-worker.ts`). It is NOT instantiated on the main thread.

```typescript
export class MavlinkService {
  constructor(
    registry: MavlinkMetadataRegistry,
    byteSource: IByteSource,
    tracker: GenericMessageTracker,
    timeseriesManager: TimeSeriesDataManager
  );
  connect(): Promise<void>;
  disconnect(): void;
  pause(): void;
  resume(): void;
  readonly isPaused: boolean;
  onMessage(callback: (msg: MavlinkMessage) => void): () => void;
}
```

**Wiring:**
- `byteSource.onData` → `parser.parse(data)`
- `parser.onFrame` → `decoder.decode(frame)` → if valid: `tracker.trackMessage(msg)`, `timeseriesManager.processMessage(msg)`, invoke `onMessage` callbacks
- Pause: stop invoking onMessage callbacks and timeseriesManager, but keep tracker running

**Acceptance criteria:**
- [ ] Connect with SpoofByteSource → onMessage receives decoded MavlinkMessages
- [ ] Messages include HEARTBEAT, ATTITUDE, GLOBAL_POSITION_INT, etc.
- [ ] Pause → onMessage stops being called; resume → resumes
- [ ] Disconnect → no more callbacks

### Task 2.7: `src/services/connection-manager.ts`

**Port from**: `lib/services/connection_manager.dart`

Main-thread facade that delegates to `MavlinkWorkerBridge`. This is what the UI interacts with.

```typescript
export class ConnectionManager {
  constructor(workerBridge: MavlinkWorkerBridge);
  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): void;
  pause(): void;
  resume(): void;
  onStatusChange(callback: (status: ConnectionStatus) => void): () => void;
  readonly status: ConnectionStatus;
}
```

Translates UI actions into worker messages. Tracks connection status locally on the main thread.

**Acceptance criteria:**
- [ ] `connect({ type: 'spoof' })` → status transitions: disconnected → connecting → connected
- [ ] `disconnect()` → status becomes disconnected, cleans up all services
- [ ] Only one connection at a time — connecting while connected disconnects first

### Task 2.8: `src/workers/mavlink-worker.ts` (Web Worker)

**This is the critical performance task.** Move the entire MAVLink pipeline off the main thread.

**Worker file** (`src/workers/mavlink-worker.ts`):
```typescript
// Runs in a Web Worker. Imports MAVLink engine directly.
// Receives: raw bytes from byte source, control messages (connect/disconnect/pause)
// Sends: decoded message stats, ring buffer data (as Transferable ArrayBuffers)

self.onmessage = (e: MessageEvent) => {
  switch (e.data.type) {
    case 'init':        // Load dialect JSON, create registry/parser/decoder
    case 'bytes':       // Feed raw bytes to parser
    case 'connect':     // Start spoof source (runs in worker)
    case 'disconnect':  // Stop source
    case 'pause':       // Pause message emission
    case 'resume':      // Resume
    case 'getBuffers':  // Request current ring buffer data for rendering
  }
};
```

**Main thread bridge** (`src/services/worker-bridge.ts`):
```typescript
export class MavlinkWorkerBridge {
  private worker: Worker;

  constructor();
  // Create worker: new Worker(new URL('../workers/mavlink-worker.ts', import.meta.url), { type: 'module' })
  // Vite handles the bundling automatically with this URL pattern.

  init(dialectJson: string): Promise<void>;
  connect(config: ConnectionConfig): void;
  disconnect(): void;
  pause(): void;
  resume(): void;

  // Called by UI at ~60Hz to get fresh data for rendering
  onStats(callback: (stats: Map<string, MessageStats>) => void): () => void;
  onUpdate(callback: (buffers: Map<string, { timestamps: Float64Array; values: Float64Array }>) => void): () => void;
}
```

**Data transfer strategy:**
- **Message stats** (small): Structured clone via `postMessage` (Map of strings → stats objects). Sent every 100ms from worker.
- **Ring buffer data** (large): Worker copies ring buffer contents into fresh `ArrayBuffer`s and transfers them as Transferable objects (zero-copy transfer). Main thread wraps received buffers as `Float64Array` views and passes directly to uPlot.
- **Control messages** (tiny): Simple `postMessage` with `{ type: string, ... }`.

**Why not SharedArrayBuffer:**
SharedArrayBuffer requires COOP/COEP headers which complicate GitHub Pages deployment. Transferable objects are simpler and fast enough for 60Hz updates.

**What runs where:**

| Component | Thread | Why |
|-----------|--------|-----|
| ByteSource (Spoof) | Worker | Generates bytes without touching main thread |
| FrameParser | Worker | CPU-intensive CRC validation |
| Decoder | Worker | DataView reads on binary payloads |
| MessageTracker | Worker | Frequency math and timers |
| TimeSeriesManager + RingBuffers | Worker | All buffer writes happen off-thread |
| ConnectionManager | Main | Thin facade, delegates to worker |
| SolidJS store/signals | Main | Reactivity is main-thread only |
| uPlot | Main | Canvas rendering |
| Gridstack | Main | DOM manipulation |

**ByteSource for Web Serial special case:**
Web Serial API must be called from the main thread (requires user gesture for `requestPort()`). For serial connections, the main thread reads bytes from the serial port and posts them to the worker for parsing. For spoof connections, the entire spoof source runs inside the worker.

**Acceptance criteria:**
- [ ] Worker loads and initializes with dialect JSON
- [ ] Spoof connection runs entirely in worker — main thread receives decoded stats
- [ ] `onStats` callback fires with message names and frequencies
- [ ] `onUpdate` callback fires with Float64Array data for each field key
- [ ] Disconnect cleans up worker timers
- [ ] Main thread stays responsive during high-rate telemetry (no jank)
- [ ] Vite bundles the worker correctly (`import.meta.url` pattern)

### Phase 2 Verification

```bash
npx vitest run
```

All Phase 1A + 1B + Phase 2 tests pass.

**Note on worker tests:** Vitest with `happy-dom` doesn't provide a real Web Worker environment. Test the worker bridge by:
1. Unit testing each service (parser, decoder, tracker, timeseries) independently (already done in their own tests)
2. Testing the worker message protocol with mock `postMessage` handlers
3. Full integration testing via Playwright MCP in Phase 3+ (connect spoof in browser, verify messages appear)

---

## Phase 3: Core UI Shell

Depends on Phase 2. First UI code — use Playwright MCP for verification.

### Task 3.1: `src/store/app-store.ts`

SolidJS reactive store for global application state.

```typescript
import { createStore } from 'solid-js/store';

export interface AppState {
  connectionStatus: ConnectionStatus;
  theme: 'dark' | 'light';
  activeTab: string;           // 'telemetry' | 'map'
  activeSubTab: string;        // plot tab ID
  plotTabs: PlotTab[];
  isPaused: boolean;
}

export const [appState, setAppState] = createStore<AppState>({
  connectionStatus: 'disconnected',
  theme: 'dark',
  activeTab: 'telemetry',
  activeSubTab: 'default',
  plotTabs: [{ id: 'default', name: 'Tab 1', plots: [] }],
  isPaused: false,
});
```

Also export service instances as module-level variables (**NOT inside the store**):

```typescript
// These are class instances with methods and TypedArrays — they MUST NOT go in createStore.
// SolidJS's deep proxy would wrap their internals, breaking class methods and TypedArray performance.
// Use non-null assertion (null!) because they're initialized in onMount before any UI reads them.
export let workerBridge: MavlinkWorkerBridge = null!;   // assigned in onMount after dialect loads
export let registry: MavlinkMetadataRegistry = null!;   // assigned in onMount
```

**Acceptance criteria:**
- [ ] Store initializes with default values
- [ ] `setAppState('theme', 'light')` updates reactively
- [ ] Types compile with strict mode
- [ ] `workerBridge` and `registry` are module-level variables, NOT inside `createStore`

### Task 3.2: `src/components/ThemeProvider.tsx`

CSS custom properties for dark/light mode. Wraps app with theme context.

**Color palette:**

```css
/* Dark (default) */
--bg-primary: #111217;
--bg-panel: #181b1f;
--bg-hover: #1e2128;
--text-primary: #e4e4e7;
--text-secondary: #a1a1aa;
--accent: #00d4ff;
--accent-green: #00ff88;
--border: #2a2d35;

/* Light */
--bg-primary: #f8f9fa;
--bg-panel: #ffffff;
--bg-hover: #f0f0f0;
--text-primary: #18181b;
--text-secondary: #52525b;
--accent: #0066cc;
--accent-green: #059669;
--border: #e4e4e7;
```

Persist preference to IndexedDB via `idb-keyval`. Apply `dark` class to `<html>` element for Tailwind.

**Acceptance criteria:**
- [ ] App renders with dark theme by default
- [ ] Toggle switches to light theme (colors change)
- [ ] Preference persists across page reload (idb-keyval)

**Playwright verification:**
```
browser_navigate → localhost:5173
browser_snapshot → verify dark theme class on html element
browser_click → theme toggle
browser_snapshot → verify light theme applied
```

### Task 3.3: `src/components/Toolbar.tsx`

Top toolbar with connection controls and theme toggle.

**Elements:**
- "MavDeck" logo/title (left)
- Connection button: "Connect Spoof" / "Disconnect" (toggles)
- Connection status indicator: colored dot (gray=disconnected, yellow=connecting, green=connected, red=error)
- Theme toggle button (sun/moon icon)
- Pause/Resume button (visible when connected)

**Acceptance criteria:**
- [ ] Toolbar renders with all elements
- [ ] Click "Connect Spoof" → calls connectionManager.connect({ type: 'spoof' })
- [ ] Status dot turns green when connected
- [ ] Theme toggle switches dark↔light

**Playwright verification:**
```
browser_snapshot → verify toolbar elements exist (Connect, theme toggle)
browser_click → "Connect Spoof"
browser_wait_for → status indicator shows connected
browser_snapshot → verify status changed
```

### Task 3.4: `src/components/TabBar.tsx`

Horizontal tab bar below toolbar for switching views.

**Tabs:**
- Telemetry (default active)
- Map

Renders content based on active tab. Telemetry tab additionally shows sub-tabs for plot tabs (from `appState.plotTabs`).

**Acceptance criteria:**
- [ ] Two tabs render: Telemetry, Map
- [ ] Clicking tab switches active content
- [ ] Active tab has visual indicator (underline/highlight)

### Task 3.5: `src/App.tsx`

Wire everything together: ThemeProvider → Toolbar → TabBar → content area.

Load dialect on mount:
```typescript
onMount(async () => {
  const response = await fetch(`${import.meta.env.BASE_URL}dialects/common.json`);
  const json = await response.text();
  registry.loadFromJsonString(json);
});
```

**Acceptance criteria:**
- [ ] App loads, shows toolbar and tab bar
- [ ] Dialect loads without errors (check console)
- [ ] Connect Spoof → connection works end-to-end

**Playwright verification (full Phase 3):**
```
browser_navigate → localhost:5173
browser_snapshot → verify: toolbar, tabs, "MavDeck" title
browser_console_messages(level="error") → empty
browser_click → "Connect Spoof"
browser_wait_for → time=2 (seconds, let messages accumulate)
browser_snapshot → verify connected state
browser_click → theme toggle
browser_take_screenshot → verify visual appearance
```

---

## Phase 4: Message Monitor Sidebar

Depends on Phase 3.

### Task 4.1: `src/components/MessageMonitor.tsx`

**Port from**: `lib/views/telemetry/mavlink_message_monitor.dart`

Left sidebar showing received MAVLink messages with live stats.

**Layout:**
- Width: ~350px (resizable via drag handle)
- Top: header "Messages" with count
- Middle: scrollable list of message cards, sorted alphabetically by name
- Bottom: StatusTextLog panel

**Message card (collapsed):**
- Message name (monospace font)
- Frequency badge: `"10.0 Hz"` (green background)
- Expand chevron

**Message card (expanded):**
- All fields listed: `field_name: value [units]`
- Numeric values formatted (2-4 decimal places for floats)
- Fields with enum types show resolved name (e.g., `type: QUADROTOR`)
- Click a numeric field → triggers "add to plot" action (callback prop)

**Reactive data source**: Subscribe to `connectionManager.tracker.onStats()`. Create SolidJS signal from callback:

```typescript
const [messageStats, setMessageStats] = createSignal<Map<string, MessageStats>>(new Map());
// In onMount: tracker.onStats(stats => setMessageStats(new Map(stats)));
```

**Acceptance criteria:**
- [ ] With spoof connected: HEARTBEAT, ATTITUDE, SYS_STATUS, GLOBAL_POSITION_INT, VFR_HUD appear
- [ ] Messages sorted alphabetically
- [ ] Frequency badges show realistic Hz values (~10 for fast, ~1 for slow)
- [ ] Click to expand shows field values
- [ ] Field values update live (not frozen)
- [ ] Enum fields show resolved names

**Playwright verification:**
```
browser_navigate → localhost:5173
browser_click → "Connect Spoof"
browser_wait_for → text="HEARTBEAT"
browser_snapshot → verify message names visible, Hz badges
browser_click → ATTITUDE message (expand)
browser_snapshot → verify roll, pitch, yaw fields visible with values
```

### Task 4.2: `src/components/StatusTextLog.tsx`

**Port from**: `lib/views/telemetry/statustext_log_panel.dart`

Shows STATUSTEXT messages with severity coloring at the bottom of the message monitor.

**Severity colors:**
```
0-2 (EMERGENCY/ALERT/CRITICAL): red text, red-tinted background
3   (ERROR):                     orange text
4   (WARNING):                   yellow/amber text
5   (NOTICE):                    cyan text
6   (INFO):                      blue-gray text
7   (DEBUG):                     gray text
```

**Layout:**
- Collapsible panel (collapsed height ~36px, expanded ~180px)
- Header: "Status" + message count badge + "NEW" indicator
- Expanded: scrollable list, newest at bottom, auto-scroll
- Each entry: `[HH:MM:SS] [SEVERITY] message text`
- Max ~100 entries (oldest pruned)

**Acceptance criteria:**
- [ ] STATUSTEXT messages from spoof appear in log
- [ ] Severity coloring applied correctly
- [ ] Auto-scrolls to newest message
- [ ] Collapse/expand toggle works
- [ ] Count badge updates

**Playwright verification:**
```
browser_click → "Connect Spoof"
browser_wait_for → time=10 (let statustext messages accumulate)
browser_snapshot → verify statustext entries visible with severity labels
```

---

## Phase 5: Plotting System

Depends on Phase 4. This is the core feature.

### Task 5.1: `src/models/plot-config.ts`

Type definitions (see Interface Contracts above). Pure types file with `PlotSignalConfig`, `PlotConfig`, `PlotTab`, `ScalingMode`, `TimeWindow`, `SIGNAL_COLORS`.

### Task 5.2: `src/components/PlotChart.tsx`

uPlot integration component.

**Initialization:**
```typescript
const u = new uPlot({
  ...opts,
  cursor: { sync: { key: 'telemetry' } },  // synced crosshairs
});
```

**Data format** (from RingBuffer):
```typescript
const [timestamps, values] = ringBuffer.toUplotData();
u.setData([timestamps, values]);  // uPlot wants [xValues, ...ySeriesValues]
```

For multiple signals: `[timestamps, series1, series2, ...]` — all same length, all from same time range.

**Live scrolling**: In a `requestAnimationFrame` loop (or 60Hz setInterval):
1. Get fresh data from ring buffers via `toUplotData()`
2. Call `u.setData(data)` with new arrays
3. Set X axis range to `[now - timeWindow, now]` for auto-scrolling

**Pause behavior:**
- Stop auto-scrolling X axis
- Continue writing data to ring buffers (don't lose data)
- Call `u.setData(data, false)` — the `false` prevents axis recalculation
- Show "RESUME LIVE" floating button overlay

**Resize**: Use `ResizeObserver` on the container element. On resize, call `u.setSize({ width, height })` (debounced ~100ms).

**Series styling:**
- Line width: 1.5px
- Colors from `SIGNAL_COLORS` palette
- Optional gradient fill under traces

**Acceptance criteria:**
- [ ] Renders a uPlot chart with live data from a ring buffer
- [ ] Multiple series render with different colors
- [ ] Auto-scrolls in live mode
- [ ] Pause stops scrolling, resume jumps to live
- [ ] Crosshair sync works between multiple PlotChart instances
- [ ] Resizes correctly when container changes size

### Task 5.3: `src/components/PlotPanel.tsx`

Wrapper for PlotChart inside a gridstack item.

**Layout:**
- Header bar: drag handle (left), signal names/title (center), close button (right)
- Live value display: current numeric value of primary signal (large monospace text)
- PlotChart fills remaining space

**Interactions:**
- Close button → removes plot from the grid
- Header → drag handle for gridstack
- Double-click header → open signal selector

**Acceptance criteria:**
- [ ] Renders header + chart
- [ ] Close button removes the panel
- [ ] Drag handle works with gridstack
- [ ] Live value updates in real-time

### Task 5.4: `src/components/SignalSelector.tsx`

Dialog/dropdown for selecting which signals to plot.

**UI:**
- Groups available fields by message type (ATTITUDE, VFR_HUD, etc.)
- Expandable groups showing individual fields
- Checkbox/toggle per field
- Color indicator per active signal
- "Add selected" action

**Data source**: `timeseriesManager.getAvailableFields()` — only shows fields that have actually been received.

**Acceptance criteria:**
- [ ] Shows all available fields grouped by message
- [ ] Toggle adds/removes signal from the plot
- [ ] Only numeric fields appear (no STATUSTEXT.text)
- [ ] Color assignment from palette

### Task 5.5: `src/components/TelemetryView.tsx`

Main telemetry view: MessageMonitor on left, plot grid on right.

**Layout:**
- Left: MessageMonitor sidebar (~350px)
- Right: Plot grid area (fills remaining width)
- Top of plot area: "Add Plot" button, time window selector, pause/resume

**Workflow for adding a signal to a plot:**
1. User clicks a field in MessageMonitor → if no plot exists, create one
2. Signal added to the selected (or new) plot
3. Plot appears in the grid with live data

**Acceptance criteria:**
- [ ] MessageMonitor + plot area render side by side
- [ ] "Add Plot" creates a new empty plot panel
- [ ] Click field in monitor → signal appears in a plot
- [ ] Time window selector changes all plots' X range
- [ ] Pause/resume affects all plots

**Playwright verification (full Phase 5):**
```
browser_navigate → localhost:5173
browser_click → "Connect Spoof"
browser_wait_for → text="ATTITUDE"
browser_click → ATTITUDE (expand)
browser_click → "roll" field
browser_wait_for → time=2 (let plot render)
browser_snapshot → verify plot panel exists with "roll" signal
browser_take_screenshot → verify chart has visible trace
browser_click → "pitch" field (add second signal)
browser_snapshot → verify two signals in plot
```

---

## Phase 6: Layout Management (Gridstack)

Depends on Phase 5.

### Task 6.1: `src/components/GridLayout.tsx`

Gridstack integration for drag-and-drop plot layout.

```typescript
import { GridStack } from 'gridstack';
import 'gridstack/dist/gridstack.css';
```

**Configuration:**
```typescript
const grid = GridStack.init({
  column: 12,
  animate: true,
  cellHeight: 80,
  margin: 4,
  float: true,
  removable: false,
});
```

**SolidJS + Gridstack integration (CRITICAL — read carefully):**

Gridstack mutates the DOM directly. SolidJS will crash or duplicate components if you use `<For>` to render gridstack items. You MUST use this pattern:

```typescript
// In GridLayout.tsx onMount:
const grid = GridStack.init({ ... }, containerRef);

function addPlotWidget(plotConfig: PlotConfig) {
  // 1. Create a plain DOM container (NOT managed by SolidJS)
  const container = document.createElement('div');

  // 2. Let Gridstack own the DOM node
  grid.addWidget(container, {
    x: plotConfig.gridPos.x, y: plotConfig.gridPos.y,
    w: plotConfig.gridPos.w, h: plotConfig.gridPos.h,
    id: plotConfig.id,
  });

  // 3. Mount SolidJS component INSIDE the unmanaged node
  const dispose = render(() => <PlotPanel config={plotConfig} />, container);

  // 4. Store dispose function for cleanup
  disposeMap.set(plotConfig.id, dispose);
}

function removePlotWidget(plotId: string) {
  const el = grid.getGridItems().find(el => el.gridstackNode?.id === plotId);
  if (el) grid.removeWidget(el);
  disposeMap.get(plotId)?.();  // Cleanup SolidJS component
  disposeMap.delete(plotId);
}
```

**Why**: Gridstack reorders DOM nodes during drag. If SolidJS owns those nodes (via `<For>`), it loses track of them and crashes or duplicates charts. By using `render()` + `dispose()` on unmanaged nodes, SolidJS and Gridstack each own their own DOM layer.

**Lifecycle:**
- `onMount`: Initialize gridstack, restore layout from IndexedDB, call `addPlotWidget` for each
- `onCleanup`: Destroy gridstack, call all dispose functions
- Listen to `change` event → update `PlotConfig.gridPos` in store
- Listen to `resizestart`/`resizestop` → trigger uPlot resize via `ResizeObserver`

**Serialization (layout only — NOT settings):**
- On `change` event: save grid positions to IndexedDB via `idb-keyval` under key `mavdeck-layout-v1`
- On mount: restore grid positions from IndexedDB
- Each widget identified by plot ID
- **Ownership boundary**: This task owns *spatial layout* (grid x/y/w/h per widget per tab). Phase 9 `settings-service` owns *app preferences* (theme, baud rate, buffer size, etc.). They use separate IndexedDB keys and do not overlap.

**Tab system:**
- Only mount gridstack and uPlot instances for the active tab
- Switching tabs: destroy old grid, create new one with saved layout
- Prevents idle uPlot instances consuming memory

**Acceptance criteria:**
- [ ] Plots appear as gridstack items in a 12-column grid
- [ ] Drag to reposition works
- [ ] Resize updates uPlot chart size
- [ ] Layout persists across page reload
- [ ] Adding/removing plots updates grid correctly

**Playwright verification:**
```
browser_navigate → localhost:5173
# Connect and add a plot
browser_click → "Connect Spoof"
browser_wait_for → text="ATTITUDE"
browser_click → ATTITUDE → roll field
browser_wait_for → time=1
browser_snapshot → verify gridstack item exists
# Check layout persists
browser_evaluate → "location.reload()"
browser_wait_for → time=2
browser_snapshot → verify plot panel still present after reload
```

---

## Phase 7: Map View

Depends on Phase 3. Can be done in parallel with Phases 4-6.

### Task 7.1: `src/components/MapView.tsx`

Leaflet + OpenStreetMap for vehicle position tracking.

```typescript
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
```

**Features:**
- OpenStreetMap tile layer
- Vehicle marker at GLOBAL_POSITION_INT lat/lon (converted from degE7: `lat / 1e7`)
- Heading indicator: rotate marker icon by `hdg / 100` degrees
- Trail line: polyline of recent positions (last ~200 points)
- Auto-center toggle: when enabled, map pans to keep vehicle centered
- Coordinate display overlay: lat, lon, alt, heading

**Data source**: Subscribe to `timeseriesManager` for `GLOBAL_POSITION_INT.lat`, `.lon`, `.alt`, `.hdg`.

**SolidJS lifecycle:**
- `onMount`: Create Leaflet map, add tile layer
- `onCleanup`: Remove map
- Use `createEffect` to update marker position when signals change

**Initial view**: Center on spoof start position (34.0522, -118.2437), zoom 15.

**Acceptance criteria:**
- [ ] Map renders with OSM tiles
- [ ] Vehicle marker appears at correct position
- [ ] Marker moves as new GPS data arrives
- [ ] Trail line draws behind vehicle
- [ ] Auto-center keeps vehicle in view
- [ ] Heading indicator rotates correctly

**Playwright verification:**
```
browser_navigate → localhost:5173
browser_click → "Connect Spoof"
browser_wait_for → time=3
browser_click → "Map" tab
browser_wait_for → time=2
browser_snapshot → verify map container exists
browser_take_screenshot → verify map tiles loaded, marker visible
```

---

## Phase 8: Web Serial Integration

Depends on Phase 2. Can be done in parallel with UI phases.

### Task 8.1: `src/services/webserial-byte-source.ts`

**Port from**: `lib/services/serial/serial_byte_source_web.dart`

```typescript
export class WebSerialByteSource implements IByteSource {
  constructor(options: { baudRate: number });
  requestPort(): Promise<void>;   // triggers browser's port selection dialog
  connect(): Promise<void>;       // opens port, starts reading
  disconnect(): void;             // closes port
  onData(callback: ByteCallback): () => void;
  readonly isConnected: boolean;
}
```

**Web Serial API flow:**
1. `requestPort()`: `navigator.serial.requestPort()` — browser shows device picker
2. `connect()`: `port.open({ baudRate })` → get `port.readable` → pipe through reader
3. Read loop: `reader.read()` → invoke `onData` callbacks with `Uint8Array` chunks
4. `disconnect()`: `reader.cancel()` → `port.close()`

**Config:** 8N1 (8 data bits, no parity, 1 stop bit) — Web Serial API default.

**Baud rates to support:** 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600.

**Error handling:**
- Port disconnected unexpectedly → invoke status callback, clean up
- Port already open → close and reopen
- Browser doesn't support Web Serial → throw descriptive error

**Acceptance criteria:**
- [ ] TypeScript compiles (Web Serial types)
- [ ] `navigator.serial` feature detection works
- [ ] API matches `IByteSource` interface
- [ ] Baud rate configurable
- [ ] Graceful disconnect handling

### Task 8.2: `src/components/SerialSettings.tsx`

Serial port configuration UI.

**Elements:**
- "Connect Serial" button (triggers `requestPort()` → browser dialog)
- Baud rate dropdown: 9600, 19200, 38400, 57600, **115200** (default), 230400, 460800, 921600
- Connection status indicator
- "Web Serial not supported" message for unsupported browsers

**Acceptance criteria:**
- [ ] Baud rate selector renders with all options
- [ ] Connect button visible
- [ ] Unsupported browser shows fallback message

---

## Phase 9: Settings & PWA

Can start after Phase 3, integrates with all later phases.

### Task 9.1: `src/services/settings-service.ts`

Persist application settings using `idb-keyval`. **Ownership boundary**: This service owns *app preferences* (theme, baud rate, buffer sizes, connection prefs). Grid *layout positions* are owned by Phase 6 (`mavdeck-layout-v1` key). Do not duplicate layout data here.

```typescript
import { get, set } from 'idb-keyval';

const SETTINGS_KEY = 'mavdeck-settings-v1';

export interface MavDeckSettings {
  theme: 'dark' | 'light';
  plotTabs: PlotTab[];
  baudRate: number;
  autoConnect: boolean;
  bufferCapacity: number;       // default 2000
  dataRetentionMinutes: number; // default 10
  updateIntervalMs: number;     // default 16 (60Hz)
}

export async function loadSettings(): Promise<MavDeckSettings>;
export async function saveSettings(settings: MavDeckSettings): Promise<void>;
```

**Debounced save**: Don't save on every keystroke. Debounce 2 seconds.

**Acceptance criteria:**
- [ ] Settings save to IndexedDB
- [ ] Settings load on app start
- [ ] Missing keys use defaults (forward-compatible)
- [ ] Theme persists across reload

### Task 9.2: PWA Configuration in `vite.config.ts`

```typescript
import { VitePWA } from 'vite-plugin-pwa';

VitePWA({
  registerType: 'autoUpdate',
  workbox: {
    globPatterns: ['**/*.{js,css,html,json,svg,png,woff2}'],
  },
  manifest: {
    name: 'MavDeck',
    short_name: 'MavDeck',
    description: 'Real-time MAVLink telemetry visualization',
    theme_color: '#111217',
    background_color: '#111217',
    display: 'standalone',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  },
})
```

Use conditional `base` so local dev works on `/` and GitHub Pages deploys to `/MavDeck/`:
```typescript
base: process.env.GITHUB_ACTIONS ? '/MavDeck/' : '/',
```
All fetch paths in app code MUST use `import.meta.env.BASE_URL` (e.g., `` `${import.meta.env.BASE_URL}dialects/common.json` ``), never hardcoded `/MavDeck/`.

**Acceptance criteria:**
- [ ] `npm run build` generates service worker
- [ ] Manifest serves correctly
- [ ] App installable as PWA (check with Lighthouse)

---

## Phase 10: Polish

After all functional phases complete.

### Task 10.1: Typography
- D-DIN font (or similar monospace tabular lining font) for numeric readouts
- Load via `@font-face` in `global.css`
- Apply to: frequency badges, field values, plot axis labels, live values

### Task 10.2: Dark mode styling
- Neon cyan (`#00d4ff`) / green (`#00ff88`) glow effects on active traces
- Subtle panel borders with `rgba(0,212,255,0.1)`
- Chart grid lines: `rgba(255,255,255,0.05)`

### Task 10.3: Light mode styling
- Clean professional palette
- Chart grid lines: `rgba(0,0,0,0.08)`
- Trace colors: deeper, less neon (blue/indigo)

### Task 10.4: Loading states
- Skeleton UI while dialect JSON loads
- Spinner on connection attempt

### Task 10.5: Responsive design
- Sidebar collapses to icon-only on viewports < 768px
- Plots stack vertically on narrow screens

### Task 10.6: Keyboard shortcuts
- `Space` — pause/resume
- `Escape` — deselect plot / close dialogs
- `Tab` — cycle between plots

### Task 10.7: Custom dialect import
- File picker button in toolbar/settings
- Accept `.xml` files
- Parse with `parseFromFileMap()` → load into registry
- Show success/error feedback

**Playwright verification (full Polish):**
```
browser_navigate → localhost:5173
browser_take_screenshot → verify dark mode aesthetic
browser_click → theme toggle
browser_take_screenshot → verify light mode aesthetic
browser_press_key → " " (space)
browser_snapshot → verify pause state
browser_press_key → " " (space)
browser_snapshot → verify resumed
```

---

## Verification Plan

| Phase | Automated | Playwright MCP |
|-------|-----------|---------------|
| 0 | `npm run build` | Navigate, verify "MavDeck" text |
| 1A | `npx vitest run src/mavlink/__tests__/crc.test.ts src/mavlink/__tests__/frame-parser.test.ts` | N/A |
| 1B | `npx vitest run src/mavlink/` — all pass | N/A |
| 2 | `npx vitest run` — all pass | N/A (worker tested in Phase 3+) |
| 3 | `npm run build` | Navigate, verify toolbar/tabs, connect spoof, toggle theme |
| 4 | Build passes | Connect spoof, verify messages in sidebar with Hz, expand fields |
| 5 | Build passes | Connect, click field, verify plot renders with live trace |
| 6 | Build passes | Drag/resize plot, reload, verify layout persists |
| 7 | Build passes | Connect, switch to Map tab, verify map renders with marker |
| 8 | Build passes | Verify serial settings UI renders (can't test real serial in CI) |
| 9 | Build passes | Verify settings persist across reload |
| 10 | Build passes | Screenshot dark/light mode, verify keyboard shortcuts |

### End-to-End Smoke Test (Playwright MCP)

```
1. browser_navigate → http://localhost:5173
2. browser_snapshot → verify app loaded (toolbar, tabs visible)
3. browser_console_messages(level="error") → empty
4. browser_click → "Connect Spoof"
5. browser_wait_for → text="HEARTBEAT"
6. browser_snapshot → messages streaming in sidebar with Hz badges
7. browser_click → expand ATTITUDE
8. browser_snapshot → roll, pitch, yaw fields visible with numeric values
9. browser_click → "roll" field to add to plot
10. browser_wait_for → time=2
11. browser_take_screenshot → plot panel visible with live trace
12. browser_click → "Map" tab
13. browser_wait_for → time=2
14. browser_take_screenshot → map with vehicle marker visible
15. browser_click → "Telemetry" tab
16. browser_click → theme toggle
17. browser_take_screenshot → light mode applied
18. browser_click → theme toggle (back to dark)
19. browser_evaluate → "location.reload()"
20. browser_wait_for → time=3
21. browser_snapshot → layout and settings preserved after reload
```
