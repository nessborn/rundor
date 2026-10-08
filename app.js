'use strict';

// ---------- Configuration ----------
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];
const FALLBACK_CENTER = [59.3293, 18.0686]; // Stockholm
const TOP_POPULAR = 3;

const TYPE_LABELS = {
  generated: 'Egen runda',
  running: 'Löpslinga',
  fitness_trail: 'Motionsspår',
  nordic: 'Elljus-/skidspår',
  path: 'Namngiven stig',
  hiking: 'Vandringsled',
  foot: 'Promenadled',
  walking: 'Promenadled',
};

// Which route types are shown and how strongly each is preferred.
const ROUTE_WEIGHTS = { running: 3, fitness_trail: 3, nordic: 2.5, path: 1.8, hiking: 1.4, foot: 1.4, walking: 1.4 };

// ---------- State ----------
const state = {
  min: 5,
  max: 7,
  sort: 'popular',
  userPos: null,
  searchCenter: null,
  fetchedRadiusKm: 0,
  routes: [],
  visible: [],
  litOnly: false,
  generated: null,
  selectedId: null,
  hoverId: null,
  abort: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  list: $('routeList'), status: $('status'), count: $('resultCount'),
  minRange: $('minRange'), maxRange: $('maxRange'), rangeLabel: $('rangeLabel'), rangeFill: $('rangeFill'),
  chips: $('presetChips'), sort: $('sortSelect'),
  detail: $('detail'), searchAreaBtn: $('searchAreaBtn'), locateBtn: $('locateBtn'),
  searchForm: $('searchForm'), searchInput: $('searchInput'), suggestions: $('suggestions'),
  panel: $('panel'), sheetHandle: $('sheetHandle'),
  litToggle: $('litToggle'), generateBtn: $('generateBtn'), generateKm: $('generateKm'),
  installBtn: $('installBtn'),
};

// ---------- Geometry helpers ----------
function haversine(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad, dLon = (b[1] - a[1]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function lineLength(coords) {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) sum += haversine(coords[i - 1], coords[i]);
  return sum;
}

// Chains unordered segments into one path, reversing segments as needed (greedy nearest end).
function orderSegments(segments) {
  if (!segments.length) return [];
  const rest = segments.map((s) => s.slice());
  rest.sort((a, b) => lineLength(b) - lineLength(a));
  let path = rest.shift();
  while (rest.length) {
    const head = path[0], tail = path[path.length - 1];
    let best = null;
    rest.forEach((seg, i) => {
      const s = seg[0], e = seg[seg.length - 1];
      const options = [
        { d: haversine(tail, s), i, mode: 'tail' },
        { d: haversine(tail, e), i, mode: 'tailRev' },
        { d: haversine(head, e), i, mode: 'head' },
        { d: haversine(head, s), i, mode: 'headRev' },
      ];
      for (const o of options) if (!best || o.d < best.d) best = o;
    });
    const seg = rest.splice(best.i, 1)[0];
    if (best.mode === 'tail') path = path.concat(seg);
    else if (best.mode === 'tailRev') path = path.concat(seg.reverse());
    else if (best.mode === 'head') path = seg.concat(path);
    else path = seg.reverse().concat(path);
  }
  return path;
}

function boundsAround(center, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos(center[0] * Math.PI / 180));
  return [center[0] - dLat, center[1] - dLon, center[0] + dLat, center[1] + dLon];
}

function radiusForMax(maxKm) {
  return Math.min(15, Math.max(4, maxKm * 0.6 + 2));
}

// ---------- Formatting ----------
const fmt1 = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 });
const fmtKm = (m) => `${fmt1.format(m / 1000)} km`;
const fmtRange = (min, max) => (max >= 40 ? `${fmt1.format(min)}+ km` : `${fmt1.format(min)}–${fmt1.format(max)} km`);
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Map ----------
const map = L.map('map', { zoomControl: false, preferCanvas: false }).setView(FALLBACK_CENTER, 13);
L.control.zoom({ position: 'topright' }).addTo(map);

// Dark mode is a CSS filter on the tile pane (styles.css), so one open tile source serves both themes.
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragsgivare',
}).addTo(map);

// Heatmap of all public OSM GPS traces; its own pane so the dark-mode tile filter doesn't recolour it.
map.createPane('heatPane');
map.getPane('heatPane').style.zIndex = 350;
map.getPane('heatPane').style.pointerEvents = 'none';
const heatLayer = L.tileLayer('https://gps.tile.openstreetmap.org/lines/{z}/{x}/{y}.png', {
  pane: 'heatPane',
  maxZoom: 19,
  opacity: 0.7,
  attribution: 'GPS-spår &copy; <a href="https://www.openstreetmap.org/traces">OpenStreetMap</a>',
});

const HeatControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const button = L.DomUtil.create('button', 'heat-toggle');
    button.type = 'button';
    button.title = 'Visa var folk har rört sig (publika GPS-spår från OpenStreetMap)';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 1s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14a8 8 0 0 0 16 0c0-5.39-2.59-10.2-6.5-13ZM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8Z"/></svg><span>Värmekarta</span>';
    L.DomEvent.disableClickPropagation(button);
    L.DomEvent.on(button, 'click', () => setHeatmap(!map.hasLayer(heatLayer)));
    this.button = button;
    return button;
  },
});
const heatControl = new HeatControl().addTo(map);

function setHeatmap(on) {
  if (on) heatLayer.addTo(map); else map.removeLayer(heatLayer);
  heatControl.button.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('heatmap', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
try { setHeatmap(localStorage.getItem('heatmap') === '1'); } catch { setHeatmap(false); }

const routeLayer = L.layerGroup().addTo(map);
const overlayLayer = L.layerGroup().addTo(map);
let userMarker = null;
const routeLayers = new Map(); // id -> { casing, line }

function accentColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#fc4c02';
}
function dimColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--route-dim').trim() || '#9a9aa0';
}

function styleFor(id) {
  const focused = state.selectedId ?? state.hoverId;
  const isFocus = id === focused;
  const anyFocus = focused != null;
  return {
    line: { color: anyFocus && !isFocus ? dimColor() : accentColor(), weight: isFocus ? 6 : 4, opacity: anyFocus && !isFocus ? 0.55 : 0.9 },
    casing: { color: '#ffffff', weight: isFocus ? 10 : 0, opacity: isFocus ? 0.9 : 0 },
  };
}

