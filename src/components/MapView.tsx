import { onMount, onCleanup, createSignal, createEffect, Show } from 'solid-js';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { convertDisplayValue, formatDisplayValue, getDisplayUnit, useWorkerBridge } from '../services';
import type { MapLayerType } from '../services';
import { appState, setAppState } from '../store';

const TILE_LAYERS = {
  street: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 20,
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  },
  hybrid: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
    labelOverlay: {
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
      maxZoom: 20,
    },
  },
} as const;

const LAYER_ORDER: MapLayerType[] = ['street', 'satellite', 'hybrid'];
const LAYER_LABELS: Record<MapLayerType, string> = {
  street: 'Street',
  satellite: 'Satellite',
  hybrid: 'Hybrid',
};

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
  const layer = appState.mapLayer;
  return (layer === 'satellite' || layer === 'hybrid') ? '#00ff88' : cssVar('--accent', '#00d4ff');
}

export default function MapView() {
  const workerBridge = useWorkerBridge();
  let containerRef: HTMLDivElement | undefined;
  let map: L.Map | undefined;
  let marker: L.Marker | undefined;
  let trail: L.Polyline | undefined;
  let tileLayer: L.TileLayer | undefined;
  let overlayLayer: L.TileLayer | undefined;
  let trailPoints: L.LatLng[] = [];
  let rafId: number | undefined;
  let unsubUpdate: (() => void) | undefined;
  let startMarker: L.CircleMarker | undefined;
  let endMarker: L.CircleMarker | undefined;
  let latestBuffers: Map<string, { timestamps: Float64Array; values: Float64Array }> | undefined;
  let savedAutoCenter: boolean | undefined;

  const [coords, setCoords] = createSignal({
    lat: appState.mapCenterLat,
    lon: appState.mapCenterLon,
    alt: 0,
    hdg: 0,
  });
  const [hasMapData, setHasMapData] = createSignal(false);

  let latestLat = appState.mapCenterLat;
  let latestLon = appState.mapCenterLon;
  let latestAlt = 0;
  let latestHdg = 0;
  let latestLatRaw = appState.mapCenterLat * 1e7;
  let latestLonRaw = appState.mapCenterLon * 1e7;
  let latestAltRaw = 0;
  let latestHdgRaw = 0;
  let prevHdg = -1;
  let hasNewData = false;

  function subscribeToUpdates() {
    unsubUpdate = workerBridge.onUpdate(buffers => {
      latestBuffers = buffers;

      const latBuf = buffers.get('GLOBAL_POSITION_INT.lat');
      const lonBuf = buffers.get('GLOBAL_POSITION_INT.lon');
      const altBuf = buffers.get('GLOBAL_POSITION_INT.alt');
      const hdgBuf = buffers.get('GLOBAL_POSITION_INT.hdg');

      if (latBuf && latBuf.values.length > 0) {
        latestLatRaw = latBuf.values[latBuf.values.length - 1];
        latestLat = latestLatRaw / 1e7;
        setHasMapData(true);
      }
      if (lonBuf && lonBuf.values.length > 0) {
        latestLonRaw = lonBuf.values[lonBuf.values.length - 1];
        latestLon = latestLonRaw / 1e7;
        setHasMapData(true);
      }
      if (altBuf && altBuf.values.length > 0) {
        latestAltRaw = altBuf.values[altBuf.values.length - 1];
        latestAlt = latestAltRaw / 1000;
      }
      if (hdgBuf && hdgBuf.values.length > 0) {
        latestHdgRaw = hdgBuf.values[hdgBuf.values.length - 1];
        latestHdg = latestHdgRaw / 100;
      }
      hasNewData = true;

      // When a log is loaded, the worker sends all buffer data at once.
      // Show the full flight path as soon as the data arrives.
      if (appState.logViewerState.isActive) {
        showFullFlightPath();
      }
    });
  }

  function showFullFlightPath() {
    if (!map || !trail || !latestBuffers) return;

    const latBuf = latestBuffers.get('GLOBAL_POSITION_INT.lat');
    const lonBuf = latestBuffers.get('GLOBAL_POSITION_INT.lon');
    if (!latBuf || !lonBuf || latBuf.values.length === 0 || lonBuf.values.length === 0) return;

    const len = Math.min(latBuf.values.length, lonBuf.values.length);
    const fullPath: L.LatLng[] = [];
    for (let i = 0; i < len; i++) {
      const lat = latBuf.values[i] / 1e7;
      const lon = lonBuf.values[i] / 1e7;
      // Skip zero/invalid coordinates
      if (lat === 0 && lon === 0) continue;
      fullPath.push(L.latLng(lat, lon));
    }

    if (fullPath.length === 0) return;

    // Set the trail polyline to the full path
    trail.setLatLngs(fullPath);
    trailPoints = fullPath;
    setHasMapData(true);

    // Ensure trail is visible on the map
    if (!map.hasLayer(trail)) trail.addTo(map);

    // Remove any existing start/end markers
    if (startMarker) { startMarker.remove(); startMarker = undefined; }
    if (endMarker) { endMarker.remove(); endMarker = undefined; }

    // Add start marker (green)
    startMarker = L.circleMarker(fullPath[0], {
      radius: 6,
      color: '#00cc00',
      fillColor: '#00ff00',
      fillOpacity: 0.8,
      weight: 2,
    }).addTo(map);

    // Add end marker (red)
    endMarker = L.circleMarker(fullPath[fullPath.length - 1], {
      radius: 6,
      color: '#cc0000',
      fillColor: '#ff0000',
      fillOpacity: 0.8,
      weight: 2,
    }).addTo(map);

    // Fit the map to show the entire path
    const bounds = trail.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [30, 30] });
    }

    // Save and disable auto-center in log mode
    if (savedAutoCenter === undefined) {
      savedAutoCenter = appState.mapAutoCenter;
    }
    setAppState('mapAutoCenter', false);
  }

  function clearLogFlightPath() {
    // Remove start/end markers
    if (startMarker) { startMarker.remove(); startMarker = undefined; }
    if (endMarker) { endMarker.remove(); endMarker = undefined; }

    // Reset trail for live mode
    trailPoints = [];
    trail?.setLatLngs([]);
    latestBuffers = undefined;
    setHasMapData(false);

    // Restore auto-center preference
    if (savedAutoCenter !== undefined) {
      setAppState('mapAutoCenter', savedAutoCenter);
      savedAutoCenter = undefined;
    }
  }

  function persistViewportCenter(): void {
    if (!map) return;
    const center = map.getCenter();
    if (center.lat !== appState.mapCenterLat) {
      setAppState('mapCenterLat', center.lat);
    }
    if (center.lng !== appState.mapCenterLon) {
      setAppState('mapCenterLon', center.lng);
    }
  }

  onMount(() => {
    if (!containerRef) return;

    map = L.map(containerRef, {
      center: [appState.mapCenterLat, appState.mapCenterLon],
      zoom: appState.mapZoom,
      zoomControl: true,
      fadeAnimation: false,
    });

    map.on('zoomend', () => {
      const z = map!.getZoom();
      if (z !== appState.mapZoom) setAppState('mapZoom', z);
      persistViewportCenter();
    });
    map.on('moveend', persistViewportCenter);

    const layerConfig = TILE_LAYERS[appState.mapLayer];
    tileLayer = L.tileLayer(layerConfig.url, {
      attribution: layerConfig.attribution,
      maxZoom: layerConfig.maxZoom,
    }).addTo(map);

    marker = L.marker([appState.mapCenterLat, appState.mapCenterLon], {
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

        // Always update the vehicle marker position
        marker.setLatLng(latlng);
        if (Math.abs(latestHdg - prevHdg) > 0.5) {
          marker.setIcon(createVehicleIcon(latestHdg));
          prevHdg = latestHdg;
        }

        // In log mode, the full flight path is drawn by showFullFlightPath().
        // Only append trail points and auto-center in live mode.
        if (!appState.logViewerState.isActive) {
          trailPoints.push(latlng);
          if (trailPoints.length > appState.mapTrailLength) {
            trailPoints = trailPoints.slice(-appState.mapTrailLength);
          }
          trail?.setLatLngs(trailPoints);

          if (appState.mapAutoCenter) {
            map.panTo(latlng, { animate: false });
          }
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
    const config = TILE_LAYERS[appState.mapLayer];
    if (tileLayer) tileLayer.remove();
    if (overlayLayer) { overlayLayer.remove(); overlayLayer = undefined; }
    tileLayer = L.tileLayer(config.url, {
      attribution: config.attribution,
      maxZoom: config.maxZoom,
    }).addTo(map);
    if ('labelOverlay' in config && config.labelOverlay) {
      overlayLayer = L.tileLayer(config.labelOverlay.url, {
        maxZoom: config.labelOverlay.maxZoom,
        pane: 'overlayPane',
      }).addTo(map);
    }
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

  // Show full flight path when a log is loaded, clear when unloaded
  createEffect(() => {
    const isLogActive = appState.logViewerState.isActive;
    if (isLogActive) {
      // Data may already be available from the onUpdate callback
      showFullFlightPath();
    } else {
      clearLogFlightPath();
    }
  });

  onCleanup(() => {
    persistViewportCenter();
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    unsubUpdate?.();
    map?.remove();
  });

  return (
    <div class="relative h-full w-full">
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

        <div class="absolute top-3 right-3 z-[1000] flex flex-col items-end gap-2">
          <div class="console-overlay rounded-md px-3 py-2 text-xs font-mono" style={{ 'pointer-events': 'none' }}>
            <div>
              Lat: {formatDisplayValue(
                convertDisplayValue(latestLatRaw, 'degE7', appState.unitProfile, { fieldName: 'lat' }),
                getDisplayUnit('degE7', appState.unitProfile, { fieldName: 'lat' }),
                'map',
                { fieldName: 'lat' },
              )} {getDisplayUnit('degE7', appState.unitProfile, { fieldName: 'lat' })}
            </div>
            <div>
              Lon: {formatDisplayValue(
                convertDisplayValue(latestLonRaw, 'degE7', appState.unitProfile, { fieldName: 'lon' }),
                getDisplayUnit('degE7', appState.unitProfile, { fieldName: 'lon' }),
                'map',
                { fieldName: 'lon' },
              )} {getDisplayUnit('degE7', appState.unitProfile, { fieldName: 'lon' })}
            </div>
            <div>
              Alt: {formatDisplayValue(
                convertDisplayValue(latestAltRaw, 'mm', appState.unitProfile, { fieldName: 'alt' }),
                getDisplayUnit('mm', appState.unitProfile, { fieldName: 'alt' }),
                'map',
                { fieldName: 'alt' },
              )} {getDisplayUnit('mm', appState.unitProfile, { fieldName: 'alt' })}
            </div>
            <div>
              Hdg: {formatDisplayValue(
                convertDisplayValue(latestHdgRaw, 'cdeg', appState.unitProfile, { fieldName: 'hdg' }),
                getDisplayUnit('cdeg', appState.unitProfile, { fieldName: 'hdg' }),
                'map',
                { fieldName: 'hdg' },
              )} {getDisplayUnit('cdeg', appState.unitProfile, { fieldName: 'hdg' })}
            </div>
          </div>

          <div class="console-overlay flex gap-1 rounded-md p-1">
            <button
              class="console-button rounded p-1.5 interactive-hover"
              style={{
                color: appState.mapLayer !== 'street' ? 'var(--accent)' : 'var(--text-secondary)',
              }}
              onClick={() => {
                const idx = LAYER_ORDER.indexOf(appState.mapLayer);
                setAppState('mapLayer', LAYER_ORDER[(idx + 1) % LAYER_ORDER.length]);
              }}
              title={`Map: ${LAYER_LABELS[appState.mapLayer]}`}
            >
              <LayerIcon />
            </button>
            <button
              class="console-button rounded p-1.5 interactive-hover"
              style={{
                color: appState.mapShowPath ? 'var(--accent)' : 'var(--text-secondary)',
              }}
              onClick={() => setAppState('mapShowPath', !appState.mapShowPath)}
              title={appState.mapShowPath ? 'Hide flight path' : 'Show flight path'}
            >
              <PathIcon />
            </button>
            <button
              class="console-button rounded p-1.5 interactive-hover"
              style={{
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

        <Show when={!hasMapData()}>
          <div class="console-overlay pointer-events-none absolute left-3 top-3 z-[1000] max-w-sm rounded-md px-3 py-2 text-sm">
            <div class="font-medium">
              {appState.logViewerState.isActive ? 'No log path yet' : 'No live position yet'}
            </div>
            <div class="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {appState.logViewerState.isActive
                ? 'Path appears when the log contains position data.'
                : 'Connect telemetry to update the map.'}
            </div>
          </div>
        </Show>
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
