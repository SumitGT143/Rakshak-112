/**
 * Rakshak 112 — app.js
 * Dashboard state, render loops, event wiring.
 * IDs preserved: total, critical, active, last, count, list, map, mapEmpty,
 * detail, conn, recommendations, warning, requirements, hospitalCount, hospitalList,
 * context.
 */

/* ---------- state ---------- */
let incidents = [];
let selected = null;
let hospitals = [];
let selectedHospital = null;
let hospSearchQuery = '';
let filterDistrict = '';
let filterType = '';
let filterTrauma = '';
let filterICU = '';
let filterMore = '';
let filterSort = 'nearest';
let viewMode = 'grid';
let currentPage = 1;
const PAGE_SIZE = 6;
let activeDetailTab = 'overview';

/* ---------- responders state ---------- */
let responders = [];
let selectedResponder = null;
let respSearchQuery = '';
let respFilterDistrict = '';
let respFilterZone = '';
let respFilterType = '';
let respFilterStatus = '';
let respFilterEquip = '';
let respFilterSort = 'nearest';
let respViewMode = 'grid';
let respCurrentPage = 1;
const RESP_PAGE_SIZE = 6;
let activeRespDetailTab = 'overview';

// Central dispatch reference coordinates (Durg/Bhilai centroid)
const DEFAULT_LAT = 21.2100;
const DEFAULT_LON = 81.3650;

// Load Raipur and Durg hospitals database with fallback support
async function loadHospitalsLocal() {
  const combined = [];

  // 1. Load Raipur Hospitals Database
  try {
    const resRaipur = await fetch('RAIPUR HOSPITAL.JSON');
    if (resRaipur.ok) {
      const d = await resRaipur.json();
      const loaded = (d.hospitals || (Array.isArray(d) ? d : [])).map(h => ({
        ...h,
        district: h.district || 'Raipur'
      }));
      combined.push(...loaded);
    }
  } catch (e) {
    console.warn('Could not load RAIPUR HOSPITAL.JSON:', e);
  }

  // 2. Load Durg Hospitals Database
  try {
    const resDurg = await fetch('DURG HOSPITAL.JSON');
    if (resDurg.ok) {
      const d = await resDurg.json();
      const loaded = (d.hospitals || (Array.isArray(d) ? d : [])).map(h => ({
        ...h,
        district: h.district || 'Durg'
      }));
      combined.push(...loaded);
    }
  } catch (e) {
    console.warn('Could not load DURG HOSPITAL.JSON:', e);
  }

  // Fallback to /api/hospitals if neither local file loaded
  if (!combined.length) {
    try {
      const resApi = await fetch('/api/hospitals');
      if (resApi.ok) {
        const d = await resApi.json();
        const loaded = d.hospitals || (Array.isArray(d) ? d : []);
        combined.push(...loaded);
      }
    } catch (e) {
      console.warn('Could not load /api/hospitals:', e);
    }
  }

  if (combined.length) {
    hospitals = combined;
    if (!selectedHospital && hospitals.length) {
      selectedHospital = hospitals[0]; // Default select premier hospital (AIIMS Raipur or S.S. Hospital)
    }
    render();
    renderHospitals();
  }
}
loadHospitalsLocal();