function drawRoutes() {
  routeLayer.clearLayers();
  routeLayers.clear();
  for (const r of state.visible) {
    const s = styleFor(r.id);
    const casing = L.polyline(r.segments, { ...s.casing, interactive: false, lineCap: 'round', lineJoin: 'round' });
    const line = L.polyline(r.segments, { ...s.line, lineCap: 'round', lineJoin: 'round' });
    line.on('click', (e) => { L.DomEvent.stopPropagation(e); selectRoute(r.id, { fit: false }); });
    line.on('mouseover', () => setHover(r.id));
    line.on('mouseout', () => setHover(null));
    line.bindTooltip(`${escapeHtml(r.name)} · ${fmtKm(r.length)}`, { sticky: true });
    casing.addTo(routeLayer);
    line.addTo(routeLayer);
    routeLayers.set(r.id, { casing, line });
  }
  restyleRoutes();
}

function restyleRoutes() {
  const focused = state.selectedId ?? state.hoverId;
  for (const [id, layers] of routeLayers) {
    const s = styleFor(id);
    layers.line.setStyle(s.line);
    layers.casing.setStyle(s.casing);
  }
  const f = routeLayers.get(focused);
  if (f) { f.casing.bringToFront(); f.line.bringToFront(); }
}

function setUserMarker(pos) {
  const icon = L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  if (userMarker) userMarker.setLatLng(pos);
  else userMarker = L.marker(pos, { icon, interactive: false, keyboard: false }).addTo(map);
}

// Moves made by the app itself (fit to route, go to place) should not offer "search this area".
let programmaticMove = false;
function fitMap(bounds, options) {
  programmaticMove = true;
  map.fitBounds(bounds, options);
}

map.on('click', () => { if (state.selectedId != null) clearSelection(); });
map.on('moveend', () => {
  if (programmaticMove) { programmaticMove = false; return; }
  if (!state.searchCenter) return;
  const c = map.getCenter();
  const movedKm = haversine([c.lat, c.lng], state.searchCenter) / 1000;
  els.searchAreaBtn.hidden = movedKm < Math.max(1, state.fetchedRadiusKm * 0.35);
});

// ---------- Data: Overpass ----------
// Relations are length-filtered server-side: long trails' full geometry makes the public servers time out.
function buildQuery(bbox, minKm, maxKm) {
  const b = bbox.map((n) => n.toFixed(5)).join(',');
  const minM = Math.round(minKm * 1000 * 0.97);
  const lengthFilter = maxKm >= 40 ? `(if:length()>=${minM})` : `(if:length()>=${minM}&&length()<=${Math.round(maxKm * 1000 * 1.03)})`;
  const ways = [
    `way["route"~"^(running|fitness_trail)$"](${b});`,
    `way["piste:type"="nordic"]["name"](${b});`,
    `way["highway"~"^(path|track|footway|bridleway)$"]["name"~"spår|slinga|motionsspår|elljus|leden|trail",i](${b});`,
  ];
  // Member ways are also returned tags-only, to derive each relation's surface and lighting.
  return `[out:json][timeout:45];relation["route"~"^(running|fitness_trail|hiking|foot|walking)$"](${b})${lengthFilter}->.rels;(.rels;${ways.join('')});out geom qt;way(r.rels);out tags qt;`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readStoredEndpoint() {
  try { return localStorage.getItem('overpassEndpoint'); } catch { return null; }
}
let preferredEndpoint = OVERPASS_ENDPOINTS.includes(readStoredEndpoint()) ? readStoredEndpoint() : OVERPASS_ENDPOINTS[0];

async function fetchOverpass(query, signal) {
  let lastError;
  const endpoints = [preferredEndpoint, ...OVERPASS_ENDPOINTS.filter((u) => u !== preferredEndpoint)];
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal });
        if (!res.ok) throw new Error(`Overpass svarade ${res.status}`);
        const data = await res.json();
        // A timed-out query still returns 200, with partial data and a "runtime error" remark.
        if (data.remark && /error/i.test(data.remark)) throw new Error(`Overpass: ${data.remark}`);
        preferredEndpoint = url;
        try { localStorage.setItem('overpassEndpoint', url); } catch { /* storage unavailable */ }
        return data;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = err;
      }
    }
    await sleep(3000);
  }
  throw lastError;
}

const areaCache = new Map();
async function fetchRoutesCached(center, radius, minKm, maxKm, signal) {
  const key = `${center[0].toFixed(3)}|${center[1].toFixed(3)}|${radius.toFixed(1)}|${minKm}|${maxKm}`;
  if (!areaCache.has(key)) {
    const bbox = boundsAround(center, radius);
    const warn = (source) => (err) => { console.warn(`${source}:`, err); return []; };
    const [data, officialTrails, parkruns] = await Promise.all([
      fetchOverpass(buildQuery(bbox, minKm, maxKm), signal),
      fetchOfficialTrails(bbox, signal).catch(warn('Naturvårdsverket')),
      loadParkrunEvents().catch(warn('parkrun')),
    ]);
    const routes = mergeOfficialTrails(parseElements(data.elements || []), officialTrails);
    markParkrunCourses(routes, parkruns, bbox);
    areaCache.set(key, routes);
  }
  return areaCache.get(key);
}

// ---------- Official trails: Naturvårdsverket (trails in protected areas, nationwide) ----------
const NV_WFS = 'https://geodata.naturvardsverket.se/leder_friluftsliv/wfs';
const OFFICIAL_MATCH_M = 40;
const OFFICIAL_MATCH_SHARE = 0.6;

function nvRouteType(trailType) {
  const t = trailType || '';
  if (/skid|snö|skoter|rid|kanot|paddel|cykel/i.test(t)) return null; // Not usable on foot in summer.
  if (/motion|elljus/i.test(t)) return 'fitness_trail';
  return 'hiking';
}

