# Contributing to MavDeck

Thanks for your interest in contributing! This guide covers what you need to get started.

## Prerequisites

- **Node.js** v20+ (LTS)
- **npm** v10+
- **Browser**: Chrome or Edge for Web Serial testing; any modern browser for everything else

## Development Setup

```bash
git clone https://github.com/DanWilson00/MavDeck.git
cd MavDeck
npm install
npm run dev
```

The dev server runs at http://localhost:5173 with hot module replacement.

## Coding Conventions

### Naming

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

### Key Rules

- TypeScript strict mode — no `any` unless unavoidable (and documented)
- No hardcoded MAVLink message IDs or field offsets — everything comes from the dialect registry
- Clean up subscriptions, timers, and observers in `onCleanup`
- Pre-allocate buffers; avoid object creation in hot paths

## Testing

All tests must pass before submitting a PR:

```bash
npm run verify    # typecheck + build + test (runs all three)
```

You can also run them individually:

```bash
npm run typecheck   # TypeScript type checking
npm run build       # Production build
npm run test        # Vitest unit and integration tests
```

## Pull Request Checklist

- [ ] `npm run verify` passes (typecheck + build + tests)
- [ ] New code follows the naming conventions above
- [ ] No `any` types without justification
- [ ] New features include tests where applicable
- [ ] Commit messages are clear and descriptive
