// --- Map + state --------------------------------------------------------
let ACTIVE_USER_ID = 1110;
const urlParams = new URLSearchParams(window.location.search);
const urlUserId = Number(urlParams.get('user_id'));
if (Number.isInteger(urlUserId) && urlUserId > 0) {
  ACTIVE_USER_ID = urlUserId;
}
const ACTIVE_SESSION_ID = "3c048758-287c-49db-938b-240bc91cc4b8";

const map = L.map('map'); // no setView yet, we'll do it after loading

let MEMORIALS = [];

const defaultView = { lat: 52.75, lon: 9.9, zoom: 11 };

fetch('/static/memorials.json')
  .then(res => res.json())
  .then(data => {
    MEMORIALS = data;
    addMemorialMarkers();

    if (MEMORIALS.length > 0) {
      const first = MEMORIALS[0];
      defaultView.lat = first.view_lat ?? first.lat;
      defaultView.lon = first.view_lon ?? first.lon;
      defaultView.zoom = first.view_zoom ?? 15;
      map.setView([defaultView.lat, defaultView.lon], defaultView.zoom);
    } else {
      map.setView([defaultView.lat, defaultView.lon], defaultView.zoom);
    }
  })
  .catch(err => {
    console.error('Error loading memorials.json:', err);
    map.setView([defaultView.lat, defaultView.lon], defaultView.zoom);
  });

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

// Optional: one marker for the last search result
let searchMarker = null;

async function searchPlaces(query, limit = 5) {
  if (!query) return [];
  const url =
    `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=${limit}&q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: { 'Accept-Language': 'en' }
  });
  if (!res.ok) {
    throw new Error('Failed to fetch location suggestions');
  }
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) {
    return [];
  }

  return data
    .map(entry => {
      const lat = parseFloat(entry.lat);
      const lon = parseFloat(entry.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
      }
      return {
        lat,
        lon,
        label: entry.display_name || entry.name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`
      };
    })
    .filter(Boolean);
}

async function geocodePlace(query) {
  const [first] = await searchPlaces(query, 1);
  return first ?? null;
}

// Custom Leaflet control for location search
const LocationSearchControl = L.Control.extend({
  options: {
    position: 'topright', // 'topleft', 'bottomleft', 'bottomright'
  },

  onAdd: function (map) {
    const container = L.DomUtil.create(
      'div',
      'leaflet-bar location-search-control'
    );

    container.innerHTML = `
      <div class="location-input-row">
        <span class="location-icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </span>
        <input
          type="text"
          id="locationQuery"
          placeholder="Search place by name…"
          autocomplete="off"
        />
        <button type="button" class="location-clear" aria-label="Clear search">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
            <line x1="4" y1="4" x2="12" y2="12"></line>
            <line x1="12" y1="4" x2="4" y2="12"></line>
          </svg>
        </button>
      </div>
      <ul class="location-suggestions" id="locationSuggestions" role="listbox"></ul>
      <small id="locStatus">
      </small>
    `;

    // Avoid map dragging when interacting with this control
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    const input = container.querySelector('#locationQuery');
    const status = container.querySelector('#locStatus');
    const suggestionsList = container.querySelector('#locationSuggestions');
    const clearButton = container.querySelector('.location-clear');

    const coordChip = document.getElementById('coordChip');
    const btnGeoSearch = document.getElementById('btnGeoSearch');
    const suggestionsState = {
      timer: null,
      requestId: 0,
      items: [],
    };

    function toggleClearButton(visible) {
      if (!clearButton) return;
      clearButton.classList.toggle('visible', Boolean(visible));
    }

    function clearSuggestions() {
      suggestionsState.items = [];
      suggestionsList.innerHTML = '';
      suggestionsList.classList.remove('open');
    }

    function renderSuggestions(items) {
      if (!items.length) {
        clearSuggestions();
        return;
      }

      suggestionsState.items = items;
      suggestionsList.innerHTML = items
        .map((item, idx) => {
          const labelShort = item.label.split(',')[0] || item.label;
          return `
            <li data-index="${idx}">
              <span class="suggestion-primary">${labelShort}</span>
              <span class="suggestion-secondary">${item.label}</span>
            </li>
          `;
        })
        .join('');
      suggestionsList.classList.add('open');
    }

    function applySelection(place) {
      if (!place) return;
      const { lat, lon, label } = place;
      const labelShort = label.split(',')[0] || label;
      const latLng = L.latLng(lat, lon);

      selectedLatLng = latLng;
      map.setView(latLng, 12);

      if (!searchMarker) {
        searchMarker = L.marker(latLng).addTo(map);
      } else {
        searchMarker.setLatLng(latLng);
      }

      updateMarker();
      updateCircle();
      updateCoordDisplay(labelShort);
      status.textContent = '';
      if (btnGeoSearch) {
        btnGeoSearch.disabled = false;
      }
      window.selectedLocation = { lat, lon, label: labelShort };
      clearSuggestions();
      toggleClearButton(true);
    }

    async function doSearch(queryOverride) {
      const query = queryOverride ?? input.value.trim();
      if (!query) return;

      status.textContent = '';

      try {
        const result = await geocodePlace(query);

        if (!result) {
          status.textContent = 'Place not found';
          clearSuggestions();
          return;
        }

        input.value = result.label;
        toggleClearButton(true);
        applySelection(result);
      } catch (err) {
        console.error(err);
        status.textContent = 'Error during search';
      }
    }

    async function fetchSuggestions(query) {
      status.textContent = '';
      const requestId = ++suggestionsState.requestId;
      try {
        const results = await searchPlaces(query, 5);
        if (requestId !== suggestionsState.requestId) return;
        if (!results.length) {
          status.textContent = '';
          clearSuggestions();
          return;
        }
        status.textContent = '';
        renderSuggestions(results);
      } catch (err) {
        console.error(err);
        if (requestId !== suggestionsState.requestId) return;
        status.textContent = '';
        clearSuggestions();
      }
    }

    function handleInput() {
      const query = input.value.trim();
      clearTimeout(suggestionsState.timer);
      if (!query) {
        status.textContent = '';
        clearSuggestions();
        return;
      }

      suggestionsState.timer = setTimeout(() => {
        fetchSuggestions(query);
      }, 250);
      toggleClearButton(query.length > 0);
    }

    input.addEventListener('input', handleInput);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (suggestionsState.items.length) {
          const first = suggestionsState.items[0];
          input.value = first.label;
          toggleClearButton(true);
          applySelection(first);
        } else {
          doSearch();
        }
      }
    });

    if (clearButton) {
      clearButton.addEventListener('mousedown', (event) => {
        event.preventDefault();
        input.value = '';
        status.textContent = 'Type to search.';
        toggleClearButton(false);
        clearSuggestions();
        suggestionsState.requestId++;
        input.focus();
      });
    }

    suggestionsList.addEventListener('mousedown', (event) => {
      const li = event.target.closest('li');
      if (!li) return;
      event.preventDefault(); // keep input focused
      const index = Number(li.dataset.index);
      const place = suggestionsState.items[index];
      if (place) {
        input.value = place.label;
        applySelection(place);
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(() => {
        clearSuggestions();
      }, 150);
    });

    return container;
  },
});

// Add the control to the map
map.addControl(new LocationSearchControl());

const geoResultsLayer = L.layerGroup().addTo(map);
let selectedLatLng = null;
let marker = null;
let circle = null;
let radius = Number(document.getElementById('radiusSlider').value);