async function fetchOfficialTrails(bbox, signal) {
  const params = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature',
    typeNames: 'Leder_friluftsliv_WFS:LED', outputFormat: 'GEOJSON',
    srsName: 'EPSG:4326', count: '1000',
    // WFS 2.0 with a URN CRS uses lat,lon axis order.
    bbox: `${bbox.map((n) => n.toFixed(5)).join(',')},urn:ogc:def:crs:EPSG::4326`,
  });
  const res = await fetch(`${NV_WFS}?${params}`, { signal });
  if (!res.ok) throw new Error(`Naturvårdsverket svarade ${res.status}`);
  const data = await res.json();

  // Features are sub-sections of a trail; group them by trail id.
  const byTrail = new Map();
  for (const f of data.features || []) {
    const p = f.properties || {};
    const type = nvRouteType(p.Typ_av_led);
    if (!type || !f.geometry) continue;
    const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    const id = p.Led_ID || p.OBJECTID;
    if (!byTrail.has(id)) byTrail.set(id, { props: p, type, segments: [] });
    for (const line of lines) if (line.length > 1) byTrail.get(id).segments.push(line.map(([lon, lat]) => [lat, lon]));
  }

  return [...byTrail.entries()].filter(([, t]) => t.segments.length).map(([id, t]) => {
    const p = t.props;
    const area = (p.Skyddat_område || '').split(',')[0].replace(/\s*\(.*\)\s*$/, '').trim();
    const areaId = String(p.Skyddat_område_ID || '').split(',')[0].trim();
    const name = (p.Lednamn || '').replace(/\\"/g, '"').replace(/\s*\(Längd:[^)]*\)\s*$/i, '').trim() || (area ? `Led i ${area}` : 'Officiell led');
    const tags = { name, route: t.type };
    if (p.Ledmarkering) tags.colour = p.Ledmarkering;
    const source = areaId
      ? { url: `https://skyddadnatur.naturvardsverket.se/sknat/?objektid=${encodeURIComponent(areaId)}`, label: 'Om området' }
      : { url: 'https://www.naturvardsverket.se/amnesomraden/friluftsliv/leder/', label: 'Om lederna' };
    const route = makeRoute(`nv${id}`, tags, t.segments, source);
    route.official = { area, marking: p.Ledmarkering || null };
    return route;
  });
}

// An official trail that an OSM route already follows marks that route; otherwise it is added as its own route.
function mergeOfficialTrails(osmRoutes, officialTrails) {
  const indexes = osmRoutes.map((r) => ({ route: r, isNear: buildProximityIndex(r.segments, OFFICIAL_MATCH_M) }));
  const added = [];
  for (const trail of officialTrails) {
    const samples = samplePath(trail.path, 40);
    let best = null, bestShare = 0;
    for (const { route, isNear } of indexes) {
      if (Math.abs(route.length - trail.length) > trail.length * 0.5) continue;
      const share = samples.filter((s) => isNear(s.lat, s.lon)).length / samples.length;
      if (share > bestShare) { best = route; bestShare = share; }
    }
    if (best && bestShare >= OFFICIAL_MATCH_SHARE) best.official = trail.official;
    else added.push(trail);
  }
  return osmRoutes.concat(added);
}

// ---------- parkrun courses (public event list, start points only) ----------
const PARKRUN_EVENTS_URL = 'https://images.parkrun.com/events.json';
const PARKRUN_NEAR_M = 300;
let parkrunEventsPromise = null;

function loadParkrunEvents() {
  parkrunEventsPromise ??= fetch(PARKRUN_EVENTS_URL)
    .then((res) => { if (!res.ok) throw new Error(`parkrun svarade ${res.status}`); return res.json(); })
    .then((data) => (data.events?.features || [])
      .filter((f) => f.properties.seriesid === 1) // 5 km events; 2 is junior parkrun.
      .map((f) => {
        const country = data.countries?.[f.properties.countrycode];
        return {
          name: f.properties.EventLongName,
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          url: country?.url ? `https://${country.url}/${f.properties.eventname}/` : 'https://www.parkrun.com/',
        };
      }))
    .catch((err) => { parkrunEventsPromise = null; throw err; });
  return parkrunEventsPromise;
}

// Only start points are public, so a course is a ~5 km route passing within reach of an event's start.
function markParkrunCourses(routes, events, bbox) {
  const nearby = events.filter((e) => e.lat >= bbox[0] - 0.05 && e.lat <= bbox[2] + 0.05 && e.lon >= bbox[1] - 0.1 && e.lon <= bbox[3] + 0.1);
  if (!nearby.length) return;
  for (const r of routes) {
    if (!/parkrun/i.test(r.name) && !(r.length > 4500 && r.length < 5700)) continue;
    const isNear = buildProximityIndex(r.segments, PARKRUN_NEAR_M);
    const event = nearby.find((e) => isNear(e.lat, e.lon));
    if (event) r.parkrun = event;
  }
}

function routeTypeOf(tags) {
  if (tags['piste:type'] === 'nordic' && !tags.route) return 'nordic';
  if (tags.route && TYPE_LABELS[tags.route]) return tags.route;
  return 'path';
}

function parseElements(elements) {
  const routes = [];
  const wayIdsInRelations = new Set();
  const wayTags = new Map();
  for (const el of elements) if (el.type === 'way' && el.tags) wayTags.set(el.id, el.tags);

  for (const el of elements) {
    if (el.type !== 'relation') continue;
    const segments = [], segmentTags = [];
    for (const m of el.members || []) {
      if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
      if (m.role === 'backward') continue; // Avoid counting one-way return legs twice.
      wayIdsInRelations.add(m.ref);
      segments.push(m.geometry.filter(Boolean).map((p) => [p.lat, p.lon]));
      segmentTags.push(wayTags.get(m.ref) || {});
    }
    if (!segments.length) continue;
    const route = makeRoute(`r${el.id}`, el.tags || {}, segments, { url: `https://www.openstreetmap.org/relation/${el.id}`, label: 'Visa i OSM' });
    Object.assign(route, surfaceAndLighting(segments, segmentTags, el.tags || {}));
    routes.push(route);
  }

  // Named ways without a route relation: group connected ways sharing the same name.
  const byName = new Map();
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || wayIdsInRelations.has(el.id)) continue;
    const tags = el.tags || {};
    const key = `${tags.name || tags.ref || el.id}|${routeTypeOf(tags)}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(el);
  }
  for (const ways of byName.values()) {
    for (const group of connectedGroups(ways)) {
      const segments = group.map((w) => w.geometry.map((p) => [p.lat, p.lon]));
      const first = group[0];
      const route = makeRoute(`w${first.id}`, first.tags || {}, segments, { url: `https://www.openstreetmap.org/way/${first.id}`, label: 'Visa i OSM' });
      Object.assign(route, surfaceAndLighting(segments, group.map((w) => w.tags || {}), first.tags || {}));
      routes.push(route);
    }
  }
  return routes;
}

const SURFACE_CLASSES = {
  paved: /^(asphalt|paved|concrete|concrete:plates|paving_stones|sett|chipseal|metal|wood)$/,
  gravel: /^(gravel|fine_gravel|compacted|pebblestone)$/,
  trail: /^(dirt|ground|earth|grass|mud|sand|unpaved|rock|roots|woodchips|forest_floor)$/,
};

