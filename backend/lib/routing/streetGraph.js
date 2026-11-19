/**
 * Grafo de ruas em memória. A pesquisa calcula a rota aqui.
 * Até RADIUS_METERS o traçado é nosso. Acima disso a tela usa o Google.
 * A cópia que fica no ar é a compacta (ruas.pack). O JSON grande só entra
 * na execução que grava essa cópia e depois termina.
 */
import fs from 'fs';

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

function projectSegment(lat, lng, aLat, aLng, bLat, bLng) {
  const [ax, ay] = toLocal(aLat, aLng, lat, lng);
  const [bx, by] = toLocal(bLat, bLng, lat, lng);
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

const GRID_CELL = 0.0015;
const GRID_I0 = 100000;
const GRID_JSPAN = 400001;
const GRID_J0 = 200000;

function gridKey(i, j) {
  return (i + GRID_I0) * GRID_JSPAN + (j + GRID_J0);
}

function fillCellKeys(lat1, lng1, lat2, lng2, cell, out) {
  const steps = Math.max(1, Math.ceil(haversineMeters(lat1, lng1, lat2, lng2) / 120));
  let n = 0;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const lat = lat1 + (lat2 - lat1) * t;
    const lng = lng1 + (lng2 - lng1) * t;
    const key = gridKey(Math.floor(lat / cell), Math.floor(lng / cell));
    let dup = false;
    for (let k = 0; k < n; k++) {
      if (out[k] === key) {
        dup = true;
        break;
      }
    }
    if (!dup) out[n++] = key;
  }
  return n;
}

function lowerBound(keys, key) {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(keys, key, lo) {
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Troca milhões de listinhas por blocos contínuos.
 * O arquivo no disco continua o mesmo. A rota lê estes blocos.
 */
function packGraph(coords, adj, edges) {
  const n = coords.length;
  const e = edges.length;
  const lat = new Float64Array(n);
  const lng = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lat[i] = coords[i][0];
    lng[i] = coords[i][1];
  }

  const edgeU = new Uint32Array(e);
  const edgeV = new Uint32Array(e);
  for (let i = 0; i < e; i++) {
    edgeU[i] = edges[i][0];
    edgeV[i] = edges[i][1];
  }

  const adjOff = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) adjOff[i + 1] = adjOff[i] + adj[i].length;
  const arcCount = adjOff[n];
  const adjTo = new Uint32Array(arcCount);
  const adjDist = new Float32Array(arcCount);
  for (let i = 0; i < n; i++) {
    const list = adj[i];
    let c = adjOff[i];
    for (let k = 0; k < list.length; k++) {
      adjTo[c] = list[k][0];
      adjDist[c] = list[k][1];
      c += 1;
    }
  }

  const cell = GRID_CELL;
  const scratch = new Float64Array(32);
  let gridCount = 0;
  for (let i = 0; i < e; i++) {
    gridCount += fillCellKeys(lat[edgeU[i]], lng[edgeU[i]], lat[edgeV[i]], lng[edgeV[i]], cell, scratch);
  }
  const rawKeys = new Float64Array(gridCount);
  const rawEdges = new Uint32Array(gridCount);
  let cursor = 0;
  for (let i = 0; i < e; i++) {
    const hit = fillCellKeys(lat[edgeU[i]], lng[edgeU[i]], lat[edgeV[i]], lng[edgeV[i]], cell, scratch);
    for (let k = 0; k < hit; k++) {
      rawKeys[cursor] = scratch[k];
      rawEdges[cursor] = i;
      cursor += 1;
    }
  }
  const order = Array.from({ length: gridCount }, (_, i) => i);
  order.sort((a, b) => (rawKeys[a] < rawKeys[b] ? -1 : rawKeys[a] > rawKeys[b] ? 1 : 0));
  const gridKeys = new Float64Array(gridCount);
  const gridEdges = new Uint32Array(gridCount);
  for (let i = 0; i < gridCount; i++) {
    const src = order[i];
    gridKeys[i] = rawKeys[src];
    gridEdges[i] = rawEdges[src];
  }

  return {
    nodeCount: n,
    edgeCount: e,
    coords: { length: n },
    edges: { length: e },
    lat,
    lng,
    edgeU,
    edgeV,
    adjOff,
    adjTo,
    adjDist,
    gridKeys,
    gridEdges,
    cell
  };
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
  const packed = packGraph(coords, adj, edges);
  return {
    ...packed,
    radiusMeters: data?.radiusMeters || RADIUS_METERS,
    builtAt: data?.builtAt || null,
    ctos: data?.ctos || [],
    source: data?.source || null
  };
}

const PACK_MAGIC = 'RUAP';

function readBlock(buf, pos) {
  const len = buf.readUInt32LE(pos);
  const end = pos + 4 + len;
  if (end > buf.length) throw new Error('Cópia compacta incompleta');
  return { text: buf.toString('utf8', pos + 4, end), next: end };
}

function align8(pos) {
  return pos + ((8 - (pos % 8)) % 8);
}

function takeArray(buf, pos, count, bytesEach, Ctor) {
  const start = align8(pos);
  const bytes = count * bytesEach;
  const end = start + bytes;
  if (end > buf.length) throw new Error('Cópia compacta incompleta');
  const arr = new Ctor(count);
  if (bytes) Buffer.from(arr.buffer).set(buf.subarray(start, end));
  return { arr, next: end };
}

