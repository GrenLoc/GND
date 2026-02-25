/**
 * GrenLoc – Grenada Digital Location Code System
 * Phase 1 Infrastructure MVP
 *
 * Architecture:
 *  - initMap()               : Bootstraps Leaflet map centered on Grenada
 *  - detectParish(lat, lng)  : Returns parish code (Phase 1: coordinate bounding boxes)
 *  - calculateGrid(lat, lng) : Returns deterministic 50m grid X/Y integers
 *  - generateLocationCode()  : Assembles GN-[PARISH]-[GRID] string
 *  - generateQRCode(url)     : Renders QR code onto canvas element
 *  - handleMapClick(e)       : Orchestrates all logic on map interaction
 *  - showToast(msg)          : UI notification helper
 *  - updateUI(data)          : Batched DOM update function
 *
 * FUTURE EXPANSION HOOKS:
 *  - detectParish() supports a GeoJSON mode — swap PARISH_MODE to 'geojson'
 *  - Business/emergency tagging: extend data payload in handleMapClick()
 *  - Street metadata: attach reverse geocode call in handleMapClick()
 */

'use strict';

// ============================================================
// CONSTANTS
// ============================================================

/** Grenada centre coordinates */
const GRENADA_CENTER = [12.1165, -61.6790];
const DEFAULT_ZOOM   = 10;

/** Grid resolution in metres */
const GRID_SIZE = 50;

/**
 * Conversion factors for ~12°N latitude
 * latMeters: 1° latitude  ≈ 111,320 m (global constant)
 * lngMeters: 1° longitude ≈ 108,900 m at ~12° N (cos(12°) × 111,320 ≈ 108,900)
 */
const LAT_TO_METERS = 111320;
const LNG_TO_METERS = 108900;

/**
 * Parish code definitions.
 * Phase 1: Simplified bounding-box polygons derived from approximate parish boundaries.
 * Phase 2: Replace BOUNDARY_TYPE with 'geojson' and supply geojson file path in GEOJSON_URL.
 *
 * Bounding boxes are [minLat, maxLat, minLng, maxLng].
 * Evaluated top-to-bottom; first match wins.
 *
 * Note: These boxes are simplified approximations. GeoJSON import will
 *       supersede this entirely — see detectParish() for the swap hook.
 */
const BOUNDARY_MODE = 'bbox'; // 'bbox' | 'geojson' (Phase 2)
// const GEOJSON_URL = './data/grenada-parishes.geojson'; // Phase 2

const PARISHES = [
  {
    code: 'STG',
    name: 'St. George',
    // St. George covers the SW including St. George's city and Grand Anse
    bbox: { minLat: 11.97, maxLat: 12.10, minLng: -61.83, maxLng: -61.65 }
  },
  {
    code: 'STA',
    name: 'St. Andrew',
    // Largest parish — covers most of the NE interior and east coast
    bbox: { minLat: 12.03, maxLat: 12.23, minLng: -61.70, maxLng: -61.58 }
  },
  {
    code: 'SDA',
    name: 'St. David',
    // SE coast and interior
    bbox: { minLat: 11.97, maxLat: 12.06, minLng: -61.67, maxLng: -61.58 }
  },
  {
    code: 'STP',
    name: 'St. Patrick',
    // Northern tip of the island
    bbox: { minLat: 12.18, maxLat: 12.28, minLng: -61.72, maxLng: -61.58 }
  },
  {
    code: 'STM',
    name: 'St. Mark',
    // Northwest coast
    bbox: { minLat: 12.08, maxLat: 12.22, minLng: -61.78, maxLng: -61.68 }
  },
  {
    code: 'STJ',
    name: 'St. John',
    // West-central coast
    bbox: { minLat: 12.04, maxLat: 12.14, minLng: -61.80, maxLng: -61.70 }
  }
];

/** Fallback parish when no bbox matches (open sea / Carriacou / Petite Martinique) */
const PARISH_FALLBACK = { code: 'GND', name: 'Grenada (Offshore / Other Islands)' };