// Untagged surfaces are inferred from the way type, which is usually right in Swedish OSM data.
function surfaceClassOf(tags) {
  const surface = tags.surface || '';
  for (const [cls, re] of Object.entries(SURFACE_CLASSES)) if (re.test(surface)) return cls;
  if (tags.tracktype === 'grade1') return 'paved';
  if (tags.highway === 'track') return 'gravel';
  if (tags.highway === 'path' || tags.highway === 'bridleway') return 'trail';
  if (tags.highway) return 'paved';
  return null;
}

// Dominant surface and lighting by length share across the route's ways.
function surfaceAndLighting(segments, segmentTags, routeTags) {
  const bySurface = {}; let litLength = 0, total = 0;
  segments.forEach((seg, i) => {
    const length = lineLength(seg), tags = segmentTags[i];
    total += length;
    const cls = surfaceClassOf(tags);
    if (cls) bySurface[cls] = (bySurface[cls] || 0) + length;
    if (tags.lit && tags.lit !== 'no') litLength += length;
  });
  const [surface, surfaceLength] = Object.entries(bySurface).sort((a, b) => b[1] - a[1])[0] || [null, 0];
  return {
    surface: surfaceLength >= total * 0.4 ? surface : null,
    lit: routeTags.lit === 'yes' || /elljus/i.test(routeTags.name || '') || (total > 0 && litLength >= total * 0.6),
  };
}

