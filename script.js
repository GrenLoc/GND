/**
 * GrenLoc – Grenada Digital Location Code System
 * Phase 1 Infrastructure MVP — Google Maps Edition
 *
 * Architecture:
 *  - initMap()               : Bootstraps Google Map centered on Grenada
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
const GRENADA_CENTER = { lat: 12.1165, lng: -61.6790 };
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

let map         = null;   // Google Map instance
let marker      = null;   // Active map marker (google.maps.Marker)
let infoWindow  = null;   // Shared InfoWindow instance
let lastClick   = null;   // Last clicked {lat, lng}
let parishBoxes = [];     // Google Maps Rectangle overlays

// ============================================================
// MAP INITIALISATION
// ============================================================

/**
 * initMap()
 * Called automatically by the Google Maps JS API (callback=initMap in URL).
 * Bootstraps the Google Map centered on Grenada.
 * Attaches click handler.
 */
function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: GRENADA_CENTER,
    zoom: DEFAULT_ZOOM,
    mapTypeId: google.maps.MapTypeId.ROADMAP,
    mapTypeControl: true,
    mapTypeControlOptions: {
      style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
      position: google.maps.ControlPosition.TOP_RIGHT,
      mapTypeIds: [
        google.maps.MapTypeId.ROADMAP,
        google.maps.MapTypeId.SATELLITE,
        google.maps.MapTypeId.HYBRID,
        google.maps.MapTypeId.TERRAIN
      ]
    },
    zoomControl: true,
    streetViewControl: true,
    fullscreenControl: true,
    styles: [
      { elementType: 'geometry',            stylers: [{ color: '#1e2d44' }] },
      { elementType: 'labels.text.stroke',  stylers: [{ color: '#0c1220' }] },
      { elementType: 'labels.text.fill',    stylers: [{ color: '#e8eef6' }] },
      { featureType: 'water', elementType: 'geometry',          stylers: [{ color: '#0c1a2e' }] },
      { featureType: 'water', elementType: 'labels.text.fill',  stylers: [{ color: '#7a92b4' }] },
      { featureType: 'road',  elementType: 'geometry',          stylers: [{ color: '#243450' }] },
      { featureType: 'road',  elementType: 'geometry.stroke',   stylers: [{ color: '#141e30' }] },
      { featureType: 'road.highway', elementType: 'geometry',        stylers: [{ color: '#f0a500' }] },
      { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#0c1220' }] },
      { featureType: 'poi',       elementType: 'geometry', stylers: [{ color: '#1e2d44' }] },
      { featureType: 'poi.park',  elementType: 'geometry', stylers: [{ color: '#1a3a2a' }] },
      { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#f0a500' }] }
    ]
  });

  // Shared InfoWindow (reused for both parish hover and marker popup)
  infoWindow = new google.maps.InfoWindow();

  // Map click handler
  map.addListener('click', handleMapClick);

  // Draw approximate parish bounding boxes (visual reference, Phase 1)
  drawParishBoxes();

  console.log('%cGrenLoc v1.0 — Phase 1 MVP (Google Maps)', 'color:#f0a500;font-weight:bold;font-size:14px;');
  console.log('Grid size:', GRID_SIZE, 'm ×', GRID_SIZE, 'm');
  console.log('Boundary mode:', BOUNDARY_MODE);
}

/**
 * drawParishBoxes()
 * Renders semi-transparent parish bounding boxes on the Google Map.
 * Each box is colour-coded and shows a label on hover.
 * Phase 2: Replace with GeoJSON polygon layer.
 */
