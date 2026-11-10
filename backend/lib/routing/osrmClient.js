/**
 * Cliente do motor de rotas próprio (OSRM).
 * OSRM_BASE_URL vazio = motor desligado; a tela segue no Google Routes.
 */

export class RoutingError extends Error {
  constructor(message, code, statusCode = 503) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function trimUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function getOsrmConfig() {
  const baseUrl = trimUrl(process.env.OSRM_BASE_URL);
  const carBaseUrl = trimUrl(process.env.OSRM_CAR_BASE_URL) || baseUrl;
  return {
    enabled: Boolean(baseUrl),
    baseUrl,
    carBaseUrl,
    timeoutMs: clamp(Number(process.env.OSRM_TIMEOUT_MS) || 3500, 500, 20000),
    footProfile: String(process.env.OSRM_FOOT_PROFILE || 'foot').trim() || 'foot',
    carProfile: String(process.env.OSRM_CAR_PROFILE || 'driving').trim() || 'driving'
  };
}

/** walking = a pé (até 5 km na tela). driving = carro (acima de 5 km). */
export function mapTravelMode(mode) {
  const value = String(mode || '').toLowerCase();
  if (value.includes('driv') || value === 'car') return 'driving';
  return 'walking';
}

export function parseLatLng(value, label) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new RoutingError(`${label} inválida`, 'INVALID_REQUEST', 400);
  }
  return { lat, lng };
}

export function pathFromOsrmGeometry(geometry) {
  const coords = geometry?.type === 'LineString' ? geometry.coordinates : null;
  if (!Array.isArray(coords)) return [];
  const path = [];
  for (const pair of coords) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const lng = Number(pair[0]);
    const lat = Number(pair[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    path.push({ lat, lng });
  }
  return path;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function endpointForMode(config, mode) {
  if (mode === 'driving') {
    return { baseUrl: config.carBaseUrl, profile: config.carProfile };
  }
  return { baseUrl: config.baseUrl, profile: config.footProfile };
}

async function fetchOsrm(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const payload = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, payload };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    throw new RoutingError(
      aborted ? 'Motor de rotas demorou demais' : 'Motor de rotas indisponível',
      'ROUTER_UNAVAILABLE',
      503
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Qualquer resposta HTTP abaixo de 500 indica que o processo está no ar. */
export async function pingOsrm(config = getOsrmConfig()) {
  if (!config.enabled) return { ok: false, reason: 'OSRM_BASE_URL não configurada' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(config.baseUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    return { ok: res.status < 500 };
  } catch {
    return { ok: false, reason: 'sem conexão com o OSRM' };
  }
}

/**
 * Rota entre dois pontos. Distância em metros e path {lat,lng} na ordem da rua.
 * OSRM recebe longitude,latitude.
 */
export async function routeBetween({ origin, destination, mode }) {
  const config = getOsrmConfig();
  if (!config.enabled) {
    throw new RoutingError('Motor de rotas não configurado', 'ROUTER_UNAVAILABLE', 503);
  }

  const from = parseLatLng(origin, 'Origem');
  const to = parseLatLng(destination, 'Destino');
  const travelMode = mapTravelMode(mode);

  if (haversineMeters(from, to) < 1) {
    return {
      mode: travelMode,
      distanceMeters: 0,
      path: [from, to]
    };
  }

  const { baseUrl, profile } = endpointForMode(config, travelMode);
  const coord = (point) => `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`;
  const url =
    `${baseUrl}/route/v1/${encodeURIComponent(profile)}/${coord(from)};${coord(to)}` +
    '?overview=full&geometries=geojson&alternatives=false&steps=false';

  const { ok, status, payload } = await fetchOsrm(url, config.timeoutMs);
  const code = payload?.code;

  if (code === 'NoRoute' || code === 'NoSegment') {
    throw new RoutingError('Nenhuma rota encontrada', 'ZERO_RESULTS', 200);
  }
  if (!ok || code !== 'Ok') {
    throw new RoutingError(
      payload?.message || `OSRM respondeu ${status || code || 'sem corpo'}`,
      'ROUTER_UNAVAILABLE',
      503
    );
  }

  const route = payload.routes && payload.routes[0];
  const path = pathFromOsrmGeometry(route?.geometry);
  if (!route || path.length < 2) {
    throw new RoutingError('Nenhuma rota encontrada', 'ZERO_RESULTS', 200);
  }

  const distanceMeters = Number(route.distance);
  return {
    mode: travelMode,
    distanceMeters: Number.isFinite(distanceMeters) ? distanceMeters : 0,
    path
  };
}