function connectedGroups(ways) {
  const parent = ways.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const ends = ways.map((w) => [w.geometry[0], w.geometry[w.geometry.length - 1]].map((p) => [p.lat, p.lon]));
  for (let i = 0; i < ways.length; i++) {
    for (let j = i + 1; j < ways.length; j++) {
      if (ends[i].some((a) => ends[j].some((b) => haversine(a, b) < 30))) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  ways.forEach((w, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(w);
  });
  return [...groups.values()];
}

function makeRoute(id, tags, segments, source) {
  const type = routeTypeOf(tags);
  const length = segments.reduce((sum, s) => sum + lineLength(s), 0);
  const path = orderSegments(segments);
  const isLoop = (path.length > 2 && haversine(path[0], path[path.length - 1]) < Math.max(250, length * 0.05))
    || /slinga|runt|spåret|\bloop\b/i.test(tags.name || '');
  let latSum = 0, lonSum = 0, n = 0;
  for (const s of segments) for (const p of s) { latSum += p[0]; lonSum += p[1]; n++; }
  return {
    id, tags, type, segments, path, length, isLoop, source,
    name: tags.name || tags.ref || TYPE_LABELS[type],
    centroid: [latSum / n, lonSum / n],
    elevation: null,
  };
}

// Popularity is not available as open data; this estimates it from how well-established a route looks in OSM.
function popularityScore(route, weights) {
  const t = route.tags;
  let score = weights[route.type] || 0;
  if (t.name) score += 0.8;
  if (route.lit || route.type === 'nordic') score += 1;
  if (route.isLoop) score += 1;
  if (t.network === 'lwn' || t.network === 'rwn' || t.network === 'lcn' || t.network === 'rcn') score += 0.5;
  if (t.website || t.wikidata || t.wikipedia || t.description || t.operator) score += 0.5;
  if (t.osmc_symbol || t.symbol || t.colour) score += 0.3;
  // Real usage outweighs tag heuristics: 1 trace ≈ +0.9, 3 ≈ +1.8, 15 ≈ +3.6.
  if (route.traces?.matches) score += Math.log2(1 + route.traces.matches) * 0.9;
  if (route.official) score += 1.2;
  if (route.parkrun) score += 1.5;
  const distKm = route.distanceFromCenter / 1000;
  score -= distKm * 0.15;
  return score;
}

// ---------- Usage from public OSM GPS traces ----------
const TRACE_API = 'https://api.openstreetmap.org/api/0.6/trackpoints';
const TRACE_PAGE_SIZE = 5000; // Fixed by the OSM API.
const TRACE_MAX_PAGES = 2;
const TRACE_MAX_ROUTES = 15;
const TRACE_NEAR_M = 25;
const TRACE_MIN_NEAR_POINTS = 20; // A trace must follow the route, not just cross it.
const TRACE_CACHE_MS = 7 * 24 * 3600 * 1000;

function readTraceCache(routeId) {
  try {
    const entry = JSON.parse(localStorage.getItem(`traces:${routeId}`));
    if (entry && Date.now() - entry.storedAt < TRACE_CACHE_MS) return { matches: entry.matches, truncated: entry.truncated };
  } catch { /* storage unavailable or corrupt */ }
  return null;
}
function writeTraceCache(routeId, result) {
  try { localStorage.setItem(`traces:${routeId}`, JSON.stringify({ ...result, storedAt: Date.now() })); } catch { /* storage unavailable */ }
}

// Grid of route segments in local metres, so each trace point only tests nearby segments.
function buildProximityIndex(segments, toleranceM) {
  const kx = 111320 * Math.cos(segments[0][0][0] * Math.PI / 180), ky = 110540, cell = 100;
  const grid = new Map(), lines = [];
  for (const s of segments) {
    for (let i = 1; i < s.length; i++) {
      const a = [s[i - 1][1] * kx, s[i - 1][0] * ky], b = [s[i][1] * kx, s[i][0] * ky];
      const idx = lines.push([a, b]) - 1;
      for (let gx = Math.floor((Math.min(a[0], b[0]) - toleranceM) / cell); gx <= Math.floor((Math.max(a[0], b[0]) + toleranceM) / cell); gx++) {
        for (let gy = Math.floor((Math.min(a[1], b[1]) - toleranceM) / cell); gy <= Math.floor((Math.max(a[1], b[1]) + toleranceM) / cell); gy++) {
          const key = `${gx},${gy}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(idx);
        }
      }
    }
  }
  return (lat, lon) => {
    const p = [lon * kx, lat * ky];
    const candidates = grid.get(`${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`) || [];
    return candidates.some((idx) => distanceToSegment(p, lines[idx][0], lines[idx][1]) <= toleranceM);
  };
}
function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

async function countTraces(route) {
  const cached = readTraceCache(route.id);
  if (cached) return cached;
  const b = L.polyline(route.segments).getBounds().pad(0.05);
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(',');
  const isNear = buildProximityIndex(route.segments, TRACE_NEAR_M);
  let matches = 0, truncated = false;
  for (let page = 0; page < TRACE_MAX_PAGES; page++) {
    const res = await fetch(`${TRACE_API}?bbox=${bbox}&page=${page}`);
    if (!res.ok) throw new Error(`OSM trackpoints svarade ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
    for (const seg of doc.getElementsByTagName('trkseg')) {
      // Private traces come without timestamps and in sorted, not travelled, order: unusable here.
      if (!seg.getElementsByTagName('time').length) continue;
      let near = 0;
      for (const pt of seg.getElementsByTagName('trkpt')) {
        if (isNear(+pt.getAttribute('lat'), +pt.getAttribute('lon')) && ++near >= TRACE_MIN_NEAR_POINTS) break;
      }
      if (near >= TRACE_MIN_NEAR_POINTS) matches++;
    }
    truncated = doc.getElementsByTagName('trkpt').length >= TRACE_PAGE_SIZE;
    if (!truncated) break;
  }
  const result = { matches, truncated };
  writeTraceCache(route.id, result);
  return result;
}

let traceRun = 0;
async function loadTracePopularity() {
  const run = ++traceRun;
  state.routes.forEach((r) => { r.tracesPending = false; });
  const queue = [...state.visible].filter((r) => !r.generated).sort((a, b) => b.score - a.score).slice(0, TRACE_MAX_ROUTES).filter((r) => !r.traces);
  if (!queue.length) return;
  queue.forEach((r) => { r.tracesPending = true; });
  renderList();
  const worker = async () => {
    while (queue.length && run === traceRun) {
      const route = queue.shift();
      try {
        route.traces = await countTraces(route);
      } catch (err) {
        console.warn(err);
        route.traces = { failed: true };
      }
      route.tracesPending = false;
      if (run === traceRun) updateTraceLabel(route);
    }
  };
  await Promise.all([worker(), worker()]); // Two at a time keeps load on the OSM API modest.
  if (run !== traceRun) return;
  scoreVisible();
  if (state.sort === 'popular') sortVisible();
  renderList();
}

function traceCount(r) {
  if (!r.traces || r.traces.failed) return '';
  // Zero within a truncated sample says nothing about the route.
  if (r.traces.truncated && !r.traces.matches) return '';
  return `${r.traces.matches}${r.traces.truncated ? '+' : ''}`;
}
function traceLabel(r) {
  const n = traceCount(r);
  return n ? `${n} GPS-spår` : '';
}

function updateTraceLabel(r) {
  const el = els.list.querySelector(`[data-id="${r.id}"] .trace-stat`);
  if (el) { el.textContent = traceLabel(r); el.classList.remove('pending'); }
  if (state.selectedId === r.id) {
    const detailEl = document.getElementById('detailTraces');
    if (detailEl) detailEl.textContent = traceCount(r) || '–';
  }
}

// ---------- Loading & filtering ----------
async function loadRoutes(center, { fitView = false } = {}) {
  state.abort?.abort();
  const controller = new AbortController();
  state.abort = controller;

  const radius = radiusForMax(state.max);
  // A generated loop belongs to its area; drop it when the search moves elsewhere.
  if (state.generated && haversine(center, state.generated.path[0]) > 2000) state.generated = null;
  state.searchCenter = center;
  state.fetchedRadiusKm = radius;
  els.searchAreaBtn.hidden = true;
  clearSelection(false);
  showLoading();

  try {
    const routes = await fetchRoutesCached(center, radius, state.min, state.max, controller.signal);
    if (controller.signal.aborted) return;
    state.routes = routes;
    applyFilters({ fitView });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    state.routes = [];
    state.visible = [];
    drawRoutes();
    els.list.innerHTML = '';
    els.count.textContent = '';
    setStatus('Kunde inte hämta rutter just nu (Overpass kan vara överbelastad). Försök igen om en stund.', true);
  }
}

function applyFilters({ fitView = false } = {}) {
  if (!state.searchCenter) return;
  const weights = ROUTE_WEIGHTS;
  const center = state.searchCenter;
  const minM = state.min * 1000, maxM = state.max >= 40 ? Infinity : state.max * 1000;

  state.visible = state.routes
    .filter((r) => weights[r.type] != null && r.length >= minM && r.length <= maxM)
    .filter((r) => !state.litOnly || r.lit)
    .map((r) => {
      r.distanceFromCenter = Math.min(...[r.path[0], r.centroid].map((p) => haversine(center, p)));
      return r;
    });
  if (state.generated) {
    state.generated.distanceFromCenter = haversine(center, state.generated.path[0]);
    state.visible.unshift(state.generated);
  }

  scoreVisible();
  sortVisible();
  drawRoutes();
  renderList();

  if (!state.visible.length) {
    const any = state.routes.some((r) => weights[r.type] != null);
    setStatus(state.litOnly
      ? 'Inga belysta rundor här. Prova utan "Bara belysta" – eller skapa en egen runda.'
      : any
        ? `Inga rundor på ${fmtRange(state.min, state.max)} här. Prova ett annat distansintervall, flytta kartan eller skapa en egen runda.`
        : 'Hittade inga kartlagda rundor i området. Flytta kartan, sök på en annan plats eller skapa en egen runda.');
  } else {
    setStatus('');
  }

  if (fitView && state.visible.length) {
    const group = L.featureGroup(state.visible.slice(0, 10).map((r) => L.polyline(r.segments)));
    fitMap(group.getBounds(), { padding: [40, 40], maxZoom: 15 });
  }
  loadTracePopularity();
}

function scoreVisible() {
  const weights = ROUTE_WEIGHTS;
  state.visible.forEach((r) => { r.score = popularityScore(r, weights); });
  const byScore = state.visible.filter((r) => !r.generated).sort((a, b) => b.score - a.score);
  const popularIds = new Set(byScore.slice(0, TOP_POPULAR).map((r) => r.id));
  state.visible.forEach((r) => { r.popular = popularIds.has(r.id); });
}

function sortVisible() {
  const cmp = {
    popular: (a, b) => b.score - a.score,
    near: (a, b) => a.distanceFromCenter - b.distanceFromCenter,
    length: (a, b) => a.length - b.length,
  }[state.sort];
  state.visible.sort((a, b) => Number(!!b.generated) - Number(!!a.generated) || cmp(a, b));
}

// ---------- Rendering ----------
function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function showLoading() {
  setStatus('');
  els.count.textContent = 'Söker rundor…';
  els.list.innerHTML = '<li class="skeleton"></li>'.repeat(4);
}

function thumbnailSvg(path) {
  const pts = path.length > 120 ? path.filter((_, i) => i % Math.ceil(path.length / 120) === 0) : path;
  const cosLat = Math.cos(pts[0][0] * Math.PI / 180);
  const xs = pts.map((p) => p[1] * cosLat), ys = pts.map((p) => -p[0]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const size = 64, pad = 8, scale = (size - pad * 2) / span;
  const offX = pad + ((size - pad * 2) - (maxX - minX) * scale) / 2;
  const offY = pad + ((size - pad * 2) - (maxY - minY) * scale) / 2;
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${(offX + (x - minX) * scale).toFixed(1)} ${(offY + (ys[i] - minY) * scale).toFixed(1)}`).join('');
  return `<svg class="thumb" viewBox="0 0 64 64" aria-hidden="true"><path d="${d}"/></svg>`;
}

function subtitle(r) {
  const parts = [TYPE_LABELS[r.type]];
  if (r.isLoop) parts.push('Slinga');
  if (r.lit) parts.push('Belyst');
  if (r.surface) parts.push(SURFACE_LABELS[r.surface]);
  return parts.filter(Boolean).join(' · ');
}

const SURFACE_LABELS = { paved: 'Asfalt', gravel: 'Grus', trail: 'Stig/terräng' };

function renderList() {
  const n = state.visible.length;
  els.count.textContent = n ? `${n} ${n === 1 ? 'runda' : 'rundor'} · ${fmtRange(state.min, state.max)}` : '';
  els.list.innerHTML = state.visible.map((r) => `
    <li class="route${r.id === state.selectedId ? ' selected' : ''}" data-id="${r.id}" tabindex="0">
      ${thumbnailSvg(r.path)}
      <div>
        <div class="route-title"><span>${escapeHtml(r.name)}</span>${r.generated ? '<em class="badge generated">Egen</em>' : r.popular ? '<em class="badge">Populär</em>' : ''}</div>
        <div class="route-sub">${escapeHtml(subtitle(r))}</div>
        ${sourceTags(r)}
        <div class="route-stats"><span><b>${fmtKm(r.length)}</b></span><span>${fmtKm(r.distanceFromCenter)} bort</span><span class="trace-stat${r.tracesPending ? ' pending' : ''}">${traceLabel(r)}</span></div>
      </div>
    </li>`).join('');
}

function sourceTags(r) {
  const tags = [];
  if (r.parkrun) tags.push('<span class="src-tag parkrun">parkrun</span>');
  if (r.official) tags.push('<span class="src-tag official">Officiell led</span>');
  return tags.length ? `<div class="src-tags">${tags.join('')}</div>` : '';
}

els.list.addEventListener('click', (e) => {
  const li = e.target.closest('.route');
  if (li) selectRoute(li.dataset.id, { fit: true });
});
els.list.addEventListener('keydown', (e) => {
  const li = e.target.closest('.route');
  if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectRoute(li.dataset.id, { fit: true }); }
});
els.list.addEventListener('mouseover', (e) => {
  const li = e.target.closest('.route');
  setHover(li ? li.dataset.id : null);
});
els.list.addEventListener('mouseleave', () => setHover(null));

function setHover(id) {
  if (state.hoverId === id) return;
  state.hoverId = id;
  restyleRoutes();
}

// ---------- Selection & detail ----------
function selectRoute(id, { fit }) {
  const r = state.visible.find((x) => x.id === id);
  if (!r) return;
  state.selectedId = id;
  restyleRoutes();
  els.list.querySelectorAll('.route').forEach((li) => li.classList.toggle('selected', li.dataset.id === id));
  els.list.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  overlayLayer.clearLayers();
  const startIcon = L.divIcon({ className: '', html: '<div class="start-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  L.marker(r.path[0], { icon: startIcon, title: 'Start' }).addTo(overlayLayer);

  const mobile = window.matchMedia('(max-width: 760px)').matches;
  document.body.classList.add('route-selected');
  renderDetail(r);
  if (fit || mobile) {
    // On mobile the sheet shrinks when a route is selected; fit after its height transition.
    setTimeout(() => {
      map.invalidateSize();
      const detailHeight = els.detail.offsetHeight + 40;
      fitMap(L.polyline(r.segments).getBounds(), {
        paddingTopLeft: [30, 30],
        paddingBottomRight: [30, detailHeight],
        maxZoom: 16,
      });
    }, mobile ? 280 : 0);
  }
  loadElevation(r);
}

function clearSelection(restyle = true) {
  if (document.body.classList.contains('route-selected')) {
    document.body.classList.remove('route-selected');
    setTimeout(() => map.invalidateSize(), 280);
  }
  state.selectedId = null;
  overlayLayer.clearLayers();
  els.detail.hidden = true;
  els.list.querySelectorAll('.route.selected').forEach((li) => li.classList.remove('selected'));
  if (restyle) restyleRoutes();
}

function renderDetail(r) {
  const start = r.path[0];
  els.detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${escapeHtml(r.name)}</h2>
        <div class="route-sub">${escapeHtml(subtitle(r))}</div>
      </div>
      <button class="close-btn" type="button" aria-label="Stäng">×</button>
    </div>
    ${sourceNotes(r)}
    <div class="detail-stats">
      <div><small>Distans</small><b>${fmtKm(r.length)}</b></div>
      <div><small>Höjdmeter</small><b id="elevGain">–</b></div>
      <div title="Publika GPS-spår i OpenStreetMap som följer rundan"><small>GPS-spår</small><b id="detailTraces">${r.traces ? (traceCount(r) || '–') : '…'}</b></div>
      <div><small>Från dig</small><b>${state.userPos ? fmtKm(haversine(state.userPos, start)) : '–'}</b></div>
    </div>
    <svg class="profile" id="profile" viewBox="0 0 300 72" preserveAspectRatio="none" aria-label="Höjdprofil"></svg>
    <div class="profile-note" id="profileNote">Hämtar höjdprofil…</div>
    <div class="detail-actions">
      ${r.generated ? '<button class="btn primary" type="button" id="variantBtn">Ny variant</button>' : ''}
      ${r.source ? `<a class="btn" href="${r.source.url}" target="_blank" rel="noopener">${r.source.label}</a>` : ''}
    </div>`;
  els.detail.hidden = false;
  els.detail.querySelector('.close-btn').addEventListener('click', () => clearSelection());
  els.detail.querySelector('#variantBtn')?.addEventListener('click', () => createGeneratedRoute());
  if (r.elevation) drawElevation(r);
}

function sourceNotes(r) {
  const notes = [];
  if (r.parkrun) {
    notes.push(`<span class="src-tag parkrun">parkrun</span> Trolig bana för <a href="${r.parkrun.url}" target="_blank" rel="noopener">${escapeHtml(r.parkrun.name)}</a>`);
  }
  if (r.official) {
    const where = r.official.area ? ` i ${escapeHtml(r.official.area)}` : '';
    const marking = r.official.marking ? `, ${escapeHtml(r.official.marking.toLowerCase())} markering` : '';
    notes.push(`<span class="src-tag official">Officiell led</span> Naturvårdsverket${where}${marking}`);
  }
  return notes.length ? `<div class="source-notes">${notes.map((n) => `<div>${n}</div>`).join('')}</div>` : '';
}

// ---------- Elevation (Open-Meteo, max 100 points per request) ----------
function samplePath(path, count) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversine(path[i - 1], path[i]));
  const total = cum[cum.length - 1];
  const out = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    while (j < cum.length - 2 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const t = Math.min(1, Math.max(0, (target - cum[j]) / seg));
    const a = path[j], b = path[Math.min(j + 1, path.length - 1)];
    out.push({ lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t, dist: target });
  }
  return out;
}

async function loadElevation(r) {
  if (r.elevation) return;
  try {
    const samples = samplePath(r.path, 100);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${samples.map((s) => s.lat.toFixed(5)).join(',')}&longitude=${samples.map((s) => s.lon.toFixed(5)).join(',')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo svarade ${res.status}`);
    const data = await res.json();
    r.elevation = samples.map((s, i) => ({ dist: s.dist, ele: data.elevation[i] }));
    if (state.selectedId === r.id) drawElevation(r);
  } catch (err) {
    console.warn(err);
    if (state.selectedId === r.id) $('profileNote').textContent = 'Höjdprofil är inte tillgänglig just nu.';
  }
}

function drawElevation(r) {
  const raw = r.elevation.map((p) => p.ele);
  // The ~90 m elevation model is noisy along shores and slopes: smooth, then only count climbs above a threshold.
  const eles = raw.map((_, i) => {
    const window = raw.slice(Math.max(0, i - 2), i + 3);
    return window.reduce((a, b) => a + b, 0) / window.length;
  });
  const pts = r.elevation.map((p, i) => ({ dist: p.dist, ele: eles[i] }));
  let gain = 0;
  let ref = eles[0];
  for (const e of eles) {
    if (e - ref > 4) { gain += e - ref; ref = e; } else if (ref - e > 4) ref = e;
  }
  const minE = Math.min(...eles), maxE = Math.max(...eles);
  const span = Math.max(maxE - minE, 20);
  const total = pts[pts.length - 1].dist || 1;
  const x = (d) => (d / total) * 300;
  const y = (e) => 68 - ((e - minE) / span) * 60;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.dist).toFixed(1)} ${y(p.ele).toFixed(1)}`).join('');
  $('profile').innerHTML = `<path class="area" d="${line}L300 72L0 72Z"/><path class="lineP" d="${line}" vector-effect="non-scaling-stroke"/>`;
  $('elevGain').textContent = `${Math.round(gain)} m`;
  $('profileNote').textContent = `Lägst ${Math.round(minE)} m · Högst ${Math.round(maxE)} m ö.h.`;
}

// ---------- Filters UI ----------
function updateRangeUi() {
  els.rangeLabel.textContent = fmtRange(state.min, state.max);
  els.generateKm.textContent = `${fmt1.format(generatedTargetKm())} km`;
  const lo = (state.min - 1) / 39 * 100, hi = (state.max - 1) / 39 * 100;
  els.rangeFill.style.left = `${lo}%`;
  els.rangeFill.style.right = `${100 - hi}%`;
  els.chips.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', +b.dataset.min === state.min && +b.dataset.max === state.max);
  });
}

let filterTimer = null;
function onRangeChanged() {
  updateRangeUi();
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    if (state.searchCenter) loadRoutes(state.searchCenter);
  }, 600);
}

els.minRange.addEventListener('input', () => {
  state.min = Math.min(+els.minRange.value, state.max - 0.5);
  els.minRange.value = state.min;
  onRangeChanged();
});
els.maxRange.addEventListener('input', () => {
  state.max = Math.max(+els.maxRange.value, state.min + 0.5);
  els.maxRange.value = state.max;
  onRangeChanged();
});
els.chips.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.min = +b.dataset.min; state.max = +b.dataset.max;
  els.minRange.value = state.min; els.maxRange.value = state.max;
  onRangeChanged();
});
els.sort.addEventListener('change', () => {
  state.sort = els.sort.value;
  sortVisible();
  renderList();
});
els.searchAreaBtn.addEventListener('click', () => {
  const c = map.getCenter();
  loadRoutes([c.lat, c.lng]);
});
els.sheetHandle.addEventListener('click', () => {
  const expanded = els.panel.classList.toggle('expanded');
  els.sheetHandle.setAttribute('aria-label', expanded ? 'Visa mindre' : 'Visa fler rundor');
  setTimeout(() => map.invalidateSize(), 300);
});