function drawParishBoxes() {
  const colors = ['#f0a500', '#3abf9e', '#e85d3a', '#7b9acc', '#b8a9f0', '#f0c86e'];

  PARISHES.forEach((parish, i) => {
    const { minLat, maxLat, minLng, maxLng } = parish.bbox;

    const rect = new google.maps.Rectangle({
      bounds: { north: maxLat, south: minLat, east: maxLng, west: minLng },
      map: map,
      strokeColor:   colors[i % colors.length],
      strokeOpacity: 0.7,
      strokeWeight:  1.5,
      fillColor:     colors[i % colors.length],
      fillOpacity:   0.06
    });

    // Parish tooltip on hover
    rect.addListener('mouseover', (e) => {
      infoWindow.setContent(
        `<div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:#0c1220;padding:2px 4px;">
          <strong>${parish.code}</strong><br>${parish.name}
        </div>`
      );
      infoWindow.setPosition(e.latLng);
      infoWindow.open(map);
    });

    rect.addListener('mouseout', () => infoWindow.close());

    // Clicks on rectangle also trigger the main handler
    rect.addListener('click', handleMapClick);

    parishBoxes.push(rect);
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
 * @param {number} lat
 * @param {number} lng
 * @returns {{ gridX: number, gridY: number, latMeters: number, lngMeters: number }}
 */
function calculateGrid(lat, lng) {
  const latMeters = Math.abs(lat) * LAT_TO_METERS;
  const lngMeters = Math.abs(lng) * LNG_TO_METERS;

  const gridX = Math.floor(latMeters / GRID_SIZE);
  const gridY = Math.floor(lngMeters / GRID_SIZE);

  return { gridX, gridY, latMeters, lngMeters };
}

// ============================================================
// CODE GENERATION
// ============================================================

/**
 * generateLocationCode(parishCode, gridX, gridY)
 * Assembles a human-readable location code: GN-[PARISH]-[XXXXXX]
 *
 * @param {string} parishCode  e.g. 'STG'
 * @param {number} gridX       e.g. 26482
 * @param {number} gridY       e.g. 134731
 * @returns {string}           e.g. 'GN-STG-482731'
 */
function generateLocationCode(parishCode, gridX, gridY) {
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
 * @param {string} url  Full Google Maps navigation URL
 */
function generateQRCode(url) {
  const wrapper     = document.getElementById('qr-wrapper');
  const placeholder = wrapper.querySelector('.qr-placeholder');
  const canvas      = document.getElementById('qr-canvas');

  if (placeholder) placeholder.style.display = 'none';

  canvas.style.display = 'none';
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const existingQR = wrapper.querySelector('.qr-generated');
  if (existingQR) existingQR.remove();

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

  setTimeout(() => {
    const sourceCanvas = tempDiv.querySelector('canvas');
    if (sourceCanvas) {
      canvas.width  = sourceCanvas.width;
      canvas.height = sourceCanvas.height;
      ctx.drawImage(sourceCanvas, 0, 0);
      canvas.style.display = 'block';
    } else {
      const sourceImg = tempDiv.querySelector('img');
      if (sourceImg) {
        canvas.style.display = 'none';
        const displayImg = document.createElement('img');
        displayImg.src = sourceImg.src;
        displayImg.id  = 'qr-img';
        displayImg.style.cssText = 'border-radius:6px;border:3px solid #f0a500;padding:8px;background:white;max-width:100%;';
        displayImg.className = 'qr-generated';
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
 *
 * @param {{ code, lat, lng, parish, gridX, gridY, latMeters, lngMeters, mapsUrl }} data
 */
function updateUI(data) {
  const codeEl = document.getElementById('location-code');
  codeEl.textContent = data.code;
  codeEl.classList.remove('updated');
  void codeEl.offsetWidth;
  codeEl.classList.add('updated');

  document.getElementById('coord-display').textContent =
    `${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}`;

  document.getElementById('parish-display').textContent =
    `Parish: ${data.parish.name} (${data.parish.code})`;

  const btnCopy = document.getElementById('btn-copy');
  const btnMaps = document.getElementById('btn-maps');

  btnCopy.disabled = false;
  btnMaps.disabled = false;

  btnCopy.onclick = () => {
    navigator.clipboard.writeText(data.code)
      .then(() => showToast(`Copied: ${data.code}`))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = data.code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast(`Copied: ${data.code}`);
      });
  };

  btnMaps.onclick = () => window.open(data.mapsUrl, '_blank');

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
 * Called on every Google Map click event.
 * Orchestrates: parish detection → grid calc → code gen → QR → UI update.
 *
 * This is the integration point for future layers:
 *  - Street metadata: add reverse geocode call here
 *  - Business tagging: emit event with location code here
 *  - Emergency tagging: flag code for emergency registry here
 *
 * @param {google.maps.MapMouseEvent} e
 */
function handleMapClick(e) {
  const lat = e.latLng.lat();
  const lng = e.latLng.lng();
  lastClick = { lat, lng };

  // 1. Detect parish
  const parish = detectParish(lat, lng);

  // 2. Calculate 50m grid
  const { gridX, gridY, latMeters, lngMeters } = calculateGrid(lat, lng);

  // 3. Generate location code
  const code = generateLocationCode(parish.code, gridX, gridY);

  // 4. Build Google Maps URL
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

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
 * Adds or moves the Google Maps marker.
 * Shows an InfoWindow popup with the generated code.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string} code
 * @param {{ code: string, name: string }} parish
 */
function placeMarker(lat, lng, code, parish) {
  const position = { lat, lng };

  if (marker) {
    marker.setPosition(position);
  } else {
    marker = new google.maps.Marker({
      position,
      map,
      animation: google.maps.Animation.DROP,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: '#f0a500',
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 3,
        scale: 10
      }
    });
  }

  infoWindow.setContent(
    `<div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:#0c1220;padding:4px 6px;line-height:1.6;">
      <strong style="font-size:14px;color:#0c1220;">${code}</strong><br>
      ${lat.toFixed(6)}, ${lng.toFixed(6)}<br>
      <em>${parish.name}</em>
    </div>`
  );
  infoWindow.open(map, marker);
}


// ============================================================
// PHASE 1 SHARING & QR EXPORT FEATURES
// ============================================================

let currentCode = null;
let currentMapsUrl = null;

// Hook into existing updateUI without breaking logic
const originalUpdateUI = updateUI;
updateUI = function(data) {

  originalUpdateUI(data);

  currentCode = data.code;
  currentMapsUrl = data.mapsUrl;

  const btnDownload = document.getElementById('btn-download');
  const btnPrint = document.getElementById('btn-print');
  const btnShare = document.getElementById('btn-share');

  if (btnDownload) btnDownload.disabled = false;
  if (btnPrint) btnPrint.disabled = false;
  if (btnShare) btnShare.disabled = false;

};

// Download QR
document.addEventListener("click", function(e){

  if(e.target.id === "btn-download"){

    const canvas = document.getElementById("qr-canvas");
    const img = document.getElementById("qr-img");

    let url = null;

    if(canvas && canvas.style.display !== "none"){
      url = canvas.toDataURL("image/png");
    } else if(img){
      url = img.src;
    }

    if(!url) return;

    const link = document.createElement("a");
    link.href = url;
    link.download = currentCode + ".png";
    link.click();

    showToast("QR downloaded");

  }

});

// Print Sticker
document.addEventListener("click", function(e){

  if(e.target.id === "btn-print"){

    const canvas = document.getElementById("qr-canvas");
    const img = document.getElementById("qr-img");

    let url = null;

    if(canvas && canvas.style.display !== "none"){
      url = canvas.toDataURL("image/png");
    } else if(img){
      url = img.src;
    }

    if(!url) return;

    const win = window.open("", "_blank");

    win.document.write(`
      <html>
      <head>
        <title>GrenLoc Sticker</title>
        <style>
          body{font-family:sans-serif;text-align:center;padding:20px}
          .card{border:2px solid black;padding:20px;display:inline-block}
          img{width:200px}
        </style>
      </head>
      <body onload="window.print()">
        <div class="card">
          <h2>GrenLoc</h2>
          <h3>${currentCode}</h3>
          <img src="${url}">
          <p>Scan for directions</p>
        </div>
      </body>
      </html>
    `);

  }

});

// Share
document.addEventListener("click", function(e){

  if(e.target.id === "btn-share"){

    if(!currentMapsUrl) return;

    const text = `My GrenLoc code: ${currentCode} ${currentMapsUrl}`;

    if(navigator.share){
      navigator.share({
        title:"GrenLoc",
        text:text,
        url:currentMapsUrl
      });
    }else{
      window.open(
        "https://wa.me/?text="+encodeURIComponent(text),
        "_blank"
      );
    }

  }

});



// ============================================================
// GrenLoc Search (5‑meter precision, non‑breaking)
// ============================================================
(function(){
const GRID_SIZE=5;
const ORIGIN_LAT=11.98;
const ORIGIN_LNG=-61.80;
const METERS_PER_DEG_LAT=111320;
function metersPerDegLng(lat){return 111320*Math.cos(lat*Math.PI/180);}

function decode(code){
 const m=/^GN-([A-Z]{3})-(\d{6})$/.exec(code);
 if(!m)return null;
 const g=m[2];
 const gx=parseInt(g.substring(0,3),10);
 const gy=parseInt(g.substring(3,6),10);
 const lat=ORIGIN_LAT+(gy*GRID_SIZE)/METERS_PER_DEG_LAT;
 const lng=ORIGIN_LNG+(gx*GRID_SIZE)/metersPerDegLng(lat);
 return {lat,lng};
}

window.addEventListener("DOMContentLoaded",()=>{
 const btn=document.getElementById("btn-search");
 const input=document.getElementById("code-search");
 if(!btn||!input)return;
 btn.onclick=()=>{
   const code=input.value.trim().toUpperCase();
   const pos=decode(code);
   if(!pos){ if(window.showToast)showToast("Invalid GrenLoc code"); return;}
   const latLng=new google.maps.LatLng(pos.lat,pos.lng);
   if(window.marker){marker.setPosition(latLng);} 
   else{window.marker=new google.maps.Marker({position:latLng,map:map});}
   map.panTo(latLng);
   map.setZoom(18);
   if(window.updateLocationInfo)updateLocationInfo(latLng);
   if(window.showToast)showToast("Location loaded");
 };
});
})();
