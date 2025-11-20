// --- Map + state --------------------------------------------------------
const ACTIVE_USER_ID = 10;

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
const detailCreatorEl = document.getElementById('detailCreator');
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

function hideItemDetailUI() {
  detailOverlay.classList.remove('open');
  detailOverlay.setAttribute('aria-hidden', 'true');
  detailImage.src = '';
  detailImage.style.display = 'none';
  detailLinkEl.style.display = 'none';
}

function showItemDetail(item) {
  const payload = item.payload || {};
  const title = payload.title || '(No title)';
  const text = payload.text || 'No description provided.';
  const creator = payload.creator || '';
  const imageUrl = payload.image_url || payload.imageUrl || '';
  const publicUrl = payload.public_url || payload.publicUrl || '';
  const coords = extractLatLonFromPayload(payload);
  const created = payload.time_metadata?.dates_of_creation;

  detailTitleEl.textContent = title;
  detailCreatorEl.textContent = creator ? `Creator: ${creator}` : 'Creator unknown';
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
  if (coords) {
    metaParts.push(`<dt>Location</dt><dd>${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}</dd>`);
  }
  if (created) {
    const value = Array.isArray(created) ? created.join(', ') : created;
    metaParts.push(`<dt>Date</dt><dd>${value}</dd>`);
  }
  if (item.score !== undefined) {
    const score = typeof item.score === 'number' ? item.score.toFixed(3) : item.score;
    metaParts.push(`<dt>Score</dt><dd>${score}</dd>`);
  }

  detailMetaEl.innerHTML = metaParts.length ? metaParts.join('') : '<dt>Details</dt><dd>No extra metadata.</dd>';

  detailOverlay.classList.add('open');
  detailOverlay.setAttribute('aria-hidden', 'false');
}

async function sendInteractionEvent(itemId, eventType, { useBeacon = false } = {}) {
  if (!itemId) return;
  const payload = {
    id: Date.now(),
    user_id: ACTIVE_USER_ID,
    item_id: itemId,
    event_type: eventType,
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

function renderResults(items, sourceLabel) {
  const typeBadgeClass = sourceLabel === 'Geo' ? 'badge badge-geo' : 'badge badge-text';

  lastResultsItems = items || [];  // NEW: remember for narrative
  btnGenerateNarrative.disabled = !lastResultsItems.length;

  if (!items.length) {
    resultsList.innerHTML = `<div class="empty-state">No results from ${sourceLabel} search.</div>`;
    resultsCount.textContent = '0 results';
    return;
  }

  resultsList.innerHTML = '';
  items.forEach(item => {
    const payload = item.payload || {};

    const title = payload.title || '(No title)';
    const creator = payload.creator || '';
    const imageUrl = payload.image_url || '';
    const publicUrl = payload.public_url || '';

    const card = document.createElement('div');
    card.className = 'result-card';

    const img = document.createElement('img');
    img.className = 'result-thumb';
    img.alt = title;
    if (imageUrl) {
      img.src = imageUrl;
    } else {
      img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACw=';
    }

    const info = document.createElement('div');

    const titleEl = document.createElement('div');
    titleEl.className = 'result-title';
    titleEl.textContent = title;

    const creatorEl = document.createElement('div');
    creatorEl.className = 'result-creator';
    creatorEl.textContent = creator ? `Creator: ${creator}` : 'Creator unknown';

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
    badge.textContent = sourceLabel === 'Geo' ? 'Geo' : 'Text';

    bottom.appendChild(link);
    bottom.appendChild(badge);

    info.appendChild(titleEl);
    info.appendChild(creatorEl);
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
    items.length + ' result' + (items.length !== 1 ? 's' : '');
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

    html += `
          <article class="narrative-segment">
            <h3>${segHeadline}</h3>
            <small>Segment ID: ${seg.segment_id || '-'}</small>
            <p>${segSummary}</p>
            ${segItems.length ? `
              <div>
                <strong>Items in this segment:</strong>
                <ul class="narrative-items">
                  ${segItems.map(id => `
                    <li>
                      <span class="narrative-item-link" data-item-id="${id}">Item ${id}</span>
                    </li>`).join('')}
                </ul>
              </div>
            ` : ''}
            ${segRels.length ? `
              <div>
                <strong>Connections:</strong>
                <ul class="narrative-relationships">
                  ${segRels.map(r => `
                    <li>${r.from} → ${r.to} (${r.type}): ${r.explanation}</li>
                  `).join('')}
                </ul>
              </div>
            ` : ''}
            ${transition ? `<p class="narrative-transition">${transition}</p>` : ''}
          </article>
        `;
  });

  narrativeContainer.innerHTML = html;

  // Wire click on items in narrative to open the detail overlay
  narrativeContainer.querySelectorAll('.narrative-item-link').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-item-id');
      if (!id) return;
      const item = lastResultsItems.find(it => String(getItemId(it)) === String(id));
      if (item) {
        // Switch back to Results visually, but keep narrative visible if user wants
        showItemDetail(item);
      }
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

hideItemDetailUI();