// ---------- Location ----------
function locate({ initial = false } = {}) {
  if (!('geolocation' in navigator)) {
    if (initial) startAt(FALLBACK_CENTER, 'Din webbläsare stöder inte positionering – visar Stockholm. Sök efter en plats ovan.');
    return;
  }
  els.locateBtn.classList.add('busy');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      els.locateBtn.classList.remove('busy');
      state.userPos = [pos.coords.latitude, pos.coords.longitude];
      setUserMarker(state.userPos);
      map.setView(state.userPos, 14);
      loadRoutes(state.userPos, { fitView: true });
    },
    () => {
      els.locateBtn.classList.remove('busy');
      if (initial) startAt(FALLBACK_CENTER, 'Kunde inte hämta din position – visar Stockholm. Sök efter en plats eller tillåt platsåtkomst.');
      else setStatus('Kunde inte hämta din position. Kontrollera att platsåtkomst är tillåten.', true);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
}

async function startAt(center, message) {
  map.setView(center, 13);
  await loadRoutes(center, { fitView: true });
  if (message && !state.visible.length) return;
  if (message) setStatus(message);
}

els.locateBtn.addEventListener('click', () => locate());

// ---------- Place search (Photon allows search-as-you-type) ----------
let suggestTimer = null, suggestAbort = null, suggestions = [], activeIndex = -1;

