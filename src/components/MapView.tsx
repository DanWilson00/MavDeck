import { onMount, onCleanup, createSignal, createEffect } from 'solid-js';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { appState, setAppState, workerBridge } from '../store/app-store';

const INITIAL_LAT = 34.0522;
const INITIAL_LON = -118.2437;

const TILE_LAYERS = {
  street: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  },
} as const;

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

function trailColor(): string {
  return appState.mapLayer === 'satellite' ? '#00ff88' : cssVar('--accent', '#00d4ff');
}

export default function MapView() {
  let containerRef: HTMLDivElement | undefined;
  let map: L.Map | undefined;
  let marker: L.Marker | undefined;
  let trail: L.Polyline | undefined;
  let tileLayer: L.TileLayer | undefined;
  let trailPoints: L.LatLng[] = [];
  let rafId: number | undefined;
  let unsubUpdate: (() => void) | undefined;

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
      zoom: appState.mapZoom,
      zoomControl: true,
    });

    map.on('zoomend', () => {
      const z = map!.getZoom();
      if (z !== appState.mapZoom) setAppState('mapZoom', z);
    });

    const layerConfig = TILE_LAYERS[appState.mapLayer];
    tileLayer = L.tileLayer(layerConfig.url, {
      attribution: layerConfig.attribution,
      maxZoom: layerConfig.maxZoom,
    }).addTo(map);

    marker = L.marker([INITIAL_LAT, INITIAL_LON], {
      icon: createVehicleIcon(0),
    }).addTo(map);

    trail = L.polyline([], {
      color: trailColor(),
      weight: 2,
      opacity: 0.7,
    });

    if (appState.mapShowPath) {
      trail.addTo(map);
    }

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
        if (trailPoints.length > appState.mapTrailLength) {
          trailPoints = trailPoints.slice(-appState.mapTrailLength);
        }
        trail?.setLatLngs(trailPoints);

        if (appState.mapAutoCenter) {
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

    map.on('dragstart', () => setAppState('mapAutoCenter', false));
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
    trail?.setStyle({ color: trailColor() });
  });

  // Toggle trail visibility
  createEffect(() => {
    if (!map || !trail) return;
    if (appState.mapShowPath) {
      if (!map.hasLayer(trail)) trail.addTo(map);
    } else {
      if (map.hasLayer(trail)) trail.remove();
    }
  });

  // Switch tile layer
  createEffect(() => {
    if (!map) return;
    const layerConfig = TILE_LAYERS[appState.mapLayer];
    if (tileLayer) tileLayer.remove();
    tileLayer = L.tileLayer(layerConfig.url, {
      attribution: layerConfig.attribution,
      maxZoom: layerConfig.maxZoom,
    }).addTo(map);
    // Update trail color for visibility on new background
    trail?.setStyle({ color: trailColor() });
  });

  // Trim trail when length setting decreases
  createEffect(() => {
    const maxLen = appState.mapTrailLength;
    if (trailPoints.length > maxLen) {
      trailPoints = trailPoints.slice(-maxLen);
      trail?.setLatLngs(trailPoints);
    }
  });

  onCleanup(() => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    unsubUpdate?.();
    map?.remove();
  });

  return (
    <div class="relative h-full w-full">
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Top-right overlay: telemetry + controls */}
      <div class="absolute top-2 right-2 z-[1000] flex flex-col items-end gap-1.5">
        {/* Coordinate readout */}
        <div
          class="rounded px-3 py-2 text-xs font-mono"
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

        {/* Map control buttons */}
        <div class="flex gap-1.5">
          <button
            class="p-1.5 rounded interactive-hover"
            style={{
              'background-color': 'var(--bg-panel)',
              border: '1px solid var(--border)',
              color: appState.mapLayer === 'satellite' ? 'var(--accent)' : 'var(--text-secondary)',
            }}
            onClick={() => setAppState('mapLayer', appState.mapLayer === 'street' ? 'satellite' : 'street')}
            title={appState.mapLayer === 'street' ? 'Switch to satellite' : 'Switch to street map'}
          >
            <LayerIcon />
          </button>
          <button
            class="p-1.5 rounded interactive-hover"
            style={{
              'background-color': 'var(--bg-panel)',
              border: '1px solid var(--border)',
              color: appState.mapShowPath ? 'var(--accent)' : 'var(--text-secondary)',
            }}
            onClick={() => setAppState('mapShowPath', !appState.mapShowPath)}
            title={appState.mapShowPath ? 'Hide flight path' : 'Show flight path'}
          >
            <PathIcon />
          </button>
          <button
            class="p-1.5 rounded interactive-hover"
            style={{
              'background-color': 'var(--bg-panel)',
              border: '1px solid var(--border)',
              color: appState.mapAutoCenter ? 'var(--accent)' : 'var(--text-secondary)',
            }}
            onClick={() => {
              const newState = !appState.mapAutoCenter;
              setAppState('mapAutoCenter', newState);
              if (newState && map) {
                map.panTo([latestLat, latestLon], { animate: true });
              }
            }}
            title={appState.mapAutoCenter ? 'Auto-center: ON' : 'Auto-center: OFF'}
          >
            <CrosshairIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

function CrosshairIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="8" />
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
    </svg>
  );
}

function PathIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 17l4-4 4 4 4-8 6 6" />
    </svg>
  );
}

function LayerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}