const radiusLabel = document.getElementById('radiusLabel');
const coordChip = document.getElementById('coordChip');
const btnGeo = document.getElementById('btnGeoSearch');
const btnClear = document.getElementById('btnClear');
const radiusSlider = document.getElementById('radiusSlider');
const locStatus = document.getElementById('locStatus');
const detailOverlay = document.getElementById('itemDetailOverlay');
const detailCloseBtn = document.getElementById('detailCloseBtn');
const detailImage = document.getElementById('detailImage');
const detailTitleEl = document.getElementById('detailTitle');
const detailTextEl = document.getElementById('detailText');
const detailMetaEl = document.getElementById('detailMeta');
const detailLinkEl = document.getElementById('detailLink');

// Mode switching (top bar)
const tabButtons = document.querySelectorAll('.mode-tab');
const modeViews = document.querySelectorAll('.mode-view');
const btnGenerateNarrative = document.getElementById('btnGenerateNarrative');
const narrativeContainer = document.getElementById('narrativeContainer');
const intentOverlay = document.getElementById('intentOverlay');
const intentChoices = document.querySelectorAll('.intent-choice');

// Store last search items so narrative can reuse them (NEW)
let lastResultsItems = [];
let lastResultsById = new Map();

function setMode(mode) {
  tabButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  modeViews.forEach(view => {
    const viewMode = view.dataset.mode;
    view.classList.toggle('active', viewMode === mode);
  });
  if (mode === 'results') {
    // Allow layout to settle before forcing Leaflet to recalc
    setTimeout(() => map.invalidateSize(), 150);
  }
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    setMode(btn.dataset.mode);
  });
});

intentChoices.forEach(choice => {
  choice.addEventListener('click', () => {
    const targetMode = choice.dataset.mode || 'results';
    setMode(targetMode);
    if (intentOverlay) {
      intentOverlay.classList.add('hidden');
    }
  });
});

function updateRadiusLabel() {
  radiusLabel.textContent = radius.toLocaleString('en-US') + ' m';
}

function updateCircle() {
  if (!selectedLatLng) return;
  if (!circle) {
    circle = L.circle(selectedLatLng, {
      radius,
      color: '#38bdf8',
      weight: 2,
      fillOpacity: 0.12
    }).addTo(map);
  } else {
    circle.setLatLng(selectedLatLng);
    circle.setRadius(radius);
  }
}

function updateMarker() {
  if (!selectedLatLng) return;
  if (!marker) {
    marker = L.marker(selectedLatLng).addTo(map);
  } else {
    marker.setLatLng(selectedLatLng);
  }
}

function setLocStatus(message) {
  if (locStatus) {
    locStatus.textContent = message;
  }
}

function updateCoordDisplay(labelExtra) {
  if (!selectedLatLng) {
    coordChip.textContent = 'No location selected';
    btnGeo.disabled = true;
    return;
  }
  const radiusText = `Radius ${radius.toLocaleString('en-US')} m`;
  const statusText = labelExtra ? 'Preferred area set' : 'Area selected';
  coordChip.textContent = `${statusText} · ${radiusText}`;
  btnGeo.disabled = false;
}

map.on('click', (e) => {
  selectedLatLng = e.latlng;
  updateMarker();
  updateCircle();
  updateCoordDisplay();
  setLocStatus('');
});

function addMemorialMarkers() {
  MEMORIALS.forEach(mem => {
    const m = L.circleMarker([mem.lat, mem.lon], {
      radius: 6,
      color: '#facc15',
      weight: 2,
      fillOpacity: 0.95
    }).addTo(map);

    m.bindPopup(`<strong>${mem.name}</strong><br>${mem.lat.toFixed(4)}, ${mem.lon.toFixed(4)}`);

    m.on('click', () => {
      selectedLatLng = m.getLatLng();
      updateMarker();
      updateCircle();
      updateCoordDisplay(mem.name);
      map.panTo(selectedLatLng);
      setLocStatus(``);
    });
  });
}

function toNumberLike(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function findLatLon(candidate) {
  if (!candidate) return null;

  if (Array.isArray(candidate)) {
    for (const entry of candidate) {
      const found = findLatLon(entry);
      if (found) return found;
    }
    return null;
  }

  if (typeof candidate === 'string') {
    const parts = candidate.split(/[,;]/).map(part => part.trim());
    if (parts.length >= 2) {
      const lat = toNumberLike(parts[0]);
      const lon = toNumberLike(parts[1]);
      if (lat !== null && lon !== null) {
        return { lat, lon };
      }
    }
    return null;
  }

  if (typeof candidate === 'object') {
    const latKeys = ['lat', 'latitude', 'lat_deg'];
    const lonKeys = ['lon', 'lng', 'longitude', 'lon_deg'];

    let lat = null;
    let lon = null;

    for (const key of latKeys) {
      if (lat === null && key in candidate) {
        lat = toNumberLike(candidate[key]);
      }
    }
    for (const key of lonKeys) {
      if (lon === null && key in candidate) {
        lon = toNumberLike(candidate[key]);
      }
    }

    if (lat !== null && lon !== null) {
      return { lat, lon };
    }

    if ('coordinates' in candidate) {
      const coords = candidate.coordinates;
      const coordsResult = findLatLon(coords);
      if (coordsResult) return coordsResult;
    }

    if ('point' in candidate) {
      const pointResult = findLatLon(candidate.point);
      if (pointResult) return pointResult;
    }

    return null;
  }

  return null;
}

function extractLatLonFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return (
    findLatLon(payload.locations) ||
    findLatLon(payload.geo_metadata) ||
    findLatLon(payload.location) ||
    findLatLon({ lat: payload.lat, lon: payload.lon })
  );
}

function formatDateValue(value) {
  const formatSingle = (val) => {
    if (val === null || val === undefined) return null;
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    if (typeof val === 'string') {
      const isoMatch = val.match(/^(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) return isoMatch[1];
      const parsed = new Date(val);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString().slice(0, 10);
      }
      return val;
    }
    return String(val);
  };

  if (Array.isArray(value)) {
    return value
      .map(formatSingle)
      .filter(Boolean)
      .join(', ');
  }
  return formatSingle(value) || '';
}

function plotGeoResultMarkers(items, { adjustView = true } = {}) {
  geoResultsLayer.clearLayers();
  if (!Array.isArray(items) || !items.length) return;

  const plotted = [];
  items.forEach(item => {
    const payload = item.payload || {};
    const coords = extractLatLonFromPayload(payload);
    if (!coords) return;

    const title = payload.title || '(No title)';
    L.circleMarker([coords.lat, coords.lon], {
      radius: 7,
      color: '#38bdf8',
      weight: 2,
      fillColor: '#38bdf8',
      fillOpacity: 0.8
    })
      .bindPopup(`<strong>${title}</strong><br>${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`)
      .addTo(geoResultsLayer);

    plotted.push([coords.lat, coords.lon]);
  });

  if (!plotted.length || !adjustView) return;

  const currentZoom = map.getZoom();
  const targetZoom = Math.min(currentZoom + 1.2, 16);

  if (plotted.length === 1) {
    map.flyTo(plotted[0], targetZoom, { duration: 0.5 });
    return;
  }

  const bounds = L.latLngBounds(plotted);
  if (bounds.isValid()) {
    map.flyToBounds(bounds, {
      padding: [50, 50],
      maxZoom: targetZoom,
    });
  }
}

