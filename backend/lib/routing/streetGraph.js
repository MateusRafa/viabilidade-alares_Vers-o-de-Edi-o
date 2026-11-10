/**
 * Grafo de ruas em memória. A pesquisa calcula a rota aqui.
 * Até RADIUS_METERS o traçado é nosso. Acima disso a tela usa o Google.
 */

export const RADIUS_METERS = 1000;
const SNAP_METERS = 160;
const STITCH_METERS = 30;
const MAX_ROUTE_METERS = 4000;
const MAX_EXPANSIONS = 30000;

export class StreetRouteError extends Error {
  constructor(message, code, statusCode = 200) {
    super(message);
    this.name = 'StreetRouteError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function haversineMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function toLocal(lat, lng, lat0, lng0) {
  const x = (lng - lng0) * Math.cos((lat0 * Math.PI) / 180) * 111320;
  const y = (lat - lat0) * 110540;
  return [x, y];
}

function projectSegment(lat, lng, a, b) {
  const [ax, ay] = toLocal(a[0], a[1], lat, lng);
  const [bx, by] = toLocal(b[0], b[1], lat, lng);
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 < 0.01) return null;
  const t = Math.min(1, Math.max(0, (-ax * abx + -ay * aby) / len2));
  const x = ax + abx * t;
  const y = ay + aby * t;
  const dist = Math.hypot(x, y);
  const latP = lat + y / 110540;
  const lngP = lng + x / (Math.cos((lat * Math.PI) / 180) * 111320);
  const edgeLen = Math.sqrt(len2);
  return {
    lat: latP,
    lng: lngP,
    dist,
    t,
    edgeLen,
    distToU: t * edgeLen,
    distToV: (1 - t) * edgeLen
  };
}

class MinHeap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(cost, node) {
    const a = this.a;
    a.push([cost, node]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break;
        [a[i], a[s]] = [a[s], a[i]];
        i = s;
      }
    }
    return top;
  }
}

/** Monta índices a partir do JSON salvo em disco. */
export function prepareGraph(data) {
  const coords = data?.nodes || [];
  const adj = coords.map(() => []);
  const edges = [];
  for (const edge of data?.edges || []) {
    const a = edge[0];
    const b = edge[1];
    const d = edge[2];
    if (a === b || !Number.isFinite(d) || d <= 0) continue;
    if (!coords[a] || !coords[b]) continue;
    adj[a].push([b, d]);
    adj[b].push([a, d]);
    edges.push([a, b]);
  }
  const stitched = stitchGaps(coords, adj, edges);
  if (stitched) {
    console.log(`🛣️ [Ruas] ${stitched} emendas entre trechos que estavam separados.`);
  }
  const cell = 0.0015;
  const grid = new Map();
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i];
    for (const key of cellsAlong(coords[a], coords[b], cell)) {
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(i);
    }
  }
  return {
    coords,
    adj,
    edges,
    grid,
    cell,
    radiusMeters: data?.radiusMeters || RADIUS_METERS,
    builtAt: data?.builtAt || null,
    ctos: data?.ctos || [],
    source: data?.source || null
  };
}

function cellsAlong(a, b, cell) {
  const keys = [];
  const seen = new Set();
  const steps = Math.max(1, Math.ceil(haversineMeters(a[0], a[1], b[0], b[1]) / 120));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const lat = a[0] + (b[0] - a[0]) * t;
    const lng = a[1] + (b[1] - a[1]) * t;
    const key = `${Math.floor(lat / cell)}:${Math.floor(lng / cell)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function stitchGaps(coords, adj, edges) {
  const cell = STITCH_METERS / 111320;
  const grid = new Map();
  for (let i = 0; i < coords.length; i++) {
    const key = `${Math.floor(coords[i][0] / cell)}:${Math.floor(coords[i][1] / cell)}`;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }
  let added = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lat, lng] = coords[i];
    const ci = Math.floor(lat / cell);
    const cj = Math.floor(lng / cell);
    const linked = new Set(adj[i].map(([node]) => node));
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const bucket = grid.get(`${ci + di}:${cj + dj}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i || linked.has(j)) continue;
          const d = haversineMeters(lat, lng, coords[j][0], coords[j][1]);
          if (d < 0.5 || d > STITCH_METERS) continue;
          const meters = Math.round(d * 10) / 10;
          adj[i].push([j, meters]);
          adj[j].push([i, meters]);
          edges.push([i, j]);
          linked.add(j);
          added += 1;
        }
      }
    }
  }
  return added;
}

function snap(prep, lat, lng) {
  const { cell, grid, edges, coords } = prep;
  const i = Math.floor(lat / cell);
  const j = Math.floor(lng / cell);
  let best = null;
  for (let di = -2; di <= 2; di++) {
    for (let dj = -2; dj <= 2; dj++) {
      const list = grid.get(`${i + di}:${j + dj}`);
      if (!list) continue;
      for (const ei of list) {
        const [u, v] = edges[ei];
        const hit = projectSegment(lat, lng, coords[u], coords[v]);
        if (!hit) continue;
        if (!best || hit.dist < best.dist) best = { ...hit, edge: ei, u, v };
      }
    }
  }
  if (!best || best.dist > SNAP_METERS) return null;
  return best;
}

