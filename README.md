# MavDeck

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/DanWilson00/MavDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/DanWilson00/MavDeck/actions/workflows/ci.yml)

A fast, web-based MAVLink telemetry viewer. No install, no MAVLink dependencies — just load your dialect XML and start plotting.

**[Open MavDeck](https://mavdeck.netlify.app)**

## Demo

<video src="https://github.com/DanWilson00/MavDeck/raw/main/demo.mp4" controls width="100%"></video>

## Why MavDeck?

- **Web-based** — opens instantly in any browser with no installation required
- **Offline-capable** — full PWA that persists across sessions without an internet connection
- **Dialect-driven** — load any MAVLink XML dialect file with no recompilation
- **Flexible plotting** — drag-and-drop grid of time-series plots with synchronized zoom across any message field

## Features

- Live map with flight path tracking
- Message monitor with real-time frequency tracking
- Status text display
- Dark and light mode
- Auto-connect with optional auto-baud detection
- Crash-resistant log autosave with in-browser replay
- Unit profiles — raw, metric, imperial, and aviation

## Browser Support

Web Serial (live telemetry) requires Chrome or Edge. Everything else works in any modern browser including Firefox and Safari.

## Quick Start

Visit **[mavdeck.netlify.app](https://mavdeck.netlify.app)** — no setup required.

To run locally:

```bash
git clone https://github.com/DanWilson00/MavDeck.git
cd MavDeck
npm install
npm run dev
```

Then open http://localhost:5173.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Support

If MavDeck has been useful to you, consider supporting continued development.

[GitHub Sponsors](https://github.com/sponsors/DanWilson00) | [Buy Me a Coffee](https://buymeacoffee.com/danwilson0x)

## License

[MIT](LICENSE)

---

Built with assistance from [Claude Code](https://claude.ai/code).
