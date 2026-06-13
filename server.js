// ============================================================
// Monitor de Viento - Región Metropolitana de Santiago
// Servidor: consulta estaciones PWS de Weather Underground,
// guarda los datos en caché y los entrega al mapa.
// ============================================================

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuración ---
const API_KEY = process.env.WU_API_KEY; // Se define en Render, NUNCA en el código
const BASE_MINUTES = Number(process.env.BASE_MINUTES || 10);   // refresco visual del mapa (rotando grupos)
const STATIONS_PER_CYCLE = Number(process.env.STATIONS_PER_CYCLE || 7); // estaciones por ciclo (cuida la cuota)
const FAST_MINUTES = Number(process.env.FAST_MINUTES || 5);    // estaciones ventosas, con viento
const WIND_TRIGGER = Number(process.env.WIND_TRIGGER || 35);   // km/h de ráfaga que activa el modo rápido
const EXTREME_TRIGGER = Number(process.env.EXTREME_TRIGGER || 60); // km/h que dispara notificación de condición extrema
const FAST_STATIONS = Number(process.env.FAST_STATIONS || 15); // cuántas estaciones sigue en modo rápido
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";               // canal de notificaciones push (ntfy.sh)
const DISCOVERY_HOURS = Number(process.env.DISCOVERY_HOURS || 12); // re-descubrir estaciones
const MAX_STATIONS = Number(process.env.MAX_STATIONS || 40); // tope para cuidar la cuota diaria

// Límites de la zona monitoreada: regiones de Valparaíso, Metropolitana y O'Higgins
const RM_BOUNDS = { latMin: -34.95, latMax: -32.0, lonMin: -72.1, lonMax: -69.75 };

// Puntos "semilla" repartidos por las 3 regiones para descubrir estaciones cercanas
const SEED_POINTS = [
  // Región Metropolitana
  [-33.45, -70.65], // Santiago centro
  [-33.40, -70.55], // Providencia / Las Condes
  [-33.58, -70.58], // Puente Alto / La Florida
  [-33.51, -70.76], // Maipú
  [-33.20, -70.67], // Colina
  [-33.61, -70.88], // Talagante
  [-33.68, -71.21], // Melipilla
  [-33.64, -70.35], // San José de Maipo (precordillera)
  [-33.83, -70.74], // Buin / Paine
  // Región de Valparaíso
  [-33.04, -71.60], // Valparaíso / Viña del Mar
  [-32.88, -71.25], // Quillota / La Calera
  [-33.59, -71.61], // San Antonio
  [-32.83, -70.60], // Los Andes / San Felipe
  [-33.40, -71.42], // Casablanca
  // Región de O'Higgins
  [-34.17, -70.74], // Rancagua
  [-34.58, -70.99], // San Fernando
  [-34.64, -71.36], // Santa Cruz
  [-34.39, -72.00], // Pichilemu (costa)
];

// --- Estado en memoria ---
let stationIds = [];
let cache = { updatedAt: null, refreshMinutes: BASE_MINUTES, autoFast: false, stations: [] };
let apiCallsToday = 0;
let callCountDate = new Date().toDateString();

// --- Modo extremo (manual): fuerza seguimiento rápido por 1 hora ---
const EXTREME_DURATION_MIN = 60; // se apaga solo después de 1 hora
const DAILY_BUDGET_GUARD = 1350; // no permite activar si ya se gastó casi toda la cuota
let forceFastUntil = 0;          // timestamp en ms; 0 = inactivo

function countCall() {
  const today = new Date().toDateString();
  if (today !== callCountDate) {
    callCountDate = today;
    apiCallsToday = 0;
  }
  apiCallsToday++;
}

async function wuFetch(url) {
  countCall();
  const res = await fetch(url);
  if (res.status === 204) return null; // estación sin datos
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url.split("apiKey")[0]}`);
  return res.json();
}

// --- Paso 1: descubrir estaciones PWS cercanas a cada punto semilla ---
async function discoverStations() {
  console.log("[descubrimiento] Buscando estaciones PWS en las 3 regiones...");
  const found = new Map();

  for (const [lat, lon] of SEED_POINTS) {
    try {
      const url = `https://api.weather.com/v3/location/near?geocode=${lat},${lon}&product=pws&format=json&apiKey=${API_KEY}`;
      const data = await wuFetch(url);
      const loc = data && data.location;
      if (!loc || !loc.stationId) continue;

      for (let i = 0; i < loc.stationId.length; i++) {
        const sLat = loc.latitude[i];
        const sLon = loc.longitude[i];
        const inBounds =
          sLat >= RM_BOUNDS.latMin && sLat <= RM_BOUNDS.latMax &&
          sLon >= RM_BOUNDS.lonMin && sLon <= RM_BOUNDS.lonMax;
        if (inBounds) found.set(loc.stationId[i], { id: loc.stationId[i], lat: sLat, lon: sLon });
      }
    } catch (err) {
      console.warn(`[descubrimiento] Falló punto ${lat},${lon}: ${err.message}`);
    }
  }

  if (found.size > 0) {
    stationIds = selectSpread([...found.values()], MAX_STATIONS);
    console.log(`[descubrimiento] ${stationIds.length} estaciones seleccionadas con dispersión geográfica (de ${found.size} encontradas).`);
  } else {
    console.warn("[descubrimiento] No se encontraron estaciones; se mantiene la lista anterior.");
  }
}

