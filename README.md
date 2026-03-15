# MavDeck

A fast, web-based MAVLink telemetry viewer. No install, no MAVLink dependencies — just load your dialect XML and start plotting.

**[Try it live](https://mavdeck.netlify.app)**

## Demo

<video src="demo.mp4" controls width="100%"></video>

## Features

- **Real-time telemetry** — Connect via Web Serial or replay `.tlog` files
- **Dynamic MAVLink parsing** — Driven by XML dialect definitions, no hardcoded message types
- **Drag-and-drop dashboards** — Gridstack-powered layout with time-series plots and map view
- **Offline-capable PWA** — Install it, use it anywhere
- **Session recording** — Automatic `.tlog` capture with crash recovery
- **Light & dark mode**

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in Chrome or Edge (Web Serial requires Chromium).

## Tech Stack

SolidJS, TypeScript, Vite, Tailwind CSS, uPlot, Leaflet, gridstack.js

## License

MIT