// ============================================================
// STATE
// ============================================================

let map       = null;   // Leaflet map instance
let marker    = null;   // Active map marker
let qrObject  = null;   // QRCode library instance tracker
let lastClick = null;   // Last clicked {lat, lng}

// ============================================================
// MAP INITIALISATION
// ============================================================

/**
 * initMap()
 * Bootstraps the Leaflet map centered on Grenada.
 * Attaches click handler.
 * Future: Load GeoJSON parish layers here.
 */
function initMap() {
  map = L.map('map', {
    center: GRENADA_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: true,
    attributionControl: true
  });

  // OpenStreetMap tile layer (free, no API key)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    subdomains: ['a', 'b', 'c']
  }).addTo(map);

  // Map click handler
  map.on('click', handleMapClick);

  // Draw approximate parish bounding boxes (visual reference, Phase 1)
  drawParishBoxes();
}

/**
 * drawParishBoxes()
 * Renders semi-transparent parish bounding boxes on the map.
 * Each box is colour-coded and labelled.
 * Phase 2: Replace with GeoJSON polygon layer.
 */
function drawParishBoxes() {
  const colors = ['#f0a500', '#3abf9e', '#e85d3a', '#7b9acc', '#b8a9f0', '#f0c86e'];

  PARISHES.forEach((parish, i) => {
    const { minLat, maxLat, minLng, maxLng } = parish.bbox;

    const rect = L.rectangle(
      [[minLat, minLng], [maxLat, maxLng]],
      {
        color: colors[i % colors.length],
        weight: 1.5,
        opacity: 0.6,
        fillOpacity: 0.06,
        dashArray: '5, 5'
      }
    ).addTo(map);

    // Parish label tooltip
    rect.bindTooltip(
      `<strong>${parish.code}</strong><br>${parish.name}`,
      { permanent: false, direction: 'center', className: 'parish-tooltip' }
    );
  });
}

// ============================================================
// PARISH DETECTION
// ============================================================

/**
 * detectParish(lat, lng)
 * Returns the parish code and name for given coordinates.
 *
 * BOUNDARY_MODE = 'bbox'    → Phase 1 bounding box logic (current)
 * BOUNDARY_MODE = 'geojson' → Phase 2 point-in-polygon using GeoJSON
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {{ code: string, name: string }}
 */
function detectParish(lat, lng) {
  if (BOUNDARY_MODE === 'geojson') {
    // ── PHASE 2 HOOK ─────────────────────────────────────
    // TODO: Replace with turf.js booleanPointInPolygon() check
    // against loaded GeoJSON feature collection.
    //
    // Example:
    //   const pt = turf.point([lng, lat]);
    //   for (const feature of parishGeoJSON.features) {
    //     if (turf.booleanPointInPolygon(pt, feature)) {
    //       return {
    //         code: feature.properties.PARISH_CODE,
    //         name: feature.properties.PARISH_NAME
    //       };
    //     }
    //   }
    // ─────────────────────────────────────────────────────
    console.warn('GeoJSON boundary mode not yet loaded — falling back to bbox.');
  }

  // Phase 1: Bounding box detection
  for (const parish of PARISHES) {
    const { minLat, maxLat, minLng, maxLng } = parish.bbox;
    if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
      return { code: parish.code, name: parish.name };
    }
  }

  return PARISH_FALLBACK;
}

// ============================================================
// GRID CALCULATION
// ============================================================

/**
 * calculateGrid(lat, lng)
 * Converts geographic coordinates into a deterministic 50m × 50m grid cell.
 *
 * Method:
 *  1. Convert lat/lng to approximate metre values (absolute, positive)
 *  2. Divide by GRID_SIZE (50m) and floor → integer cell index
 *  3. Grid cells are globally unique and reproducible
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {{ gridX: number, gridY: number, latMeters: number, lngMeters: number }}
 */