// Selección con dispersión geográfica: divide el territorio en celdas de ~28 km
// y toma una estación por celda antes de repetir zona. Así las áreas periféricas
// (Talagante, Melipilla, San José de Maipo, costa, etc.) quedan siempre cubiertas.
function selectSpread(candidates, max) {
  const CELL = 0.25; // grados
  const buckets = new Map();
  for (const c of candidates) {
    const key = `${Math.floor((c.lat - RM_BOUNDS.latMin) / CELL)}_${Math.floor((c.lon - RM_BOUNDS.lonMin) / CELL)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  const selected = [];
  const lists = [...buckets.values()];
  while (selected.length < max) {
    let added = false;
    for (const list of lists) {
      if (list.length > 0 && selected.length < max) {
        selected.push(list.shift().id);
        added = true;
      }
    }
    if (!added) break; // no quedan candidatos
  }
  return selected;
}

// --- Paso 2: leer las condiciones actuales de una lista de estaciones ---
async function fetchStations(ids) {
  const results = [];
  for (const id of ids) {
    try {
      const url = `https://api.weather.com/v2/pws/observations/current?stationId=${id}&format=json&units=m&apiKey=${API_KEY}`;
      const data = await wuFetch(url);
      const obs = data && data.observations && data.observations[0];
      if (!obs) continue;

      results.push({
        id: obs.stationID,
        name: obs.neighborhood || obs.stationID,
        lat: obs.lat,
        lon: obs.lon,
        windDir: obs.winddir,                          // grados desde donde SOPLA el viento
        windSpeed: obs.metric ? obs.metric.windSpeed : null, // km/h
        windGust: obs.metric ? obs.metric.windGust : null,   // km/h
        temp: obs.metric ? obs.metric.temp : null,
        pressure: obs.metric ? obs.metric.pressure : null,       // hPa
        precipRate: obs.metric ? obs.metric.precipRate : null,   // mm/h
        precipTotal: obs.metric ? obs.metric.precipTotal : null, // mm acumulados hoy
        humidity: obs.humidity,
        obsTimeLocal: obs.obsTimeLocal,
        epoch: obs.epoch,
      });
    } catch (err) {
      console.warn(`[consulta] Estación ${id} falló: ${err.message}`);
    }
  }
  return results;
}

function updateCache(newStations) {
  // Mezcla: reemplaza las estaciones actualizadas, conserva el resto
  const byId = new Map(cache.stations.map(s => [s.id, s]));
  newStations.forEach(s => byId.set(s.id, s));
  const fast = fastActive();
  cache = {
    updatedAt: new Date().toISOString(),
    refreshMinutes: fast ? FAST_MINUTES : BASE_MINUTES,
    fast,
    forceFastUntil: forceFastUntil > Date.now() ? forceFastUntil : 0,
    apiCallsToday,
    stations: [...byId.values()],
  };
}

async function refreshObservations() {
  if (stationIds.length === 0) {
    console.warn("[refresco] Sin estaciones para consultar.");
    return;
  }
  console.log(`[refresco] Consultando ${stationIds.length} estaciones... (llamadas hoy: ${apiCallsToday})`);
  const results = await fetchStations(stationIds);
  if (results.length > 0) {
    updateCache(results);
    console.log(`[refresco] OK: ${results.length} estaciones con datos.`);
  } else {
    console.warn("[refresco] Ninguna estación entregó datos; se mantiene el caché anterior.");
  }
}

// --- Notificaciones push (ntfy.sh) ---
async function notify(title, message, priority = "high", tags = "warning,dash") {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { "Title": title, "Priority": priority, "Tags": tags },
      body: message,
    });
    console.log(`[notificacion] Enviada: ${message}`);
  } catch (err) {
    console.warn(`[notificacion] Falló: ${err.message}`);
  }
}

// --- Planificador adaptativo ---
// Refresco visual cada BASE_MINUTES rotando grupos de STATIONS_PER_CYCLE
// estaciones (cubre toda la red sin exceder la cuota).
// Modo rápido (cada FAST_MINUTES, las FAST_STATIONS más ventosas) cuando
// hay ráfagas >= WIND_TRIGGER, o cuando se activa el modo extremo manual.
// Notifica al detectar viento fuerte y, aparte, condiciones extremas (>= EXTREME_TRIGGER).
const FAST_BUDGET_GUARD = 1400;
let lastFullRefresh = 0;
let lastFastRefresh = 0;
let groupIndex = 0;
let wasFast = false;
let lastWindNotify = 0;
let lastExtremeNotify = 0;