radiusSlider.addEventListener('input', () => {
  radius = Number(radiusSlider.value);
  updateRadiusLabel();
  updateCircle();
  updateCoordDisplay();
});
updateRadiusLabel();

btnClear.addEventListener('click', () => {
  selectedLatLng = null;
  if (marker) { map.removeLayer(marker); marker = null; }
  if (circle) { map.removeLayer(circle); circle = null; }
  if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
  updateCoordDisplay();
  setLocStatus('');
  plotGeoResultMarkers([]);
  map.setView([defaultView.lat, defaultView.lon], defaultView.zoom);
});

// --- Location search by name (OpenStreetMap Nominatim) ------------------
const locationInput = document.getElementById('locationQuery');
const btnLocate = document.getElementById('btnLocate');

async function doLocate() {
  if (!locationInput) return;
  const q = locationInput.value.trim();
  if (!q) return;
  setLocStatus('');

  try {
    const result = await geocodePlace(q);
    if (!result) {
      setLocStatus('');
      return;
    }
    const { lat, lon, label } = result;
    const labelShort = label.split(',')[0] || label;
    selectedLatLng = L.latLng(lat, lon);
    map.setView(selectedLatLng, 11);
    updateMarker();
    updateCircle();
    updateCoordDisplay(labelShort);
    setLocStatus(``);
  } catch (err) {
    setLocStatus('');
    console.error(err);
  }
}

if (btnLocate) {
  btnLocate.addEventListener('click', doLocate);
}
if (locationInput) {
  locationInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLocate();
  });
}

// --- Results rendering --------------------------------------------------
const resultsList = document.getElementById('resultsList');
const resultsCount = document.getElementById('resultsCount');
let activeInteraction = null;
const BLANK_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAAD/ACw=';

function truncateText(text, maxLength = 160) {
  if (!text) return '';
  const clean = String(text).trim();
  if (clean.length <= maxLength) return clean;
  return clean.slice(0, maxLength - 1) + '…';
}

function normalizeResults(json) {
  if (!json || typeof json !== 'object') return [];
  if (json.result) {
    if (Array.isArray(json.result.items)) {
      return json.result.items;
    }
    if (Array.isArray(json.result.prepare_llm_itemsitems)) {
      return json.result.prepare_llm_itemsitems;
    }
  }
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json)) return json;
  return [];
}

function getItemId(item) {
  if (!item) return null;
  const payload = item.payload || {};
  return item.id ?? payload.id ?? payload.item_id ?? null;
}

function setPageScrollLocked(locked) {
  if (!document?.body) return;
  document.body.classList.toggle('no-scroll', Boolean(locked));
}

function hideItemDetailUI() {
  detailOverlay.classList.remove('open');
  detailOverlay.setAttribute('aria-hidden', 'true');
  detailImage.src = '';
  detailImage.style.display = 'none';
  detailLinkEl.style.display = 'none';
  setPageScrollLocked(false);
}

function showItemDetail(item) {
  const payload = item.payload || {};
  const title = payload.title || '(No title)';
  const text = payload.text || '';
  const creator = payload.creator || '';
  const imageUrl = payload.image_url || payload.imageUrl || '';
  const publicUrl = payload.public_url || payload.publicUrl || '';
  const coords = extractLatLonFromPayload(payload);
  const created = payload.time_metadata?.dates_of_creation;

  detailTitleEl.textContent = title;
  detailTextEl.textContent = text;

  if (imageUrl) {
    detailImage.src = imageUrl;
    detailImage.style.display = 'block';
  } else {
    detailImage.style.display = 'none';
  }

  if (publicUrl) {
    detailLinkEl.href = publicUrl;
    detailLinkEl.style.display = 'inline-flex';
  } else {
    detailLinkEl.style.display = 'none';
  }

  const metaParts = [];
  const creatorValue = creator || 'Creator unknown';
  metaParts.push(`<dt>Creator</dt><dd>${creatorValue}</dd>`);
  if (coords) {
    metaParts.push(`<dt>Location</dt><dd>${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}</dd>`);
  }
  if (created) {
    const value = formatDateValue(created);
    metaParts.push(`<dt>Date</dt><dd>${value}</dd>`);
  }
  if (item.score !== undefined) {
    const score = typeof item.score === 'number' ? item.score.toFixed(3) : item.score;
    metaParts.push(`<dt>Score</dt><dd>${score}</dd>`);
  }

  detailMetaEl.innerHTML = metaParts.length ? metaParts.join('') : '<dt>Details</dt><dd>No extra metadata.</dd>';

  detailOverlay.classList.add('open');
  detailOverlay.setAttribute('aria-hidden', 'false');
  setPageScrollLocked(true);
}

async function sendInteractionEvent(itemId, eventType, eventContext = {}, { useBeacon = false } = {}) {
  if (!itemId) return;
  const payload = {
    // id: Date.now(),
    user_id: ACTIVE_USER_ID,
    session_id: ACTIVE_SESSION_ID,
    item_id: itemId,
    event_type: eventType,
    event_payload: eventContext || {}, // Use the empty dict default
    ts: new Date().toISOString()
  };

  if (useBeacon && navigator.sendBeacon) {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    navigator.sendBeacon('/db/events', blob);
    return;
  }

  try {
    await fetch('/db/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: useBeacon
    });
  } catch (err) {
    console.error('Failed to log event', err);
  }
}

async function finalizeActiveInteraction(targetItemId = null, options = {}) {
  if (!activeInteraction) return;
  if (targetItemId && activeInteraction.itemId !== targetItemId) return;
  const { itemId } = activeInteraction;
  activeInteraction = null;
  await sendInteractionEvent(itemId, 'end', options);
}

async function handleResultClick(item) {
  await finalizeActiveInteraction();
  hideItemDetailUI();

  const payload = item.payload || {};
  const coords = extractLatLonFromPayload(payload);
  if (coords) {
    const targetZoom = Math.min(Math.max(map.getZoom(), 12) + 1.1, 16);
    map.flyTo([coords.lat, coords.lon], targetZoom, { duration: 0.5 });
  }

  const itemId = getItemId(item);
  if (!itemId) return;

  activeInteraction = { itemId, startedAt: Date.now() };
  await sendInteractionEvent(itemId, 'start');
  showItemDetail(item);
}

