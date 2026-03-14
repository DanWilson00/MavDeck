# MavDeck

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/DanWilson00/MavDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/DanWilson00/MavDeck/actions/workflows/ci.yml)

A fast, web-based MAVLink telemetry viewer. No install, no MAVLink dependencies — just load your dialect XML and start plotting.

**[Open MavDeck](https://mavdeck.netlify.app)**

## Why MavDeck?

- **Web-based and snappy** — opens instantly in any browser, no downloads
- **Works offline** — full PWA that persists across browser close, no internet needed after first load
- **No MAVLink dependencies** — drop in any MAVLink XML dialect file and it just works, no recompile
- **Easy plotting** — drag-and-drop grid of time-series plots, pick any message field, synchronized zoom

## Features

- Live map with flight path tracking
- Message monitor with real-time frequency tracking
- Status text display
- Dark and light mode
- Auto-connect for previously granted serial devices, with optional auto-baud detection
- Logs autosave to the browser (crash-resistant) and can be replayed later
- In-browser log library for replaying previously saved sessions
- Unit profiles — switch between raw, metric, imperial, and aviation units globally

### Unit Profiles

All telemetry values can be displayed in your preferred unit system. Choose a profile in Settings:

| Profile | Altitude | Speed | Distance | Temperature |
|---------|----------|-------|----------|-------------|
| **Raw** | as received | as received | as received | as received |
| **Metric** | meters | m/s | meters | °C |
| **Imperial** | feet | ft/s | feet | °F |
| **Aviation** | feet | knots | nautical miles | °C |

Angles and coordinates are automatically converted to degrees in all profiles. Changing the profile instantly updates every plot axis, value display, and label across the app — no restart needed.

## Browser Support

**Web Serial** (live telemetry from a serial device) requires a Chromium-based browser (Chrome, Edge) and previously granted serial access. Everything else — replaying logs already saved by MavDeck, plotting, map, offline mode — works in any modern browser including Firefox and Safari.

## Quick Start

Just visit **[mavdeck.netlify.app](https://mavdeck.netlify.app)** — no setup required.

To run locally:

```bash
git clone https://github.com/DanWilson00/MavDeck.git
cd MavDeck
npm install
npm run dev
```

Then open http://localhost:5173.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Support

If MavDeck saves you time, helps you debug a weird flight log, or just spares you from opening a heavier ground station, consider helping to keep the LLM token supply topped off.

## License

[MIT](LICENSE)

---

Built with assistance from [Claude Code](https://claude.ai/code).