function maxGustNow() {
  return cache.stations.reduce((m, s) => Math.max(m, s.windGust ?? s.windSpeed ?? 0), 0);
}
function forceFast() {
  return forceFastUntil > Date.now();
}
function fastActive() {
  if (apiCallsToday >= FAST_BUDGET_GUARD) return false; // freno de presupuesto
  return forceFast() || maxGustNow() >= WIND_TRIGGER;
}

async function checkNotifications(now) {
  const peak = maxGustNow();
  // Condición extrema: aviso prioritario (máx. 1 cada 30 min)
  if (peak >= EXTREME_TRIGGER && now - lastExtremeNotify > 30 * 60 * 1000) {
    const top = [...cache.stations].sort((a, b) => (b.windGust ?? b.windSpeed ?? 0) - (a.windGust ?? a.windSpeed ?? 0))[0];
    notify("⚠️ Condicion EXTREMA de viento",
      `Rafagas de ${Math.round(peak)} km/h en ${top ? top.name : "la red"}. Revisa el mapa.`,
      "urgent", "rotating_light");
    lastExtremeNotify = now;
  }
  // Viento fuerte (entrada a modo rápido): aviso normal (máx. 1 por hora)
  const active = fastActive();
  if (active && !wasFast && now - lastWindNotify > 60 * 60 * 1000) {
    const top = [...cache.stations].sort((a, b) => (b.windGust ?? b.windSpeed ?? 0) - (a.windGust ?? a.windSpeed ?? 0))[0];
    if (top) {
      notify("Viento fuerte detectado",
        `Rafagas de ${Math.round(top.windGust ?? top.windSpeed)} km/h en ${top.name}. Seguimiento rapido activado (cada ${FAST_MINUTES} min).`);
      lastWindNotify = now;
    }
  }
  wasFast = active;
}

async function scheduler() {
  const now = Date.now();
  try {
    await checkNotifications(now);

    // Refresco visual: rota grupos para cubrir toda la red dentro de cuota
    if (now - lastFullRefresh >= BASE_MINUTES * 60 * 1000) {
      lastFullRefresh = now;
      const groups = Math.max(1, Math.ceil(stationIds.length / STATIONS_PER_CYCLE));
      const grupo = stationIds.filter((_, i) => i % groups === (groupIndex % groups));
      groupIndex++;
      console.log(`[refresco] Grupo ${groupIndex % groups + 1}/${groups}: ${grupo.length} estaciones (llamadas hoy: ${apiCallsToday})`);
      const results = await fetchStations(grupo);
      if (results.length > 0) updateCache(results);
      return;
    }
    // Modo rápido: las más ventosas cada FAST_MINUTES
    if (fastActive() && now - lastFastRefresh >= FAST_MINUTES * 60 * 1000) {
      lastFastRefresh = now;
      const top = [...cache.stations]
        .sort((a, b) => (b.windGust ?? b.windSpeed ?? 0) - (a.windGust ?? a.windSpeed ?? 0))
        .slice(0, FAST_STATIONS)
        .map(s => s.id);
      if (top.length > 0) {
        console.log(`[rápido] Consultando ${top.length} estaciones ventosas (llamadas hoy: ${apiCallsToday})`);
        const results = await fetchStations(top);
        if (results.length > 0) updateCache(results);
      }
    }
  } catch (err) {
    console.warn(`[planificador] Error: ${err.message}`);
  }
}

// Modo extremo manual: fuerza el seguimiento rápido (5 min) por 1 hora
const app_extreme_routes = (app) => {
  app.get("/api/extreme/start", (req, res) => {
    if (apiCallsToday > DAILY_BUDGET_GUARD) {
      return res.json({ ok: false, reason: "Cuota diaria casi agotada; inténtalo mañana." });
    }
    forceFastUntil = Date.now() + EXTREME_DURATION_MIN * 60 * 1000;
    lastFastRefresh = 0; // dispara una consulta rápida de inmediato
    console.log("[extremo] Seguimiento rápido (5 min) ACTIVADO por 60 minutos.");
    res.json({ ok: true, forceFastUntil });
  });
};

// ============================================================
// Campo de viento (Open-Meteo): grilla densa sobre las 3 regiones
// Sin API key y sin riesgo para la cuota de Wunderground.
// El modelo se actualiza cada ~15 min, así que refrescar cada
// 15 min entrega siempre el dato más nuevo disponible.
// ============================================================
const GRID_SPACING = 0.2; // grados (~22 km entre puntos)
const GRID_REFRESH_MINUTES = Number(process.env.GRID_REFRESH_MINUTES || 30);
let gridCache = { updatedAt: null, points: [] };
let velocityCache = null; // formato leaflet-velocity (animación tipo Windy)