function renderResults(items, sourceLabel = 'Text') {
  const badgeText =
    sourceLabel === 'Geo'
      ? 'Geo'
      : sourceLabel === 'Explore'
        ? 'Explore'
        : 'Text';
  const typeBadgeClass =
    sourceLabel === 'Geo'
      ? 'badge badge-geo'
      : sourceLabel === 'Explore'
        ? 'badge badge-explore'
        : 'badge badge-text';
  const countWord = sourceLabel === 'Explore' ? 'neighbor' : 'result';
  const emptyMessage =
    sourceLabel === 'Explore'
      ? 'No nearby documents for this spot. Hover over another cluster.'
      : `No results from ${sourceLabel} search.`;

  lastResultsItems = items || [];  // NEW: remember for narrative
  lastResultsById = new Map();
  lastResultsItems.forEach(it => {
    const id = getItemId(it);
    if (id !== null && id !== undefined) {
      lastResultsById.set(String(id), it);
    }
  });
  btnGenerateNarrative.disabled = !lastResultsItems.length;

  if (!items.length) {
    resultsList.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    resultsCount.textContent = `0 ${countWord}s`;
    return;
  }

  resultsList.innerHTML = '';
  items.forEach(item => {
    const payload = item.payload || {};

    const title = payload.title || '(No title)';
    const clusterLabel = sourceLabel === 'Explore'
      ? (payload.cluster_label || payload.topic_label || payload.topic_name || '')
      : null;
    const creator = clusterLabel || payload.creator || '';
    const imageUrl = payload.image_url || '';
    const publicUrl = payload.public_url || '';

    const card = document.createElement('div');
    card.className = 'result-card';

    const img = document.createElement('img');
    img.className = 'result-thumb';
    img.alt = title;
    img.src = imageUrl || BLANK_IMAGE;

    const info = document.createElement('div');

    const titleEl = document.createElement('div');
    titleEl.className = 'result-title';
    titleEl.textContent = title;

    const creatorEl = document.createElement('div');
    creatorEl.className = 'result-creator';
    const creatorLabel = sourceLabel === 'Explore' ? 'Cluster' : 'Creator';
    creatorEl.textContent = creator
      ? `${creatorLabel}: ${creator}`
      : sourceLabel === 'Explore'
        ? 'Cluster unknown'
        : 'Creator unknown';

        const snippetText = sourceLabel === 'Explore' ? truncateText(payload.text, 180) : '';
    let snippetEl = null;
    if (snippetText) {
      snippetEl = document.createElement('div');
      snippetEl.className = 'result-snippet';
      snippetEl.textContent = snippetText;
    }

    const bottom = document.createElement('div');
    bottom.className = 'result-meta-bottom';

    const link = document.createElement('a');
    link.className = 'result-link';
    link.href = publicUrl || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = publicUrl ? 'Open source ↗' : 'No public URL';

    const badge = document.createElement('span');
    badge.className = typeBadgeClass;
    badge.textContent = badgeText;

    bottom.appendChild(link);
    bottom.appendChild(badge);

    info.appendChild(titleEl);
    info.appendChild(creatorEl);
    if (snippetEl) {
      info.appendChild(snippetEl);
    }
    info.appendChild(bottom);

    card.appendChild(img);
    card.appendChild(info);
    card.addEventListener('click', () => handleResultClick(item));
    link.addEventListener('click', (event) => {
      event.stopPropagation();
      hideItemDetailUI();
      finalizeActiveInteraction(getItemId(item), { useBeacon: true });
    });
    resultsList.appendChild(card);
  });

  resultsCount.textContent =
    `${items.length} ${countWord}${items.length === 1 ? '' : 's'}`;
}

function getNarrativeItemById(itemId) {
  if (itemId === null || itemId === undefined) return null;
  const key = String(itemId);
  return lastResultsById.get(key) || null;
}

async function loadProfileResults(userId) {
  if (!Number.isInteger(userId) || userId <= 0) return;
  resultsCount.textContent = 'Loading your profile results…';
  try {
    const params = new URLSearchParams({ user_id: userId });
    const res = await fetch('/api/search/profile?' + params.toString());
    const json = await res.json();
    const items = normalizeResults(json);
    await finalizeActiveInteraction();
    hideItemDetailUI();
    renderResults(items, 'Profile');
    plotGeoResultMarkers(items, { adjustView: false });
  } catch (err) {
    console.error('Error loading profile results', err);
    resultsList.innerHTML = '<div class="empty-state">Error loading profile results.</div>';
    resultsCount.textContent = 'Error';
    plotGeoResultMarkers([]);
  }
}

