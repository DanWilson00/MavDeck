# MavDeck

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/DanWilson00/MavDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/DanWilson00/MavDeck/actions/workflows/ci.yml)

**A fast, web-based MAVLink telemetry viewer. No install, no MAVLink dependencies — just load your dialect XML and start plotting.**

**[Try it live at deck.netlify.app](https://deck.netlify.app)**

<!-- screenshot placeholder -->

## Why MavDeck?

- **Web-based and snappy** — opens instantly in any browser, no downloads
- **Works offline** — full PWA that persists across browser close, no internet needed after first load
- **No MAVLink dependencies** — drop in any MAVLink XML dialect file and it just works, no recompile
- **Easy plotting** — drag-and-drop grid of time-series plots, pick any message field, synchronized zoom

## More Features

- **Live map** — real-time vehicle position on OpenStreetMap with flight path trace
- **Message monitor** — full message list with live frequency tracking
- **Status text display** — see STATUSTEXT messages as they arrive
- **Dark/light mode** — switch themes to suit your environment
- **Crash-resistant logs** — sessions autosave to browser storage and can be reloaded later

## Browser Support

MavDeck works in any modern browser. **Web Serial** (connecting to a flight controller over USB) requires a Chromium-based browser (Chrome or Edge). All other features — tlog playback, plotting, map, message monitor — work everywhere.

## Quick Start

Just visit **[deck.netlify.app](https://deck.netlify.app)** — no setup needed.

To run locally:

```bash
git clone https://github.com/DanWilson00/MavDeck.git
cd MavDeck
npm install
npm run dev
```

Then open http://localhost:5173.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)

---

Built with assistance from [Claude Code](https://claude.ai/code).