function calculateGrid(lat, lng) {
  // Step 1: Convert to metres (use Math.abs for positive values)
  const latMeters = Math.abs(lat) * LAT_TO_METERS;
  const lngMeters = Math.abs(lng) * LNG_TO_METERS;

  // Step 2: Deterministic 50m cell index
  const gridX = Math.floor(latMeters / GRID_SIZE);
  const gridY = Math.floor(lngMeters / GRID_SIZE);

  return { gridX, gridY, latMeters, lngMeters };
}

// ============================================================
// CODE GENERATION
// ============================================================

/**
 * generateLocationCode(parishCode, gridX, gridY)
 * Assembles the final location string: GN-[PARISH]-[GRID_X_LAST3][GRID_Y_LAST3]
 *
 * Uses last 3 digits of each grid index to keep visual output short
 * while preserving full determinism from the source coordinates.
 *
 * @param {string} parishCode  e.g. 'STG'
 * @param {number} gridX       e.g. 26482
 * @param {number} gridY       e.g. 134731
 * @returns {string}           e.g. 'GN-STG-482731'
 */
function generateLocationCode(parishCode, gridX, gridY) {
  // Extract last 3 digits, zero-padded to ensure consistent length
  const gx = String(gridX).slice(-3).padStart(3, '0');
  const gy = String(gridY).slice(-3).padStart(3, '0');

  return `GN-${parishCode}-${gx}${gy}`;
}

// ============================================================
// QR CODE GENERATION
// ============================================================

/**
 * generateQRCode(url)
 * Renders a QR code encoding the given URL onto #qr-canvas.
 * Uses the qrcode.js library (QRCode global).
 *
 * Strategy: Re-creates the QR element each call to ensure freshness.
 *
 * @param {string} url  Full Google Maps navigation URL
 */