function renderNarrativeResultCard(itemId) {
  const item = getNarrativeItemById(itemId);
  const payload = item?.payload || {};
  const title = payload.title || `Item ${itemId ?? ''}`;
  const creator = payload.topic_label || payload.creator || payload.topic_name || '';
  const snippet = payload.text ? truncateText(payload.text, 140) : '';
  const imageUrl = payload.image_url || payload.imageUrl || '';
  const publicUrl = payload.public_url || payload.publicUrl || '';
  const badgeLabel = item?.source || '';
  const dataAttr =
    itemId !== null && itemId !== undefined ? `data-item-id="${itemId}"` : '';

  return `
    <div class="result-card narrative-inline-card" ${dataAttr}>
      <img class="result-thumb" src="${imageUrl || BLANK_IMAGE}" alt="${title}">
      <div class="narrative-inline-body">
        <div class="result-title">${title}</div>
        ${creator ? `<div class="result-creator">${creator}</div>` : ''}
        ${snippet ? `<div class="result-snippet">${snippet}</div>` : ''}
        <div class="result-meta-bottom">
          ${
            publicUrl
              ? `<a class="result-link" href="${publicUrl}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`
              : '<span class="result-link muted-link">No public URL</span>'
          }
          ${
            badgeLabel
              ? `<span class="badge badge-text">${badgeLabel}</span>`
              : ''
          }
        </div>
      </div>
    </div>
  `;
}

function renderNarrativeConnection(rel) {
  if (!rel) return '';
  const typeLabel = rel.type || 'Relationship';
  const explanation = rel.explanation || '';

  return `
    <div class="narrative-connection">
      ${renderNarrativeResultCard(rel.from)}
      <div class="connection-arrow">
        <div class="connection-pill">
          <span class="connection-type">${typeLabel}</span>
          ${explanation ? `<span class="connection-text">${explanation}</span>` : ''}
        </div>
        <span class="arrow-body" aria-hidden="true"></span>
      </div>
      ${renderNarrativeResultCard(rel.to)}
    </div>
  `;
}

// --- Narrative generation / rendering (NEW) -----------------------------
function renderNarrative(narrative) {
  if (!narrative) {
    narrativeContainer.innerHTML =
      '<div class="empty-state">No narrative available.</div>';
    return;
  }

  const title = narrative.narrative_title || 'Narrative';
  const overview = narrative.overview || '';

  let html = `
        <div>
          <h2 class="narrative-title">${title}</h2>
          <p class="narrative-overview">${overview}</p>
        </div>
      `;

  const segments = Array.isArray(narrative.segments) ? narrative.segments : [];

  if (!segments.length) {
    html += `<div class="empty-state">Narrative has no segments.</div>`;
    narrativeContainer.innerHTML = html;
    return;
  }

  segments.forEach(seg => {
    const segHeadline = seg.headline || '(Untitled segment)';
    const segSummary = seg.summary || '';
    const segItems = Array.isArray(seg.item_ids) ? seg.item_ids : [];
    const segRels = Array.isArray(seg.relationships) ? seg.relationships : [];
    const transition = seg.transition_to_next || '';

    const connectionsHtml = segRels.length
      ? `<div class="narrative-flow">
            ${segRels.map(renderNarrativeConnection).join('')}
         </div>`
      : '';

    const cardsFallback = !segRels.length && segItems.length
      ? `<div class="narrative-item-grid">
            ${segItems.map(renderNarrativeResultCard).join('')}
         </div>`
      : '';

    const bodyContent =
      connectionsHtml ||
      cardsFallback ||
      '<div class="empty-state narrative-empty">This segment does not reference specific items.</div>';

    html += `
          <article class="narrative-segment">
            <div class="narrative-segment-header">
              <h3>${segHeadline}</h3>
            </div>
            ${segSummary ? `<p class="narrative-segment-summary">${segSummary}</p>` : ''}
            ${bodyContent}
            ${transition ? `<p class="narrative-transition">${transition}</p>` : ''}
          </article>
        `;
  });

  narrativeContainer.innerHTML = html;

  // Wire click on items in narrative to open the detail overlay
  narrativeContainer.querySelectorAll('.result-card.narrative-inline-card[data-item-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-item-id');
      if (!id) return;
      const item = getNarrativeItemById(id);
      if (item) {
        showItemDetail(item);
      }
    });

    el.querySelectorAll('.result-link').forEach(link => {
      link.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    });
  });
}

async function generateNarrativeFromResults() {
  if (!lastResultsItems.length) return;

  narrativeContainer.innerHTML =
    '<div class="empty-state">Generating narrative…</div>';

  try {
    // Adjust to match your real backend API:
    const res = await fetch('/api/narrative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: lastResultsItems })
    });

    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }

    const narrative = await res.json();
    renderNarrative(narrative.result);
  } catch (err) {
    console.error('Error generating narrative:', err);
    narrativeContainer.innerHTML =
      '<div class="empty-state">Error generating narrative.</div>';
  }
}

btnGenerateNarrative.addEventListener('click', () => {
  generateNarrativeFromResults();
  setMode('narrative');
});

// --- API calls (search) -------------------------------------------------
const btnTextSearch = document.getElementById('btnTextSearch');
const textQueryInput = document.getElementById('textQuery');

async function doGeoSearch() {
  if (!selectedLatLng) return;

  const params = new URLSearchParams({
    lat: selectedLatLng.lat,
    lon: selectedLatLng.lng,
    radius_meters: radius
  });

  resultsCount.textContent = 'Loading geo results…';

  try {
    const res = await fetch('/api/search/geo?' + params.toString());
    const json = await res.json();
    const items = normalizeResults(json);
    await finalizeActiveInteraction();
    hideItemDetailUI();
    renderResults(items, 'Geo');
    plotGeoResultMarkers(items, { adjustView: true });
  } catch (err) {
    console.error(err);
    resultsList.innerHTML = '<div class="empty-state">Error loading geo results.</div>';
    resultsCount.textContent = 'Error';
    plotGeoResultMarkers([]);
  }
}

async function doTextSearch() {
  const q = textQueryInput.value.trim();
  if (!q) return;

  resultsCount.textContent = 'Loading text results…';

  try {
    const params = new URLSearchParams({ q });
    const res = await fetch('/api/search?' + params.toString());
    const json = await res.json();
    const items = normalizeResults(json);
    await finalizeActiveInteraction();
    hideItemDetailUI();
    renderResults(items, 'Text');
    plotGeoResultMarkers(items, { adjustView: false });
  } catch (err) {
    console.error(err);
    resultsList.innerHTML = '<div class="empty-state">Error loading text results.</div>';
    resultsCount.textContent = 'Error';
    plotGeoResultMarkers([]);
  }
}

btnGeo.addEventListener('click', doGeoSearch);
btnTextSearch.addEventListener('click', doTextSearch);
textQueryInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') doTextSearch();
});

detailCloseBtn.addEventListener('click', () => {
  hideItemDetailUI();
  finalizeActiveInteraction();
});

detailOverlay.addEventListener('click', (event) => {
  if (event.target === detailOverlay) {
    hideItemDetailUI();
    finalizeActiveInteraction();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && detailOverlay.classList.contains('open')) {
    hideItemDetailUI();
    finalizeActiveInteraction();
  }
});

window.addEventListener('beforeunload', () => {
  if (!activeInteraction) return;
  const { itemId } = activeInteraction;
  activeInteraction = null;
  sendInteractionEvent(itemId, 'end', { useBeacon: true });
});

if (Number.isInteger(urlUserId) && urlUserId > 0) {
  loadProfileResults(urlUserId);
}

hideItemDetailUI();

// ---------- Exploration mode: 2D topic space -----------------------------

const exploreSvg = document.getElementById("exploreScatter");
const exploreInfo = document.getElementById("exploreInfo");
const hoverCard = document.getElementById("exploreHoverCard");
const hoverTitle = document.getElementById("hoverTitle");
const hoverMeta = document.getElementById("hoverMeta");
const topicFilter = document.getElementById("topicFilter");
const qdrantCache = new Map();
let exploreResultsSeq = 0;

let explorePoints = [];
let exploreVisiblePoints = [];
let exploreViewBox = { x: 0, y: 0, width: 100, height: 100 };
let exploreBaseSpan = 1;
let exploreRootGroup;
let exploreBlobGroup;
let explorePointRadius = 0.02;
const explorePointElements = new Map();
let exploreIsPanning = false;
let exploreHoverFrame = null;
let explorePendingEvent = null;
let exploreLastResultsKey = "";
let exploreLabelNodes = [];
// Keep default aspect ratio handling for accurate pointer mapping
if (exploreSvg) {
  exploreSvg.setAttribute("preserveAspectRatio", "xMidYMid meet");
}

// ---------- Helpers for client-side coordinates ----------------------------

function ensureExploreCoordinates(items) {
  let fallbackCounter = 0;
  for (const item of items) {
    const x = Number(item.x);
    const y = Number(item.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      item.x = x;
      item.y = y;
      continue;
    }

    const vec = Array.isArray(item.vector) ? item.vector : null;
    if (vec && vec.length >= 2) {
      const vx = Number(vec[0]);
      const vy = Number(vec[1]);
      item.x = Number.isFinite(vx) ? vx : 0;
      item.y = Number.isFinite(vy) ? vy : 0;
      continue;
    }

    item.x = fallbackCounter * 0.1;
    item.y = 0;
    fallbackCounter += 1;
  }

  // If all points are effectively on a line (x ~= y), add small deterministic jitter
  // so the plot remains readable until true 2D coordinates are available.
  const coords = items
    .map((d) => [d.x, d.y])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (!coords.length) return;

  const meanX = coords.reduce((s, [a]) => s + a, 0) / coords.length;
  const meanY = coords.reduce((s, [, b]) => s + b, 0) / coords.length;
  const cov =
    coords.reduce((s, [a, b]) => s + (a - meanX) * (b - meanY), 0) /
    coords.length;
  const varX =
    coords.reduce((s, [a]) => s + (a - meanX) * (a - meanX), 0) /
    coords.length;
  const varY =
    coords.reduce((s, [, b]) => s + (b - meanY) * (b - meanY), 0) /
    coords.length;
  const corr =
    varX > 0 && varY > 0 ? cov / Math.sqrt(varX * varY) : 0;

  if (Math.abs(corr) <= 0.995) return;

  const labels = Array.from(
    new Set(items.map((d) => (d.label !== undefined ? String(d.label) : "unknown")))
  ).sort();

  const labelAngles = new Map();
  labels.forEach((lbl, idx) => {
    labelAngles.set(lbl, (idx / labels.length) * Math.PI * 2);
  });

  const xs = coords.map(([a]) => a);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const span = Math.max(maxX - minX, 1e-6);

  function hashToUnit(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i) + 7) >>> 0;
    }
    return (h % 10000) / 10000;
  }

  items.forEach((item, idx) => {
    const labelKey = item.label !== undefined ? String(item.label) : "unknown";
    const angleBase = labelAngles.get(labelKey) ?? 0;
    const key =
      item.id !== undefined
        ? String(item.id)
        : item.label !== undefined
          ? String(item.label)
          : String(idx);

    const thetaJitter = (hashToUnit(key + "theta") - 0.5) * (Math.PI / labels.length);
    const radialJitter = (hashToUnit(key + "radial") - 0.5) * 0.3;
    const baseRadius = 1 + (Number(item.x) - minX) / span;
    const r = baseRadius + radialJitter;
    const theta = angleBase + thetaJitter;

    item.x = r * Math.cos(theta);
    item.y = r * Math.sin(theta);
  });

  console.warn("Topic map: colinear coordinates detected; redistributed points radially by label.");
}

function ensureExploreDefs() {
  if (!exploreSvg) return;
  let defs = exploreSvg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    exploreSvg.insertBefore(defs, exploreSvg.firstChild);
  }
  if (!exploreSvg.querySelector("#exploreBlobBlur")) {
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.setAttribute("id", "exploreBlobBlur");
    filter.setAttribute("x", "-20%");
    filter.setAttribute("y", "-20%");
    filter.setAttribute("width", "140%");
    filter.setAttribute("height", "140%");
    const fe = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
    fe.setAttribute("in", "SourceGraphic");
    fe.setAttribute("stdDeviation", "0.18");
    filter.appendChild(fe);
    defs.appendChild(filter);
  }
}

function updateExploreLabelAppearance() {
  const span = Math.max(exploreViewBox.width, exploreViewBox.height, 1e-6);
  const detail = exploreBaseSpan / span;
  const scale = span / exploreBaseSpan;
  exploreLabelNodes.forEach(({ node, count, baseFont }) => {
    if (!node) return;
    const score = (count || 1) * detail;
    const visible = score >= 1.6;
    node.style.display = visible ? "block" : "none";
    node.style.opacity = visible ? "0.9" : "0";
    const size = Math.max((baseFont || 0.16) * scale, 0.08);
    node.setAttribute("font-size", size);
  });
}

function svgPointFromClient(event) {
  if (!exploreSvg || !exploreSvg.createSVGPoint) return null;
  const pt = exploreSvg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const ctm = exploreSvg.getScreenCTM();
  if (!ctm) return null;
  const inv = ctm.inverse();
  const svgPt = pt.matrixTransform(inv);
  return {
    x: svgPt.x,
    y: svgPt.y,
  };
}

function getNeighborRadius() {
  const base = Math.max(exploreViewBox.width, exploreViewBox.height);
  return Math.max(base * 0.08, 0.05);
}

function findNeighborsAtPosition(x, y, options = {}) {
  const limit = options.limit ?? 12;
  const radius = options.radius ?? getNeighborRadius();
  const matches = [];
  const dataset = exploreVisiblePoints.length ? exploreVisiblePoints : explorePoints;
  for (const point of dataset) {
    if (typeof point.x !== "number" || typeof point.y !== "number") continue;
    const dx = point.x - x;
    const dy = point.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(dist)) continue;
    if (dist <= radius) {
      matches.push({ point, distance: dist });
    }
  }
  matches.sort((a, b) => a.distance - b.distance);
  return matches.slice(0, limit);
}

function computeCentroid(points) {
  if (!points.length) return { x: 0, y: 0 };
  const sum = points.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
    { x: 0, y: 0 }
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function computeHull(points) {
  if (points.length <= 1) return points.slice();
  const pts = points
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function scalePolygon(points, factor) {
  if (!points.length) return [];
  const c = computeCentroid(points);
  return points.map((p) => ({
    x: c.x + (p.x - c.x) * factor,
    y: c.y + (p.y - c.y) * factor,
  }));
}

function polygonPath(points) {
  if (!points.length) return "";
  const cmds = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 1; i < points.length; i++) {
    cmds.push(`L ${points[i].x} ${points[i].y}`);
  }
  cmds.push("Z");
  return cmds.join(" ");
}

function lightenColor(hex, amount = 0.2) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || "");
  const rgb = m
    ? [
        parseInt(m[1].slice(0, 2), 16),
        parseInt(m[1].slice(2, 4), 16),
        parseInt(m[1].slice(4, 6), 16),
      ]
    : [120, 120, 120];
  const t = Math.max(0, Math.min(1, amount));
  const mix = rgb.map((c) => Math.round(c + (255 - c) * t));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function darkenColor(hex, amount = 0.2) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || "");
  const rgb = m
    ? [
        parseInt(m[1].slice(0, 2), 16),
        parseInt(m[1].slice(2, 4), 16),
        parseInt(m[1].slice(4, 6), 16),
      ]
    : [80, 80, 80];
  const t = Math.max(0, Math.min(1, amount));
  const mix = rgb.map((c) => Math.round(c * (1 - t)));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function highlightExploreNeighbors(neighbors) {
  const highlightMap = new Map();
  neighbors.forEach((entry, idx) => {
    highlightMap.set(String(entry.point.id), idx);
  });

  explorePointElements.forEach((circle, id) => {
    if (!circle) return;
    if (highlightMap.has(id)) {
      circle.classList.add("neighbor-highlight");
      const idx = highlightMap.get(id);
      const scale = idx === 0 ? 2 : 1.35;
      circle.setAttribute("r", (explorePointRadius * scale).toFixed(4));
      circle.setAttribute("stroke", "rgba(15, 23, 42, 0.35)");
      circle.setAttribute("stroke-width", 0.01);
    } else {
      circle.classList.remove("neighbor-highlight");
      circle.setAttribute("r", explorePointRadius);
      circle.setAttribute("stroke", "none");
      circle.setAttribute("stroke-width", 0);
    }
  });
}

async function fetchQdrantItems(itemIds = []) {
  const ids = Array.from(
    new Set(
      itemIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
    )
  );

  const missing = ids.filter((id) => !qdrantCache.has(String(id)));
  if (missing.length) {
    const params = new URLSearchParams();
    missing.forEach((id) => params.append("item_id", id));
    try {
      const res = await fetch(`/debug/item_info?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const result = data?.result;
        if (result && typeof result === "object" && !Array.isArray(result)) {
          Object.entries(result).forEach(([key, payload]) => {
            qdrantCache.set(String(key), payload || {});
          });
        } else if (Array.isArray(result)) {
          result.forEach((entry) => {
            const key = entry?.id ?? entry?.point_id;
            if (key !== undefined) {
              qdrantCache.set(String(key), entry?.payload || entry || {});
            }
          });
        }
      }
    } catch (err) {
      console.error("Failed to fetch Qdrant items", err);
    }
  }

  const map = new Map();
  ids.forEach((id) => {
    const key = String(id);
    if (qdrantCache.has(key)) {
      map.set(key, qdrantCache.get(key));
    }
  });
  return map;
}

