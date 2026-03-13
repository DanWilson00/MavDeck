# Contributing to MavDeck

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- **Node.js** v20+ (LTS)
- **npm** v10+
- **Browser**: Chrome or Edge for Web Serial testing; any modern browser for everything else

## Dev Setup

```bash
git clone https://github.com/DanWilson00/MavDeck.git
cd MavDeck
npm install
npm run dev
```

The dev server starts at http://localhost:5173 with hot module replacement.

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
- Pre-allocate buffers in hot paths, avoid GC pressure
- Never destructure SolidJS props (kills reactivity)
- Clean up subscriptions and timers in `onCleanup`

## Testing

All tests must pass before submitting a PR:

```bash
npm run verify    # Runs typecheck + build + tests
```

Or individually:

```bash
npm run typecheck        # TypeScript type checking
npm run build            # Production build
npm run test             # Vitest unit/integration tests
```

## PR Checklist

Before submitting a pull request:

- [ ] `npm run verify` passes (typecheck + build + tests)
- [ ] No previously passing tests are broken
- [ ] New logic has corresponding tests
- [ ] Code follows the naming conventions above
- [ ] Commit messages are clear and descriptive

## Questions?

Open an issue on GitHub — happy to help!
