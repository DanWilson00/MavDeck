# Phase 7: Map View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Leaflet + OpenStreetMap map view that shows vehicle position, heading, trail, and coordinates from GLOBAL_POSITION_INT telemetry.

**Architecture:** Single `MapView.tsx` component creates a Leaflet map in `onMount`, subscribes to `workerBridge.onUpdate()` for GPS data, and updates a rotatable DivIcon marker + polyline trail in a 60Hz RAF loop. Auto-center toggle keeps the vehicle in view. Wired into App.tsx replacing the Phase 7 placeholder.

**Tech Stack:** Leaflet (already installed), @types/leaflet (already installed), CSS DivIcon with SVG for rotatable heading indicator.

---

## Task 1: Create MapView Component with Leaflet Map

Create the base component that initializes a Leaflet map with OSM tiles and proper cleanup.

**Files:**
- Create: `src/components/MapView.tsx`
- Modify: `src/App.tsx` (replace placeholder)

**Step 1: Create MapView.tsx**

```tsx
// src/components/MapView.tsx
import { onMount, onCleanup, createSignal } from 'solid-js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { appState, workerBridge } from '../store/app-store';

// Initial position: Los Angeles (spoof start)
const INITIAL_LAT = 34.0522;
const INITIAL_LON = -118.2437;
const INITIAL_ZOOM = 15;
const MAX_TRAIL_POINTS = 200;

// SVG arrow icon for vehicle marker — rotated by CSS transform
function createVehicleIcon(heading: number): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html: `<div style="transform: rotate(${heading}deg); width: 24px; height: 24px;">
      <svg viewBox="0 0 24 24" width="24" height="24">
        <polygon points="12,2 4,20 12,16 20,20" fill="#00d4ff" stroke="#000" stroke-width="1"/>
      </svg>
    </div>`,
  });
}

export default function MapView() {
  let containerRef: HTMLDivElement | undefined;
  let map: L.Map | undefined;
  let marker: L.Marker | undefined;
  let trail: L.Polyline | undefined;
  let trailPoints: L.LatLng[] = [];
  let rafId: number | undefined;
  let unsubUpdate: (() => void) | undefined;

  const [autoCenter, setAutoCenter] = createSignal(true);
  const [coords, setCoords] = createSignal({
    lat: INITIAL_LAT,
    lon: INITIAL_LON,
    alt: 0,
    hdg: 0,
  });

  // Latest values from worker (written in callback, read in RAF)
  let latestLat = INITIAL_LAT;
  let latestLon = INITIAL_LON;
  let latestAlt = 0;
  let latestHdg = 0;
  let hasNewData = false;

  onMount(() => {
    if (!containerRef) return;

    // Create Leaflet map
    map = L.map(containerRef, {
      center: [INITIAL_LAT, INITIAL_LON],
      zoom: INITIAL_ZOOM,
      zoomControl: true,
    });

    // OSM tile layer
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    // Vehicle marker
    marker = L.marker([INITIAL_LAT, INITIAL_LON], {
      icon: createVehicleIcon(0),
    }).addTo(map);

    // Trail polyline
    trail = L.polyline([], {
      color: '#00d4ff',
      weight: 2,
      opacity: 0.7,
    }).addTo(map);

    // Subscribe to worker updates
    if (appState.isReady) {
      subscribeToUpdates();
    }

    // RAF loop to apply updates
    function tick() {
      if (hasNewData && map && marker) {
        hasNewData = false;
        const latlng = L.latLng(latestLat, latestLon);

        // Update marker position and heading icon
        marker.setLatLng(latlng);
        marker.setIcon(createVehicleIcon(latestHdg));

        // Update trail
        trailPoints.push(latlng);
        if (trailPoints.length > MAX_TRAIL_POINTS) {
          trailPoints = trailPoints.slice(-MAX_TRAIL_POINTS);
        }
        trail?.setLatLngs(trailPoints);

        // Auto-center map
        if (autoCenter()) {
          map.panTo(latlng, { animate: false });
        }

        // Update coordinate display signal
        setCoords({
          lat: latestLat,
          lon: latestLon,
          alt: latestAlt,
          hdg: latestHdg,
        });
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    // Disable auto-center when user drags the map
    map.on('dragstart', () => setAutoCenter(false));
  });

  function subscribeToUpdates() {
    unsubUpdate = workerBridge.onUpdate(buffers => {
      const latBuf = buffers.get('GLOBAL_POSITION_INT.lat');
      const lonBuf = buffers.get('GLOBAL_POSITION_INT.lon');
      const altBuf = buffers.get('GLOBAL_POSITION_INT.alt');
      const hdgBuf = buffers.get('GLOBAL_POSITION_INT.hdg');

      if (latBuf && latBuf.values.length > 0) {
        // lat/lon are degE7 — divide by 1e7
        latestLat = latBuf.values[latBuf.values.length - 1] / 1e7;
      }
      if (lonBuf && lonBuf.values.length > 0) {
        latestLon = lonBuf.values[lonBuf.values.length - 1] / 1e7;
      }
      if (altBuf && altBuf.values.length > 0) {
        // alt is mm — divide by 1000
        latestAlt = altBuf.values[altBuf.values.length - 1] / 1000;
      }
      if (hdgBuf && hdgBuf.values.length > 0) {
        // hdg is cdeg — divide by 100
        latestHdg = hdgBuf.values[hdgBuf.values.length - 1] / 100;
      }
      hasNewData = true;
    });
  }

  onCleanup(() => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    unsubUpdate?.();
    map?.remove();
  });

  return (
    <div class="relative h-full w-full">
      {/* Map container */}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Coordinate overlay */}
      <div
        class="absolute top-2 right-2 z-[1000] rounded px-3 py-2 text-xs font-mono"
        style={{
          'background-color': 'rgba(0, 0, 0, 0.75)',
          color: '#e4e4e7',
          'pointer-events': 'none',
        }}
      >
        <div>Lat: {coords().lat.toFixed(6)}</div>
        <div>Lon: {coords().lon.toFixed(6)}</div>
        <div>Alt: {coords().alt.toFixed(1)} m</div>
        <div>Hdg: {coords().hdg.toFixed(1)}&deg;</div>
      </div>

      {/* Auto-center toggle */}
      <button
        class="absolute bottom-4 right-2 z-[1000] rounded px-3 py-1.5 text-xs font-medium transition-colors"
        style={{
          'background-color': autoCenter() ? 'var(--accent)' : 'var(--bg-panel)',
          color: autoCenter() ? '#000' : 'var(--text-primary)',
          border: '1px solid var(--border)',
        }}
        onClick={() => {
          setAutoCenter(!autoCenter());
          if (!autoCenter() && map) {
            // When re-enabling, immediately center
          } else if (autoCenter() && map) {
            map.panTo([latestLat, latestLon], { animate: true });
          }
        }}
      >
        {autoCenter() ? 'Auto-Center: ON' : 'Auto-Center: OFF'}
      </button>
    </div>
  );
}
```