function placeLabel(p) {
  const pr = p.properties;
  const main = pr.name || [pr.street, pr.housenumber].filter(Boolean).join(' ') || pr.city;
  const sub = [pr.city !== main ? pr.city : null, pr.county, pr.country].filter(Boolean).join(', ');
  return { main, sub };
}

async function fetchSuggestions(q) {
  suggestAbort?.abort();
  suggestAbort = new AbortController();
  const c = map.getCenter();
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}`;
  const res = await fetch(url, { signal: suggestAbort.signal });
  if (!res.ok) throw new Error(`Photon svarade ${res.status}`);
  return (await res.json()).features || [];
}

function renderSuggestions() {
  if (!suggestions.length) { els.suggestions.hidden = true; return; }
  els.suggestions.innerHTML = suggestions.map((p, i) => {
    const { main, sub } = placeLabel(p);
    return `<li role="option" data-i="${i}" aria-selected="${i === activeIndex}">${escapeHtml(main || 'Okänd plats')}<small>${escapeHtml(sub)}</small></li>`;
  }).join('');
  els.suggestions.hidden = false;
}

function choosePlace(p) {
  const [lon, lat] = p.geometry.coordinates;
  els.searchInput.value = placeLabel(p).main || '';
  els.suggestions.hidden = true;
  els.searchInput.blur();
  const ext = p.properties.extent; // [minLon, maxLat, maxLon, minLat]
  if (ext) map.fitBounds([[ext[3], ext[0]], [ext[1], ext[2]]], { maxZoom: 15 });
  else map.setView([lat, lon], 14);
  loadRoutes([lat, lon], { fitView: true });
}

els.searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = els.searchInput.value.trim();
  if (q.length < 2) { suggestions = []; renderSuggestions(); return; }
  suggestTimer = setTimeout(async () => {
    try {
      suggestions = await fetchSuggestions(q);
      activeIndex = -1;
      renderSuggestions();
    } catch (err) {
      if (err.name !== 'AbortError') console.warn(err);
    }
  }, 250);
});
els.searchInput.addEventListener('keydown', (e) => {
  if (els.suggestions.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, suggestions.length - 1); renderSuggestions(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); renderSuggestions(); }
  else if (e.key === 'Escape') { els.suggestions.hidden = true; }
});
els.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (activeIndex >= 0 && suggestions[activeIndex]) return choosePlace(suggestions[activeIndex]);
  const q = els.searchInput.value.trim();
  if (!q) return;
  try {
    const found = suggestions.length ? suggestions : await fetchSuggestions(q);
    if (found[0]) choosePlace(found[0]);
    else setStatus(`Hittade ingen plats för ”${q}”.`, true);
  } catch (err) {
    if (err.name !== 'AbortError') setStatus('Platssökningen fungerar inte just nu.', true);
  }
});
els.suggestions.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (li) { e.preventDefault(); choosePlace(suggestions[+li.dataset.i]); }
});
els.searchInput.addEventListener('blur', () => setTimeout(() => { els.suggestions.hidden = true; }, 150));

// ---------- Lighting filter ----------
els.litToggle.addEventListener('change', () => {
  state.litOnly = els.litToggle.checked;
  clearSelection(false);
  applyFilters();
});

// ---------- Generated loops (FOSSGIS OSRM foot routing) ----------
const ROUTING_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';
const LOOP_TOLERANCE = 0.03;
const LOOP_MAX_ATTEMPTS = 5;

function generatedTargetKm() {
  return state.max >= 40 ? state.min : Math.round(state.min + state.max) / 2;
}

function destinationPoint([lat, lon], distanceM, bearingDeg) {
  const rad = Math.PI / 180, d = distanceM / 6371000, b = bearingDeg * rad;
  const lat1 = lat * rad, lon1 = lon * rad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [lat2 / rad, lon2 / rad];
}

async function routeThrough(points) {
  const coords = points.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
  const res = await fetch(`${ROUTING_URL}/${coords}?overview=full&geometries=geojson&continue_straight=true`);
  if (!res.ok) throw new Error(`Ruttjänsten svarade ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error(`Ruttjänsten hittade ingen väg (${data.code})`);
  return { distance: data.routes[0].distance, path: data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]) };
}