/** Grava o grafo já com emendas. Quem chama é a execução que termina em seguida. */
export function writePackedGraphFile(file, prep) {
  const builtAt = Buffer.from(String(prep.builtAt || ''), 'utf8');
  const source = Buffer.from(JSON.stringify(prep.source ?? null), 'utf8');
  const ctos = Buffer.from(JSON.stringify(prep.ctos ?? []), 'utf8');
  const header = Buffer.alloc(32);
  header.write(PACK_MAGIC, 0, 'utf8');
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(prep.nodeCount, 8);
  header.writeUInt32LE(prep.edgeCount, 12);
  header.writeUInt32LE(prep.adjTo.length, 16);
  header.writeUInt32LE(prep.gridKeys.length, 20);
  header.writeDoubleLE(Number(prep.radiusMeters) || RADIUS_METERS, 24);
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, header);
    let pos = header.length;
    for (const part of [builtAt, source, ctos]) {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(part.length);
      fs.writeSync(fd, len);
      fs.writeSync(fd, part);
      pos += 4 + part.length;
    }
    const arrays = [
      prep.lat,
      prep.lng,
      prep.edgeU,
      prep.edgeV,
      prep.adjOff,
      prep.adjTo,
      prep.adjDist,
      prep.gridKeys,
      prep.gridEdges
    ];
    for (const arr of arrays) {
      const pad = (8 - (pos % 8)) % 8;
      if (pad) {
        fs.writeSync(fd, Buffer.alloc(pad));
        pos += pad;
      }
      const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
      if (bytes.length) fs.writeSync(fd, bytes);
      pos += bytes.length;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Lê a cópia compacta para a memória do processo que atende a pesquisa. */
export function readPackedGraphFile(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 32 || buf.toString('utf8', 0, 4) !== PACK_MAGIC) {
    throw new Error('Cópia compacta inválida');
  }
  if (buf.readUInt32LE(4) !== 1) throw new Error('Cópia compacta de outra versão');
  const nodeCount = buf.readUInt32LE(8);
  const edgeCount = buf.readUInt32LE(12);
  const arcCount = buf.readUInt32LE(16);
  const gridCount = buf.readUInt32LE(20);
  const radiusMeters = buf.readDoubleLE(24);
  let pos = 32;
  const builtAt = readBlock(buf, pos);
  pos = builtAt.next;
  const source = readBlock(buf, pos);
  pos = source.next;
  const ctos = readBlock(buf, pos);
  pos = ctos.next;
  const lat = takeArray(buf, pos, nodeCount, 8, Float64Array);
  pos = lat.next;
  const lng = takeArray(buf, pos, nodeCount, 8, Float64Array);
  pos = lng.next;
  const edgeU = takeArray(buf, pos, edgeCount, 4, Uint32Array);
  pos = edgeU.next;
  const edgeV = takeArray(buf, pos, edgeCount, 4, Uint32Array);
  pos = edgeV.next;
  const adjOff = takeArray(buf, pos, nodeCount + 1, 4, Uint32Array);
  pos = adjOff.next;
  const adjTo = takeArray(buf, pos, arcCount, 4, Uint32Array);
  pos = adjTo.next;
  const adjDist = takeArray(buf, pos, arcCount, 4, Float32Array);
  pos = adjDist.next;
  const gridKeys = takeArray(buf, pos, gridCount, 8, Float64Array);
  pos = gridKeys.next;
  const gridEdges = takeArray(buf, pos, gridCount, 4, Uint32Array);
  return {
    nodeCount,
    edgeCount,
    coords: { length: nodeCount },
    edges: { length: edgeCount },
    lat: lat.arr,
    lng: lng.arr,
    edgeU: edgeU.arr,
    edgeV: edgeV.arr,
    adjOff: adjOff.arr,
    adjTo: adjTo.arr,
    adjDist: adjDist.arr,
    gridKeys: gridKeys.arr,
    gridEdges: gridEdges.arr,
    cell: GRID_CELL,
    radiusMeters,
    builtAt: builtAt.text || null,
    ctos: JSON.parse(ctos.text || '[]'),
    source: JSON.parse(source.text || 'null')
  };
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
  const { cell, gridKeys, gridEdges, edgeU, edgeV, lat: lats, lng: lngs } = prep;
  const i = Math.floor(lat / cell);
  const j = Math.floor(lng / cell);
  let best = null;
  for (let di = -2; di <= 2; di++) {
    for (let dj = -2; dj <= 2; dj++) {
      const key = gridKey(i + di, j + dj);
      const start = lowerBound(gridKeys, key);
      const end = upperBound(gridKeys, key, start);
      for (let p = start; p < end; p++) {
        const ei = gridEdges[p];
        const u = edgeU[ei];
        const v = edgeV[ei];
        const hit = projectSegment(lat, lng, lats[u], lngs[u], lats[v], lngs[v]);
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
    out.push({ lat: prep.lat[cur], lng: prep.lng[cur] });
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
  if (!prep || !prep.nodeCount || !prep.edgeCount) {
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
    const from = prep.adjOff[node];
    const toArc = prep.adjOff[node + 1];
    for (let arc = from; arc < toArc; arc++) {
      const to = prep.adjTo[arc];
      const w = prep.adjDist[arc];
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