function neighborToResult(neighbor, qdrantPayload) {
  const { point, distance } = neighbor;
  const snippet = (point.text || "").trim();
  const fallbackTitle = snippet
    ? snippet.slice(0, 80) + (snippet.length > 80 ? "…" : "")
    : `Document ${point.id}`;
  const payload = { ...(qdrantPayload || {}) };

  // Preserve item title if present; otherwise fall back to snippet or id (not cluster label)
  if (!payload.title) payload.title = fallbackTitle;
  if (!payload.text) payload.text = snippet;
  if (!payload.topic_label) payload.topic_label = point.label || "";
  if (!payload.topic_name) payload.topic_name = point.topic || "";
  if (!payload.cluster_label) payload.cluster_label = point.label || point.topic || "";
  payload.explore_distance = distance;

  return {
    id: point.id,
    score: Number.isFinite(distance) ? Number(distance.toFixed(3)) : undefined,
    payload,
    source: "Explore",
  };
}

async function updateExploreResultsFromNeighbors(neighbors, trigger = "hover", { force = false } = {}) {
  if (!neighbors.length) return;
  const key = neighbors.map((entry) => entry.point.id).join("|");
  if (!force && trigger === "hover" && key === exploreLastResultsKey) {
    return;
  }
  exploreLastResultsKey = key;
  const requestId = ++exploreResultsSeq;
  const ids = neighbors
    .map((entry) => entry.point?.id)
    .filter((id) => id !== undefined && id !== null);

  exploreInfo.textContent =
    trigger === "click"
      ? `Loading ${neighbors.length} items from Qdrant…`
      : `Loading preview from Qdrant…`;

  const qdrantMap = await fetchQdrantItems(ids);
  if (requestId !== exploreResultsSeq) {
    return;
  }

  const mapped = neighbors.map((neighbor) => {
    const idKey = String(neighbor.point.id);
    return neighborToResult(neighbor, qdrantMap.get(idKey));
  });
  renderResults(mapped, "Explore");
  plotGeoResultMarkers(mapped, { adjustView: false });
  const action = trigger === "click" ? "Pinned" : "Hovering";
  exploreInfo.textContent = `${action} ${mapped.length} Qdrant item${mapped.length === 1 ? "" : "s"}.`;
}