function generateQRCode(url) {
  const wrapper     = document.getElementById('qr-wrapper');
  const placeholder = wrapper.querySelector('.qr-placeholder');
  const canvas      = document.getElementById('qr-canvas');

  // Hide placeholder, show canvas
  if (placeholder) placeholder.style.display = 'none';

  // Clear previous QR render
  canvas.style.display = 'none';
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Remove any previous QR div injected by QRCode lib
  const existingQR = wrapper.querySelector('.qr-generated');
  if (existingQR) existingQR.remove();

  // QRCode lib renders into a new div, we capture the canvas from it
  const tempDiv = document.createElement('div');
  tempDiv.className = 'qr-generated';
  tempDiv.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
  document.body.appendChild(tempDiv);

  new QRCode(tempDiv, {
    text: url,
    width: 200,
    height: 200,
    colorDark: '#0c1220',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  // After lib renders, copy canvas from temp div into our visible canvas
  setTimeout(() => {
    const sourceCanvas = tempDiv.querySelector('canvas');
    if (sourceCanvas) {
      canvas.width  = sourceCanvas.width;
      canvas.height = sourceCanvas.height;
      ctx.drawImage(sourceCanvas, 0, 0);
      canvas.style.display = 'block';
    } else {
      // Library rendered an img tag (some browsers) — use it directly
      const sourceImg = tempDiv.querySelector('img');
      if (sourceImg) {
        canvas.style.display = 'none';
        const displayImg = document.createElement('img');
        displayImg.src = sourceImg.src;
        displayImg.id  = 'qr-img';
        displayImg.style.cssText = 'border-radius:6px;border:3px solid #f0a500;padding:8px;background:white;max-width:100%;';
        displayImg.className = 'qr-generated';
        // Remove old img if exists
        const oldImg = wrapper.querySelector('#qr-img');
        if (oldImg) oldImg.remove();
        wrapper.appendChild(displayImg);
      }
    }
    tempDiv.remove();
  }, 100);
}

// ============================================================
// UI HELPERS
// ============================================================

/**
 * updateUI(data)
 * Batched DOM update to display generated code, coordinates, and QR.
 * Separated from logic to keep script.js testable.
 *
 * @param {{ code, lat, lng, parish, gridX, gridY, latMeters, lngMeters, mapsUrl }} data
 */
function updateUI(data) {
  // Location code — with flash animation
  const codeEl = document.getElementById('location-code');
  codeEl.textContent = data.code;
  codeEl.classList.remove('updated');
  void codeEl.offsetWidth; // force reflow
  codeEl.classList.add('updated');

  // Coordinates
  document.getElementById('coord-display').textContent =
    `${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}`;

  // Parish name
  document.getElementById('parish-display').textContent =
    `Parish: ${data.parish.name} (${data.parish.code})`;

  // Enable buttons
  const btnCopy = document.getElementById('btn-copy');
  const btnMaps = document.getElementById('btn-maps');

  btnCopy.disabled = false;
  btnMaps.disabled = false;

  // Wire copy button
  btnCopy.onclick = () => {
    navigator.clipboard.writeText(data.code)
      .then(() => showToast(`Copied: ${data.code}`))
      .catch(() => {
        // Fallback for non-HTTPS
        const ta = document.createElement('textarea');
        ta.value = data.code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast(`Copied: ${data.code}`);
      });
  };

  // Wire maps button
  btnMaps.onclick = () => window.open(data.mapsUrl, '_blank');

  // Debug panel
  document.getElementById('dbg-gx').textContent  = data.gridX;
  document.getElementById('dbg-gy').textContent  = data.gridY;
  document.getElementById('dbg-lm').textContent  = data.latMeters.toFixed(2) + ' m';
  document.getElementById('dbg-nm').textContent  = data.lngMeters.toFixed(2) + ' m';
  document.getElementById('dbg-par').textContent = `${data.parish.code} – ${data.parish.name}`;
}

/**
 * showToast(message)
 * Displays a transient notification banner.
 * @param {string} message
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

// ============================================================
// MAP CLICK HANDLER — MAIN ORCHESTRATOR
// ============================================================

/**
 * handleMapClick(e)
 * Called on every Leaflet map click.
 * Orchestrates: parish detection → grid calc → code gen → QR → UI update.
 *
 * This is the integration point for future layers:
 *  - Street metadata: add reverse geocode call here
 *  - Business tagging: emit event with location code here
 *  - Emergency tagging: flag code for emergency registry here
 *
 * @param {L.LeafletMouseEvent} e
 */
function handleMapClick(e) {
  const { lat, lng } = e.latlng;
  lastClick = { lat, lng };

  // 1. Detect parish
  const parish = detectParish(lat, lng);

  // 2. Calculate 50m grid
  const { gridX, gridY, latMeters, lngMeters } = calculateGrid(lat, lng);

  // 3. Generate location code
  const code = generateLocationCode(parish.code, gridX, gridY);

  // 4. Build Google Maps URL
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;

  // 5. Place / move marker on map
  placeMarker(lat, lng, code, parish);

  // 6. Generate QR code
  generateQRCode(mapsUrl);

  // 7. Update all UI elements
  updateUI({ code, lat, lng, parish, gridX, gridY, latMeters, lngMeters, mapsUrl });
}

// ============================================================
// MARKER MANAGEMENT
// ============================================================

/**
 * placeMarker(lat, lng, code, parish)
 * Adds or moves the marker on the map.
 * Shows a popup with the generated code.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string} code
 * @param {{ code: string, name: string }} parish
 */
function placeMarker(lat, lng, code, parish) {
  // Custom icon
  const icon = L.divIcon({
    html: `<div class="custom-marker"></div>`,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -30]
  });

  if (marker) {
    marker.setLatLng([lat, lng]);
  } else {
    marker = L.marker([lat, lng], { icon }).addTo(map);
  }

  marker.bindPopup(
    `<strong>${code}</strong><br>${lat.toFixed(6)}, ${lng.toFixed(6)}<br><em>${parish.name}</em>`
  ).openPopup();
}

// ============================================================
// BOOTSTRAP
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  console.log('%cGrenLoc v1.0 — Phase 1 MVP', 'color:#f0a500;font-weight:bold;font-size:14px;');
  console.log('Grid size:', GRID_SIZE, 'm ×', GRID_SIZE, 'm');
  console.log('Boundary mode:', BOUNDARY_MODE);
});