// Start -> three points on a circle through the start -> start; the circle is rescaled until the
// walked distance is within tolerance, since roads never follow the circle exactly.
async function generateLoop(start, targetM, bearing) {
  let factor = 0.75, best = null;
  for (let attempt = 0; attempt < LOOP_MAX_ATTEMPTS; attempt++) {
    const radius = (targetM * factor) / (2 * Math.PI);
    const center = destinationPoint(start, radius, bearing);
    const waypoints = [90, 180, 270].map((angle) => destinationPoint(center, radius, bearing + 180 + angle));
    const result = await routeThrough([start, ...waypoints, start]);
    if (!best || Math.abs(result.distance - targetM) < Math.abs(best.distance - targetM)) best = result;
    if (Math.abs(result.distance - targetM) <= targetM * LOOP_TOLERANCE) break;
    factor *= targetM / result.distance;
  }
  return best;
}

let generating = false;
async function createGeneratedRoute() {
  if (generating) return;
  generating = true;
  const fromUser = !!state.userPos;
  const start = state.userPos || [map.getCenter().lat, map.getCenter().lng];
  const targetM = generatedTargetKm() * 1000;
  els.generateBtn.disabled = true;
  els.generateBtn.classList.add('busy');
  setStatus(`Skapar en runda på ${fmt1.format(targetM / 1000)} km från ${fromUser ? 'din position' : 'kartans mitt'}…`);
  try {
    const loop = await generateLoop(start, targetM, Math.random() * 360);
    const route = makeRoute(`gen${Date.now()}`, { route: 'generated', name: `Egen runda ${fmtKm(loop.distance)}` }, [loop.path], null);
    route.generated = true;
    route.isLoop = true;
    if (!state.searchCenter) state.searchCenter = start;
    state.generated = route;
    clearSelection(false);
    applyFilters();
    selectRoute(route.id, { fit: true });
    setStatus(fromUser ? '' : 'Rundan utgår från kartans mitt – tillåt platsåtkomst för att starta där du är.');
  } catch (err) {
    console.warn(err);
    setStatus('Kunde inte skapa en runda just nu. Försök igen, eller flytta kartan till ett område med gångvägar.', true);
  } finally {
    generating = false;
    els.generateBtn.disabled = false;
    els.generateBtn.classList.remove('busy');
  }
}
els.generateBtn.addEventListener('click', () => createGeneratedRoute());

// ---------- Installable app (PWA) ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  els.installBtn.hidden = false;
});
els.installBtn.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  els.installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => { els.installBtn.hidden = true; });
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker:', err)));
}

// ---------- Start ----------
updateRangeUi();
locate({ initial: true });