function processExplorePointerEvent(event, trigger) {
  if (!exploreSvg || !explorePoints.length) return;
  const svgPoint = svgPointFromClient(event);
  if (!svgPoint) return;
  const neighbors = findNeighborsAtPosition(svgPoint.x, svgPoint.y);
  highlightExploreNeighbors(neighbors);
  if (!neighbors.length) {
    if (trigger === "click") {
      exploreInfo.textContent = "No nearby documents here. Try another region.";
    } else {
      exploreInfo.textContent = "Hover to preview density. Click to send neighbors to results.";
    }
    return;
  }
  if (trigger === "click") {
    updateExploreResultsFromNeighbors(neighbors, trigger, { force: true });
  } else {
    exploreInfo.textContent = `Hovering near ${neighbors.length} document${neighbors.length === 1 ? "" : "s"}. Click to preview them.`;
  }
}

function handleExplorePointerMove(event) {
  if (exploreIsPanning) return;
  explorePendingEvent = {
    clientX: event.clientX,
    clientY: event.clientY,
  };
  if (exploreHoverFrame) return;
  exploreHoverFrame = window.requestAnimationFrame(() => {
    exploreHoverFrame = null;
    if (!explorePendingEvent) return;
    processExplorePointerEvent(explorePendingEvent, "hover");
    explorePendingEvent = null;
  });
}

function handleExploreClick(event) {
  if (exploreIsPanning) return;
  processExplorePointerEvent(
    { clientX: event.clientX, clientY: event.clientY },
    "click"
  );
}

// Utility: load JSONL file
async function loadJsonl(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.map((l) => JSON.parse(l));
}