function buildGridCoords() {
  const latVals = [], lonVals = [];
  for (let lat = RM_BOUNDS.latMin; lat <= RM_BOUNDS.latMax + 1e-9; lat += GRID_SPACING) latVals.push(+lat.toFixed(2));
  for (let lon = RM_BOUNDS.lonMin; lon <= RM_BOUNDS.lonMax + 1e-9; lon += GRID_SPACING) lonVals.push(+lon.toFixed(2));
  const coords = [];
  for (const lat of latVals) for (const lon of lonVals) coords.push({ lat, lon });
  return { latVals, lonVals, coords };
}

async function refreshGrid() {
  try {
    const { latVals, lonVals, coords } = buildGridCoords();
    const points = new Array(coords.length).fill(null);
    const CHUNK = 50; // puntos por petición (URLs más cortas y robustas)

    for (let i = 0; i < coords.length; i += CHUNK) {
      const slice = coords.slice(i, i + CHUNK);
      const latStr = slice.map(c => c.lat).join(",");
      const lonStr = slice.map(c => c.lon).join(",");
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latStr}&longitude=${lonStr}` +
        `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh&timezone=America%2FSantiago`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      const data = await res.json();
      const arr = Array.isArray(data) ? data : [data];
      arr.forEach((p, j) => {
        if (!p.current) return;
        points[i + j] = {
          lat: coords[i + j].lat, // coordenada de la grilla regular
          lon: coords[i + j].lon,
          windSpeed: p.current.wind_speed_10m,
          windDir: p.current.wind_direction_10m,
          windGust: p.current.wind_gusts_10m,
        };
      });
    }

    const valid = points.filter(Boolean);
    if (valid.length > 0) {
      gridCache = { updatedAt: new Date().toISOString(), points: valid };
      velocityCache = buildVelocityData(points, latVals, lonVals);
      console.log(`[grilla] OK: ${valid.length} puntos del modelo actualizados (animación lista).`);
    }
  } catch (err) {
    console.warn(`[grilla] Falló la actualización: ${err.message}`);
  }
}

// Convierte la grilla a componentes U/V (m/s) en el formato que espera
// leaflet-velocity: filas de norte a sur, columnas de oeste a este.
function buildVelocityData(points, latVals, lonVals) {
  const nx = lonVals.length, ny = latVals.length;
  const u = [], v = [];
  for (let iLat = ny - 1; iLat >= 0; iLat--) {       // norte → sur
    for (let iLon = 0; iLon < nx; iLon++) {           // oeste → este
      const p = points[iLat * nx + iLon];
      if (!p || p.windSpeed == null || p.windDir == null) { u.push(0); v.push(0); continue; }
      const ms = p.windSpeed / 3.6;                   // km/h → m/s
      const rad = (p.windDir * Math.PI) / 180;        // dirección DESDE donde sopla
      u.push(-ms * Math.sin(rad));
      v.push(-ms * Math.cos(rad));
    }
  }
  const header = {
    parameterUnit: "m.s-1", parameterCategory: 2,
    nx, ny, dx: GRID_SPACING, dy: GRID_SPACING,
    lo1: lonVals[0], la1: latVals[ny - 1],            // esquina noroeste
    lo2: lonVals[nx - 1], la2: latVals[0],            // esquina sureste
    refTime: new Date().toISOString(),
  };
  return [
    { header: { ...header, parameterNumber: 2, parameterNumberName: "eastward_wind" }, data: u },
    { header: { ...header, parameterNumber: 3, parameterNumberName: "northward_wind" }, data: v },
  ];
}


// --- API para el mapa ---
app.get("/api/wind", (req, res) => res.json(cache));
app.get("/api/grid", (req, res) => res.json(gridCache));
app.get("/api/velocity", (req, res) => res.json(velocityCache || []));
app.get("/api/health", (req, res) => res.json({ ok: true, stations: stationIds.length, gridPoints: gridCache.points.length, apiCallsToday }));
app_extreme_routes(app);

// Frontend estático
app.use(express.static(path.join(__dirname, "public")));

// --- Arranque ---
app.listen(PORT, async () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  if (!API_KEY) {
    console.error("FALTA la variable de entorno WU_API_KEY. Configúrala en Render.");
    return;
  }
  await discoverStations();
  lastFullRefresh = Date.now();
  await refreshObservations();
  await refreshGrid();
  setInterval(scheduler, 60 * 1000); // el planificador decide cada minuto qué consultar
  setInterval(discoverStations, DISCOVERY_HOURS * 60 * 60 * 1000);
  setInterval(refreshGrid, GRID_REFRESH_MINUTES * 60 * 1000);
});