**Key design notes:**

- **DivIcon with CSS rotation**: No Leaflet rotation plugin needed. The SVG arrow polygon is wrapped in a div with `transform: rotate(Xdeg)`. Creates a new icon on each heading update — cheap for one marker.
- **degE7 / cdeg / mm conversions**: GLOBAL_POSITION_INT stores lat/lon as `int32 * 1e7`, hdg as `uint16 * 100`, alt as `int32 mm`. Divide in the callback.
- **RAF loop pattern**: Same as PlotChart — worker callback writes latest values, RAF reads them. No reactive signals in the hot path.
- **Trail management**: Plain array of `L.LatLng`, capped at 200. `polyline.setLatLngs()` updates efficiently.
- **Auto-center**: Defaults to ON. User dragging the map disables it. Button re-enables with immediate pan.

**Step 2: Wire into App.tsx**

Replace the Phase 7 placeholder (lines 60-63) in `src/App.tsx`:

```tsx
import MapView from './components/MapView';

// Replace:
<Show when={appState.activeTab === 'map'}>
  <div class="flex items-center justify-center h-full" style={{ color: 'var(--text-secondary)' }}>
    Map view — Phase 7
  </div>
</Show>

// With:
<Show when={appState.activeTab === 'map'}>
  <MapView />
</Show>
```

