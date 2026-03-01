# Phase 4: Message Monitor Sidebar — Design

## Goal

Build a left sidebar showing all received MAVLink messages with live stats, expandable field details with enum resolution, and a collapsible STATUSTEXT log panel.

## Architecture

The telemetry tab's `<main>` area becomes a flex row:
- **Left**: `MessageMonitor` (~350px sidebar, border-right) containing message cards + StatusTextLog
- **Right**: plot area (flex-1, placeholder for Phase 5)

## Data Flow

```
Worker: MavlinkService.onMessage → GenericMessageTracker → onStats → postMessage('stats')
        MavlinkService.onMessage → if STATUSTEXT → postMessage('statustext')
                                          ↓
Main:   workerBridge.onStats → MessageMonitor signal
        workerBridge.onStatusText → StatusTextLog signal (accumulate ≤100 entries)
```

## Worker Protocol Addition

New message type from worker:
```typescript
{ type: 'statustext', severity: number, text: string, timestamp: number }
```

New bridge subscription:
```typescript
type StatusTextEntry = { severity: number; text: string; timestamp: number };
type StatusTextCallback = (entry: StatusTextEntry) => void;
onStatusText(cb: StatusTextCallback): () => void
```

This fires every time a STATUSTEXT message is decoded, giving reliable ordered delivery.

## Components

### MessageMonitor.tsx

- Header: "Messages" + count badge
- Scrollable list of message cards sorted alphabetically
- Collapsed card: message name (monospace) + frequency badge ("10.0 Hz", green)
- Expanded card: field name, formatted value, units, enum names via registry
- Numeric fields clickable → `onFieldSelected(msgName, fieldName)` callback prop (Phase 5)
- Subscribes to `workerBridge.onStats()` gated by `appState.isReady`

### StatusTextLog.tsx

- Collapsible panel at bottom of MessageMonitor
- Collapsed ~36px, expanded ~180px
- Header: "Status" + count badge
- Severity colors: 0-2 red, 3 orange, 4 amber, 5 cyan, 6 blue-gray, 7 gray
- Format: `[HH:MM:SS] [SEVERITY] message text`
- Auto-scroll to newest, max 100 entries
- Subscribes to `workerBridge.onStatusText()`

## Key Decisions

1. **Dedicated worker callback for STATUSTEXT** — Stats only expose the latest message per type. A dedicated `onStatusText` callback fires on every decoded STATUSTEXT, giving reliable history accumulation.
2. **Subscribe to `workerBridge.onStats()`** — PLAN.md references `connectionManager.tracker.onStats()` but ConnectionManager has no tracker property. The real API is `workerBridge.onStats()`.
3. **Registry for enum resolution** — `registry.resolveEnumValue(field.enumType, value)` for fields with enum types; fall back to raw numeric display if resolution fails.