// Initialization
async function initExploreSpace() {
  if (!exploreSvg) return;

  try {
    exploreInfo.textContent = "Loading topic map…";

    const items = await loadJsonl("/static/data/topics.jsonl");
    ensureExploreCoordinates(items);
    explorePoints = items;

    if (!items.length) {
      exploreInfo.textContent = "No points available.";
      return;
    }

    // Build topic list based on topic text (fallback to label)
    const labelSet = new Set(items.map((d) => d.label));
    const topics = [...new Set(items.map((d) => d.topic || d.label || ""))].sort();
    for (const topic of topics) {
      const opt = document.createElement("option");
      opt.value = String(topic);
      opt.textContent = topic;
      topicFilter.appendChild(opt);
    }


    // Determine bounds from x,y
    const xs = items.map((d) => d.x);
    const ys = items.map((d) => d.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const dominantSpan = Math.max(spanX, spanY);
    const padding = Math.max(dominantSpan * 0.1, 0.05);

    exploreViewBox.x = minX - padding;
    exploreViewBox.y = minY - padding;
    exploreViewBox.width = spanX + padding * 2;
    exploreViewBox.height = spanY + padding * 2;

    const baseSize = Math.max(exploreViewBox.width, exploreViewBox.height);
    exploreBaseSpan = baseSize;
    explorePointRadius = Math.min(Math.max(baseSize * 0.006, 0.004), 0.02);

    exploreSvg.setAttribute(
      "viewBox",
      `${exploreViewBox.x} ${exploreViewBox.y} ${exploreViewBox.width} ${exploreViewBox.height}`
    );

    // Root group for pan/zoom
    exploreRootGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    exploreSvg.appendChild(exploreRootGroup);
    ensureExploreDefs();

    drawExplorePoints();

    setupExploreInteractions();

    exploreInfo.textContent = `Loaded ${items.length} items across ${topics.length} clusters. Hover or click to surface neighbors.`;
  } catch (err) {
    console.error("Error loading explore space:", err);
    exploreInfo.textContent = "Error loading topic map.";
  }
}

// Draw points according to topic filter
function drawExplorePoints() {
  if (!exploreRootGroup) return;
  exploreRootGroup.innerHTML = "";
  explorePointElements.clear();
  exploreLabelNodes = [];
  highlightExploreNeighbors([]);
  exploreBlobGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  exploreBlobGroup.setAttribute("class", "explore-blobs");
  exploreBlobGroup.setAttribute("pointer-events", "none");

  const pointsGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  pointsGroup.setAttribute("class", "explore-points");

  const labelsGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  labelsGroup.setAttribute("class", "explore-labels");

  const filterValue = topicFilter.value;
  const filtered =
    filterValue === "all"
      ? explorePoints
      : explorePoints.filter((p) => String(p.topic || p.label) === filterValue);
  exploreVisiblePoints = filtered;

  const topicColors = {};
  const colorPalette = [
    "#E67702", "#4C6EF5", "#12B886", "#F03E3E",
    "#7048E8", "#099268", "#D6336C", "#228BE6",
  ];

  function getLabelColor(label) {
    const key = String(label);
    if (!topicColors[key]) {
      const idx = Object.keys(topicColors).length % colorPalette.length;
      topicColors[key] = colorPalette[idx];
    }
    return topicColors[key];
  }

  const centroids = new Map();
  const pointsByLabel = new Map();

  for (const p of filtered) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", p.x);
    circle.setAttribute("cy", p.y);
    circle.setAttribute("r", explorePointRadius);
    circle.setAttribute("fill", getLabelColor(p.label));
    circle.setAttribute("fill-opacity", "0.9");
    circle.setAttribute("data-id", p.id);
    circle.setAttribute("data-label", p.label);
    circle.setAttribute("data-topic", p.topic);
    circle.setAttribute("stroke", "none");
    circle.setAttribute("stroke-width", 0);
    circle.classList.add("explore-point");
    explorePointElements.set(String(p.id), circle);

    const title = p.text?.slice(0, 80) + (p.text && p.text.length > 80 ? "…" : "");
    const topicName = p.topic?.replace(/\*\*/g, "") || "";

    // Hover
    circle.addEventListener("mouseenter", () => {
      hoverTitle.textContent = title || `Item ${p.id}`;
      hoverMeta.textContent = `${topicName} · ${p.label}`;
      hoverCard.hidden = false;
    });
    circle.addEventListener("mouseleave", () => {
      hoverCard.hidden = true;
    });

    // Click – hook into your detail logic here
    circle.addEventListener("click", () => {
      console.log("Clicked point", p);
      // Example future hook:
      // openItemDetailById(p.id);
      // or call your /debug/item_info?item_id=... endpoint
    });

    pointsGroup.appendChild(circle);

    // accumulate centroid per label
    const lbl = String(p.label);
    const current =
      centroids.get(lbl) ||
      { sumX: 0, sumY: 0, count: 0, color: getLabelColor(lbl), topic: p.topic || "" };
    current.sumX += Number(p.x) || 0;
    current.sumY += Number(p.y) || 0;
    current.count += 1;
    if (!current.topic && p.topic) {
      current.topic = p.topic;
    }
    centroids.set(lbl, current);
    if (!pointsByLabel.has(lbl)) {
      pointsByLabel.set(lbl, []);
    }
    pointsByLabel.get(lbl).push({ x: Number(p.x), y: Number(p.y) });
  }

  // Cluster blob “mass” effect
  pointsByLabel.forEach((pts, lbl) => {
    if (!pts.length) return;
    const hull = computeHull(pts);
    const color = getLabelColor(lbl);
    const light = lightenColor(color, 0.4);
    const scales = [1.18, 1.1, 1.0];
    const alphas = [0.08, 0.12, 0.18];

    scales.forEach((factor, idx) => {
      const poly = hull.length >= 3 ? scalePolygon(hull, factor) : scalePolygon(pts, factor);
      const pathD = polygonPath(poly);
      if (!pathD) return;
      const blob = document.createElementNS("http://www.w3.org/2000/svg", "path");
      blob.setAttribute("d", pathD);
      blob.setAttribute("fill", light);
      blob.setAttribute("fill-opacity", alphas[idx] || 0.1);
      blob.setAttribute("filter", "url(#exploreBlobBlur)");
      blob.setAttribute("stroke", "none");
      blob.setAttribute("pointer-events", "none");
      exploreBlobGroup.appendChild(blob);
    });
  });

  // Add label text at cluster centroids with simple collision avoidance
  const labelsArr = Array.from(centroids.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  const placedBoxes = [];

  function makeBounds(cx, cy, textStr, fontSize) {
    const halfW = (textStr.length * fontSize * 0.55) / 2;
    const halfH = fontSize * 0.6;
    return {
      x1: cx - halfW,
      x2: cx + halfW,
      y1: cy - halfH,
      y2: cy + halfH,
    };
  }

  function overlaps(box, other) {
    return !(
      box.x2 < other.x1 ||
      box.x1 > other.x2 ||
      box.y2 < other.y1 ||
      box.y1 > other.y2
    );
  }

  labelsArr.forEach(([lbl, info]) => {
    if (!info.count) return;
    const baseX = info.sumX / info.count;
    const baseY = info.sumY / info.count;
    const fontSize = Math.max(explorePointRadius * 6, 0.16);
    const textStr = info.topic || lbl;
    const step = fontSize * 1.4;
    const offsets = [0, step, -step, 2 * step, -2 * step, 3 * step, -3 * step];

    let placedX = baseX;
    let placedY = baseY;
    let bounds = makeBounds(baseX, baseY, textStr, fontSize);

    for (const dy of offsets) {
      const candidate = makeBounds(baseX, baseY + dy, textStr, fontSize);
      const hit = placedBoxes.some((box) => overlaps(candidate, box));
      if (!hit) {
        placedY = baseY + dy;
        bounds = candidate;
        break;
      }
    }

    placedBoxes.push(bounds);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", placedX);
    text.setAttribute("y", placedY);
    const labelColor = darkenColor(info.color, 0.35);
    text.setAttribute("fill", labelColor || "#111827");
    text.setAttribute("font-size", fontSize);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("font-weight", "600");
    text.setAttribute("letter-spacing", "-0.02em");
    text.setAttribute("pointer-events", "none");
    text.classList.add("explore-label");
    text.textContent = textStr;
    labelsGroup.appendChild(text);
    if (text.style) {
      text.style.userSelect = "none";
    }
    exploreLabelNodes.push({ node: text, count: info.count, baseFont: fontSize });
  });

  exploreRootGroup.appendChild(exploreBlobGroup);
  exploreRootGroup.appendChild(pointsGroup);
  exploreRootGroup.appendChild(labelsGroup);

  updateExploreLabelAppearance();
}

// Basic pan/zoom for SVG
function setupExploreInteractions() {
  let lastX = 0;
  let lastY = 0;

  exploreSvg.addEventListener("mousedown", (e) => {
    exploreIsPanning = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  window.addEventListener("mouseup", () => {
    exploreIsPanning = false;
  });

  exploreSvg.addEventListener("mousemove", (e) => {
    if (!exploreIsPanning) {
      handleExplorePointerMove(e);
      return;
    }

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    const svgRect = exploreSvg.getBoundingClientRect();
    const scaleX = exploreViewBox.width / svgRect.width;
    const scaleY = exploreViewBox.height / svgRect.height;

    exploreViewBox.x -= dx * scaleX;
    exploreViewBox.y -= dy * scaleY;

    exploreSvg.setAttribute(
      "viewBox",
      `${exploreViewBox.x} ${exploreViewBox.y} ${exploreViewBox.width} ${exploreViewBox.height}`
    );
    updateExploreLabelAppearance();
  });

  exploreSvg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const zoomFactor = 1.1;
    const direction = e.deltaY > 0 ? 1 : -1;
    const factor = direction > 0 ? zoomFactor : 1 / zoomFactor;

    const svgRect = exploreSvg.getBoundingClientRect();
    const mouseX = e.clientX - svgRect.left;
    const mouseY = e.clientY - svgRect.top;

    const vx = exploreViewBox.x + (mouseX / svgRect.width) * exploreViewBox.width;
    const vy = exploreViewBox.y + (mouseY / svgRect.height) * exploreViewBox.height;

    exploreViewBox.width *= factor;
    exploreViewBox.height *= factor;
    exploreViewBox.x = vx - (mouseX / svgRect.width) * exploreViewBox.width;
    exploreViewBox.y = vy - (mouseY / svgRect.height) * exploreViewBox.height;

    exploreSvg.setAttribute(
      "viewBox",
      `${exploreViewBox.x} ${exploreViewBox.y} ${exploreViewBox.width} ${exploreViewBox.height}`
    );
    updateExploreLabelAppearance();
  });

  topicFilter.addEventListener("change", () => {
    drawExplorePoints();
    exploreLastResultsKey = "";
    exploreInfo.textContent = "Filter applied. Hover to explore nearby stories.";
  });

  exploreSvg.addEventListener("click", handleExploreClick);
  exploreSvg.addEventListener("mouseleave", () => {
    if (!exploreIsPanning) {
      highlightExploreNeighbors([]);
    }
    explorePendingEvent = null;
  });
}

// Call this once on page load (after DOM ready)
  document.addEventListener("DOMContentLoaded", () => {
    initExploreSpace();
  });
(function preloadIntentQuery() {
  const stored = sessionStorage.getItem('memoriseIntentQuery');
  if (!stored) return;
  const textInput = typeof document !== 'undefined'
    ? document.getElementById('textQuery')
    : null;
  if (!textInput) return;
  textInput.value = stored;
  sessionStorage.removeItem('memoriseIntentQuery');
  setTimeout(() => {
    if (typeof doTextSearch === 'function') {
      doTextSearch();
    }
  }, 50);
})();