**Step 3: Handle late worker readiness**

The `onMount` only subscribes if `appState.isReady` is already true. But if the map tab is shown before the worker is ready (unlikely but possible), we need a `createEffect` to subscribe once ready:

Add inside `MapView()`, after the `onMount`:

```tsx
import { createEffect } from 'solid-js'; // add to imports

createEffect(() => {
  if (appState.isReady && !unsubUpdate) {
    subscribeToUpdates();
  }
});
```

**Step 4: Fix Leaflet default icon paths**

Leaflet's default marker icon paths break with bundlers. Since we use a custom DivIcon for the vehicle marker, this isn't an issue for us. But to be safe, add this after the Leaflet import in MapView.tsx to suppress any warnings:

```tsx
// Fix Leaflet default icon path issue with bundlers
// (We use custom DivIcon, but this prevents warnings if default markers are ever used)
delete (L.Icon.Default.prototype as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});
```

Actually — skip this. We only use DivIcon. YAGNI.

**Step 5: Verify build**

Run: `npm run build`
Expected: No type errors.

**Step 6: Verify tests**

Run: `npx vitest run`
Expected: All 132 tests pass. No regressions.

**Step 7: Commit**

```
Phase 7: Add MapView with Leaflet, vehicle marker, trail, and auto-center
```

---

## Task 2: Playwright Visual Verification

Verify all acceptance criteria using the Playwright MCP tools against the running dev server.

**Files:** None (verification only)

**Step 1: Start dev server**

Run: `npm run dev` (background)

**Step 2: Navigate and connect**

```
browser_navigate → http://localhost:5173
browser_click → "Connect Spoof"
browser_wait_for → time=3
```

**Step 3: Switch to Map tab**

```
browser_click → "Map" tab
browser_wait_for → time=2
```

**Step 4: Verify map container exists**

```
browser_snapshot → verify Leaflet map container (.leaflet-container) exists
```

**Step 5: Verify map tiles and marker**

```
browser_take_screenshot → verify OSM tiles loaded, vehicle marker visible
```

**Step 6: Wait for movement and verify trail**

```
browser_wait_for → time=5
browser_take_screenshot → verify trail line is visible behind marker
```

**Step 7: Verify coordinate overlay**

```
browser_snapshot → verify coordinate display shows lat, lon, alt, hdg values
```

**Step 8: Verify auto-center toggle**

```
browser_snapshot → find auto-center button, verify it shows "ON"
browser_click → auto-center button
browser_snapshot → verify it shows "OFF"
browser_click → auto-center button again
browser_snapshot → verify it shows "ON"
```

**Step 9: Check console for errors**

```
browser_console_messages(level="error") → no JS errors (except favicon 404)
```

**Acceptance criteria checklist:**

| Criterion | Verification method |
|-----------|-------------------|
| Map renders with OSM tiles | Screenshot shows map tiles |
| Vehicle marker appears at correct position | Marker visible near LA |
| Marker moves as new GPS data arrives | Second screenshot shows different position |
| Trail line draws behind vehicle | Trail line visible in screenshot |
| Auto-center keeps vehicle in view | Marker stays centered (default ON) |
| Heading indicator rotates correctly | SVG arrow points in heading direction |
| Coordinate overlay shows values | Snapshot shows lat/lon/alt/hdg text |

**Step 10: Commit any fixes**

If visual verification reveals issues, fix and commit:
```
Phase 7: Fix [issue] found during verification
```

---

## Notes

- **No unit tests for MapView**: This is a DOM-heavy Leaflet integration. Vitest with happy-dom can't render Leaflet maps. All verification is via Playwright MCP.
- **Leaflet CSS**: Must import `leaflet/dist/leaflet.css` or the map won't render correctly (tiles misaligned, controls broken).
- **z-index for overlays**: Leaflet uses z-index internally. Our overlay and button use `z-[1000]` to sit above map layers.
- **Memory**: Trail is capped at 200 points. Marker icon is recreated on heading change (one small div — negligible). RAF loop is cancelled in `onCleanup`.
- **Offline behavior**: OSM tiles require network. If offline, the map shows grey tiles but the marker/trail/overlay still work with cached tile data if available through the PWA service worker.
