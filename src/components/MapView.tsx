import { onMount, onCleanup, createSignal, createEffect } from 'solid-js';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { appState, workerBridge } from '../store/app-store';

const INITIAL_LAT = 34.0522;
const INITIAL_LON = -118.2437;
const INITIAL_ZOOM = 15;
const MAX_TRAIL_POINTS = 200;

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function createVehicleIcon(heading: number): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html: `<div style="transform: rotate(${heading}deg); width: 24px; height: 24px;">
      <svg viewBox="0 0 24 24" width="24" height="24">
        <polygon points="12,2 4,20 12,16 20,20" fill="${cssVar('--accent', '#00d4ff')}" stroke="${cssVar('--map-marker-stroke', '#000')}" stroke-width="1"/>
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

  let latestLat = INITIAL_LAT;
  let latestLon = INITIAL_LON;
  let latestAlt = 0;
  let latestHdg = 0;
  let prevHdg = -1;
  let hasNewData = false;

  function subscribeToUpdates() {
    unsubUpdate = workerBridge.onUpdate(buffers => {
      const latBuf = buffers.get('GLOBAL_POSITION_INT.lat');
      const lonBuf = buffers.get('GLOBAL_POSITION_INT.lon');
      const altBuf = buffers.get('GLOBAL_POSITION_INT.alt');
      const hdgBuf = buffers.get('GLOBAL_POSITION_INT.hdg');

      if (latBuf && latBuf.values.length > 0) {
        latestLat = latBuf.values[latBuf.values.length - 1] / 1e7;
      }
      if (lonBuf && lonBuf.values.length > 0) {
        latestLon = lonBuf.values[lonBuf.values.length - 1] / 1e7;
      }
      if (altBuf && altBuf.values.length > 0) {
        latestAlt = altBuf.values[altBuf.values.length - 1] / 1000;
      }
      if (hdgBuf && hdgBuf.values.length > 0) {
        latestHdg = hdgBuf.values[hdgBuf.values.length - 1] / 100;
      }
      hasNewData = true;
    });
  }

  onMount(() => {
    if (!containerRef) return;

    map = L.map(containerRef, {
      center: [INITIAL_LAT, INITIAL_LON],
      zoom: INITIAL_ZOOM,
      zoomControl: true,
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    marker = L.marker([INITIAL_LAT, INITIAL_LON], {
      icon: createVehicleIcon(0),
    }).addTo(map);

    trail = L.polyline([], {
      color: cssVar('--accent', '#00d4ff'),
      weight: 2,
      opacity: 0.7,
    }).addTo(map);

    if (appState.isReady) {
      subscribeToUpdates();
    }

    function tick() {
      if (hasNewData && map && marker) {
        hasNewData = false;
        const latlng = L.latLng(latestLat, latestLon);

        marker.setLatLng(latlng);
        if (Math.abs(latestHdg - prevHdg) > 0.5) {
          marker.setIcon(createVehicleIcon(latestHdg));
          prevHdg = latestHdg;
        }

        trailPoints.push(latlng);
        if (trailPoints.length > MAX_TRAIL_POINTS) {
          trailPoints.shift();
        }
        trail?.setLatLngs(trailPoints);

        if (autoCenter()) {
          map.panTo(latlng, { animate: false });
        }

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

    map.on('dragstart', () => setAutoCenter(false));
  });

  // Subscribe once worker is ready (if not already)
  createEffect(() => {
    if (appState.isReady && !unsubUpdate) {
      subscribeToUpdates();
      onCleanup(() => {
        unsubUpdate?.();
        unsubUpdate = undefined;
      });
    }
  });

  // Keep map visuals synchronized with current theme tokens.
  createEffect(() => {
    appState.theme;
    marker?.setIcon(createVehicleIcon(latestHdg));
    trail?.setStyle({ color: cssVar('--accent', '#00d4ff') });
  });

  onCleanup(() => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    unsubUpdate?.();
    map?.remove();
  });

  return (
    <div class="relative h-full w-full">
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Coordinate overlay */}
      <div
        class="absolute top-2 right-2 z-[1000] rounded px-3 py-2 text-xs font-mono"
        style={{
          'background-color': 'var(--map-overlay-bg)',
          color: 'var(--map-overlay-text)',
          'pointer-events': 'none',
          border: '1px solid var(--map-overlay-border)',
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
          const newState = !autoCenter();
          setAutoCenter(newState);
          if (newState && map) {
            map.panTo([latestLat, latestLon], { animate: true });
          }
        }}
      >
        {autoCenter() ? 'Auto-Center: ON' : 'Auto-Center: OFF'}
      </button>
    </div>
  );
}