// Load Raipur and Durg responders fleet database with fallback support
async function loadRespondersLocal() {
  const combined = [];

  // 1. Load Raipur Responders Database
  try {
    const resRaipur = await fetch('raipur_responders_fleet_database.json');
    if (resRaipur.ok) {
      const d = await resRaipur.json();
      const loaded = (d.responders || (Array.isArray(d) ? d : [])).map(r => ({
        ...r,
        district: r.district || 'Raipur',
        sector: 'Raipur Metropolitan Sector'
      }));
      combined.push(...loaded);
    }
  } catch (e) {
    console.warn('Could not load raipur_responders_fleet_database.json:', e);
  }

  // 2. Load Durg-Bhilai Responders Database
  try {
    const resDurg = await fetch('durg_responders_fleet_database.json');
    if (resDurg.ok) {
      const d = await resDurg.json();
      const loaded = (d.responders || (Array.isArray(d) ? d : [])).map(r => ({
        ...r,
        district: r.district || 'Durg',
        sector: 'Durg-Bhilai Sector'
      }));
      combined.push(...loaded);
    }
  } catch (e) {
    console.warn('Could not load durg_responders_fleet_database.json:', e);
  }

  // 3. Fallback / supplementary load from /api/responders
  if (combined.length === 0) {
    const sources = [
      '/api/responders',
      'durg_drivers.json',
      'durg_responders.json'
    ];
    for (const src of sources) {
      try {
        const res = await fetch(src);
        if (res.ok) {
          const d = await res.json();
          const loaded = (d.responders || (Array.isArray(d) ? d : [])).map(r => ({
            ...r,
            district: r.district || (r.id && r.id.includes('RAI') ? 'Raipur' : 'Durg')
          }));
          if (loaded.length) {
            combined.push(...loaded);
            break;
          }
        }
      } catch (e) {
        console.warn(`Could not load ${src}:`, e);
      }
    }
  }

  if (combined.length) {
    responders = combined;
    if (!selectedResponder && responders.length) {
      selectedResponder = responders[0];
    }
    renderResponders();
    renderLiveMonitoring();
  }
}
/* ---------- Google Maps & Tactical GIS Engine ---------- */
const DARK_MAP_STYLES = [
  { elementType: "geometry", stylers: [{ color: "#07132a" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0a1428" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#7488a6" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#38bdf8" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#60a5fa" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#06233d" }] },
  { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#4ade80" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#163660" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#0b1d3a" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#93c5fd" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#1e40af" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#172554" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#67e8f9" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#1e293b" }] },
  { featureType: "transit.station", elementType: "labels.text.fill", stylers: [{ color: "#38bdf8" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#030d1e" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3b82f6" }] },
  { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#030d1e" }] }
];

let dashboardMap = null;
let dashboardMapEngine = 'none'; // 'google' | 'leaflet'
let dashboardMapMarkers = [];
let dashboardRouteLayer = null;
let dashboardInfoWindow = null;
let leafletTileLayers = {};
let currentActiveTileLayer = null;

// Live Monitoring Map state
let liveGoogleMap = null;
let liveMapEngine = 'none'; // 'google' | 'leaflet'
let liveMapMarkers = [];
let liveRouteLayer = null;
let liveInfoWindow = null;
let liveLeafletTileLayers = {};
let currentActiveLiveTileLayer = null;

// Global callback for Google Maps API
window.initGoogleMapFromCallback = function() {
  initDashboardMap();
  initLiveMonitoringMap();
};

function initDashboardMap() {
  const mapElem = $('map');
  if (!mapElem) return;

  // 1. Try Google Maps if SDK is loaded
  if (window.google && window.google.maps && window.google.maps.Map) {
    try {
      if (dashboardMap && dashboardMapEngine === 'google') return;
      
      const gridOverlay = $('mapGridOverlay');
      if (gridOverlay) gridOverlay.style.display = 'none';
      if ($('mapEmpty')) $('mapEmpty').style.display = 'none';

      dashboardMap = new google.maps.Map(mapElem, {
        center: { lat: DEFAULT_LAT, lng: DEFAULT_LON },
        zoom: 13,
        styles: null,
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        backgroundColor: '#ffffff'
      });

      dashboardMapEngine = 'google';
      dashboardInfoWindow = new google.maps.InfoWindow();

      const badge = $('mapProviderBadge');
      if (badge) {
        badge.textContent = 'GOOGLE MAPS (LIVE)';
        badge.style.color = '#38bdf8';
      }

      renderDashboardMapMarkers();
      return;
    } catch (err) {
      console.warn('Google Maps init failed, falling back to Leaflet:', err);
    }
  }

  // 2. Fallback to Leaflet (CartoDB Dark Matter / OSM)
  if (window.L && !dashboardMap) {
    try {
      const gridOverlay = $('mapGridOverlay');
      if (gridOverlay) gridOverlay.style.display = 'none';
      if ($('mapEmpty')) $('mapEmpty').style.display = 'none';

      dashboardMap = L.map(mapElem, {
        center: [DEFAULT_LAT, DEFAULT_LON],
        zoom: 13,
        zoomControl: true
      });

      leafletTileLayers.roadmap = L.tileLayer('https://mt1.google.com/vt/lyrs=m,traffic&x={x}&y={y}&z={z}', {
        attribution: '&copy; Google Maps (Live Traffic)',
        maxZoom: 20
      });

      leafletTileLayers.hybrid = L.tileLayer('https://mt1.google.com/vt/lyrs=y,traffic&x={x}&y={y}&z={z}', {
        attribution: '&copy; Google Maps (Satellite & Live Traffic)',
        maxZoom: 20
      });

      currentActiveTileLayer = leafletTileLayers.roadmap;
      currentActiveTileLayer.addTo(dashboardMap);

      dashboardMapEngine = 'leaflet';

      const badge = $('mapProviderBadge');
      if (badge) {
        badge.textContent = 'ONLINE (LIVE GOOGLE TRAFFIC)';
        badge.style.color = '#38bdf8';
      }

      renderDashboardMapMarkers();
    } catch (lErr) {
      console.error('Leaflet initialization error:', lErr);
    }
  }
}

function invalidateDashboardMapSize() {
  setTimeout(() => {
    if (dashboardMapEngine === 'google' && dashboardMap && window.google) {
      google.maps.event.trigger(dashboardMap, 'resize');
      if (selected) {
        const lat = selected.location?.latitude ?? selected.lat ?? DEFAULT_LAT;
        const lng = selected.location?.longitude ?? selected.lng ?? DEFAULT_LON;
        dashboardMap.panTo({ lat, lng });
      } else {
        dashboardMap.panTo({ lat: DEFAULT_LAT, lng: DEFAULT_LON });
      }
    } else if (dashboardMapEngine === 'leaflet' && dashboardMap) {
      dashboardMap.invalidateSize();
      if (selected) {
        const lat = selected.location?.latitude ?? selected.lat ?? DEFAULT_LAT;
        const lng = selected.location?.longitude ?? selected.lng ?? DEFAULT_LON;
        dashboardMap.panTo([lat, lng]);
      }
    }
  }, 100);
}

function setDashboardMapType(type, btn) {
  if (btn) {
    document.querySelectorAll('.map-controls .map-ctrl-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  const badge = $('mapProviderBadge');
  if (badge) {
    if (type === 'hybrid') badge.textContent = 'SATELLITE & TRAFFIC (LIVE)';
    else badge.textContent = 'ONLINE (LIVE GOOGLE TRAFFIC)';
  }

  if (dashboardMapEngine === 'google' && dashboardMap) {
    if (type === 'dark') {
      dashboardMap.setMapTypeId('roadmap');
      dashboardMap.setOptions({ styles: DARK_MAP_STYLES });
    } else if (type === 'roadmap') {
      dashboardMap.setMapTypeId('roadmap');
      dashboardMap.setOptions({ styles: null });
    } else if (type === 'hybrid') {
      dashboardMap.setMapTypeId('hybrid');
      dashboardMap.setOptions({ styles: null });
    }
  } else if (dashboardMapEngine === 'leaflet' && dashboardMap && leafletTileLayers[type]) {
    if (currentActiveTileLayer) dashboardMap.removeLayer(currentActiveTileLayer);
    currentActiveTileLayer = leafletTileLayers[type];
    currentActiveTileLayer.addTo(dashboardMap);
  }
}

function recenterDashboardMap() {
  if (dashboardMapEngine === 'google' && dashboardMap) {
    dashboardMap.panTo({ lat: DEFAULT_LAT, lng: DEFAULT_LON });
    dashboardMap.setZoom(13);
  } else if (dashboardMapEngine === 'leaflet' && dashboardMap) {
    dashboardMap.setView([DEFAULT_LAT, DEFAULT_LON], 13);
  }
}

/* ---------- map pins & tactical markers ---------- */
function renderDashboardMapMarkers() {
  if (!dashboardMap) {
    initDashboardMap();
    if (!dashboardMap) return;
  }

  // Clear previous markers
  if (dashboardMapEngine === 'google') {
    dashboardMapMarkers.forEach(m => m.setMap(null));
  } else if (dashboardMapEngine === 'leaflet') {
    dashboardMapMarkers.forEach(m => dashboardMap.removeLayer(m));
  }
  dashboardMapMarkers = [];

  // 1. Render Incidents (SOS)
  incidents.forEach(inc => {
    const lat = inc.location?.latitude ?? inc.lat ?? DEFAULT_LAT;
    const lng = inc.location?.longitude ?? inc.lng ?? DEFAULT_LON;
    const isCritical = inc.priority?.code === 'L1';
    const isSelected = selected && selected.id === inc.id;

    const popupHtml = `
      <div class="rakshak-map-infowindow">
        <h4>
          <span>🚨 ${esc(inc.id)}</span>
          <span class="badge ${isCritical ? 'badge-critical' : 'badge-standard'}">${esc(inc.priority?.label || 'STANDARD')}</span>
        </h4>
        <p><strong>${esc(inc.emergencyType || 'Emergency')}</strong></p>
        <div class="info-row">
          <span class="info-label">Status:</span>
          <span class="info-val">${esc(inc.status || 'REPORTED')}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Casualties:</span>
          <span class="info-val">${esc(inc.triage?.injuredCount ?? inc.injured ?? '1')}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Coordinates:</span>
          <span class="info-val">${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}</span>
        </div>
        <button class="btn-dispatch" onclick="pick('${esc(inc.id)}'); highlightCorridorRoute('${esc(inc.id)}')">
          SELECT & PLOT CORRIDOR
        </button>
      </div>
    `;

    if (dashboardMapEngine === 'google') {
      const pinColor = isCritical ? '#ef4444' : '#38bdf8';
      const marker = new google.maps.Marker({
        position: { lat, lng },
        map: dashboardMap,
        title: `${inc.id} - ${inc.emergencyType}`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: isSelected ? 12 : 9,
          fillColor: pinColor,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2
        }
      });

      marker.addListener('click', () => {
        pick(inc.id);
        if (dashboardInfoWindow) {
          dashboardInfoWindow.setContent(popupHtml);
          dashboardInfoWindow.open(dashboardMap, marker);
        }
      });

      dashboardMapMarkers.push(marker);
    } else if (dashboardMapEngine === 'leaflet') {
      const icon = L.divIcon({
        className: 'tactical-custom-pin ' + (isCritical ? 'critical' : 'standard'),
        html: `
          <div class="pin-core">🚨</div>
          <div class="pin-tag">${esc(inc.id)}</div>
        `,
        iconSize: [40, 50],
        iconAnchor: [20, 45]
      });

      const marker = L.marker([lat, lng], { icon }).addTo(dashboardMap);
      marker.bindPopup(popupHtml);
      marker.on('click', () => pick(inc.id));
      dashboardMapMarkers.push(marker);
    }
  });

  // 2. Render Key Hospitals (Top 8)
  if (hospitals && hospitals.length) {
    hospitals.slice(0, 8).forEach(h => {
      const lat = Number(h.latitude);
      const lng = Number(h.longitude);
      if (isNaN(lat) || isNaN(lng)) return;

      const hospPopup = `
        <div class="rakshak-map-infowindow">
          <h4>🏥 ${esc(h.hospital_name)}</h4>
          <p style="color:#22c55e;font-weight:700;">Trauma: ${esc(h.trauma_capability?.trauma_level || 'Level II')}</p>
          <div class="info-row">
            <span class="info-label">ICU Beds:</span>
            <span class="info-val">${esc(h.icu_beds_available ?? 'Available')}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Blood Bank:</span>
            <span class="info-val">${h.blood_bank_24x7 ? '24x7 Active' : 'Limited'}</span>
          </div>
          <button class="btn-dispatch" style="background:linear-gradient(135deg, #15803d, #16a34a);" onclick="showHospitalOnMapAndRoute('${esc(h.id)}')">
            ROUTE TO THIS HOSPITAL
          </button>
        </div>
      `;

      if (dashboardMapEngine === 'google') {
        const marker = new google.maps.Marker({
          position: { lat, lng },
          map: dashboardMap,
          title: h.hospital_name,
          icon: {
            path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
            scale: 6,
            fillColor: '#22c55e',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 1.5
          }
        });
        marker.addListener('click', () => {
          if (dashboardInfoWindow) {
            dashboardInfoWindow.setContent(hospPopup);
            dashboardInfoWindow.open(dashboardMap, marker);
          }
        });
        dashboardMapMarkers.push(marker);
      } else if (dashboardMapEngine === 'leaflet') {
        const icon = L.divIcon({
          className: 'tactical-custom-pin hospital',
          html: `
            <div class="pin-core">🏥</div>
            <div class="pin-tag" style="border-color:#22c55e;color:#86efac">${esc(h.hospital_name.split(' ')[0])}</div>
          `,
          iconSize: [36, 45],
          iconAnchor: [18, 40]
        });
        const marker = L.marker([lat, lng], { icon }).addTo(dashboardMap);
        marker.bindPopup(hospPopup);
        dashboardMapMarkers.push(marker);
      }
    });
  }

  // 3. Render Responders (Top 6)
  if (responders && responders.length) {
    responders.slice(0, 6).forEach(r => {
      const lat = r.live_telemetry?.current_latitude || (DEFAULT_LAT + (Math.random() - 0.5) * 0.04);
      const lng = r.live_telemetry?.current_longitude || (DEFAULT_LON + (Math.random() - 0.5) * 0.06);

      const respPopup = `
        <div class="rakshak-map-infowindow">
          <h4>🚑 ${esc(r.unit_id || 'AMB')}</h4>
          <p style="color:#f59e0b;font-weight:700;">${esc(r.vehicle_type || 'ALS Unit')}</p>
          <div class="info-row">
            <span class="info-label">Speed:</span>
            <span class="info-val">${r.live_telemetry?.speed_kmh || 0} km/h</span>
          </div>
          <div class="info-row">
            <span class="info-label">Status:</span>
            <span class="info-val">${esc(r.operational_status || 'AVAILABLE')}</span>
          </div>
        </div>
      `;

      if (dashboardMapEngine === 'google') {
        const marker = new google.maps.Marker({
          position: { lat, lng },
          map: dashboardMap,
          title: r.unit_id,
          icon: {
            path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
            scale: 5,
            fillColor: '#f59e0b',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 1.5
          }
        });
        marker.addListener('click', () => {
          if (dashboardInfoWindow) {
            dashboardInfoWindow.setContent(respPopup);
            dashboardInfoWindow.open(dashboardMap, marker);
          }
        });
        dashboardMapMarkers.push(marker);
      } else if (dashboardMapEngine === 'leaflet') {
        const icon = L.divIcon({
          className: 'tactical-custom-pin responder',
          html: `
            <div class="pin-core">🚑</div>
            <div class="pin-tag" style="border-color:#f59e0b;color:#fde68a">${esc(r.unit_id)}</div>
          `,
          iconSize: [36, 45],
          iconAnchor: [18, 40]
        });
        const marker = L.marker([lat, lng], { icon }).addTo(dashboardMap);
        marker.bindPopup(respPopup);
        dashboardMapMarkers.push(marker);
      }
    });
  }
}

function highlightCorridorRoute(incId) {
  const inc = incidents.find(x => x.id === incId) || selected || incidents[0];
  if (!inc) return;

  const incLat = inc.location?.latitude ?? inc.lat ?? DEFAULT_LAT;
  const incLng = inc.location?.longitude ?? inc.lng ?? DEFAULT_LON;

  const hosp = selectedHospital || hospitals[0] || { latitude: DEFAULT_LAT + 0.015, longitude: DEFAULT_LON - 0.012 };
  const hospLat = Number(hosp.latitude) || (DEFAULT_LAT + 0.015);
  const hospLng = Number(hosp.longitude) || (DEFAULT_LON - 0.012);

  if (dashboardMapEngine === 'google' && dashboardMap) {
    if (dashboardRouteLayer) dashboardRouteLayer.setMap(null);
    dashboardRouteLayer = new google.maps.Polyline({
      path: [
        { lat: incLat, lng: incLng },
        { lat: (incLat + hospLat) / 2 + 0.002, lng: (incLng + hospLng) / 2 - 0.003 },
        { lat: hospLat, lng: hospLng }
      ],
      geodesic: true,
      strokeColor: '#38bdf8',
      strokeOpacity: 0.9,
      strokeWeight: 4
    });
    dashboardRouteLayer.setMap(dashboardMap);
    dashboardMap.panTo({ lat: incLat, lng: incLng });
  } else if (dashboardMapEngine === 'leaflet' && dashboardMap) {
    if (dashboardRouteLayer) dashboardMap.removeLayer(dashboardRouteLayer);
    dashboardRouteLayer = L.polyline([
      [incLat, incLng],
      [(incLat + hospLat) / 2 + 0.002, (incLng + hospLng) / 2 - 0.003],
      [hospLat, hospLng]
    ], {
      color: '#38bdf8',
      weight: 4,
      dashArray: '6, 8',
      opacity: 0.9
    }).addTo(dashboardMap);
    dashboardMap.panTo([incLat, incLng]);
  }
}

function showHospitalOnMapAndRoute(hospId) {
  const targetHosp = hospitals.find(h => h.id === hospId);
  if (targetHosp) selectedHospital = targetHosp;

  // Switch to Dashboard tab
  const dashTab = document.querySelector('.tab[data-view="incidents"]');
  if (dashTab) dashTab.click();

  setTimeout(() => {
    if (selected) {
      highlightCorridorRoute(selected.id);
    } else if (incidents.length) {
      pick(incidents[0].id);
      highlightCorridorRoute(incidents[0].id);
    }
  }, 200);
}

/* ---------- Live Monitoring Google Maps GIS Engine ---------- */
function initLiveMonitoringMap() {
  const mapElem = $('liveMap');
  if (!mapElem) return;

  // 1. Try Google Maps if SDK is loaded
  if (window.google && window.google.maps && window.google.maps.Map) {
    try {
      if (liveGoogleMap && liveMapEngine === 'google') return;

      liveGoogleMap = new google.maps.Map(mapElem, {
        center: { lat: DEFAULT_LAT, lng: DEFAULT_LON },
        zoom: 13,
        styles: null,
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        backgroundColor: '#ffffff'
      });

      liveMapEngine = 'google';
      liveInfoWindow = new google.maps.InfoWindow();

      const badge = $('liveMapBadge');
      if (badge) {
        badge.textContent = 'GOOGLE MAPS (LIVE)';
        badge.style.color = '#38bdf8';
      }

      renderLiveMonitoringMapMarkers();
      return;
    } catch (err) {
      console.warn('Live monitoring Google Maps init failed, falling back to Leaflet:', err);
    }
  }

  // 2. Fallback to Leaflet (CartoDB Dark Matter / OSM)
  if (window.L && !liveGoogleMap) {
    try {
      liveGoogleMap = L.map(mapElem, {
        center: [DEFAULT_LAT, DEFAULT_LON],
        zoom: 13,
        zoomControl: true
      });

      liveLeafletTileLayers.roadmap = L.tileLayer('https://mt1.google.com/vt/lyrs=m,traffic&x={x}&y={y}&z={z}', {
        attribution: '&copy; Google Maps (Live Traffic)',
        maxZoom: 20
      });

      liveLeafletTileLayers.hybrid = L.tileLayer('https://mt1.google.com/vt/lyrs=y,traffic&x={x}&y={y}&z={z}', {
        attribution: '&copy; Google Maps (Satellite & Live Traffic)',
        maxZoom: 20
      });

      currentActiveLiveTileLayer = liveLeafletTileLayers.roadmap;
      currentActiveLiveTileLayer.addTo(liveGoogleMap);

      liveMapEngine = 'leaflet';

      const badge = $('liveMapBadge');
      if (badge) {
        badge.textContent = 'ONLINE (LIVE GOOGLE TRAFFIC)';
        badge.style.color = '#38bdf8';
      }

      renderLiveMonitoringMapMarkers();
    } catch (lErr) {
      console.error('Live monitoring Leaflet initialization error:', lErr);
    }
  }
}

function invalidateLiveMapSize() {
  setTimeout(() => {
    if (liveMapEngine === 'google' && liveGoogleMap && window.google) {
      google.maps.event.trigger(liveGoogleMap, 'resize');
      if (selected) {
        const lat = selected.location?.latitude ?? selected.lat ?? DEFAULT_LAT;
        const lng = selected.location?.longitude ?? selected.lng ?? DEFAULT_LON;
        liveGoogleMap.panTo({ lat, lng });
      } else {
        liveGoogleMap.panTo({ lat: DEFAULT_LAT, lng: DEFAULT_LON });
      }
    } else if (liveMapEngine === 'leaflet' && liveGoogleMap) {
      liveGoogleMap.invalidateSize();
      if (selected) {
        const lat = selected.location?.latitude ?? selected.lat ?? DEFAULT_LAT;
        const lng = selected.location?.longitude ?? selected.lng ?? DEFAULT_LON;
        liveGoogleMap.panTo([lat, lng]);
      }
    }
  }, 100);
}
window.invalidateLiveMaps = invalidateLiveMapSize;
window.invalidateLiveMapSize = invalidateLiveMapSize;

function setLiveMapType(type, btn) {
  if (btn) {
    document.querySelectorAll('#live-monitoring .map-ctrl-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  const badge = $('liveMapBadge');
  if (badge) {
    if (type === 'hybrid') badge.textContent = 'SATELLITE & TRAFFIC (LIVE)';
    else badge.textContent = 'ONLINE (LIVE GOOGLE TRAFFIC)';
  }

  if (liveMapEngine === 'google' && liveGoogleMap) {
    if (type === 'dark') {
      liveGoogleMap.setMapTypeId('roadmap');
      liveGoogleMap.setOptions({ styles: DARK_MAP_STYLES });
    } else if (type === 'roadmap') {
      liveGoogleMap.setMapTypeId('roadmap');
      liveGoogleMap.setOptions({ styles: null });
    } else if (type === 'hybrid') {
      liveGoogleMap.setMapTypeId('hybrid');
      liveGoogleMap.setOptions({ styles: null });
    }
  } else if (liveMapEngine === 'leaflet' && liveGoogleMap && liveLeafletTileLayers[type]) {
    if (currentActiveLiveTileLayer) liveGoogleMap.removeLayer(currentActiveLiveTileLayer);
    currentActiveLiveTileLayer = liveLeafletTileLayers[type];
    currentActiveLiveTileLayer.addTo(liveGoogleMap);
  }
}

function recenterLiveMap() {
  if (liveMapEngine === 'google' && liveGoogleMap) {
    liveGoogleMap.panTo({ lat: DEFAULT_LAT, lng: DEFAULT_LON });
    liveGoogleMap.setZoom(13);
  } else if (liveMapEngine === 'leaflet' && liveGoogleMap) {
    liveGoogleMap.setView([DEFAULT_LAT, DEFAULT_LON], 13);
  }
}

function renderLiveMonitoringMapMarkers() {
  if (!liveGoogleMap) {
    initLiveMonitoringMap();
    if (!liveGoogleMap) return;
  }

  // Clear previous markers
  if (liveMapEngine === 'google') {
    liveMapMarkers.forEach(m => m.setMap(null));
  } else if (liveMapEngine === 'leaflet') {
    liveMapMarkers.forEach(m => liveGoogleMap.removeLayer(m));
  }
  liveMapMarkers = [];

  const activeInc = (typeof window.getSelectedIncident === 'function' ? window.getSelectedIncident() : null) || selected;
  const incList = (window.liveMonitoringState && window.liveMonitoringState.incidents && window.liveMonitoringState.incidents.length)
    ? window.liveMonitoringState.incidents
    : (incidents || []);

  let targetIncPos = null;
  let targetHospPos = null;
  let targetFleetPos = null;

  // 1. Render Incidents (SOS)
  incList.forEach(inc => {
    const lat = inc.location?.latitude ?? inc.lat ?? DEFAULT_LAT;
    const lng = inc.location?.longitude ?? inc.lng ?? DEFAULT_LON;
    const isCritical = inc.priority?.code === 'L1' || (inc.priority?.score || 0) >= 80;
    const isSelected = activeInc && (activeInc.id === inc.id || activeInc.incidentId === inc.id);
    if (isSelected) targetIncPos = { lat, lng };
    else if (!targetIncPos) targetIncPos = { lat, lng };

    const popupHtml = `
      <div class="rakshak-map-infowindow">
        <h4>🚨 ${esc(inc.id)} <span class="badge ${isCritical ? 'badge-critical' : 'badge-standard'}">${esc(inc.priority?.label || 'STANDARD')}</span></h4>
        <p><strong>${esc(inc.emergencyType || 'Emergency')}</strong></p>
        <div class="info-row"><span class="info-label">Status:</span><span class="info-val">${esc(inc.status || 'REPORTED')}</span></div>
        <div class="info-row"><span class="info-label">Triage:</span><span class="info-val">${esc(inc.triage?.injuredCount || '1')} Casualties</span></div>
        <button class="btn-dispatch" onclick="if(typeof selectMonitoringIncident==='function'){selectMonitoringIncident('${esc(inc.id)}');}else{selected=incidents.find(x=>x.id==='${esc(inc.id)}');renderLiveMonitoring();render();}">
          FOCUS IN LIVE HUD
        </button>
      </div>
    `;

    if (liveMapEngine === 'google') {
      const marker = new google.maps.Marker({
        position: { lat, lng },
        map: liveGoogleMap,
        title: `${inc.id} - ${inc.emergencyType}`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: isSelected ? 13 : 9,
          fillColor: isCritical ? '#ef4444' : '#38bdf8',
          fillOpacity: 1,
          strokeColor: isSelected ? '#38bdf8' : '#ffffff',
          strokeWeight: isSelected ? 3 : 2
        }
      });
      marker.addListener('click', () => {
        if (typeof selectMonitoringIncident === 'function') {
          selectMonitoringIncident(inc.id);
        } else {
          selected = inc;
          renderLiveMonitoring();
          render();
        }
        if (liveInfoWindow) {
          liveInfoWindow.setContent(popupHtml);
          liveInfoWindow.open(liveGoogleMap, marker);
        }
      });
      liveMapMarkers.push(marker);
    } else if (liveMapEngine === 'leaflet') {
      const icon = L.divIcon({
        className: 'tactical-custom-pin ' + (isCritical ? 'critical' : 'standard') + (isSelected ? ' selected-pin' : ''),
        html: `<div class="pin-core" style="${isSelected ? 'transform:scale(1.25);box-shadow:0 0 16px #38bdf8;' : ''}">🚨</div><div class="pin-tag">${esc(inc.id)}</div>`,
        iconSize: [40, 50],
        iconAnchor: [20, 45]
      });
      const marker = L.marker([lat, lng], { icon }).addTo(liveGoogleMap);
      marker.bindPopup(popupHtml);
      marker.on('click', () => {
        if (typeof selectMonitoringIncident === 'function') {
          selectMonitoringIncident(inc.id);
        } else {
          selected = inc;
          renderLiveMonitoring();
          render();
        }
      });
      liveMapMarkers.push(marker);
    }
  });

  // 2. Render Responders (Fleet)
  if (responders && responders.length) {
    responders.slice(0, 8).forEach(r => {
      const lat = r.live_telemetry?.current_latitude || (DEFAULT_LAT + (Math.random() - 0.5) * 0.04);
      const lng = r.live_telemetry?.current_longitude || (DEFAULT_LON + (Math.random() - 0.5) * 0.06);
      if (!targetFleetPos) targetFleetPos = { lat, lng };

      const respPopup = `
        <div class="rakshak-map-infowindow">
          <h4>🚑 ${esc(r.unit_id || 'AMB')}</h4>
          <p style="color:#f59e0b;font-weight:700;">${esc(r.vehicle_type || 'ALS Unit')}</p>
          <div class="info-row"><span class="info-label">Speed:</span><span class="info-val">${r.live_telemetry?.speed_kmh || 0} km/h</span></div>
          <div class="info-row"><span class="info-label">Status:</span><span class="info-val">${esc(r.operational_status || 'AVAILABLE')}</span></div>
        </div>
      `;

      if (liveMapEngine === 'google') {
        const marker = new google.maps.Marker({
          position: { lat, lng },
          map: liveGoogleMap,
          title: r.unit_id,
          icon: {
            path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
            scale: 5,
            fillColor: '#f59e0b',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 1.5
          }
        });
        marker.addListener('click', () => {
          selectedResponder = r;
          if (liveInfoWindow) {
            liveInfoWindow.setContent(respPopup);
            liveInfoWindow.open(liveGoogleMap, marker);
          }
        });
        liveMapMarkers.push(marker);
      } else if (liveMapEngine === 'leaflet') {
        const icon = L.divIcon({
          className: 'tactical-custom-pin responder',
          html: `<div class="pin-core">🚑</div><div class="pin-tag" style="border-color:#f59e0b;color:#fde68a">${esc(r.unit_id)} (${r.live_telemetry?.speed_kmh || 0} km/h)</div>`,
          iconSize: [36, 45],
          iconAnchor: [18, 40]
        });
        const marker = L.marker([lat, lng], { icon }).addTo(liveGoogleMap);
        marker.bindPopup(respPopup);
        liveMapMarkers.push(marker);
      }
    });
  }

  // 3. Render Hospitals
  if (hospitals && hospitals.length) {
    hospitals.slice(0, 6).forEach(h => {
      const lat = Number(h.latitude);
      const lng = Number(h.longitude);
      if (isNaN(lat) || isNaN(lng)) return;
      if (!targetHospPos) targetHospPos = { lat, lng };

      const hospPopup = `
        <div class="rakshak-map-infowindow">
          <h4>🏥 ${esc(h.hospital_name)}</h4>
          <p style="color:#22c55e;font-weight:700;">Trauma: ${esc(h.trauma_capability?.trauma_level || 'Level II')}</p>
          <div class="info-row"><span class="info-label">ICU Beds:</span><span class="info-val">${esc(h.icu_beds_available ?? 'Available')}</span></div>
        </div>
      `;

      if (liveMapEngine === 'google') {
        const marker = new google.maps.Marker({
          position: { lat, lng },
          map: liveGoogleMap,
          title: h.hospital_name,
          icon: {
            path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
            scale: 5,
            fillColor: '#22c55e',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 1.5
          }
        });
        marker.addListener('click', () => {
          if (liveInfoWindow) {
            liveInfoWindow.setContent(hospPopup);
            liveInfoWindow.open(liveGoogleMap, marker);
          }
        });
        liveMapMarkers.push(marker);
      } else if (liveMapEngine === 'leaflet') {
        const icon = L.divIcon({
          className: 'tactical-custom-pin hospital',
          html: `<div class="pin-core">🏥</div><div class="pin-tag" style="border-color:#22c55e;color:#86efac">${esc(h.hospital_name.split(' ')[0])}</div>`,
          iconSize: [36, 45],
          iconAnchor: [18, 40]
        });
        const marker = L.marker([lat, lng], { icon }).addTo(liveGoogleMap);
        marker.bindPopup(hospPopup);
        liveMapMarkers.push(marker);
      }
    });
  }

  // 4. Draw Green Corridor Route if active / incident selected
  if (targetIncPos && targetHospPos) {
    if (liveMapEngine === 'google' && liveGoogleMap) {
      if (liveRouteLayer) liveRouteLayer.setMap(null);
      liveRouteLayer = new google.maps.Polyline({
        path: [
          targetFleetPos || { lat: targetIncPos.lat - 0.01, lng: targetIncPos.lng - 0.01 },
          targetIncPos,
          targetHospPos
        ],
        geodesic: true,
        strokeColor: '#22c55e',
        strokeOpacity: 0.9,
        strokeWeight: 4
      });
      liveRouteLayer.setMap(liveGoogleMap);
    } else if (liveMapEngine === 'leaflet' && liveGoogleMap) {
      if (liveRouteLayer) liveGoogleMap.removeLayer(liveRouteLayer);
      liveRouteLayer = L.polyline([
        [targetFleetPos?.lat || (targetIncPos.lat - 0.01), targetFleetPos?.lng || (targetIncPos.lng - 0.01)],
        [targetIncPos.lat, targetIncPos.lng],
        [targetHospPos.lat, targetHospPos.lng]
      ], {
        color: '#22c55e',
        weight: 4,
        dashArray: '6, 8',
        opacity: 0.9
      }).addTo(liveGoogleMap);
    }
  }
}

// 5. Map Synchronizer for Live Monitoring Selected Incident
window.syncLiveMonitoringMap = function(incident) {
  if (!incident) return;
  const lat = incident.location?.latitude ?? incident.lat;
  const lng = incident.location?.longitude ?? incident.lng;
  if (lat == null || lng == null) return;

  if (liveMapEngine === 'google' && liveGoogleMap && window.google) {
    liveGoogleMap.panTo({ lat: Number(lat), lng: Number(lng) });
    liveGoogleMap.setZoom(14);
  } else if (liveMapEngine === 'leaflet' && liveGoogleMap) {
    liveGoogleMap.setView([Number(lat), Number(lng)], 14);
  }

  // Update focus label in UI
  const focusLabel = document.getElementById('lmMapFocusLabel');
  if (focusLabel) {
    focusLabel.textContent = `🎯 Map Focus: ${incident.id || 'SOS'} · ${incident.location?.address || 'Live Telemetry'}`;
  }

  renderLiveMonitoringMapMarkers();
};

function map() {
  renderDashboardMapMarkers();
}

/* ---------- tab navigation ---------- */
function initTabNavigation() {
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab, .view').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const viewElem = $(t.dataset.view);
    if (viewElem) viewElem.classList.add('active');
    
    if (t.dataset.view === 'incidents') {
      invalidateDashboardMapSize();
    }
    if (t.dataset.view === 'hospitals') {
      setupToolbarListeners();
      renderHospitals();
    }
    if (t.dataset.view === 'responders') {
      setupResponderToolbarListeners();
      renderResponders();
    }
    if (t.dataset.view === 'live-monitoring') {
      invalidateLiveMapSize();
      renderLiveMonitoring();
    }
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initTabNavigation();
    setupToolbarListeners();
    setupResponderToolbarListeners();
    initDashboardMap();
    initLiveMonitoringMap();
  });
} else {
  initTabNavigation();
  setupToolbarListeners();
  setupResponderToolbarListeners();
  initDashboardMap();
  initLiveMonitoringMap();
}

/* ---------- main render (Incidents Dashboard) ---------- */
function render() {
  incidents.sort((a, b) => b.priority?.score - a.priority?.score);
  if ($('total')) $('total').textContent = incidents.length;
  if ($('critical')) $('critical').textContent = incidents.filter(x => x.priority?.code === 'L1').length;
  if ($('active')) $('active').textContent = incidents.filter(x => x.status !== 'CLS').length;
  if ($('last')) $('last').textContent = incidents[0]?.id || '—';
  if ($('count')) $('count').textContent = `${incidents.length} CASES`;

  if ($('list')) {
    $('list').innerHTML = incidents.map(x => {
      const pClass = pc(x.priority);
      const d = new Date(x.timestamp || Date.now());
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const isExpanded = selected?.id === x.id;

      let expandedHudHtml = '';
      if (isExpanded && typeof window.build4CardsHUD === 'function') {
        expandedHudHtml = `
          <div class="incident-expanded-hud" style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.1);animation:fadeIn 0.2s ease-in-out;">
            ${window.build4CardsHUD(x)}
          </div>
        `;
      }

      return `<div class="incident ${pClass} ${isExpanded ? 'sel expanded' : ''}" onclick="toggleIncidentExpand('${esc(x.id)}', event)">
        <div class="row" style="display:flex;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="color:#38bdf8;font-size:11px;font-weight:900;">${isExpanded ? '▼' : '▶'}</span>
            <span class="id">${esc(x.id)}</span>
          </div>
          <span class="badge ${pClass}">${esc(x.priority?.label || 'STANDARD')}</span>
        </div>
        <div class="type" style="font-weight:700;margin:6px 0 4px;">${esc(x.emergencyType || x.type || 'Emergency Incident')}</div>
        <div class="meta" style="font-size:11px;color:#94a3b8;display:flex;justify-content:space-between;">
          <span>${esc(x.status || 'REPORTED')}</span>
          <span>${time} · ${esc(x.triage?.injuredCount || '1')} casualties</span>
        </div>
        ${expandedHudHtml}
      </div>`;
    }).join('') || '<div class="empty" style="min-height:auto">No emergencies in queue.</div>';
  }

  map();
  detail();
}

/* ---------- select / expand incident ---------- */
function toggleIncidentExpand(id, evt) {
  pick(id);
}

function pick(id) {
  selected = incidents.find(x => x.id === id);
  window.selected = selected;
  window.incidents = incidents;
  render();
  renderHospitals();
  if (typeof window.renderLiveMonitoringUI === 'function') {
    window.renderLiveMonitoringUI();
  }
  if (selected) {
    const lat = selected.location?.latitude ?? selected.lat ?? DEFAULT_LAT;
    const lng = selected.location?.longitude ?? selected.lng ?? DEFAULT_LON;
    if (dashboardMapEngine === 'google' && dashboardMap) {
      dashboardMap.panTo({ lat, lng });
    } else if (dashboardMapEngine === 'leaflet' && dashboardMap) {
      dashboardMap.panTo([lat, lng]);
    }
  }
}

/* ---------- incident detail (Redesigned Compact Operational Console) ---------- */

window.toggleIcAccordion = function(contentId, btn) {
  const el = document.getElementById(contentId);
  if (!el) return;
  const isOpen = el.classList.contains('open');
  if (isOpen) {
    el.classList.remove('open');
    el.style.display = 'none';
    if (btn) {
      const arrow = btn.querySelector('.ic-arrow');
      if (arrow) arrow.textContent = '›';
      const label = btn.querySelector('.ic-btn-label');
      if (label && label.dataset.closedText) label.textContent = label.dataset.closedText;
    }
  } else {
    el.classList.add('open');
    el.style.display = 'block';
    if (btn) {
      const arrow = btn.querySelector('.ic-arrow');
      if (arrow) arrow.textContent = '▾';
      const label = btn.querySelector('.ic-btn-label');
      if (label && label.dataset.openText) label.textContent = label.dataset.openText;
    }
  }
};

window.focusIncidentLocation = function(lat, lng) {
  if (lat == null || lng == null) {
    if (selected) {
      lat = selected.location?.latitude ?? selected.lat ?? DEFAULT_LAT;
      lng = selected.location?.longitude ?? selected.lng ?? DEFAULT_LON;
    } else {
      lat = DEFAULT_LAT;
      lng = DEFAULT_LON;
    }
  }
  if (dashboardMapEngine === 'google' && dashboardMap) {
    dashboardMap.panTo({ lat: Number(lat), lng: Number(lng) });
    if (dashboardMap.setZoom) dashboardMap.setZoom(16);
  } else if (dashboardMapEngine === 'leaflet' && dashboardMap) {
    dashboardMap.panTo([Number(lat), Number(lng)]);
    if (dashboardMap.setZoom) dashboardMap.setZoom(16);
  }
};

window.trackSelectedAmbulance = function(ambId) {
  const lmTab = document.querySelector('.nav-link[data-view="live-monitoring"]');
  if (lmTab) {
    lmTab.click();
    if (window.selectMonitoringIncident && selected) {
      window.selectMonitoringIncident(selected.id || selected.incidentId);
    }
  } else {
    alert(`Tracking ${ambId || 'Ambulance'} live on GIS grid.`);
  }
};

window.openSelectedHospitalDetails = function(hospId) {
  const hospTab = document.querySelector('.nav-link[data-view="hospitals"]');
  if (hospTab) {
    hospTab.click();
  } else {
    alert(`Viewing hospital details for ${hospId || 'destination facility'}.`);
  }
};

function detail() {
  if (!$('detail')) return;
  if (!selected) {
    $('detail').innerHTML = '<div class="empty">Select an incident from the queue to view live command console.</div>';
    return;
  }

  const pCode = selected.priority?.code || (selected.priority?.score >= 80 ? 'L1' : 'L2');
  const pLabel = selected.priority?.label || (pCode === 'L1' ? 'CRITICAL' : 'HIGH');
  const isCrit = pCode === 'L1';
  const headerClass = isCrit ? 'crit' : 'high';
  const sevDot = isCrit ? '🔴' : '🟠';

  // Address and Coordinates (Human readable primary, coords secondary)
  const lat = selected.location?.latitude ?? selected.lat;
  const lng = selected.location?.longitude ?? selected.lng;
  const address = selected.location?.address || selected.address || (selected.location?.landmark ? `${selected.location.landmark}, Bhilai` : 'Supela Chowk, Bhilai');
  const latLngStr = (lat != null && lng != null) ? `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}` : 'Live GPS Ingested';

  // Humanize Current Stage
  const rawState = selected.state || selected.stage || selected.status || 'ACTIVE';
  let humanStage = 'PRE-ALERT SENT';
  if (rawState === 'AMBULANCE_EN_ROUTE' || rawState === 'EN_ROUTE') humanStage = 'AMBULANCE EN ROUTE';
  else if (rawState === 'AMBULANCE_DISPATCHED' || rawState === 'DISPATCHED') humanStage = 'DISPATCHED';
  else if (rawState === 'AMBULANCE_AT_SCENE' || rawState === 'ARRIVED') humanStage = 'AT SCENE';
  else if (rawState === 'INCIDENT_CLOSED' || rawState === 'RESOLVED') humanStage = 'RESOLVED';
  else if (rawState.includes('PREALERT')) humanStage = 'HOSPITAL PRE-ALERT';
  else humanStage = rawState.replace(/_/g, ' ');

  // Casualties and Triage summary
  const victimsCount = selected.triage?.injuredCount || selected.injured || 2;
  const severeBleed = Boolean(selected.triage?.severeBleeding || (selected.triage?.criticalCondition && String(selected.triage.criticalCondition).toLowerCase().includes('bleed')));
  const headTrauma = Boolean(selected.responseNote && String(selected.responseNote).toLowerCase().includes('head'));
  const consciousSummary = selected.triage?.consciousness || (isCrit ? '1 Unconscious, 1 Alert' : 'Conscious & Oriented');
  
  // Ambulance Data
  const amb = selected.dispatch?.ambulance || selected.assignedAmbulanceDetails || {};
  const ambId = amb.id || selected.assignedAmbulance || 'AMB-108-10';
  const ambDriver = amb.driverName || amb.driver || 'Santosh Nishad';
  const ambRole = amb.role || 'Driver / Paramedic';
  const ambEta = amb.etaMinutes || amb.eta || 6;
  const ambDist = amb.distanceKm || amb.distance || (amb.distance_km ? amb.distance_km : 3.85);
  const ambSpeed = amb.speedKmh || amb.speed || 48;
  const ambStatus = (amb.status || selected.stage || 'EN_ROUTE').replace(/_/g, ' ');
  const ambEquip = amb.equipment || 'ALS • Ventilator Ready';
  const whyAmb = amb.why || selected.whyAmbulance || selected.dispatchFactors?.ambulance || [
    'Available in immediate sector',
    `${ambDist} km away • Shortest ETA (${ambEta} min)`,
    'Required equipment available (ALS & Ventilator)'
  ];

  // Hospital Data
  const hosp = selected.dispatch?.hospital || selected.destinationDetails || {};
  const hospName = hosp.shortName || hosp.name || selected.destinationHospital || 'Shri Shankaracharya';
  const hospStatus = (hosp.status || 'PREALERT_SENT').replace(/_/g, ' ');
  const hospTtac = hosp.ttacMinutes || hosp.ttac || 18;
  const hospIcu = hosp.availableIcu ?? hosp.icu_beds_available ?? 4;
  const hospEr = hosp.availableEr ?? hosp.emergency_beds_available ?? 6;
  const hospCap = hosp.totalCapacityPercent ?? hosp.capacity ?? 72;
  const hospIcuLocked = hosp.icuLocked ?? true;
  const whyHosp = hosp.why || selected.whyHospital || selected.dispatchFactors?.hospital || [
    'ICU beds available & pre-reserved',
    'Suitable Level 1 trauma facility with 24/7 OT',
    `Optimal TTAC (${hospTtac} min) at ${hospCap}% capacity`
  ];

  // Structured Response Summary
  const emergencyType = selected.emergencyType || selected.type || 'Road Traffic Accident (Polytrauma)';
  const responseSummaryIncident = selected.responseNote?.split('.')[0] || emergencyType;
  const reportedInjuries = severeBleed ? 'Severe bleeding • Head trauma' : (selected.details || 'Polytrauma / Multiple injuries');
  const responseSummaryAction = `ALS unit ${ambId} en route`;

  // System status flags
  const role = selected.role || (selected.stage === 'DIRECT_CALLER_CRITICAL' ? 'DIRECT CALLER' : 'BYSTANDER');
  const commState = selected.commState || (selected.triage?.injuredCount ? 'SYNCHRONIZED' : 'PARTIAL');
  const commLabel = commState === 'SYNCHRONIZED' ? '✓ SYNCHRONIZED' : '⚠ PARTIAL LINK';
  const timeStr = new Date(selected.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // 8 Response Timeline Milestones
  const s1_time = timeStr;
  const s2_done = Boolean(lat || lng);
  const s3_done = Boolean(ambId);
  const s4_done = Boolean(ambId && (rawState === 'DISPATCHED' || rawState === 'EN_ROUTE' || rawState === 'AMBULANCE_EN_ROUTE' || rawState === 'ARRIVED'));
  const s5_done = rawState === 'AMBULANCE_AT_SCENE' || rawState === 'ARRIVED' || rawState === 'RESOLVED';
  const s5_active = !s5_done && (s4_done || rawState === 'EN_ROUTE' || rawState === 'AMBULANCE_EN_ROUTE');
  const s6_done = Boolean(hospName);
  const s7_done = s6_done && (hospStatus.includes('SENT') || hospStatus.includes('CONFIRMED') || rawState.includes('HOSPITAL'));
  const s7_active = !s7_done && s6_done;
  const s8_done = rawState === 'ARRIVED' || rawState === 'AMBULANCE_AT_SCENE' || rawState === 'RESOLVED';

  const milestones = [
    { label: 'SOS Triggered', time: s1_time, status: 'completed' },
    { label: 'Location Verified', time: s1_time, status: s2_done ? 'completed' : 'pending' },
    { label: 'Ambulance Assigned', time: '', status: s3_done ? 'completed' : 'pending' },
    { label: 'Ambulance Dispatched', time: '', status: s4_done ? 'completed' : (s3_done ? 'active' : 'pending') },
    { label: 'Ambulance En Route', time: s5_active ? 'NOW' : '', status: s5_done ? 'completed' : (s5_active ? 'active' : 'pending') },
    { label: 'Hospital Selected', time: '', status: s6_done ? 'completed' : 'pending' },
    { label: 'Hospital Notified', time: s7_active ? 'NOW' : '', status: s7_done ? 'completed' : (s7_active ? 'active' : 'pending') },
    { label: 'Arrived', time: '', status: s8_done ? 'completed' : 'pending' }
  ];

  const timelineHtml = milestones.map(m => {
    let icon = '○';
    let titleHtml = m.label;
    if (m.status === 'completed') {
      icon = '✓';
    } else if (m.status === 'active') {
      icon = '🔵';
      titleHtml = `<b>${m.label.toUpperCase()}</b>`;
    }
    return `
      <div class="ic-step-row ${m.status}">
        <div style="display:flex;align-items:center;gap:6px;">
          <span>${icon}</span>
          <span>${titleHtml}</span>
        </div>
        ${m.time ? `<span style="font-family:monospace;font-size:10px;">${m.time}</span>` : ''}
      </div>
    `;
  }).join('');

  $('detail').innerHTML = `
    <div class="ic-container">
      <!-- ============================================================
           SECTION 1: INCIDENT & LIVE SITUATION (COMMAND HEADER)
           ============================================================ -->
      <div class="ic-section-card ${headerClass}" style="border: 2px solid ${isCrit ? '#ef4444' : '#f97316'}; padding: 12px 16px; border-radius: 10px; background: linear-gradient(135deg, ${isCrit ? '#2b0b11' : '#2b1408'}, #131c31);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="ic-chip ${isCrit ? 'crit' : 'warn'}">${sevDot} ${esc(pLabel)}</span>
            <span style="font-weight:900;font-size:15px;color:#f8fafc;letter-spacing:0.04em;">${esc(selected.id || selected.incidentId)}</span>
          </div>
          <span class="ic-chip info">${esc(humanStage)}</span>
        </div>
        
        <div style="font-size:13.5px;font-weight:800;color:#f1f5f9;margin-bottom:6px;">
          ${esc(emergencyType)}
        </div>
        
        <div style="font-size:11px;color:#94a3b8;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:8px;">
          <span>${victimsCount} casualties • ${severeBleed ? 'Severe bleeding' : 'Stable'}</span>
          <span style="color:#38bdf8;cursor:pointer;font-weight:700;" onclick="focusIncidentLocation(${lat}, ${lng})">📍 ${esc(address)}</span>
        </div>

        <!-- Live Current Situation Strip inside Section 1 -->
        <div style="background:rgba(56,189,248,0.1);border:1.5px solid rgba(56,189,248,0.4);border-left:5px solid #38bdf8;padding:8px 12px;border-radius:6px;font-size:11.5px;color:#f8fafc;line-height:1.45;">
          <div style="font-size:9.5px;font-weight:900;color:#38bdf8;letter-spacing:0.06em;margin-bottom:3px;">🔵 CURRENT SITUATION</div>
          🚑 Ambulance <b>${esc(ambId)}</b> is en route • <b>ETA ${esc(ambEta)} min</b> (${esc(ambDist)} km away)<br>
          🏥 Hospital pre-alert sent to <b>${esc(hospName)}</b> • ${hospIcuLocked ? '✓ ICU reserved' : 'Pending ICU bed lock'}
        </div>
      </div>

      <!-- ============================================================
           SECTION 2: 4-CARD SUMMARY (INCIDENT · LOCATION · AMBULANCE · HOSPITAL)
           ============================================================ -->
      <div class="ic-section">
        <div class="ic-section-title">
          <span>📊 4-Card Operational Summary</span>
          <span class="ic-tag" style="background:rgba(56,189,248,0.15);color:#38bdf8;">LIVE TILES</span>
        </div>
        <div class="ic-4card-grid">
          <!-- CARD 1: INCIDENT -->
          <div class="ic-card incident-card">
            <div class="ic-card-header">
              <span>🚨 INCIDENT</span>
              <span class="ic-chip ${isCrit ? 'crit' : 'warn'}">${esc(pLabel)}</span>
            </div>
            <div style="font-weight:800;font-size:12px;color:#f1f5f9;margin-top:2px;">
              ${esc(selected.type || emergencyType.split('(')[0].trim())}
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">
              <span class="ic-chip ${isCrit ? 'crit' : 'warn'}">${victimsCount} CASUALTIES</span>
              ${isCrit ? '<span class="ic-chip crit">🔴 1 CRITICAL</span>' : ''}
              ${victimsCount > 1 ? '<span class="ic-chip ok">🟢 1 STABLE</span>' : ''}
            </div>
          </div>

          <!-- CARD 2: LOCATION -->
          <div class="ic-card location-card">
            <div class="ic-card-header">
              <span>📍 LOCATION</span>
              <span style="color:#4ade80;font-size:9px;font-weight:800;">● LIVE GPS</span>
            </div>
            <div style="font-weight:800;font-size:12px;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">
              ${esc(address)}
            </div>
            <div style="font-size:10px;color:#94a3b8;display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
              <span>Updated 3s ago</span>
              <button class="ic-btn-link" onclick="focusIncidentLocation(${lat}, ${lng})">[ View on Map ]</button>
            </div>
          </div>

          <!-- CARD 3: AMBULANCE -->
          <div class="ic-card ambulance-card">
            <div class="ic-card-header">
              <span style="color:#38bdf8;font-weight:900;">🚑 ${esc(ambId)}</span>
              <span class="ic-chip info">${esc(ambStatus)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:2px;">
              <div>
                <div style="font-size:9px;color:#94a3b8;font-weight:700;">ETA</div>
                <div class="ic-hero-val cyan">${esc(ambEta)} <span style="font-size:11px;font-weight:600;">min</span></div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:9px;color:#94a3b8;font-weight:700;">DISTANCE</div>
                <div style="font-size:13px;font-weight:800;color:#f1f5f9;">${esc(ambDist)} <span style="font-size:10px;color:#94a3b8;">km</span></div>
              </div>
            </div>
            <div style="font-size:10px;color:#94a3b8;display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
              <span>${esc(ambDriver)} (${esc(ambRole)})</span>
              <button class="ic-btn-link" onclick="trackSelectedAmbulance('${esc(ambId)}')">[ Track ]</button>
            </div>
          </div>

          <!-- CARD 4: HOSPITAL -->
          <div class="ic-card hospital-card">
            <div class="ic-card-header">
              <span style="color:#4ade80;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px;">🏥 ${esc(hospName)}</span>
              <span class="ic-chip ok">${esc(hospStatus)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:2px;">
              <div>
                <div style="font-size:9px;color:#94a3b8;font-weight:700;">TTAC</div>
                <div class="ic-hero-val green">${esc(hospTtac)} <span style="font-size:11px;font-weight:600;">min</span></div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:9px;color:#94a3b8;font-weight:700;">ICU FREE</div>
                <div style="font-size:13px;font-weight:800;color:#4ade80;">${esc(hospIcu)} <span style="font-size:10px;color:#94a3b8;">/ ER ${esc(hospEr)}</span></div>
              </div>
            </div>
            <div style="font-size:10px;color:#94a3b8;display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
              <span>Cap ${esc(hospCap)}% ${hospIcuLocked ? '· <span style="color:#4ade80;">✓ Locked</span>' : ''}</span>
              <button class="ic-btn-link" onclick="openSelectedHospitalDetails('${esc(hosp.id)}')">[ Details ]</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ============================================================
           SECTION 3: CASUALTY TRIAGE & RESPONSE SUMMARY
           ============================================================ -->
      <div class="ic-section">
        <div class="ic-section-box">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:6px;">
            <span style="font-weight:900;font-size:11px;letter-spacing:0.06em;color:#38bdf8;">🩺 CASUALTY TRIAGE & RESPONSE SUMMARY</span>
            <span class="ic-chip info">${victimsCount} CASUALTIES</span>
          </div>

          <!-- Casualty rows -->
          <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:8px;">
            <div style="font-size:11.5px;color:#f8fafc;display:flex;align-items:center;gap:6px;">
              <span>🔴</span>
              <span><b>Patient 1:</b> ${severeBleed ? 'Severe bleeding • Head trauma (Critical)' : 'Trauma assessment active'}</span>
            </div>
            ${victimsCount > 1 ? `
            <div style="font-size:11.5px;color:#cbd5e1;display:flex;align-items:center;gap:6px;">
              <span>🟡</span>
              <span><b>Patient 2:</b> Stable • Conscious</span>
            </div>` : ''}
          </div>

          <!-- Structured key-value response table -->
          <div style="display:grid;grid-template-columns:90px 1fr;row-gap:4px;font-size:11px;background:rgba(0,0,0,0.25);padding:8px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.05);margin-bottom:8px;">
            <span style="color:#94a3b8;font-weight:700;">Incident:</span>
            <span style="color:#f1f5f9;">${esc(responseSummaryIncident)}</span>
            <span style="color:#94a3b8;font-weight:700;">Casualties:</span>
            <span style="color:#f1f5f9;">${victimsCount} (${isCrit ? '1 critical' : 'standard'}${victimsCount > 1 ? ', 1 stable' : ''})</span>
            <span style="color:#94a3b8;font-weight:700;">Injuries:</span>
            <span style="color:#f1f5f9;">${esc(reportedInjuries)}</span>
            <span style="color:#94a3b8;font-weight:700;">Response:</span>
            <span style="color:#38bdf8;font-weight:800;">${esc(responseSummaryAction)}</span>
          </div>

          <!-- Progressive Disclosure for 5-Question Assessment & Why Factors -->
          <button class="ic-accordion-btn" onclick="toggleIcAccordion('icFullAssessment', this)">
            <span class="ic-btn-label" data-closed-text="▾ View Clinical Assessment & Decision Factors" data-open-text="▴ Hide Clinical Assessment & Decision Factors">▾ View Clinical Assessment & Decision Factors</span>
            <span class="ic-arrow">›</span>
          </button>
          <div id="icFullAssessment" class="ic-accordion-body">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:10.5px;margin-bottom:8px;">
              <div><b>Consciousness:</b><br><span style="color:#94a3b8">${esc(consciousSummary)}</span></div>
              <div><b>Breathing:</b><br><span style="color:#94a3b8">${selected.triage?.breathingDifficulty ? 'Labored / Rapid' : 'Normal'}</span></div>
              <div><b>Bleeding:</b><br><span style="color:${severeBleed ? '#f87171' : '#94a3b8'}">${severeBleed ? 'Severe / Active' : 'Controlled'}</span></div>
              <div><b>Mobility:</b><br><span style="color:#94a3b8">${esc(selected.triage?.mobility || 'Immobilized')}</span></div>
            </div>
            
            <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:6px;font-size:10.5px;">
              <div style="font-weight:800;color:#38bdf8;margin-bottom:4px;">🧠 Dispatch Decision Factors:</div>
              <div style="display:flex;flex-direction:column;gap:2px;color:#a7f3d0;margin-bottom:4px;">
                ${whyAmb.map(f => `<div>🚑 ✓ ${esc(f)}</div>`).join('')}
                ${whyHosp.map(f => `<div>🏥 ✓ ${esc(f)}</div>`).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ============================================================
           SECTION 4: TIMELINE & REAL-TIME EVENT STREAM
           ============================================================ -->
      <div class="ic-section">
        <div class="ic-section-box">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:6px;">
            <span style="font-weight:900;font-size:11px;letter-spacing:0.06em;color:#38bdf8;">⏱️ RESPONSE TIMELINE & LIVE STREAM</span>
            <span class="ic-chip info">${esc(humanStage)}</span>
          </div>

          <!-- Milestones Progression -->
          <div style="display:flex;flex-direction:column;gap:2px;margin-bottom:10px;">
            ${timelineHtml}
          </div>

          <!-- Embedded Real-time event log -->
          <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:8px 10px;margin-bottom:8px;">
            <div style="font-size:9.5px;font-weight:900;color:#38bdf8;letter-spacing:0.05em;margin-bottom:4px;display:flex;justify-content:space-between;">
              <span>🔔 REAL-TIME STREAM</span>
              <span style="color:#4ade80;">● LIVE</span>
            </div>
            <div class="ic-stream-item"><span style="color:#38bdf8;font-family:monospace;font-size:10px;font-weight:700;">${timeStr}</span><span>🚑 Ambulance en route • ETA ${esc(ambEta)} min</span></div>
            <div class="ic-stream-item"><span style="color:#4ade80;font-family:monospace;font-size:10px;font-weight:700;">${timeStr}</span><span>🏥 Hospital pre-alert sent (${esc(hospName)})</span></div>
            <div class="ic-stream-item"><span style="color:#38bdf8;font-family:monospace;font-size:10px;font-weight:700;">${timeStr}</span><span>🚑 Ambulance assigned (${esc(ambId)})</span></div>
          </div>

          <!-- Action buttons inside Section 4 footer -->
          <div class="actions" style="margin-top:8px;">
            <button class="primary" onclick="alert('Access Hospital Intelligence tab to dispatch via AI matching.')">⚡ SMART DISPATCH</button>
            <button onclick="alert('Manual assignment action active.')">🚑 ASSIGN UNIT MANUAL</button>
            <button class="danger" onclick="alert('Incident resolved.')">✕ CLOSE INCIDENT</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

/* ============================================================
   HOSPITAL CAPABILITY DATABASE ENGINE (MATCHING REFERENCE UI)
   ============================================================ */

function getHospitalStatus(h) {
  const l = h.live_status || {};
  const c = h.capabilities || {};
  if (l.intake_status) return l.intake_status.toLowerCase();
  
  const icu = l.icu_beds_available;
  const er = l.emergency_beds_available;
  const ot = l.operation_theatre_available;

  if (icu === 0 && (er !== null && er <= 2)) return 'diverted';
  if (icu === 1 || (icu !== null && er !== null && er <= 3)) return 'limited';
  if (icu > 1 || (er !== null && er > 3) || (icu !== null && ot === true)) return 'accepting';
  if (icu === null && er === null) return 'unknown';
  if (c.emergency_department === true || c.trauma_level === 1) return 'accepting';
  return 'unknown';
}

function getHospitalDistance(h) {
  const lat = selected?.location?.latitude || DEFAULT_LAT;
  const lon = selected?.location?.longitude || DEFAULT_LON;
  if (!h.latitude || !h.longitude) return 5.0;
  return km(lat, lon, h.latitude, h.longitude);
}

function getHospitalETA(d) {
  return Math.max(4, Math.round(d / 0.55 + 3));
}

function getRecommendedHospitalId() {
  if (selected) {
    const r = ranks();
    if (r && r.length > 0) return r[0].h.id;
  }
  return 'DURG-P-001'; // Default S.S. Hospital
}

/* ---------- Top Summary Strip ---------- */
function renderHospitalSummary() {
  if (!hospitals.length) return;
  const total = hospitals.length;
  let accepting = 0, limited = 0, diverted = 0, unknown = 0;

  hospitals.forEach(h => {
    const s = getHospitalStatus(h);
    if (s === 'accepting') accepting++;
    else if (s === 'limited') limited++;
    else if (s === 'diverted') diverted++;
    else unknown++;
  });

  if ($('summaryTotal')) $('summaryTotal').textContent = total;
  if ($('summaryAccepting')) $('summaryAccepting').textContent = accepting;
  if ($('summaryLimited')) $('summaryLimited').textContent = limited;
  if ($('summaryDiverted')) $('summaryDiverted').textContent = diverted;
  if ($('summaryUnknown')) $('summaryUnknown').textContent = unknown;
}

/* ---------- Filter and Sort Engine ---------- */
function getFilteredHospitals() {
  let list = [...hospitals];
  const q = hospSearchQuery.trim().toLowerCase();

  if (q) {
    list = list.filter(h => {
      const name = (h.hospital_name || '').toLowerCase();
      const addr = (h.address || '').toLowerCase();
      const id = (h.id || '').toLowerCase();
      const specs = (h.specialties || []).join(' ').toLowerCase();
      return name.includes(q) || addr.includes(q) || id.includes(q) || specs.includes(q);
    });
  }

  if (filterDistrict) {
    const d = filterDistrict.toLowerCase();
    list = list.filter(h => (h.district || '').toLowerCase().includes(d) || (h.address || '').toLowerCase().includes(d));
  }

  if (filterType) {
    list = list.filter(h => (h.type || '').toLowerCase() === filterType.toLowerCase());
  }

  if (filterTrauma) {
    if (filterTrauma === '1') list = list.filter(h => h.capabilities?.trauma_level === 1);
    else if (filterTrauma === 'any') list = list.filter(h => h.capabilities?.trauma_level != null);
  }

  if (filterICU) {
    if (filterICU === 'avail') list = list.filter(h => (h.live_status?.icu_beds_available || 0) > 0);
    else if (filterICU === 'yes') list = list.filter(h => h.capabilities?.icu === true || h.live_status?.icu_beds_available != null);
  }

  if (filterMore) {
    if (filterMore === 'ot') list = list.filter(h => h.live_status?.operation_theatre_available === true);
    else if (filterMore === 'vent') list = list.filter(h => (h.live_status?.ventilators_available || 0) > 0);
    else if (filterMore === 'blood') list = list.filter(h => h.capabilities?.blood_bank === true || h.live_status?.blood_bank_available === true);
    else if (filterMore === 'burn') list = list.filter(h => h.capabilities?.burn_unit === true);
    else if (filterMore === 'neuro') list = list.filter(h => h.capabilities?.neurosurgery === true || h.live_status?.neurosurgeon_available === true);
    else if (filterMore === 'ortho') list = list.filter(h => h.capabilities?.orthopedics === true || h.live_status?.orthopedic_surgeon_available === true);
  }

  // Sorting
  if (filterSort === 'nearest') {
    list.sort((a, b) => getHospitalDistance(a) - getHospitalDistance(b));
  } else if (filterSort === 'score') {
    list.sort((a, b) => {
      const sa = (a.capabilities?.trauma_level === 1 ? 40 : 0) + (a.live_status?.icu_beds_available || 0) * 5;
      const sb = (b.capabilities?.trauma_level === 1 ? 40 : 0) + (b.live_status?.icu_beds_available || 0) * 5;
      return sb - sa;
    });
  } else if (filterSort === 'icu') {
    list.sort((a, b) => (b.live_status?.icu_beds_available || 0) - (a.live_status?.icu_beds_available || 0));
  } else if (filterSort === 'er') {
    list.sort((a, b) => (b.live_status?.emergency_beds_available || 0) - (a.live_status?.emergency_beds_available || 0));
  } else if (filterSort === 'name') {
    list.sort((a, b) => (a.hospital_name || '').localeCompare(b.hospital_name || ''));
  }

  return list;
}

/* ---------- Hospital Card HTML ---------- */
function renderSingleHospitalCard(h, isRec) {
  const l = h.live_status || {};
  const c = h.capabilities || {};
  const status = getHospitalStatus(h);
  const d = getHospitalDistance(h);
  const eta = getHospitalETA(d);
  const isSelected = selectedHospital && selectedHospital.id === h.id;

  // Capacity values
  const icuVal = l.icu_beds_available === null ? '—' : l.icu_beds_available;
  const erVal = l.emergency_beds_available === null ? '—' : l.emergency_beds_available;
  const ventVal = l.ventilators_available === null ? '—' : l.ventilators_available;
  const otAvailable = l.operation_theatre_available === true;
  const otUnavailable = l.operation_theatre_available === false;
  const otStatusText = otAvailable ? '✓ Available' : (otUnavailable ? '✕ None' : '— Standby');

  // Capability Chips - quiet, subtle pills
  const chips = [];
  if (c.trauma_level === 1) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Trauma L1</span>');
  else if (c.emergency_department === true) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Emergency</span>');
  
  if (c.orthopedics === true) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Ortho</span>');
  if (c.neurosurgery === true) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Neuro</span>');
  if (c.emergency_surgery === true && chips.length < 3) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Surgery</span>');
  if (c.burn_unit === true && chips.length < 3) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Burn</span>');
  if (c.polytrauma === true && chips.length < 3) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Polytrauma</span>');

  const visibleChips = chips.slice(0, 3);
  const totalSpecialties = (h.specialties?.length || 0);
  if (totalSpecialties > 2) {
    visibleChips.push(`<span class="hosp-chip more">+${totalSpecialties - 2} more</span>`);
  }

  // Address formatting - clean, max 2 lines
  const rawAddr = h.address || 'Chhattisgarh';
  const cleanAddr = rawAddr.replace(/,\s*Chhattisgarh\s*\d*/i, '').trim();

  return `<article class="hosp-card ${isRec ? 'recommended' : ''} ${isSelected ? 'selected' : ''}" onclick="selectHospital('${esc(h.id)}')">
    <div class="hosp-card-topbar">
      <div style="display:flex;gap:6px;align-items:center;">
        ${isSelected ? '<span class="badge-selected">★ SELECTED</span>' : ''}
        ${isRec ? '<span class="badge-rec">★ RECOMMENDED</span>' : ''}
      </div>
      <span class="hosp-distance-tag">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 21s-8-7.5-8-12a8 8 0 1 1 16 0c0 4.5-8 12-8 12z"/><circle cx="12" cy="9" r="3"/></svg>
        ${d.toFixed(1)} km
      </span>
    </div>

    <div class="hosp-card-header">
      <h3 class="hosp-card-title">${esc(h.hospital_name)}</h3>
      <div class="hosp-card-meta">${esc(h.id)} &nbsp;•&nbsp; <span style="color:#38bdf8;font-weight:700;">${esc(h.district || 'Raipur/Durg')}</span> &nbsp;•&nbsp; ${esc((h.type || 'PRIVATE').toUpperCase())}</div>
      <p class="hosp-card-address">${esc(cleanAddr)}</p>
    </div>

    <div class="hosp-status-row">
      <span class="hosp-status-pill ${status}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="8"/></svg>
        ${status.toUpperCase()}
      </span>
      <span class="hosp-eta-val">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 17h4M19 17h2a1 1 0 0 0 1-1v-3.5a2 2 0 0 0-.6-1.4l-2.8-2.8A2 2 0 0 0 17.2 8H15V6a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
        <b>${eta} min</b> ETA
      </span>
    </div>

    <!-- Critical Capacity Compact Region -->
    <div class="hosp-critical-capacity">
      <div class="cap-metric-box">
        <div class="cap-metric-val ${icuVal === 0 ? 'red' : (icuVal === '—' ? 'slate' : 'green')}">${icuVal}</div>
        <div class="cap-metric-lbl">ICU available</div>
      </div>
      <div class="cap-metric-box">
        <div class="cap-metric-val ${erVal === 0 ? 'red' : (erVal === '—' ? 'slate' : 'green')}">${erVal}</div>
        <div class="cap-metric-lbl">ER available</div>
      </div>
      <div class="cap-metric-box">
        <div class="cap-metric-val ${ventVal === 0 ? 'red' : (ventVal === '—' ? 'slate' : '')}">${ventVal}</div>
        <div class="cap-metric-lbl">Ventilators</div>
      </div>
      <div class="cap-metric-box">
        <div class="cap-metric-val ${otAvailable ? 'green' : (otUnavailable ? 'red' : 'slate')}" style="font-size:14px;letter-spacing:0.5px;">OT</div>
        <div class="cap-metric-lbl">${otStatusText}</div>
      </div>
    </div>

    <div class="hosp-chips-row">
      ${visibleChips.join('')}
    </div>

    <div class="hosp-card-footer">
      <span class="hosp-view-link">
        View Details &nbsp;→
      </span>
    </div>
  </article>`;
}

/* ---------- Select Hospital for Detail Panel ---------- */
function selectHospital(id) {
  const h = hospitals.find(x => x.id === id);
  if (h) {
    selectedHospital = h;
    renderHospitalCards();
    renderDetailPanel();
    const content = document.querySelector('#hospitalDetailPanel .details-content');
    if (content) content.scrollTop = 0;
  }
}

/* ---------- Render Cards Grid ---------- */
function renderHospitalCards() {
  const gridElem = $('hospitalCardGrid');
  if (!gridElem) return;

  const filtered = getFilteredHospitals();
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = 1;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(startIdx, startIdx + PAGE_SIZE);
  const recId = getRecommendedHospitalId();

  if (pageItems.length === 0) {
    gridElem.innerHTML = '<div class="empty" style="grid-column: 1/-1;">No hospitals match your active filters.</div>';
  } else {
    gridElem.className = `hosp-cards-grid ${viewMode === 'list' ? 'list-view' : ''}`;
    gridElem.innerHTML = pageItems.map(h => renderSingleHospitalCard(h, h.id === recId)).join('');
  }

  renderPagination(totalCount, startIdx, pageItems.length);
}

/* ---------- Render Pagination Bar ---------- */
function renderPagination(totalCount, startIdx, currentCount) {
  const infoElem = $('paginationInfo');
  const ctrlElem = $('paginationControls');
  if (!infoElem || !ctrlElem) return;

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const from = totalCount === 0 ? 0 : startIdx + 1;
  const to = startIdx + currentCount;

  infoElem.textContent = `Showing ${from}–${to} of ${totalCount} hospitals`;

  let btns = '';
  btns += `<button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} onclick="goToPage(${currentPage - 1})">‹</button>`;
  for (let i = 1; i <= totalPages; i++) {
    btns += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }
  btns += `<button class="page-btn" ${currentPage === totalPages ? 'disabled' : ''} onclick="goToPage(${currentPage + 1})">›</button>`;
  ctrlElem.innerHTML = btns;
}

function goToPage(p) {
  currentPage = p;
  renderHospitalCards();
}

/* ---------- Detail Panel Tabs ---------- */
function setDetailTab(tab) {
  activeDetailTab = tab;
  renderDetailPanel();
}

/* ---------- Render Right Detail Panel ---------- */
function renderDetailPanel() {
  const panel = $('hospitalDetailPanel');
  const ws = $('hospWorkspace');
  if (!panel) return;

  if (!selectedHospital) {
    if (ws) ws.classList.remove('has-detail');
    panel.style.display = 'none';
    panel.innerHTML = '<div class="empty">Select a hospital from the list to view its complete capability intel.</div>';
    return;
  }

  if (ws) ws.classList.add('has-detail');
  panel.style.display = 'flex';

  const h = selectedHospital;
  const l = h.live_status || {};
  const c = h.capabilities || {};
  const status = getHospitalStatus(h);
  const d = getHospitalDistance(h);
  const eta = getHospitalETA(d);
  const isRec = h.id === getRecommendedHospitalId();

  const icuVal = l.icu_beds_available === null ? '—' : l.icu_beds_available;
  const erVal = l.emergency_beds_available === null ? '—' : l.emergency_beds_available;
  const ventVal = l.ventilators_available === null ? '—' : l.ventilators_available;
  const otVal = l.operation_theatre_available === true ? 'AVAILABLE' : (l.operation_theatre_available === false ? 'NOT AVAILABLE' : 'STANDBY');

  // Detail header
  let html = `
    <div class="detail-header">
      <button class="detail-close-btn" onclick="selectedHospital=null;renderHospitalCards();renderDetailPanel();" title="Close Panel">✕</button>
      <div class="detail-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 9h6M12 6v6M9 15h2M13 15h2M9 18h2M13 18h2"/></svg>
      </div>
      <div class="detail-id-block">
        <div class="detail-context-label">SELECTED HOSPITAL</div>
        <div class="detail-title-row">
          <h2 class="detail-title">${esc(h.hospital_name)}</h2>
          ${isRec ? '<span class="badge-rec">RECOMMENDED</span>' : ''}
        </div>
        <div class="detail-meta">${esc(h.id)} &nbsp;•&nbsp; ${esc((h.type || 'PRIVATE').toUpperCase())}</div>
        <div class="detail-address">${esc(h.address || 'Durg, Chhattisgarh')}</div>
        <div class="detail-subbar">
          <span class="hosp-status-pill ${status}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="8"/></svg>
            ${status.toUpperCase()}
          </span>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="hosp-distance-tag">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 21s-8-7.5-8-12a8 8 0 1 1 16 0c0 4.5-8 12-8 12z"/><circle cx="12" cy="9" r="3"/></svg>
              ${d.toFixed(1)} km
            </span>
            <span class="hosp-eta-val">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 17h4M19 17h2a1 1 0 0 0 1-1v-3.5a2 2 0 0 0-.6-1.4l-2.8-2.8A2 2 0 0 0 17.2 8H15V6a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
              <b>${eta} min</b> ETA
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Navigation Tabs (Sleek, 4 focused tabs) -->
    <div class="detail-tabs">
      <button class="detail-tab ${activeDetailTab === 'overview' ? 'active' : ''}" onclick="setDetailTab('overview')">Overview</button>
      <button class="detail-tab ${activeDetailTab === 'clinical' ? 'active' : ''}" onclick="setDetailTab('clinical')">Clinical</button>
      <button class="detail-tab ${activeDetailTab === 'resources' ? 'active' : ''}" onclick="setDetailTab('resources')">Resources</button>
      <button class="detail-tab ${activeDetailTab === 'route' ? 'active' : ''}" onclick="setDetailTab('route')">Route & Dispatch</button>
    </div>

    <!-- Scrollable Content Area -->
    <div class="details-content detail-content">
  `;

  if (activeDetailTab === 'overview') {
    html += `
      <!-- Section 1: Identity & Status -->
      <div class="detail-section">
        <div class="detail-sec-header">IDENTITY & STATUS</div>
        <div class="detail-field-grid">
          <div class="detail-field">
            <span class="detail-field-label">Hospital ID</span>
            <span class="detail-field-val">${esc(h.id)}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Trauma Level</span>
            <span class="detail-status-tag ${c.trauma_level === 1 ? 'available' : (c.trauma_level === null ? 'not-reported' : 'unavailable')}">${c.trauma_level === 1 ? 'LEVEL 1' : (c.trauma_level === null ? 'NOT REPORTED' : 'NONE')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Facility Type</span>
            <span class="detail-field-val">${esc((h.type || 'Private').charAt(0).toUpperCase() + (h.type || 'Private').slice(1))}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Emergency Dept</span>
            <span class="detail-status-tag ${c.emergency_department === true ? 'operational' : (c.emergency_department === null ? 'not-reported' : 'unavailable')}">${c.emergency_department === true ? 'OPERATIONAL' : (c.emergency_department === null ? 'NOT REPORTED' : 'NOT AVAILABLE')}</span>
          </div>
          <div class="detail-field full-width">
            <span class="detail-field-label">Address</span>
            <span class="detail-field-val" style="font-weight:500;color:#cbd5e1">${esc(h.address || 'Chhaoni, Jamul Road, Bhilai, Durg')}</span>
          </div>
        </div>
      </div>

      <!-- Section 2: Live Capacity -->
      <div class="detail-section">
        <div class="detail-sec-header">
          <span>LIVE CAPACITY</span>
          <span class="live-tag">● LIVE · Updated 5 min ago</span>
        </div>
        <div class="detail-capacity-strip">
          <div class="detail-cap-item">
            <div class="detail-cap-val ${icuVal === 0 ? 'red' : (icuVal === '—' ? 'slate' : 'green')}">${icuVal}</div>
            <div class="detail-cap-lbl">ICU BEDS</div>
          </div>
          <div class="detail-cap-item">
            <div class="detail-cap-val ${erVal === 0 ? 'red' : (erVal === '—' ? 'slate' : 'green')}">${erVal}</div>
            <div class="detail-cap-lbl">ER BEDS</div>
          </div>
          <div class="detail-cap-item">
            <div class="detail-cap-val ${ventVal === 0 ? 'red' : (ventVal === '—' ? 'slate' : '')}">${ventVal}</div>
            <div class="detail-cap-lbl">VENTILATORS</div>
          </div>
          <div class="detail-cap-item">
            <div class="detail-cap-val ${otVal === 'AVAILABLE' ? 'green' : (otVal === 'NOT AVAILABLE' ? 'red' : 'slate')}" style="font-size:13px">${otVal === 'AVAILABLE' ? 'YES' : (otVal === 'NOT AVAILABLE' ? 'NO' : '—')}</div>
            <div class="detail-cap-lbl">OT READY</div>
          </div>
        </div>
      </div>

      <!-- Section 3: Clinical Readiness (2-column clean field grid) -->
      <div class="detail-section">
        <div class="detail-sec-header">CLINICAL READINESS</div>
        <div class="detail-field-grid">
          <div class="detail-field">
            <span class="detail-field-label">Trauma Team</span>
            <span class="detail-status-tag ${l.trauma_team_available === true ? 'available' : (l.trauma_team_available === false ? 'unavailable' : 'not-reported')}">${l.trauma_team_available === true ? 'AVAILABLE' : (l.trauma_team_available === false ? 'NOT AVAILABLE' : 'NOT REPORTED')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Emergency Surgery</span>
            <span class="detail-status-tag ${c.emergency_surgery === true ? 'available' : (c.emergency_surgery === false ? 'unavailable' : 'not-reported')}">${c.emergency_surgery === true ? 'AVAILABLE' : (c.emergency_surgery === false ? 'NOT AVAILABLE' : 'NOT REPORTED')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Neurosurgeon</span>
            <span class="detail-status-tag ${l.neurosurgeon_available === true ? 'available' : (l.neurosurgeon_available === false ? 'unavailable' : 'not-reported')}">${l.neurosurgeon_available === true ? 'AVAILABLE' : (l.neurosurgeon_available === false ? 'NOT AVAILABLE' : 'NOT REPORTED')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Anaesthesia</span>
            <span class="detail-status-tag available">AVAILABLE</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Orthopedic</span>
            <span class="detail-status-tag ${l.orthopedic_surgeon_available === true || c.orthopedics === true ? 'available' : (l.orthopedic_surgeon_available === false ? 'unavailable' : 'not-reported')}">${l.orthopedic_surgeon_available === true || c.orthopedics === true ? 'AVAILABLE' : (l.orthopedic_surgeon_available === false ? 'NOT AVAILABLE' : 'NOT REPORTED')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Cardiology</span>
            <span class="detail-status-tag not-reported">NOT REPORTED</span>
          </div>
        </div>
      </div>

      <!-- Section 4: Trauma Capabilities (Quiet subtle pills) -->
      <div class="detail-section">
        <div class="detail-sec-header">TRAUMA CAPABILITIES</div>
        <div class="hosp-chips-row">
          <span class="hosp-chip ${c.trauma_level === 1 ? 'verified' : ''}">${c.trauma_level === 1 ? '<span class="chip-icon">✓</span> Trauma L1' : '<span style="color:#64748b">✕</span> Trauma L1'}</span>
          <span class="hosp-chip ${c.emergency_surgery === true ? 'verified' : ''}">${c.emergency_surgery === true ? '<span class="chip-icon">✓</span> Emergency Surgery' : '<span class="chip-icon">?</span> Emergency Surgery'}</span>
          <span class="hosp-chip ${c.neurosurgery === true ? 'verified' : ''}">${c.neurosurgery === true ? '<span class="chip-icon">✓</span> Neurosurgery' : '<span class="chip-icon">?</span> Neurosurgery'}</span>
          <span class="hosp-chip ${c.orthopedics === true ? 'verified' : ''}">${c.orthopedics === true ? '<span class="chip-icon">✓</span> Orthopedics' : '<span class="chip-icon">?</span> Orthopedics'}</span>
          <span class="hosp-chip ${c.polytrauma === true ? 'verified' : ''}">${c.polytrauma === true ? '<span class="chip-icon">✓</span> Polytrauma' : '<span class="chip-icon">?</span> Polytrauma'}</span>
          <span class="hosp-chip ${c.burn_unit === true ? 'verified' : ''}">${c.burn_unit === true ? '<span class="chip-icon">✓</span> Burn Unit' : '<span class="chip-icon">?</span> Burn Unit'}</span>
        </div>
      </div>

      <!-- Section 5: Integrated Emergency Contacts & Access -->
      <div class="detail-section">
        <div class="detail-sec-header">EMERGENCY CONTACTS & ACCESS</div>
        <div class="detail-field-grid">
          <div class="detail-field">
            <span class="detail-field-label">Control Room Hotline</span>
            <span class="detail-field-val">+91 (0788) 224-8112</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">CMO Direct Mobile</span>
            <span class="detail-field-val">+91 94252 01120</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Ambulance Bay Entry</span>
            <span class="detail-field-val">Gate 2 (North Wing)</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">ER Desk Extension</span>
            <span class="detail-field-val">Ext. 101 / 102</span>
          </div>
          <div class="detail-field full-width">
            <span class="detail-field-label">GPS Telemetry</span>
            <span class="detail-field-val" style="font-family:monospace;color:#38bdf8;font-size:11px">${h.latitude || '21.220736'}, ${h.longitude || '81.380495'}</span>
          </div>
        </div>
      </div>

      <!-- Section 6: Data Quality & Mode -->
      <div class="detail-section">
        <div class="data-quality-box">
          <div><span style="color:#64748b;margin-right:4px">Mode</span> <span class="detail-status-tag available">${esc(l.mode || 'LIVE')}</span></div>
          <div><span style="color:#64748b;margin-right:4px">Updated</span> <b style="color:#fff">${l.last_updated ? new Date(l.last_updated).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '10:00 AM'}</b></div>
          <div><span style="color:#64748b;margin-right:4px">Confidence</span> <b style="color:#38bdf8">${esc(l.status_confidence || 'DEMO_SIMULATED')}</b></div>
        </div>
      </div>
    `;
  } else if (activeDetailTab === 'clinical') {
    const specs = h.specialties && h.specialties.length ? h.specialties : ['Orthopaedics', 'General Surgery', 'General Medicine', 'Burns', 'Plastic & Reconstructive Surgery', 'Obstetrics & Gynaecology'];
    html += `
      <div class="detail-section">
        <div class="detail-sec-header">MEDICAL SPECIALTIES & CLINICAL DEPARTMENTS</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">
          ${specs.map(s => `<span class="hosp-chip verified" style="font-size:11px;padding:3px 8px"><span class="chip-icon">✓</span> ${esc(s)}</span>`).join('')}
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-sec-header">EMPANELLED PM-JAY PACKAGES & PROTOCOLS</div>
        <div class="detail-field-grid">
          <div class="detail-field"><span class="detail-field-label">Critical Care PM-JAY</span><span class="detail-status-tag available">VERIFIED</span></div>
          <div class="detail-field"><span class="detail-field-label">Emergency Surgery Protocol</span><span class="detail-status-tag available">ACTIVE</span></div>
          <div class="detail-field"><span class="detail-field-label">Polytrauma Triage Level</span><span class="detail-status-tag available">LEVEL 1 READY</span></div>
          <div class="detail-field"><span class="detail-field-label">Burn Unit Intensive Care</span><span class="detail-status-tag available">OPERATIONAL</span></div>
        </div>
      </div>
    `;
  } else if (activeDetailTab === 'resources') {
    html += `
      <div class="detail-section">
        <div class="detail-sec-header">DIAGNOSTIC & SURGICAL INFRASTRUCTURE</div>
        <div class="detail-field-grid">
          <div class="detail-field"><span class="detail-field-label">64-Slice CT Scanner</span><span class="detail-status-tag available">OPERATIONAL</span></div>
          <div class="detail-field"><span class="detail-field-label">1.5T MRI Machine</span><span class="detail-status-tag unknown">STANDBY</span></div>
          <div class="detail-field"><span class="detail-field-label">Digital X-Ray Units (2)</span><span class="detail-status-tag available">OPERATIONAL</span></div>
          <div class="detail-field"><span class="detail-field-label">Ultrasound & 2D Echo</span><span class="detail-status-tag available">AVAILABLE</span></div>
          <div class="detail-field"><span class="detail-field-label">Liquid Medical Oxygen (LMO)</span><span class="detail-status-tag available">98% CAPACITY</span></div>
          <div class="detail-field"><span class="detail-field-label">Emergency Power Backup</span><span class="detail-status-tag available">100% ONLINE</span></div>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-sec-header">BLOOD BANK & TRANSFUSION INVENTORY</div>
        <div class="detail-field-grid">
          <div class="detail-field"><span class="detail-field-label">Blood Bank On-Site</span><span class="detail-status-tag ${l.blood_bank_available === true ? 'available' : 'not-reported'}">${l.blood_bank_available === true ? 'AVAILABLE' : 'NOT REPORTED'}</span></div>
          <div class="detail-field"><span class="detail-field-label">O-Negative Emergency Units</span><span class="detail-status-tag available">ADEQUATE</span></div>
        </div>
      </div>
    `;
  } else if (activeDetailTab === 'route') {
    html += `
      <div class="detail-section">
        <div class="detail-sec-header">EMERGENCY CORRIDOR & TRAFFIC ROUTING</div>
        <div class="detail-field-grid">
          <div class="detail-field"><span class="detail-field-label">Primary Route</span><span class="detail-field-val">G.E. Road via Supela Flyover</span></div>
          <div class="detail-field"><span class="detail-field-label">Estimated Distance</span><span class="detail-field-val">${d.toFixed(1)} km</span></div>
          <div class="detail-field"><span class="detail-field-label">Traffic Clearance</span><span class="detail-status-tag available">GREEN CORRIDOR</span></div>
          <div class="detail-field"><span class="detail-field-label">Ambulance ETA</span><span class="detail-field-val" style="color:#38bdf8">~${eta} Minutes</span></div>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-sec-header">DISPATCH & EN-ROUTE NAVIGATION</div>
        <div class="data-quality-box" style="flex-direction:column;align-items:flex-start;gap:6px">
          <div><b style="color:#38bdf8">Optimal Navigation:</b> High-speed green corridor cleared on G.E. Road. Bypass inner market signals.</div>
          <div style="color:#7e92b2">Emergency contact at facility notified upon unit dispatch.</div>
        </div>
      </div>
    `;
  }

  // Close scrollable content and append hierarchical action buttons
  html += `
    </div>

    <!-- Bottom Action Buttons with Clear Priority (Primary / Secondary / Tertiary) -->
    <div class="details-actions detail-actions">
      <button class="btn-primary" onclick="showHospitalOnMapAndRoute('${esc(h.id)}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
        <span>Show on Map / Route</span>
      </button>
      <button class="btn-secondary" onclick="alert('Opening official health facility dossier for ${esc(h.hospital_name)}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        <span>Open Hospital Record</span>
      </button>
      <button class="btn-tertiary" onclick="dispatch('${esc(h.id)}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        <span>Notify Hospital</span>
      </button>
    </div>
  `;

  panel.innerHTML = html;
}

/* ---------- Master Hospital View Render Loop ---------- */
function renderHospitals() {
  renderHospitalSummary();
  renderHospitalCards();
  renderDetailPanel();
}

/* ---------- Setup Toolbar Listeners ---------- */
function setupToolbarListeners() {
  const searchInput = $('hospSearch');
  if (searchInput) {
    searchInput.oninput = (e) => {
      hospSearchQuery = e.target.value;
      currentPage = 1;
      renderHospitalCards();
    };
  }

  const selectDist = $('filterDistrict');
  if (selectDist) {
    selectDist.onchange = (e) => {
      filterDistrict = e.target.value;
      selectDist.classList.toggle('has-value', !!filterDistrict);
      currentPage = 1;
      renderHospitalCards();
    };
  }

  const selectType = $('filterType');
  if (selectType) {
    selectType.onchange = (e) => {
      filterType = e.target.value;
      selectType.classList.toggle('has-value', !!filterType);
      currentPage = 1;
      renderHospitalCards();
    };
  }

  const selectTrauma = $('filterTrauma');
  if (selectTrauma) {
    selectTrauma.onchange = (e) => {
      filterTrauma = e.target.value;
      selectTrauma.classList.toggle('has-value', !!filterTrauma);
      currentPage = 1;
      renderHospitalCards();
    };
  }

  const selectICU = $('filterICU');
  if (selectICU) {
    selectICU.onchange = (e) => {
      filterICU = e.target.value;
      selectICU.classList.toggle('has-value', !!filterICU);
      currentPage = 1;
      renderHospitalCards();
    };
  }

  const selectMore = $('filterMore');
  if (selectMore) {
    selectMore.onchange = (e) => {
      filterMore = e.target.value;
      selectMore.classList.toggle('has-value', !!filterMore);
      currentPage = 1;
      renderHospitalCards();
    };
  }

  const selectSort = $('filterSort');
  if (selectSort) {
    selectSort.onchange = (e) => {
      filterSort = e.target.value;
      selectSort.classList.toggle('has-value', filterSort !== 'score');
      currentPage = 1;
      renderHospitalCards();
    };
  }

  const btnGrid = $('btnGridView');
  const btnList = $('btnListView');
  if (btnGrid && btnList) {
    btnGrid.onclick = () => {
      viewMode = 'grid';
      btnGrid.classList.add('active');
      btnList.classList.remove('active');
      renderHospitalCards();
    };
    btnList.onclick = () => {
      viewMode = 'list';
      btnList.classList.add('active');
      btnGrid.classList.remove('active');
      renderHospitalCards();
    };
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupToolbarListeners);
} else {
  setupToolbarListeners();
}

/* ---------- API Dispatch and Sync Actions ---------- */
async function dispatch(id) {
  const h = hospitals.find(x => x.id === id);
  if (!h) return;
  const l = h.live_status || {};
  if (l.icu_beds_available != null) l.icu_beds_available = Math.max(0, l.icu_beds_available - 1);
  if (l.emergency_beds_available != null) l.emergency_beds_available = Math.max(0, l.emergency_beds_available - 1);
  l.last_updated = new Date().toISOString();
  localStorage.setItem('rakshak_hospitals', JSON.stringify(hospitals));

  if (!selected) {
    alert(`Notification dispatched to ${h.hospital_name} for emergency intake readiness.`);
    renderHospitals();
    return;
  }

  try {
    const r = await fetch('/api/incidents/' + selected.id + '/assign-destination', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hospitalId: h.id,
        hospitalName: h.hospital_name,
        reasons: ['Trauma Level 1 Verified', 'ICU Available', 'Emergency Surgery', 'Trauma Surgeon', 'Blood Bank', 'Orthopaedics']
      })
    });
    const j = await r.json();
    if (j.ok) alert(`Dispatched unit to ${h.hospital_name} for incident ${selected.id}.`);
  } catch (e) {
    alert(`Dispatched unit to ${h.hospital_name} (local mode).`);
  }
  renderHospitals();
}

/* ---------- Central Data Loader & Health Sync ---------- */
async function load() {
  try {
    const [a, b, c] = await Promise.all([
      fetch('/api/incidents').catch(() => null),
      fetch('/api/hospitals').catch(() => null),
      fetch('/api/responders').catch(() => null)
    ]);

    if (a && a.ok) {
      const x = await a.json();
      const loaded = Array.isArray(x) ? x : (x.incidents || []);
      if (loaded.length) {
        incidents = loaded;
        if (!selected && incidents.length) selected = incidents[0];
        window.selected = selected;
        window.incidents = incidents;
      }
      if ($('apiConn')) $('apiConn').textContent = 'CONNECTED';
      if ($('apiBadge')) $('apiBadge').classList.add('live-ok');
    } else {
      if ($('apiConn')) $('apiConn').textContent = 'OFFLINE';
      if ($('apiBadge')) $('apiBadge').classList.remove('live-ok');
    }

    if (b && b.ok) {
      const y = await b.json();
      const loadedHosp = y.hospitals || (Array.isArray(y) ? y : []);
      if (loadedHosp.length) {
        hospitals = loadedHosp;
        if (!selectedHospital && hospitals.length) selectedHospital = hospitals[0];
      }
    }

    if (c && c.ok) {
      const z = await c.json();
      const loadedResp = z.responders || (Array.isArray(z) ? z : []);
      if (loadedResp.length) {
        responders = loadedResp;
        if (!selectedResponder && responders.length) selectedResponder = responders[0];
      }
    }

    render();
    renderHospitals();
    renderResponders();
    renderLiveMonitoring();
  } catch (e) {
    console.warn('Failed to load initial data:', e);
    if ($('apiConn')) $('apiConn').textContent = 'OFFLINE';
    if ($('apiBadge')) $('apiBadge').classList.remove('live-ok');
  }
}

/* ---------- Central Incident Ingestion Engine ---------- */
function handleIncomingIncident(x, eventName = 'incident') {
  if (!x || !x.id) return;
  
  const existingIdx = incidents.findIndex(v => v.id === x.id);
  const isNew = existingIdx === -1;

  if (isNew) {
    incidents = [x, ...incidents];
    playEmergencyAlertSound();
    const lat = x.location?.latitude ?? x.lat;
    const lng = x.location?.longitude ?? x.lng;
    const locText = (lat != null && lng != null) ? `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` : (x.location?.address || 'Live GPS');
    addTelemetryLog('sos', `🚨 NEW SOS BEACON: ${x.id} · ${x.emergencyType || 'Unclassified'} · ${locText}`);
  } else {
    incidents[existingIdx] = { ...incidents[existingIdx], ...x };
    const updated = incidents[existingIdx];
    const stage = updated.stage || updated.status || 'UPDATE';
    const inj = updated.triage?.injuredCount || updated.triage?.trappedOrInjured || '1';
    addTelemetryLog('triage', `📝 TRIAGE / STATUS UPDATE: ${x.id} -> ${stage} (${inj} casualties, ${updated.priority?.label || 'CRITICAL'})`);
  }

  // Synchronize with liveMonitoringState
  if (window.liveMonitoringState) {
    const lmIdx = window.liveMonitoringState.incidents.findIndex(v => v.id === x.id || v.incidentId === x.id);
    if (lmIdx >= 0) {
      window.liveMonitoringState.incidents[lmIdx] = { ...window.liveMonitoringState.incidents[lmIdx], ...x };
    } else {
      window.liveMonitoringState.incidents.unshift(x);
    }
    
    // If no incident selected yet, select this first one
    if (!window.liveMonitoringState.selectedIncidentId) {
      window.liveMonitoringState.selectedIncidentId = x.id;
      selected = x;
    } else if (window.liveMonitoringState.selectedIncidentId === x.id) {
      selected = x;
    } else if (isNew) {
      // Non-intrusive notification without forcibly interrupting operator
      if (typeof window.showNewIncidentNotification === 'function') {
        window.showNewIncidentNotification(x);
      }
    }
  } else {
    if (!selected || selected.id === x.id || isNew) {
      selected = incidents.find(v => v.id === x.id) || x;
    }
  }

  window.selected = selected;
  window.incidents = incidents;

  // Auto-match nearest available responder + assign hospital
  if (isNew && !x.assigned_responder_id) {
    autoMatchAndDispatch(x);
  }

  // Central re-render across all UI subsystems
  render();
  renderHospitals();
  renderResponders();
  renderLiveMonitoring();
  if (typeof window.renderLiveMonitoringUI === 'function') {
    window.renderLiveMonitoringUI();
  }
}

/* ---------- Automatic Dispatch ---------- */
function autoMatchAndDispatch(incident) {
  if (!incident || !incident.id) return { assigned: false };
  // Prevent double-assign
  if (incident.assigned_responder_id) return { assigned: true, responder_id: incident.assigned_responder_id };

  // S2: wait / guard for loaded responders
  const respondersArr = (typeof responders !== 'undefined' && Array.isArray(responders)) ? responders : [];
  if (respondersArr.length === 0) {
    setTimeout(() => autoMatchAndDispatch(incident), 500);
    return { assigned: false, reason: 'responders_not_loaded' };
  }

  // S3: filter available, not already on this incident
  const lat = (incident.location && incident.location.latitude != null) ? incident.location.latitude : (incident.lat || 21.2065);
  const lng = (incident.location && incident.location.longitude != null) ? incident.location.longitude : (incident.lng || 81.3320);
  let candidates = respondersArr.filter(r => {
    if (!r) return false;
    if (r.status !== 'AVAILABLE') return false;
    if (r.active_mission && r.active_mission.incident_id === incident.id) return false;
    return true;
  });

  // S4: score by distance + capabilities; cap 4 km
  function scoreCandidate(r) {
    let d = 99;
    try {
      const rLat = (r.live_telemetry && r.live_telemetry.current_latitude != null) ? r.live_telemetry.current_latitude : (r.station && r.station.latitude != null ? r.station.latitude : null);
      const rLng = (r.live_telemetry && r.live_telemetry.current_longitude != null) ? r.live_telemetry.current_longitude : (r.station && r.station.longitude != null ? r.station.longitude : null);
      if (rLat != null && rLng != null && !isNaN(rLat) && !isNaN(rLng)) {
        d = km(lat, lng, rLat, rLng);
      }
    } catch (e) { d = 99; }
    if (d >= 4.0 || isNaN(d)) return Infinity;
    let score = d * 10;
    if (r.equipment) {
      if (r.equipment.ventilator === true) score -= 3;
      if ((r.equipment.stretcher_count || 0) >= 1) score -= 2;
      if (incident.priority && incident.priority.code === 'L1' && (r.equipment.trauma_kit_level || '').toString().includes('Level-1')) score -= 4;
    }
    return score;
  }

  if (candidates.length === 0) {
    addTelemetryLog('alert', `NO AVAILABLE RESCUERS — SOS OPEN: ${incident.id}`);
    return { assigned: false, reason: 'no_available_responders' };
  }

  // S5: pick best score; tie-break by eta
  let best = candidates[0];
  let bestScore = scoreCandidate(best);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const s = scoreCandidate(c);
    if (s < bestScore || (s === bestScore && ((c.live_telemetry && c.live_telemetry.estimated_eta_mins || 99) < (best.live_telemetry && best.live_telemetry.estimated_eta_mins || 99)))) {
      best = c;
      bestScore = s;
    }
  }

  // S6: double-check before mutation
  const idx = respondersArr.findIndex(r => r && r.unit_id === best.unit_id && r.id === best.id);
  if (idx === -1 || !respondersArr[idx] || respondersArr[idx].status !== 'AVAILABLE') {
    // Stale pointer / concurrent change — retry once
    return autoMatchAndDispatch(incident);
  }

  // S7/S8: assign responder & update incident
  const res = respondersArr[idx];
  res.status = 'EN_ROUTE_TO_INCIDENT';
  res.active_mission = { incident_id: incident.id, target_hospital_id: null, assigned_at: Date.now() };
  if (res.live_telemetry) {
    res.live_telemetry.distance_from_center_km = bestScore / 10;
    res.live_telemetry.estimated_eta_mins = Math.round((bestScore / 10) / 0.55 + 3);
  }
  incident.status = 'DISPATCHED';
  incident.assigned_responder_id = res.id || res.unit_id;
  incident.stage = 'DISPATCHED';

  // S9: assign hospital (best ranked, avoiding diverted / 0 ICU)
  try {
    let hospId = getRecommendedHospitalId();
    if (hospId) {
      const ranked = (typeof ranks === 'function') ? ranks() : [];
      let chosen = null;
      if (ranked && ranked.length) {
        for (const item of ranked) {
          const h = item && item.h ? item.h : item;
          if (!h) continue;
          const status = (typeof getHospitalStatus === 'function') ? getHospitalStatus(h) : 'unknown';
          const icu = (h.live_status && h.live_status.icu_beds_available != null) ? h.live_status.icu_beds_available : -1;
          if (status !== 'diverted' && icu > 0) {
            chosen = h.id || h.hospital_id || h.name;
            break;
          }
        }
      }
      if (chosen) hospId = chosen;
    }
    incident.assigned_hospital_id = hospId || null;
  } catch (e) {
    incident.assigned_hospital_id = null;
  }

  // S10: notify / render
  try {
    addTelemetryLog('dispatch', `🚓 AUTO DISPATCH: ${res.unit_id || res.id} -> Incident ${incident.id} (Hospital: ${incident.assigned_hospital_id})`);
    if (esInstance && esInstance.readyState === 1) {
      try { esInstance.send(JSON.stringify({ event: 'dispatch', unit_id: res.unit_id || res.id, incident_id: incident.id })); } catch (e) {}
    }
  } catch (e) {}

  render();
  renderResponders();
  renderLiveMonitoring();
  return { assigned: true, responder_id: res.id || res.unit_id, hospital_id: incident.assigned_hospital_id };
}

function assignResponder(incident, responder) {
  if (!responder || responder.status !== 'AVAILABLE') return false;
  if (responder.active_mission && responder.active_mission.incident_id === incident.id) return true;
  responder.status = 'EN_ROUTE_TO_INCIDENT';
  responder.active_mission = { incident_id: incident.id, target_hospital_id: null, assigned_at: Date.now() };
  incident.status = 'DISPATCHED';
  incident.assigned_responder_id = responder.id || responder.unit_id;
  return true;
}

function assignHospital(incident) {
  try {
    let id = getRecommendedHospitalId();
    const ranked = (typeof ranks === 'function') ? ranks() : [];
    for (const item of ranked || []) {
      const h = item && item.h ? item.h : item;
      if (!h) continue;
      const st = (typeof getHospitalStatus === 'function') ? getHospitalStatus(h) : 'unknown';
      const icu = (h.live_status && h.live_status.icu_beds_available != null) ? h.live_status.icu_beds_available : -1;
      if (st !== 'diverted' && icu > 0) { id = h.id || h.hospital_id || h.name; break; }
    }
    incident.assigned_hospital_id = id || null;
  } catch (e) { incident.assigned_hospital_id = null; }
  return incident.assigned_hospital_id;
}

/* ---------- SSE Streaming Connection ---------- */
let esInstance = null;
function initSSEConnection() {
  if (typeof EventSource === 'undefined') {
    if ($('conn')) $('conn').textContent = 'UNSUPPORTED';
    return;
  }

  try {
    if (esInstance) {
      esInstance.close();
    }
    esInstance = new EventSource('/api/events');

    esInstance.onopen = () => {
      if ($('conn')) $('conn').textContent = 'LIVE';
      if ($('sseBadge')) $('sseBadge').classList.add('live-ok');
      load(); // Resynchronize full state on connect / reconnect
    };

    esInstance.addEventListener('ready', () => {
      if ($('conn')) $('conn').textContent = 'LIVE';
      if ($('sseBadge')) $('sseBadge').classList.add('live-ok');
      load();
    });

    esInstance.onerror = () => {
      if ($('conn')) $('conn').textContent = 'RECONNECTING';
      if ($('sseBadge')) $('sseBadge').classList.remove('live-ok');
    };

    const incidentEvents = [
      'incident',
      'incident:update',
      'new_sos',
      'incident.created',
      'incident.updated',
      'incident.cancelled',
      'incident.resolved'
    ];

    incidentEvents.forEach(evtName => {
      esInstance.addEventListener(evtName, e => {
        try {
          const inc = JSON.parse(e.data);
          handleIncomingIncident(inc, evtName);
        } catch (err) {
          console.error(`SSE parse error on '${evtName}':`, err);
        }
      });
    });

    esInstance.addEventListener('dispatch', e => {
      try {
        const d = JSON.parse(e.data);
        addTelemetryLog('dispatch', `🚓 DISPATCH UPDATE: Unit assigned -> ${d.unit_id || d.id || 'Responder Unit'}`);
        renderResponders();
        renderLiveMonitoring();
      } catch (err) {
        console.error('SSE parse error on dispatch:', err);
      }
    });

    esInstance.onmessage = e => {
      try {
        const data = JSON.parse(e.data);
        if (data && data.id) {
          handleIncomingIncident(data, 'message');
        }
      } catch (err) {}
    };

  } catch (e) {
    console.error('SSE initialization error:', e);
    if ($('conn')) $('conn').textContent = 'OFFLINE';
    if ($('sseBadge')) $('sseBadge').classList.remove('live-ok');
  }
}

initSSEConnection();
load();

/* ============================================================
   RESPONDER FLEET TELEMETRY & DISPATCH CONTROLLER
   ============================================================ */

function renderResponderSummary() {
  const total = responders.length;
  const avail = responders.filter(r => r.status === 'AVAILABLE').length;
  const enroute = responders.filter(r => r.status === 'EN_ROUTE_TO_INCIDENT').length;
  const onscene = responders.filter(r => r.status === 'ON_SCENE').length;
  const offline = responders.filter(r => r.status === 'MAINTENANCE' || r.status === 'OFF_DUTY').length;

  if ($('respSummaryTotal')) $('respSummaryTotal').textContent = total;
  if ($('respSummaryAvailable')) $('respSummaryAvailable').textContent = avail;
  if ($('respSummaryEnRoute')) $('respSummaryEnRoute').textContent = enroute;
  if ($('respSummaryOnScene')) $('respSummaryOnScene').textContent = onscene;
  if ($('respSummaryOffline')) $('respSummaryOffline').textContent = offline;
}

function getFilteredResponders() {
  let list = [...responders];

  // Search
  if (respSearchQuery.trim()) {
    const q = respSearchQuery.toLowerCase().trim();
    list = list.filter(r => 
      (r.unit_id && r.unit_id.toLowerCase().includes(q)) ||
      (r.vehicle_number && r.vehicle_number.toLowerCase().includes(q)) ||
      (r.driver?.name && r.driver.name.toLowerCase().includes(q)) ||
      (r.call_sign && r.call_sign.toLowerCase().includes(q)) ||
      (r.station?.name && r.station.name.toLowerCase().includes(q)) ||
      (r.zone && r.zone.toLowerCase().includes(q)) ||
      (r.district && r.district.toLowerCase().includes(q)) ||
      (r.type && r.type.toLowerCase().includes(q))
    );
  }

  // District filter (Raipur vs Durg)
  if (respFilterDistrict) {
    list = list.filter(r => 
      (r.district && r.district.toLowerCase() === respFilterDistrict.toLowerCase()) ||
      (r.id && r.id.toLowerCase().includes(respFilterDistrict.toLowerCase().slice(0, 3)))
    );
  }

  // Zone filter
  if (respFilterZone) {
    list = list.filter(r => r.zone === respFilterZone);
  }

  // Type filter
  if (respFilterType) {
    if (respFilterType === 'volunteer') {
      list = list.filter(r => r.category === 'volunteer');
    } else {
      list = list.filter(r => r.type && r.type.toLowerCase().includes(respFilterType.toLowerCase()));
    }
  }

  // Status filter
  if (respFilterStatus) {
    list = list.filter(r => r.status === respFilterStatus);
  }

  // Equipment filter
  if (respFilterEquip) {
    if (respFilterEquip === 'ventilator') list = list.filter(r => r.equipment?.ventilator === true);
    if (respFilterEquip === 'aed') list = list.filter(r => r.equipment?.defibrillator_aed === true);
    if (respFilterEquip === 'o2_high') list = list.filter(r => (r.equipment?.oxygen_level_pct || 0) >= 90);
    if (respFilterEquip === 'stretcher') list = list.filter(r => (r.equipment?.stretcher_count || 0) >= 2);
    if (respFilterEquip === 'extrication') list = list.filter(r => r.equipment?.trauma_kit_level && r.equipment.trauma_kit_level.includes('Hydraulic'));
    if (respFilterEquip === 'monitor') list = list.filter(r => r.equipment?.patient_monitor === true);
  }

  // Sorting
  if (respFilterSort === 'nearest') {
    list.sort((a, b) => (a.live_telemetry?.distance_from_center_km || 99) - (b.live_telemetry?.distance_from_center_km || 99));
  } else if (respFilterSort === 'o2') {
    list.sort((a, b) => (b.equipment?.oxygen_level_pct || 0) - (a.equipment?.oxygen_level_pct || 0));
  } else if (respFilterSort === 'status') {
    const statusPriority = { 'AVAILABLE': 1, 'ON_SCENE': 2, 'EN_ROUTE_TO_INCIDENT': 3, 'TRANSPORTING_PATIENT': 4, 'PATIENT_HANDOVER': 5, 'MAINTENANCE': 6, 'OFF_DUTY': 7 };
    list.sort((a, b) => (statusPriority[a.status] || 99) - (statusPriority[b.status] || 99));
  } else if (respFilterSort === 'battery') {
    list.sort((a, b) => (b.live_telemetry?.battery_pct || 0) - (a.live_telemetry?.battery_pct || 0));
  } else if (respFilterSort === 'name') {
    list.sort((a, b) => a.unit_id.localeCompare(b.unit_id));
  }

  return list;
}

function renderResponders() {
  renderResponderSummary();
  const grid = $('responderCardGrid');
  const panel = $('responderDetailPanel');
  const workspace = $('respWorkspace');
  if (!grid) return;

  const filtered = getFilteredResponders();
  const totalItems = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / RESP_PAGE_SIZE));

  if (respCurrentPage > totalPages) respCurrentPage = totalPages;
  if (respCurrentPage < 1) respCurrentPage = 1;

  const startIdx = (respCurrentPage - 1) * RESP_PAGE_SIZE;
  const pageItems = filtered.slice(startIdx, startIdx + RESP_PAGE_SIZE);

  // Pagination Info
  if ($('respPaginationInfo')) {
    if (totalItems === 0) {
      $('respPaginationInfo').textContent = 'No responder units match filters';
    } else {
      $('respPaginationInfo').textContent = `Showing ${startIdx + 1}–${Math.min(startIdx + RESP_PAGE_SIZE, totalItems)} of ${totalItems} responders`;
    }
  }

  // Pagination Controls
  if ($('respPaginationControls')) {
    let btnsHtml = `<button class="page-btn" onclick="goToRespPage(${respCurrentPage - 1})" ${respCurrentPage === 1 ? 'disabled' : ''}>‹</button>`;
    for (let p = 1; p <= totalPages; p++) {
      btnsHtml += `<button class="page-btn ${p === respCurrentPage ? 'active' : ''}" onclick="goToRespPage(${p})">${p}</button>`;
    }
    btnsHtml += `<button class="page-btn" onclick="goToRespPage(${respCurrentPage + 1})" ${respCurrentPage === totalPages ? 'disabled' : ''}>›</button>`;
    $('respPaginationControls').innerHTML = btnsHtml;
  }

  // Detail Panel
  if (selectedResponder) {
    if (workspace) workspace.classList.add('has-detail');
    if (panel) {
      panel.style.display = 'flex';
      panel.innerHTML = renderResponderDetailPanel();
    }
  } else {
    if (workspace) workspace.classList.remove('has-detail');
    if (panel) {
      panel.style.display = 'none';
      panel.innerHTML = '<div class="empty">Select a responder unit from the list to view live telemetry and dispatch intel.</div>';
    }
  }

  // Render Cards Grid
  if (pageItems.length === 0) {
    grid.innerHTML = '<div class="empty" style="grid-column: 1 / -1; padding: 40px;">No responder fleet units match your current filter criteria.<br><button class="hosp-view-link" style="margin-top:12px;background:none;border:none;cursor:pointer;" onclick="resetRespFilters()">Reset All Filters</button></div>';
    return;
  }

  grid.className = `hosp-cards-grid hospital-grid ${respViewMode === 'list' ? 'list-view' : ''}`;
  grid.innerHTML = pageItems.map(r => renderSingleResponderCard(r)).join('');
  setupResponderToolbarListeners();
}

function getResponderPillStatus(status) {
  switch (status) {
    case 'AVAILABLE': return 'accepting';
    case 'EN_ROUTE_TO_INCIDENT':
    case 'ON_SCENE':
    case 'TRANSPORTING_PATIENT':
    case 'PATIENT_HANDOVER':
      return 'limited';
    case 'MAINTENANCE': return 'diverted';
    default: return 'unknown';
  }
}

function getStatusBadgeLabel(status) {
  switch (status) {
    case 'AVAILABLE': return 'AVAILABLE';
    case 'EN_ROUTE_TO_INCIDENT': return 'EN ROUTE';
    case 'ON_SCENE': return 'ON SCENE';
    case 'TRANSPORTING_PATIENT': return 'TRANSPORTING';
    case 'PATIENT_HANDOVER': return 'HANDOVER';
    case 'MAINTENANCE': return 'MAINTENANCE';
    case 'OFF_DUTY': return 'OFF DUTY';
    default: return (status || 'UNKNOWN').replace(/_/g, ' ');
  }
}

function renderSingleResponderCard(r) {
  const isSel = selectedResponder && selectedResponder.id === r.id;
  const isRec = r.status === 'AVAILABLE' && (r.live_telemetry?.distance_from_center_km || 99) <= 4.0;
  const pillStatus = getResponderPillStatus(r.status);
  const statusLabel = getStatusBadgeLabel(r.status);
  const d = r.live_telemetry?.distance_from_center_km != null ? r.live_telemetry.distance_from_center_km : 0;
  const eta = r.live_telemetry?.estimated_eta_mins != null ? r.live_telemetry.estimated_eta_mins : '—';
  const o2 = r.equipment?.oxygen_level_pct != null ? `${r.equipment.oxygen_level_pct}%` : '—';
  const speed = r.live_telemetry?.speed_kmh ? `${r.live_telemetry.speed_kmh} km/h` : '0 (Idle)';
  const bat = r.live_telemetry?.battery_pct ? `${r.live_telemetry.battery_pct}%` : '95%';
  const hasVent = r.equipment?.ventilator === true;
  const stretcherCount = r.equipment?.stretcher_count || 0;
  const stretcherText = stretcherCount > 0 ? `${stretcherCount} Ready` : (hasVent ? 'Ventilator' : 'None');

  // Capability Chips - quiet, subtle pills exactly matching hospital chips
  const chips = [];
  if (r.equipment?.ventilator) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Ventilator</span>');
  if (r.equipment?.defibrillator_aed) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Defib AED</span>');
  if (r.equipment?.stretcher_count) chips.push(`<span class="hosp-chip verified"><span class="chip-icon">✓</span> ${r.equipment.stretcher_count} Stretcher</span>`);
  if (r.equipment?.trauma_kit_level && r.equipment.trauma_kit_level.includes('Level-1')) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Trauma L1</span>');
  if (r.equipment?.water_capacity_litres) chips.push(`<span class="hosp-chip verified"><span class="chip-icon">✓</span> ${r.equipment.water_capacity_litres}L Water</span>`);
  if (r.equipment?.breathalyzer) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Breathalyzer</span>');
  if (chips.length === 0) chips.push('<span class="hosp-chip verified"><span class="chip-icon">✓</span> Tactical Kit</span>');

  const visibleChips = chips.slice(0, 3);
  if (chips.length > 3) {
    visibleChips.push(`<span class="hosp-chip more">+${chips.length - 3} more</span>`);
  }

  // Address line
  const rawAddr = r.station?.address || 'Civil Lines, Durg-Bhilai';
  const cleanAddr = rawAddr.replace(/,\s*Chhattisgarh\s*\d*/i, '').trim();

  return `<article class="hosp-card ${isRec ? 'recommended' : ''} ${isSel ? 'selected' : ''}" onclick="pickResponder('${esc(r.id)}')">
    <div class="hosp-card-topbar">
      <div style="display:flex;gap:6px;align-items:center;">
        ${isSel ? '<span class="badge-selected">★ SELECTED</span>' : ''}
        ${isRec ? '<span class="badge-rec">★ RECOMMENDED</span>' : ''}
      </div>
      <span class="hosp-distance-tag">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 21s-8-7.5-8-12a8 8 0 1 1 16 0c0 4.5-8 12-8 12z"/><circle cx="12" cy="9" r="3"/></svg>
        ${d.toFixed(1)} km
      </span>
    </div>

    <div class="hosp-card-header">
      <h3 class="hosp-card-title">${esc(r.unit_id)}</h3>
      <div class="hosp-card-meta"><span style="color:#38bdf8;font-weight:700;">${esc((r.district || (r.id.includes('RAI') ? 'Raipur' : 'Durg')).toUpperCase())}</span> &nbsp;•&nbsp; ${esc(r.id)} &nbsp;•&nbsp; ${esc((r.vehicle_number || '').toUpperCase())} &nbsp;•&nbsp; ${esc((r.type || 'AMBULANCE').toUpperCase())}</div>
      <p class="hosp-card-address">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" style="vertical-align:-1px;margin-right:2px"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <b>${esc(r.driver?.name || 'Driver')}</b> (${esc(r.driver?.phone || '')}) &nbsp;•&nbsp; 
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" style="vertical-align:-1px;margin-right:2px"><path d="M12 21s-8-7.5-8-12a8 8 0 1 1 16 0c0 4.5-8 12-8 12z"/><circle cx="12" cy="9" r="3"/></svg>
        ${esc(cleanAddr)}
      </p>
    </div>

    <div class="hosp-status-row">
      <span class="hosp-status-pill ${pillStatus}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="8"/></svg>
        ${statusLabel}
      </span>
      <span class="hosp-eta-val">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 17h4M19 17h2a1 1 0 0 0 1-1v-3.5a2 2 0 0 0-.6-1.4l-2.8-2.8A2 2 0 0 0 17.2 8H15V6a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
        <b>${eta} min</b> ETA
      </span>
    </div>

    <!-- Critical Capacity Compact Region -->
    <div class="hosp-critical-capacity">
      <div class="cap-metric-box">
        <div class="cap-metric-val ${parseInt(o2) >= 80 ? 'green' : (o2 === '0%' ? 'slate' : 'amber')}">${o2}</div>
        <div class="cap-metric-lbl">O2 available</div>
      </div>
      <div class="cap-metric-box">
        <div class="cap-metric-val ${r.live_telemetry?.speed_kmh > 0 ? 'green' : 'slate'}">${speed}</div>
        <div class="cap-metric-lbl">Live speed</div>
      </div>
      <div class="cap-metric-box">
        <div class="cap-metric-val ${parseInt(bat) >= 50 ? 'green' : 'red'}">${bat}</div>
        <div class="cap-metric-lbl">Battery level</div>
      </div>
      <div class="cap-metric-box">
        <div class="cap-metric-val ${stretcherCount > 0 || hasVent ? 'green' : 'slate'}" style="font-size:14px;letter-spacing:0.5px;">${stretcherText}</div>
        <div class="cap-metric-lbl">${stretcherCount > 0 ? 'Stretcher' : (hasVent ? 'Ventilator' : 'Gear')}</div>
      </div>
    </div>

    <div class="hosp-chips-row">
      ${visibleChips.join('')}
    </div>

    <div class="hosp-card-footer">
      <span class="hosp-view-link">View Details &rarr;</span>
    </div>
  </article>`;
}

function renderResponderDetailPanel() {
  const r = selectedResponder;
  if (!r) return '';

  const pillStatus = getResponderPillStatus(r.status);
  const statusLabel = getStatusBadgeLabel(r.status);
  const d = r.live_telemetry?.distance_from_center_km != null ? r.live_telemetry.distance_from_center_km : 0;
  const eta = r.live_telemetry?.estimated_eta_mins != null ? r.live_telemetry.estimated_eta_mins : '—';
  const isRec = r.status === 'AVAILABLE' && d <= 4.0;

  const o2Val = r.equipment?.oxygen_level_pct != null ? `${r.equipment.oxygen_level_pct}%` : '—';
  const speedVal = r.live_telemetry?.speed_kmh ? `${r.live_telemetry.speed_kmh} km/h` : '0 km/h';
  const batVal = r.live_telemetry?.battery_pct ? `${r.live_telemetry.battery_pct}%` : '95%';
  const stretcherVal = r.equipment?.stretcher_count ? `${r.equipment.stretcher_count} UNITS` : 'NONE';

  let tabContent = '';

  if (activeRespDetailTab === 'overview') {
    const headingDeg = r.live_telemetry?.heading_degrees != null ? `${r.live_telemetry.heading_degrees}°` : '90° East';
    const gpsStatusText = r.live_telemetry?.gps_signal === 'EXCELLENT' ? 'Live Locked (3D Fix)' : (r.live_telemetry?.gps_signal || 'Tracking Active');
    const missionIncident = r.active_mission?.incident_id || (r.status === 'AVAILABLE' ? 'Standby (Queue Ready)' : 'Patrol Standby');
    const missionStatus = r.status === 'AVAILABLE' ? 'Available for Dispatch' : (r.status === 'EN_ROUTE_TO_INCIDENT' ? 'En Route to Incident' : (r.status === 'ON_SCENE' ? 'On Scene Operations' : (r.status === 'TRANSPORTING_PATIENT' ? 'Patient Transport in Progress' : statusLabel)));
    const missionDestination = r.active_mission?.target_hospital_name || r.active_mission?.target_location || (r.station?.name || 'Central Operations Hub');
    const crewName = r.lead_crew?.name ? `${esc(r.driver?.name || 'Driver')} / ${esc(r.lead_crew.name)}` : esc(r.driver?.name || 'Assigned Driver');
    const driverPhone = r.driver?.phone || '+91 98271 23401';
    const otherEquip = r.equipment?.trauma_kit_level || (r.equipment?.patient_monitor ? 'Patient Monitor, Suction' : 'Tactical Kit');

    tabContent = `
      <!-- Section 1: Identity & Status -->
      <div class="detail-section">
        <div class="detail-sec-header">IDENTITY & STATUS</div>
        <div class="detail-field-grid">
          <div class="detail-field">
            <span class="detail-field-label">Unit Type</span>
            <span class="detail-status-tag operational">${esc(r.type || 'Ambulance (ALS)')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Unit ID</span>
            <span class="detail-field-val">${esc(r.unit_id)}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Call Sign</span>
            <span class="detail-field-val" style="color:#38bdf8;font-weight:700;">${esc(r.call_sign || 'GARUDA-1')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Status</span>
            <span class="detail-status-tag ${pillStatus}">${statusLabel}</span>
          </div>
        </div>
      </div>

      <!-- Section 2: Live Telemetry -->
      <div class="detail-section">
        <div class="detail-sec-header">
          <span>LIVE TELEMETRY</span>
          <span class="live-tag">● LIVE · Updated 5 sec ago</span>
        </div>
        <div class="detail-capacity-strip">
          <div class="detail-cap-item">
            <div class="detail-cap-val ${parseInt(o2Val) >= 80 ? 'green' : (o2Val === '0%' ? 'slate' : 'amber')}">${o2Val}</div>
            <div class="detail-cap-lbl">OXYGEN</div>
          </div>
          <div class="detail-cap-item">
            <div class="detail-cap-val ${r.live_telemetry?.speed_kmh > 0 ? 'green' : 'slate'}">${speedVal}</div>
            <div class="detail-cap-lbl">SPEED</div>
          </div>
          <div class="detail-cap-item">
            <div class="detail-cap-val ${parseInt(batVal) >= 50 ? 'green' : 'red'}">${batVal}</div>
            <div class="detail-cap-lbl">BATTERY</div>
          </div>
          <div class="detail-cap-item">
            <div class="detail-cap-val green" style="font-size:13px">${esc(r.live_telemetry?.gps_signal || 'EXCELLENT')}</div>
            <div class="detail-cap-lbl">GPS SIGNAL</div>
          </div>
        </div>
      </div>

      <!-- Section 3: Crew & Comms -->
      <div class="detail-section">
        <div class="detail-sec-header">CREW & COMMS</div>
        <div class="detail-field-grid">
          <div class="detail-field">
            <span class="detail-field-label">Lead Driver</span>
            <span class="detail-field-val">${esc(r.driver?.name || 'Assigned Driver')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Paramedic / Officer</span>
            <span class="detail-field-val">${esc(r.lead_crew?.name || 'Officer On Duty')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Phone Direct</span>
            <span class="detail-field-val"><a href="tel:${esc(driverPhone)}" style="color:#38bdf8;font-weight:700;">${esc(driverPhone)}</a></span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Radio / Comms</span>
            <span class="detail-status-tag available">VHF CHANNEL 4</span>
          </div>
        </div>
      </div>

      <!-- Section 4: Equipment -->
      <div class="detail-section">
        <div class="detail-sec-header">EQUIPMENT</div>
        <div class="detail-field-grid">
          <div class="detail-field">
            <span class="detail-field-label">Ventilator</span>
            <span class="detail-status-tag ${r.equipment?.ventilator ? 'available' : 'unavailable'}">${r.equipment?.ventilator ? '✓ Installed' : '✕ None'}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Defib AED</span>
            <span class="detail-status-tag ${r.equipment?.defibrillator_aed ? 'available' : 'unavailable'}">${r.equipment?.defibrillator_aed ? '✓ Available' : '✕ None'}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Stretchers</span>
            <span class="detail-field-val">${r.equipment?.stretcher_count ? `${r.equipment.stretcher_count} Ready` : (r.equipment?.ventilator ? '1 Ready' : 'None')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">First Aid Kit</span>
            <span class="detail-status-tag available">TRAUMA READY</span>
          </div>
          <div class="detail-field full-width">
            <span class="detail-field-label">Other Equipment</span>
            <span class="detail-field-val" style="font-size:11px">${esc(otherEquip)}</span>
          </div>
        </div>
      </div>

      <!-- Section 5: Current Location -->
      <div class="detail-section">
        <div class="detail-sec-header">CURRENT LOCATION</div>
        <div class="detail-field-grid">
          <div class="detail-field full-width">
            <span class="detail-field-label">Base Station</span>
            <span class="detail-field-val" style="color:#cbd5e1;font-weight:500;">${esc(r.station?.address || r.station?.name || 'Civil Lines, Durg-Bhilai')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Dist. from Center</span>
            <span class="detail-field-val">${d.toFixed(1)} km (${eta} min)</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Coordinates</span>
            <span class="detail-field-val" style="font-family:monospace;font-size:11px;color:#38bdf8">${(r.live_telemetry?.current_latitude || 21.1904).toFixed(4)}, ${(r.live_telemetry?.current_longitude || 81.2849).toFixed(4)}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Heading</span>
            <span class="detail-field-val">${headingDeg}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">GPS Status</span>
            <span class="detail-status-tag available">${gpsStatusText}</span>
          </div>
        </div>
      </div>

      <!-- Section 6: Mission -->
      <div class="detail-section">
        <div class="detail-sec-header">MISSION</div>
        <div class="detail-field-grid">
          <div class="detail-field">
            <span class="detail-field-label">Current Incident</span>
            <span class="detail-field-val" style="color:#38bdf8">${esc(missionIncident)}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Mission Status</span>
            <span class="detail-status-tag ${r.status === 'AVAILABLE' ? 'available' : 'limited'}">${esc(missionStatus)}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Destination</span>
            <span class="detail-field-val" style="color:#cbd5e1">${esc(missionDestination)}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Dispatch Status</span>
            <span class="detail-status-tag ${r.status === 'AVAILABLE' ? 'available' : 'operational'}">${r.status === 'AVAILABLE' ? 'READY' : 'DEPLOYED'}</span>
          </div>
        </div>
      </div>
    `;
  } else if (activeRespDetailTab === 'clinical') {
    tabContent = `
      <div class="detail-section">
        <div class="detail-sec-header">LIFE SUPPORT SPECIFICATIONS</div>
        <div class="detail-field-grid">
          <div class="detail-field">
            <span class="detail-field-label">Ventilator</span>
            <span class="detail-status-tag ${r.equipment?.ventilator ? 'available' : 'unavailable'}">${r.equipment?.ventilator ? 'INSTALLED & TESTED' : 'NOT INSTALLED'}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Defibrillator (AED)</span>
            <span class="detail-status-tag ${r.equipment?.defibrillator_aed ? 'available' : 'unavailable'}">${r.equipment?.defibrillator_aed ? 'CHARGED (100%)' : 'NONE'}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Oxygen Tank Pressure</span>
            <span class="detail-status-tag ${parseInt(o2Val) >= 80 ? 'available' : 'unavailable'}">${o2Val} (${parseInt(o2Val) >= 80 ? 'FULL' : 'REFILL REQ'})</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Patient Monitor</span>
            <span class="detail-status-tag ${r.equipment?.patient_monitor ? 'available' : 'unavailable'}">${r.equipment?.patient_monitor ? 'ONLINE (ECG/SPO2)' : 'NONE'}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Trauma Grade</span>
            <span class="detail-field-val">${esc(r.equipment?.trauma_kit_level || 'Tactical Grade')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Suction Machine</span>
            <span class="detail-status-tag ${r.equipment?.suction_machine ? 'available' : 'unavailable'}">${r.equipment?.suction_machine ? 'OPERATIONAL' : 'NOT REPORTED'}</span>
          </div>
        </div>
      </div>
    `;
  } else if (activeRespDetailTab === 'resources' || activeRespDetailTab === 'crew') {
    tabContent = `
      <div class="detail-section">
        <div class="detail-sec-header">ON-BOARD EQUIPMENT & CAPABILITIES</div>
        <div class="detail-field-grid">
          <div class="detail-field">
            <span class="detail-field-label">Ventilator</span>
            <span class="detail-status-tag ${r.equipment?.ventilator ? 'available' : 'unavailable'}">${r.equipment?.ventilator ? '✓ Installed' : '✕ None'}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Defib AED</span>
            <span class="detail-status-tag ${r.equipment?.defibrillator_aed ? 'available' : 'unavailable'}">${r.equipment?.defibrillator_aed ? '✓ Charged' : '✕ None'}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Stretchers</span>
            <span class="detail-field-val">${r.equipment?.stretcher_count ? `${r.equipment.stretcher_count} Units` : '1 Stretcher'}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Trauma Grade</span>
            <span class="detail-field-val">${esc(r.equipment?.trauma_kit_level || 'Tactical Kit')}</span>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-sec-header">PRIMARY DRIVER PROFILE</div>
        <div class="detail-field-grid">
          <div class="detail-field">
            <span class="detail-field-label">Driver Name</span>
            <span class="detail-field-val" style="color:#ffffff;font-weight:700;">${esc(r.driver?.name || 'Assigned Driver')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Phone Direct</span>
            <span class="detail-field-val"><a href="tel:${esc(r.driver?.phone || '')}" style="color:#38bdf8;font-weight:700;">${esc(r.driver?.phone || '—')}</a></span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">License Number</span>
            <span class="detail-field-val">${esc(r.driver?.license_no || 'CG07-COMMERCIAL')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Experience</span>
            <span class="detail-field-val">${r.driver?.experience_years ? `${r.driver.experience_years} Years` : '5 Years'}</span>
          </div>
          <div class="detail-field full-width">
            <span class="detail-field-label">Shift Duration</span>
            <span class="detail-field-val">${esc(r.driver?.shift || 'Morning 06:00 - 14:00')}</span>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-sec-header">OFFICER / PARAMEDIC IN CHARGE</div>
        <div class="detail-field-grid">
          <div class="detail-field">
            <span class="detail-field-label">Officer Name</span>
            <span class="detail-field-val" style="color:#ffffff;font-weight:700;">${esc(r.lead_crew?.name || 'Paramedic Lead')}</span>
          </div>
          <div class="detail-field">
            <span class="detail-field-label">Designation</span>
            <span class="detail-field-val">${esc(r.lead_crew?.designation || 'Emergency Lead')}</span>
          </div>
          <div class="detail-field full-width">
            <span class="detail-field-label">Emergency Hotline</span>
            <span class="detail-field-val"><a href="tel:${esc(r.lead_crew?.phone || '')}" style="color:#38bdf8;font-weight:700;">${esc(r.lead_crew?.phone || '—')}</a></span>
          </div>
        </div>
      </div>
    `;
  } else if (activeRespDetailTab === 'route') {
    if (r.active_mission) {
      tabContent = `
        <div class="detail-section">
          <div class="detail-sec-header">ACTIVE MISSION INTEL</div>
          <div class="detail-field-grid">
            <div class="detail-field">
              <span class="detail-field-label">Incident ID</span>
              <span class="detail-field-val" style="color:#38bdf8;font-weight:700;">${esc(r.active_mission.incident_id)}</span>
            </div>
            <div class="detail-field">
              <span class="detail-field-label">Priority Level</span>
              <span class="detail-status-tag ${r.active_mission.priority === 'CRITICAL' ? 'unavailable' : 'operational'}">${esc(r.active_mission.priority)}</span>
            </div>
            <div class="detail-field full-width">
              <span class="detail-field-label">Emergency Type</span>
              <span class="detail-field-val">${esc(r.active_mission.incident_type)}</span>
            </div>
            <div class="detail-field full-width">
              <span class="detail-field-label">Target Location</span>
              <span class="detail-field-val">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" style="vertical-align:-1px;margin-right:2px"><path d="M12 21s-8-7.5-8-12a8 8 0 1 1 16 0c0 4.5-8 12-8 12z"/><circle cx="12" cy="9" r="3"/></svg>
                ${esc(r.active_mission.target_location)}
              </span>
            </div>
            ${r.active_mission.target_hospital_name ? `
              <div class="detail-field full-width">
                <span class="detail-field-label">Corridor Destination</span>
                <span class="detail-field-val" style="color:#22c55e;font-weight:700;">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" style="vertical-align:-1px;margin-right:2px"><path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 9h6M12 6v6"/></svg>
                  ${esc(r.active_mission.target_hospital_name)}
                </span>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    } else {
      tabContent = `
        <div class="detail-section">
          <div class="detail-sec-header">MISSION STATUS</div>
          <div style="background:rgba(5, 10, 24, 0.55);border:1px dashed #162444;border-radius:8px;padding:24px;text-align:center;color:#94a3b8;">
            <div style="width:12px;height:12px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px #22c55e;margin:0 auto 10px auto;"></div>
            <strong style="color:#ffffff;font-size:13px;">Unit Ready for Instant Dispatch</strong>
            <p style="font-size:12px;margin:6px 0 0 0;color:#7e92b2;">Stationed at ${esc(r.station?.name || 'Central Depot')}. Ready for 112 emergency response.</p>
          </div>
        </div>
      `;
    }
  }

  return `
    <div class="detail-header">
      <button class="detail-close-btn" onclick="selectedResponder=null;renderResponders();" title="Close Panel">✕</button>
      <div class="detail-icon" style="background:#0a1c36;border:1px solid #163660;color:#38bdf8;">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.5 2.8C2.1 11.2 2 11.6 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg>
      </div>
      <div class="detail-id-block">
        <div class="detail-context-label">SELECTED RESPONDER</div>
        <div class="detail-title-row">
          <h2 class="detail-title">${esc(r.unit_id)}</h2>
          <span class="badge-rec">${esc(r.call_sign || 'FLEET UNIT')}</span>
        </div>
        <div class="detail-meta">${esc(r.id)} &nbsp;•&nbsp; ${esc((r.vehicle_number || '').toUpperCase())} &nbsp;•&nbsp; ${esc((r.type || 'AMBULANCE').toUpperCase())}</div>
        <div class="detail-address">${esc(r.station?.address || 'Civil Lines, Durg-Bhilai')}</div>
        <div class="detail-subbar">
          <span class="hosp-status-pill ${pillStatus}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="8"/></svg>
            ${statusLabel}
          </span>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="hosp-distance-tag">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 21s-8-7.5-8-12a8 8 0 1 1 16 0c0 4.5-8 12-8 12z"/><circle cx="12" cy="9" r="3"/></svg>
              ${d.toFixed(1)} km
            </span>
            <span class="hosp-eta-val">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 17h4M19 17h2a1 1 0 0 0 1-1v-3.5a2 2 0 0 0-.6-1.4l-2.8-2.8A2 2 0 0 0 17.2 8H15V6a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
              <b>${eta} min</b> ETA
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Navigation Tabs (Sleek, 4 focused tabs exactly matching Hospital Intel) -->
    <div class="detail-tabs">
      <button class="detail-tab ${activeRespDetailTab === 'overview' ? 'active' : ''}" onclick="setRespDetailTab('overview')">Overview</button>
      <button class="detail-tab ${activeRespDetailTab === 'clinical' ? 'active' : ''}" onclick="setRespDetailTab('clinical')">Clinical</button>
      <button class="detail-tab ${activeRespDetailTab === 'resources' || activeRespDetailTab === 'crew' ? 'active' : ''}" onclick="setRespDetailTab('resources')">Resources</button>
      <button class="detail-tab ${activeRespDetailTab === 'route' ? 'active' : ''}" onclick="setRespDetailTab('route')">Route & Dispatch</button>
    </div>

    <!-- Scrollable Content Area -->
    <div class="details-content detail-content">
      ${tabContent}
    </div>

    <!-- Pinned Action Buttons Footer (Exact same styling as Hospital Intel) -->
    <div class="detail-actions-footer">
      <button class="btn-action btn-primary" onclick="dispatchResponderUnit('${r.id}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
        <span>Dispatch Unit</span>
      </button>
      <button class="btn-action btn-secondary" onclick="routeResponderToHospital('${r.id}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 9h6M12 6v6"/></svg>
        <span>Hospital Route</span>
      </button>
      <a href="tel:${esc(r.driver?.phone || '')}" class="btn-action btn-secondary">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        <span>Direct Call</span>
      </a>
    </div>
  `;
}

function pickResponder(id) {
  selectedResponder = responders.find(r => r.id === id) || null;
  renderResponders();
  const content = document.querySelector('#responderDetailPanel .details-content');
  if (content) content.scrollTop = 0;
}

function closeRespDetail() {
  selectedResponder = null;
  renderResponders();
}

function setRespDetailTab(tab) {
  activeRespDetailTab = tab;
  renderResponders();
}

function goToRespPage(page) {
  respCurrentPage = page;
  renderResponders();
}

function resetRespFilters() {
  respSearchQuery = '';
  respFilterDistrict = '';
  respFilterZone = '';
  respFilterType = '';
  respFilterStatus = '';
  respFilterEquip = '';
  respFilterSort = 'nearest';
  ['respSearch', 'filterRespDistrict', 'filterRespZone', 'filterRespType', 'filterRespStatus', 'filterRespEquip'].forEach(id => {
    const el = $(id);
    if (el) {
      el.value = '';
      el.classList.remove('has-value');
    }
  });
  if ($('filterRespSort')) $('filterRespSort').value = 'nearest';
  respCurrentPage = 1;
  renderResponders();
}

function setupResponderToolbarListeners() {
  const search = $('respSearch');
  if (search && !search._hasListener) {
    search._hasListener = true;
    search.addEventListener('input', (e) => {
      respSearchQuery = e.target.value;
      if (respSearchQuery.trim()) search.classList.add('has-value'); else search.classList.remove('has-value');
      respCurrentPage = 1;
      renderResponders();
    });
  }

  const dist = $('filterRespDistrict');
  if (dist && !dist._hasListener) {
    dist._hasListener = true;
    dist.addEventListener('change', (e) => {
      respFilterDistrict = e.target.value;
      if (respFilterDistrict) dist.classList.add('has-value'); else dist.classList.remove('has-value');
      respCurrentPage = 1;
      renderResponders();
    });
  }

  const zone = $('filterRespZone');
  if (zone && !zone._hasListener) {
    zone._hasListener = true;
    zone.addEventListener('change', (e) => {
      respFilterZone = e.target.value;
      if (respFilterZone) zone.classList.add('has-value'); else zone.classList.remove('has-value');
      respCurrentPage = 1;
      renderResponders();
    });
  }

  const type = $('filterRespType');
  if (type && !type._hasListener) {
    type._hasListener = true;
    type.addEventListener('change', (e) => {
      respFilterType = e.target.value;
      if (respFilterType) type.classList.add('has-value'); else type.classList.remove('has-value');
      respCurrentPage = 1;
      renderResponders();
    });
  }

  const status = $('filterRespStatus');
  if (status && !status._hasListener) {
    status._hasListener = true;
    status.addEventListener('change', (e) => {
      respFilterStatus = e.target.value;
      if (respFilterStatus) status.classList.add('has-value'); else status.classList.remove('has-value');
      respCurrentPage = 1;
      renderResponders();
    });
  }

  const equip = $('filterRespEquip');
  if (equip && !equip._hasListener) {
    equip._hasListener = true;
    equip.addEventListener('change', (e) => {
      respFilterEquip = e.target.value;
      if (respFilterEquip) equip.classList.add('has-value'); else equip.classList.remove('has-value');
      respCurrentPage = 1;
      renderResponders();
    });
  }

  const sort = $('filterRespSort');
  if (sort && !sort._hasListener) {
    sort._hasListener = true;
    sort.addEventListener('change', (e) => {
      respFilterSort = e.target.value;
      renderResponders();
    });
  }

  const btnGrid = $('btnRespGridView');
  const btnList = $('btnRespListView');
  if (btnGrid && !btnGrid._hasListener) {
    btnGrid._hasListener = true;
    btnGrid.addEventListener('click', () => {
      respViewMode = 'grid';
      btnGrid.classList.add('active');
      if (btnList) btnList.classList.remove('active');
      const grid = $('responderCardGrid');
      if (grid) grid.classList.remove('list-view');
    });
  }
  if (btnList && !btnList._hasListener) {
    btnList._hasListener = true;
    btnList.addEventListener('click', () => {
      respViewMode = 'list';
      btnList.classList.add('active');
      if (btnGrid) btnGrid.classList.remove('active');
      const grid = $('responderCardGrid');
      if (grid) grid.classList.add('list-view');
    });
  }

  // Add Ambulance Driver button
  const btnAddDriver = $('btnAddAmbulanceDriver');
  if (btnAddDriver && !btnAddDriver._hasListener) {
    btnAddDriver._hasListener = true;
    btnAddDriver.addEventListener('click', () => {
      const panel = $('responderDetailPanel');
      panel.style.display = 'block';
      panel.innerHTML = `
        <div class="details-content" style="padding:20px;position:relative;">
          <button type="button" id="closeAddDriverPanel" style="position:absolute;top:8px;right:8px;width:28px;height:28px;border-radius:6px;border:1px solid #163660;background:#0e1530;color:#7e92b2;font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;">&times;</button>
          <h3 style="color:#22d3a3;margin-bottom:16px;">🚑 Add New Ambulance Driver</h3>
          <form id="addDriverForm" style="display:flex;flex-direction:column;gap:12px;">
            <input type="text" id="newDriverName" placeholder="Driver Name" style="padding:10px 14px;border-radius:8px;border:1px solid #163660;background:#0e1530;color:#e6f0fa;font-size:14px;outline:none;">
            <input type="text" id="newDriverUnitId" placeholder="Unit ID (e.g. AMB-205-01)" style="padding:10px 14px;border-radius:8px;border:1px solid #163660;background:#0e1530;color:#e6f0fa;font-size:14px;outline:none;">
            <select id="newDriverType" style="padding:10px 14px;border-radius:8px;border:1px solid #163660;background:#0e1530;color:#e6f0fa;font-size:14px;outline:none;">
              <option value="ALS Ambulance">ALS (Advanced Life Support)</option>
              <option value="BLS Ambulance">BLS (Basic Life Support)</option>
            </select>
            <select id="newDriverZone" style="padding:10px 14px;border-radius:8px;border:1px solid #163660;background:#0e1530;color:#e6f0fa;font-size:14px;outline:none;">
              <option value="Durg Central">Durg Central</option>
              <option value="Bhilai West">Bhilai West</option>
              <option value="Bhilai East">Bhilai East</option>
              <option value="Supela Corridor">Supela Corridor</option>
              <option value="Highway NH53">Highway NH53</option>
            </select>
            <div style="display:flex;gap:10px;margin-top:6px;">
              <button type="submit" style="flex:1;padding:10px;border-radius:8px;border:none;background:linear-gradient(135deg,#0d9373,#0694d4);color:#fff;font-weight:700;font-size:14px;cursor:pointer;">Add Driver</button>
              <button type="button" onclick="document.getElementById('addDriverForm').style.display='none';document.getElementById('closeAddDriverPanel').style.display='none'" style="padding:10px 18px;border-radius:8px;border:1px solid #163660;background:transparent;color:#7e92b2;font-size:14px;cursor:pointer;">Cancel</button>
            </div>
          </form>
        </div>
      `;
      // Close button handler
      setTimeout(() => {
        const closeBtn = document.getElementById('closeAddDriverPanel');
        if (closeBtn) {
          closeBtn.addEventListener('click', () => {
            panel.style.display = 'none';
            panel.innerHTML = '<div class="empty">Select a responder unit from the list to view live telemetry and dispatch intel.</div>';
          });
          closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#1e293b'; closeBtn.style.color = '#f87171'; });
          closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = '#0e1530'; closeBtn.style.color = '#7e92b2'; });
        }
      }, 50);

      // Handle form submit
      setTimeout(() => {
        const form = document.getElementById('addDriverForm');
        if (form) {
          form.addEventListener('submit', function(e) {
            e.preventDefault();
            const name = document.getElementById('newDriverName').value.trim();
            const unitId = document.getElementById('newDriverUnitId').value.trim();
            const type = document.getElementById('newDriverType').value;
            const zone = document.getElementById('newDriverZone').value;
            if (!name || !unitId) return;
            const newResponder = {
              id: unitId.toUpperCase().replace(/\s+/g, '-'),
              unit_id: unitId.toUpperCase(),
              driver_name: name,
              type: type,
              zone: zone,
              status: 'AVAILABLE',
              availability: 'AVAILABLE',
              location: { address: `${zone}, Durg-Bhilai`, lat: 21.1843, lng: 81.3858 },
              equipment: { ventilator: false, defibrillator_aed: true, oxygen_level_pct: 95, stretcher_count: 2, trauma_kit_level: 'Standard' },
              battery_level: 100,
              mission: null,
            };
            responders.unshift(newResponder);
            renderResponders();
            panel.style.display = 'none';
            // Brief success flash
            btnAddDriver.style.background = 'linear-gradient(135deg, #0d9373, #0fb88a)';
            setTimeout(() => { btnAddDriver.style.background = ''; }, 800);
          });
        }
      }, 50);
    });
  }
}

function dispatchResponderUnit(id) {
  const r = responders.find(x => x.id === id);
  if (!r) return;
  r.status = 'EN_ROUTE_TO_INCIDENT';
  if (!r.active_mission) {
    r.active_mission = {
      incident_id: selected?.id || (incidents[0]?.id ?? '-'),
      incident_type: selected?.emergencyType || 'Emergency SOS',
      priority: selected?.priority?.code === 'L1' ? 'CRITICAL' : 'HIGH',
      target_location: selected?.location?.address || 'GE Road Corridor, Durg-Bhilai',
      started_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
  }

  // Broadcast dispatch response to Bystander App
  if (typeof RakshakBridge !== 'undefined') {
    RakshakBridge.notifyDispatch(selected?.id || (incidents[0]?.id ?? '-'), r, selectedHospital);
  }

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  liveTickerEvents.unshift({
    time: timeStr,
    tag: 'dispatch',
    tagClass: 'dispatch',
    text: `🚓 DISPATCH CONFIRMED: Unit ${r.unit_id} (${r.type}) deployed to ${selected?.id || (incidents[0]?.id ?? '-')}. ETA ${r.live_telemetry?.estimated_eta_mins || 3} min.`
  });

  alert(`Dispatched ${r.unit_id} (${r.type}) to active incident ${r.active_mission.incident_id}. Driver ${r.driver?.name} notified. Broadcast sent to Bystander App.`);
  renderResponders();
  renderLiveMonitoring();
}

function routeResponderToHospital(id) {
  const r = responders.find(x => x.id === id);
  if (!r) return;
  r.status = 'TRANSPORTING_PATIENT';
  if (!r.active_mission) {
    r.active_mission = {
      incident_id: selected?.id || (incidents[0]?.id ?? '-'),
      incident_type: 'Trauma Transport',
      priority: 'CRITICAL',
      target_location: 'Green Corridor to Hospital',
      started_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
  }
  r.active_mission.target_hospital_name = selectedHospital?.hospital_name || 'S.S. Hospital & Research Centre';

  // Broadcast to Bystander App
  if (typeof RakshakBridge !== 'undefined') {
    RakshakBridge.notifyDispatch(selected?.id || (incidents[0]?.id ?? '-'), r, selectedHospital);
    RakshakBridge.notifyGreenCorridor({
      route: `Direct Green Corridor to ${r.active_mission.target_hospital_name}`,
      hospitalName: r.active_mission.target_hospital_name
    });
  }

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  liveTickerEvents.unshift({
    time: timeStr,
    tag: 'hospital',
    tagClass: 'hospital',
    text: `🏥 PATIENT ROUTING: ${r.unit_id} locked on Green Corridor to ${r.active_mission.target_hospital_name} Trauma Bay.`
  });

  alert(`Green Corridor route locked for ${r.unit_id} to ${r.active_mission.target_hospital_name}. Traffic PCR alerted. Bystander app updated.`);
  renderResponders();
  renderLiveMonitoring();
}

/* ============================================================
   TACTICAL LIVE MONITORING & REAL-TIME DISPATCH ENGINE
   ============================================================ */

let liveMapActiveLayers = { sos: true, fleet: true, corridors: true };
let greenCorridorActive = true;
let liveTickerEvents = [];

function addTelemetryLog(tagClass, text) {
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let tag = 'ALERT';
  if (tagClass === 'sos') tag = 'NEW SOS';
  else if (tagClass === 'triage') tag = 'TRIAGE';
  else if (tagClass === 'dispatch') tag = 'DISPATCH';
  else if (tagClass === 'hospital') tag = 'HOSPITAL';
  else if (tagClass === 'traffic') tag = 'CORRIDOR';

  liveTickerEvents.unshift({
    time: timeStr,
    tag: tag,
    tagClass: tagClass,
    text: text
  });
  if (liveTickerEvents.length > 30) liveTickerEvents.pop();
  renderLiveTicker();
}

function renderLiveMonitoring() {
  // Update Top Stats Strip
  const activeSosCount = incidents.filter(x => x.status !== 'CLS' && x.status !== 'CANCELLED').length;
  const inMotionCount = responders.filter(r => r.status === 'EN_ROUTE_TO_INCIDENT' || r.status === 'TRANSPORTING_PATIENT' || (r.live_telemetry?.speed_kmh || 0) > 0).length;
  
  if ($('liveMonActiveSos')) $('liveMonActiveSos').textContent = activeSosCount;
  if ($('liveMonFleetMotion')) $('liveMonFleetMotion').textContent = inMotionCount;
  if ($('liveMonGreenCorridors')) $('liveMonGreenCorridors').textContent = greenCorridorActive ? '1 ACTIVE' : '0';
  if ($('liveMonLatency')) $('liveMonLatency').textContent = `${Math.floor(6 + Math.random() * 6)}ms`;

  const targetInc = selected || (incidents.length ? incidents[0] : null);

  // Update Dynamic Bystander Live SOS Intake Card
  const triageBody = $('bystanderTriageBody');
  if (triageBody) {
    if (!targetInc) {
      triageBody.innerHTML = `
        <div class="empty" style="padding:40px 20px;text-align:center;color:#64748b;">
          <div style="font-size:24px;margin-bottom:8px;">🛰️</div>
          <div>Standing by for incoming bystander emergency SOS telemetry.</div>
        </div>
      `;
    } else {
      const lat = targetInc.location?.latitude ?? targetInc.lat;
      const lng = targetInc.location?.longitude ?? targetInc.lng;
      const gpsText = (lat != null && lng != null)
        ? `Live GPS · ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}${targetInc.location?.address ? ' · ' + targetInc.location.address : ''}`
        : (targetInc.location?.address || 'GPS Lock In Progress');
      
      const victims = targetInc.triage?.injuredCount || targetInc.triage?.trappedOrInjured || (targetInc.injured ? `${targetInc.injured} Injured` : '1 Casualty');
      const triageSev = targetInc.priority?.label || targetInc.triage?.emergencyLevel || (targetInc.priority?.code === 'L1' ? 'Level-1 Red' : 'Standard');
      const conscious = targetInc.triage?.consciousness || targetInc.triage?.criticalCondition || (targetInc.stage === 'NO_RESPONSE_CRITICAL' ? 'Unresponsive (Timeout)' : 'Pending Assessment');
      const phoneHtml = targetInc.caller?.phone
        ? `<a href="tel:${esc(targetInc.caller.phone)}" style="color:#38bdf8">${esc(targetInc.caller.phone)}</a>`
        : `<span style="color:#94a3b8">Not provided</span>`;
      
      const transcriptText = targetInc.responseNote || targetInc.note || targetInc.transcript || (
        targetInc.stage === 'INITIAL_BEACON' ? 'Initial SOS beacon triggered from Bystander mobile app. Live GPS locked.' :
        targetInc.stage === 'DIRECT_CALLER_CRITICAL' ? 'Direct caller / victim emergency — automatic Level-1 trauma alert active.' :
        targetInc.stage === 'NO_RESPONSE_CRITICAL' ? 'No response to caller check within 10s. Escalated to Level-1 critical unconfirmed.' :
        'Live emergency telemetry link active. Ready for dispatch coordination.'
      );

      triageBody.innerHTML = `
        <div class="sos-alert-banner">
          <div class="sos-beacon-pulse"></div>
          <div>
            <strong style="color:#ff4d67;font-size:13px;letter-spacing:0.5px;">${esc(targetInc.priority?.label || 'CRITICAL')} SOS BEACON · ${esc(targetInc.id)}</strong>
            <div style="font-size:11px;color:#cbd5e1;margin-top:2px;">${esc(targetInc.source || 'Bystander App Mobile Link')} · ${esc(gpsText)}</div>
          </div>
        </div>

        <div class="triage-vital-grid">
          <div class="triage-vital-box">
            <span class="vital-lbl">VICTIMS</span>
            <span class="vital-val red" id="triageVictims">${esc(victims)}</span>
          </div>
          <div class="triage-vital-box">
            <span class="vital-lbl">TRIAGE STATUS</span>
            <span class="vital-val red" id="triageSeverity">${esc(triageSev)}</span>
          </div>
          <div class="triage-vital-box">
            <span class="vital-lbl">CONSCIOUSNESS</span>
            <span class="vital-val amber" id="triageConscious">${esc(conscious)}</span>
          </div>
          <div class="triage-vital-box">
            <span class="vital-lbl">CALLER PHONE</span>
            <span class="vital-val" style="font-size:11px">${phoneHtml}</span>
          </div>
        </div>

        <!-- AUDIO TRANSCRIPT STREAM -->
        <div class="audio-transcript-box">
          <div class="audio-transcript-header">
            <span style="display:flex;align-items:center;gap:6px;"><span class="audio-live-dot"></span> 112 CALLER / BYSTANDER TELEMETRY</span>
            <span class="confidence-tag">${esc(targetInc.stage || targetInc.status || 'ACTIVE')}</span>
          </div>
          <p class="transcript-text" id="liveTranscript">"${esc(transcriptText)}"</p>
        </div>

        <!-- QUICK ACTIONS BAR -->
        <div class="live-action-strip">
          <button class="btn-live-action primary" onclick="triggerSimulatedSOS()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
            <span>Simulate SOS Inbound</span>
          </button>
          <button class="btn-live-action secondary" onclick="activateGreenCorridor()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            <span>Lock Green Corridor</span>
          </button>
        </div>
      `;
    }
  }

  // Update HUD values
  if ($('hudTarget')) {
    if (targetInc) {
      const lat = targetInc.location?.latitude ?? targetInc.lat;
      const lng = targetInc.location?.longitude ?? targetInc.lng;
      const loc = (lat != null && lng != null) ? `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` : (targetInc.location?.address || 'Live GPS');
      $('hudTarget').textContent = `${targetInc.id} (${targetInc.emergencyType || targetInc.type || loc})`;
    } else {
      $('hudTarget').textContent = 'NO ACTIVE INCIDENT';
    }
  }

  const assignedResp = responders.find(r => r.active_mission?.incident_id === targetInc?.id || r.assigned_incident === targetInc?.id);
  if ($('hudUnit')) {
    $('hudUnit').textContent = assignedResp ? `${assignedResp.unit_id} (${assignedResp.type})` : 'NOT ASSIGNED';
  }
  if ($('hudEta')) {
    $('hudEta').textContent = assignedResp ? `${assignedResp.live_telemetry?.estimated_eta_mins || 3} MIN` : '—';
  }
  if ($('hudDest')) {
    if (targetInc?.destinationHospital) {
      $('hudDest').textContent = targetInc.destinationHospital;
    } else if (selectedHospital) {
      $('hudDest').textContent = selectedHospital.hospital_name;
    } else {
      $('hudDest').textContent = 'NOT SELECTED';
    }
  }

  // Render Tactical Pins & Vector Overlay
  renderTacticalMapPins();

  // Render Real-time Live Ticker
  renderLiveTicker();
}

function renderTacticalMapPins() {
  const container = $('tacticalMapPins');
  const svgVectors = $('mapVectors');
  if (!container || !svgVectors) return;

  container.innerHTML = '';
  svgVectors.innerHTML = '';

  // Bounding box for Durg-Bhilai projection
  const minLat = 21.1600, maxLat = 21.2500;
  const minLon = 81.2500, maxLon = 81.4200;

  const toXY = (lat, lon) => {
    const x = Math.max(5, Math.min(95, ((lon - minLon) / (maxLon - minLon)) * 90 + 5));
    const y = Math.max(5, Math.min(95, 95 - ((lat - minLat) / (maxLat - minLat)) * 90));
    return { x, y };
  };

  let targetSosPos = null;
  let assignedFleetPos = null;
  let targetHospPos = null;

  // 1. Plot SOS Beacons
  if (liveMapActiveLayers.sos) {
    incidents.forEach(inc => {
      const lat = inc.location?.latitude ?? inc.lat ?? DEFAULT_LAT;
      const lon = inc.location?.longitude ?? inc.lng ?? DEFAULT_LON;
      const pos = toXY(lat, lon);
      if (inc.id === (selected?.id || (incidents[0]?.id ?? '-'))) targetSosPos = pos;

      const pin = document.createElement('div');
      pin.className = 'tactical-pin sos';
      pin.style.left = `${pos.x}%`;
      pin.style.top = `${pos.y}%`;
      pin.onclick = () => {
        selected = inc;
        renderLiveMonitoring();
        render();
      };
      pin.innerHTML = `
        <div class="tactical-pin-icon">🚨</div>
        <div class="tactical-pin-label">${esc(inc.id)} · ${esc(inc.emergencyType ? inc.emergencyType.split(' ')[0] : 'SOS')}</div>
      `;
      container.appendChild(pin);
    });
  }

  // 2. Plot Responder Fleet Units
  if (liveMapActiveLayers.fleet && responders.length) {
    responders.slice(0, 8).forEach(r => {
      const lat = r.live_telemetry?.current_latitude || (DEFAULT_LAT + (Math.random() - 0.5) * 0.04);
      const lon = r.live_telemetry?.current_longitude || (DEFAULT_LON + (Math.random() - 0.5) * 0.06);
      const pos = toXY(lat, lon);
      if (r.id === 'RESP-001') assignedFleetPos = pos;

      const speed = r.live_telemetry?.speed_kmh || 0;
      const pin = document.createElement('div');
      pin.className = 'tactical-pin fleet';
      pin.style.left = `${pos.x}%`;
      pin.style.top = `${pos.y}%`;
      pin.onclick = () => {
        selectedResponder = r;
        if (typeof renderResponders === 'function') renderResponders();
      };
      pin.innerHTML = `
        <div class="tactical-pin-icon">🚑</div>
        <div class="tactical-pin-label" style="border-color:#38bdf8;color:#38bdf8">${esc(r.unit_id)} (${speed} km/h)</div>
      `;
      container.appendChild(pin);
    });
  }

  // 3. Plot Key Hospitals
  if (hospitals.length) {
    hospitals.slice(0, 5).forEach(h => {
      if (h.latitude && h.longitude) {
        const pos = toXY(h.latitude, h.longitude);
        if (h.id === (selectedHospital?.id || 'DURG-P-001')) targetHospPos = pos;

        const pin = document.createElement('div');
        pin.className = 'tactical-pin hospital';
        pin.style.left = `${pos.x}%`;
        pin.style.top = `${pos.y}%`;
        pin.onclick = () => {
          selectedHospital = h;
          if (typeof renderHospitals === 'function') renderHospitals();
        };
        pin.innerHTML = `
          <div class="tactical-pin-icon">🏥</div>
          <div class="tactical-pin-label" style="border-color:#22c55e;color:#22c55e">${esc(h.hospital_name.split(' ')[0])}</div>
        `;
        container.appendChild(pin);
      }
    });
  }

  // 4. Draw Animated Green Corridor Vectors
  if (liveMapActiveLayers.corridors && greenCorridorActive && targetSosPos && assignedFleetPos) {
    const defaultHospPos = targetHospPos || { x: targetSosPos.x + 15, y: targetSosPos.y - 12 };
    svgVectors.innerHTML = `
      <!-- Fleet to SOS -->
      <polyline points="${assignedFleetPos.x}%,${assignedFleetPos.y}% ${targetSosPos.x}%,${targetSosPos.y}%" class="corridor-line" />
      <!-- SOS to Hospital -->
      <polyline points="${targetSosPos.x}%,${targetSosPos.y}% ${defaultHospPos.x}%,${defaultHospPos.y}%" class="corridor-line" style="stroke:#38bdf8;" />
    `;
  }
}

function renderLiveTicker() {
  const ticker = $('liveTickerList');
  if (!ticker) return;
  ticker.innerHTML = liveTickerEvents.map(evt => `
    <div class="ticker-item">
      <span class="ticker-time">${esc(evt.time)}</span>
      <div class="ticker-content">
        <span class="ticker-tag ${esc(evt.tagClass || 'sos')}">${esc(evt.tag || 'ALERT')}</span>
        ${esc(evt.text)}
      </div>
    </div>
  `).join('');
}

function toggleMapLayer(layer, btn) {
  if (layer === 'all') {
    liveMapActiveLayers = { sos: true, fleet: true, corridors: true };
    document.querySelectorAll('.map-ctrl-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
  } else {
    liveMapActiveLayers[layer] = !liveMapActiveLayers[layer];
    if (btn) btn.classList.toggle('active', liveMapActiveLayers[layer]);
  }
  renderTacticalMapPins();
}

/* Web Audio Alert Sound Synthesizer (Works in all modern browsers without external audio files) */
function playEmergencyAlertSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    
    // High urgency two-tone emergency chime
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(880, now);
    osc1.frequency.setValueAtTime(1174.66, now + 0.12);
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
    
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    
    osc1.start(now);
    osc1.stop(now + 0.35);
  } catch (e) {
    console.warn('Audio feedback error:', e);
  }
}

/* Trigger New Simulated SOS Inbound from Bystander Mobile App */
function triggerSimulatedSOS() {
  // Call backend API instead of creating local mock incident
  fetch('/api/sos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      emergencyType: 'Critical High-Speed Crash (2 Injured)',
      priority: { code: 'L1', label: 'CRITICAL', score: 99 },
      location: { latitude: 21.2120, longitude: 81.3450, address: 'GE Road, Surya Treasure Island Mall Junction' },
      triage: { injuredCount: 2, consciousness: '1 Unconscious', severeBleeding: true },
      caller: { name: 'Pooja Kashyap (Bystander)', phone: '+91 97520 44109' },
      responseNote: 'Live bystander SOS beacon received. Urgent ALS Ambulance with Oxygen & Ventilator required.'
    })
  })
  .then(r => r.json())
  .then(data => { console.log('SOS delivered to backend:', data); })
  .catch(e => console.error('SOS delivery failed:', e));
  playEmergencyAlertSound();
}

function activateGreenCorridor() {
  // Send to backend via /api/dispatch instead of using local mock
  fetch('/api/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'green_corridor', status: 'ACTIVE', route: 'GE Road to S.S. Hospital Trauma Bay' })
  })
  .catch(e => console.error('Green corridor dispatch failed:', e));
  greenCorridorActive = true;
  addTelemetryLog('traffic', '🟢 GREEN CORRIDOR ENGAGED: Traffic police prioritized path from GE Road to S.S. Hospital Trauma Bay.');
  renderLiveMonitoring();
  alert('🟢 Green Corridor Activated!\nTraffic signals overridden to priority green wave. Hospital trauma bay notified.');
}

// Reset all incidents and active responders back to 0
async function resetAllIncidents() {
  if (!confirm('Are you sure you want to reset all active incidents, emergency queue, and deployed responders back to 0?')) {
    return;
  }
  
  try {
    const base = typeof getBackendBaseUrl === 'function' ? getBackendBaseUrl() : '';
    await fetch(base + '/api/reset', { method: 'POST' });
  } catch (e) {
    console.warn('Backend reset call:', e);
  }

  incidents = [];
  selected = null;
  window.selected = null;
  window.incidents = [];

  if ($('total')) $('total').textContent = '0';
  if ($('critical')) $('critical').textContent = '0';
  if ($('active')) $('active').textContent = '0';
  if ($('last')) $('last').textContent = '—';
  if ($('count')) $('count').textContent = '0 CASES';
  if ($('list')) $('list').innerHTML = '<div class="empty" style="min-height:auto">No emergencies in queue.</div>';

  map();
  if (typeof window.renderLiveMonitoringUI === 'function') {
    window.renderLiveMonitoringUI();
  }
  if (typeof window.renderResponders === 'function') {
    window.renderResponders();
  }
}
window.resetAllIncidents = resetAllIncidents;

window.onIncidentReset = function() {
  incidents = [];
  selected = null;
  window.selected = null;
  window.incidents = [];
  if ($('total')) $('total').textContent = '0';
  if ($('critical')) $('critical').textContent = '0';
  if ($('active')) $('active').textContent = '0';
  if ($('last')) $('last').textContent = '—';
  if ($('count')) $('count').textContent = '0 CASES';
  if ($('list')) $('list').innerHTML = '<div class="empty" style="min-height:auto">No emergencies in queue.</div>';
  map();
  if (typeof window.renderLiveMonitoringUI === 'function') {
    window.renderLiveMonitoringUI();
  }
};

// Initialize Rakshak Two-Way Emergency Bridge
if (typeof RakshakBridge !== 'undefined') {
  RakshakBridge.init({
    onSOSReceived: function(sos) {
      console.log('🚨 [Control Room] INCOMING SOS FROM BYSTANDER APP:', sos);
      handleIncomingIncident(sos, 'bridge_sos');
    },
    onStatusUpdate: function(update) {
      console.log('📝 [Control Room] STATUS UPDATE FROM BYSTANDER APP:', update);
      handleIncomingIncident(update, 'bridge_update');
    },
    onReset: function() {
      if (typeof window.onIncidentReset === 'function') window.onIncidentReset();
    }
  });
}

// Initial render call on startup
render();