function trace(prep, parent, node) {
  const out = [];
  let cur = node;
  const guard = new Set();
  while (cur !== undefined && !guard.has(cur)) {
    guard.add(cur);
    const c = prep.coords[cur];
    out.push({ lat: c[0], lng: c[1] });
    cur = parent.get(cur);
  }
  out.reverse();
  return out;
}

/**
 * Rota a pé entre dois pontos. Ignora mão de rua: o cabo segue a via nos dois sentidos.
 * @returns {{ distanceMeters: number, path: {lat:number,lng:number}[] }}
 */
export function routeOnGraph(prep, origin, destination) {
  if (!prep || !prep.coords?.length || !prep.edges?.length) {
    throw new StreetRouteError('Arquivo de ruas ainda não está pronto', 'ROUTER_UNAVAILABLE', 503);
  }
  const oLat = Number(origin?.lat);
  const oLng = Number(origin?.lng);
  const dLat = Number(destination?.lat);
  const dLng = Number(destination?.lng);
  if (![oLat, oLng, dLat, dLng].every(Number.isFinite)) {
    throw new StreetRouteError('Coordenada inválida', 'INVALID_REQUEST', 400);
  }
  const linear = haversineMeters(oLat, oLng, dLat, dLng);
  if (linear > prep.radiusMeters) {
    throw new StreetRouteError('Rota acima de 1 km', 'ROUTE_LONG', 200);
  }
  if (linear < 1) {
    return {
      distanceMeters: 0,
      path: [
        { lat: oLat, lng: oLng },
        { lat: dLat, lng: dLng }
      ]
    };
  }

  const s1 = snap(prep, oLat, oLng);
  const s2 = snap(prep, dLat, dLng);
  if (!s1 || !s2) {
    throw new StreetRouteError('Rua não encontrada no mapa local', 'ZERO_RESULTS', 200);
  }

  if (s1.edge === s2.edge) {
    const along = Math.abs(s1.t - s2.t) * s1.edgeLen;
    return {
      distanceMeters: along,
      path: [
        { lat: s1.lat, lng: s1.lng },
        { lat: s2.lat, lng: s2.lng }
      ]
    };
  }

  const starts = [
    [s1.u, s1.distToU],
    [s1.v, s1.distToV]
  ];
  const goals = new Map([
    [s2.u, s2.distToU],
    [s2.v, s2.distToV]
  ]);

  const gScore = new Map();
  const parent = new Map();
  const heap = new MinHeap();
  for (const [node, seed] of starts) {
    if (gScore.has(node) && gScore.get(node) <= seed) continue;
    gScore.set(node, seed);
    heap.push(seed, node);
  }

  let best = Infinity;
  let bestNode = -1;
  let expansions = 0;

  while (heap.size) {
    const [g, node] = heap.pop();
    if (g !== gScore.get(node)) continue;
    if (g > best || g > MAX_ROUTE_METERS) break;
    const extra = goals.get(node);
    if (extra !== undefined && g + extra < best) {
      best = g + extra;
      bestNode = node;
    }
    expansions += 1;
    if (expansions > MAX_EXPANSIONS) break;
    for (const [to, w] of prep.adj[node]) {
      const ng = g + w;
      if (ng > MAX_ROUTE_METERS || ng >= best) continue;
      if (ng >= (gScore.get(to) ?? Infinity)) continue;
      gScore.set(to, ng);
      parent.set(to, node);
      heap.push(ng, to);
    }
  }

  if (bestNode < 0 || !Number.isFinite(best)) {
    throw new StreetRouteError('Nenhuma rota no mapa local', 'ZERO_RESULTS', 200);
  }

  const mid = trace(prep, parent, bestNode);
  const path = [{ lat: s1.lat, lng: s1.lng }, ...mid, { lat: s2.lat, lng: s2.lng }];
  const compact = [];
  for (const p of path) {
    const prev = compact[compact.length - 1];
    if (prev && Math.abs(prev.lat - p.lat) < 1e-7 && Math.abs(prev.lng - p.lng) < 1e-7) continue;
    compact.push(p);
  }
  if (compact.length < 2) {
    compact.push({ lat: dLat, lng: dLng });
  }
  return { distanceMeters: best, path: compact };
}

/**
 * Constrói nodes/edges a partir de trechos de rua com geometry.
 * @param {{geometry:{lat:number,lon:number}[]}[]} ways
 */
export function graphFromWays(ways) {
  const index = new Map();
  const nodes = [];
  const seen = new Set();
  const edges = [];

  function idOf(lat, lng) {
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = nodes.length;
      index.set(key, id);
      nodes.push([Number(lat.toFixed(6)), Number(lng.toFixed(6))]);
    }
    return id;
  }

  for (const way of ways) {
    const geom = way?.geometry;
    if (!Array.isArray(geom) || geom.length < 2) continue;
    let prev = null;
    let prevLat = 0;
    let prevLng = 0;
    for (const p of geom) {
      const lat = Number(p.lat);
      const lng = Number(p.lon ?? p.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const id = idOf(lat, lng);
      if (prev !== null && prev !== id) {
        const dist = haversineMeters(prevLat, prevLng, lat, lng);
        if (dist > 0.5 && dist < 400) {
          const a = Math.min(prev, id);
          const b = Math.max(prev, id);
          const key = `${a}:${b}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push([a, b, Math.round(dist * 10) / 10]);
          }
        }
      }
      prev = id;
      prevLat = lat;
      prevLng = lng;
    }
  }

  return { nodes, edges };
}
