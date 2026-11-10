/**
 * Arquivo de ruas no disco do backend (DATA_DIR/ruas).
 * Depois da base + mancha, checa se alguma rua mudou ou se entrou CTO fora da área.
 * Só então monta o arquivo novo e troca pelo antigo.
 */
import fs from 'fs';
import path from 'path';
import supabase, { isSupabaseAvailable } from '../../supabase.js';
import { getActiveDatasetId } from '../ctoCoverageDatasets.js';
import { RADIUS_METERS, graphFromWays, haversineMeters, prepareGraph } from './streetGraph.js';

const HIGHWAY =
  '^(footway|path|pedestrian|steps|residential|living_street|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|trunk|trunk_link|cycleway|road)$';

let dataDir = '';
let prepared = null;
let running = false;

function ruasDir() {
  return path.join(dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'ruas');
}

function ruasFile() {
  return path.join(ruasDir(), 'ruas.json');
}

function overpassMirrors() {
  const list = [
    process.env.OVERPASS_URL,
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ];
  const out = [];
  for (const item of list) {
    const url = String(item || '').trim();
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function streetGraphStatus() {
  return {
    available: Boolean(prepared && prepared.edges.length > 0),
    builtAt: prepared?.builtAt || null,
    nodes: prepared?.coords?.length || 0,
    edges: prepared?.edges?.length || 0,
    radiusMeters: RADIUS_METERS,
    running
  };
}

export function streetGraphPrepared() {
  return prepared;
}

export function initStreetGraph(dir) {
  dataDir = dir || dataDir;
  try {
    const file = ruasFile();
    if (!fs.existsSync(file)) {
      console.log('🛣️ [Ruas] Arquivo ainda não existe. As rotas de até 1 km usam o Google até a primeira montagem.');
      return;
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    prepared = prepareGraph(raw);
    console.log(
      `🛣️ [Ruas] Arquivo no ar: ${prepared.coords.length} pontos, ${prepared.edges.length} trechos, raio ${RADIUS_METERS} m.`
    );
  } catch (err) {
    prepared = null;
    console.warn('⚠️ [Ruas] Não foi possível ler o arquivo:', err.message);
  }
}

function cellSizeDeg(lat) {
  const latSize = RADIUS_METERS / 111320;
  const lngSize = latSize / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  return { latSize, lngSize };
}

function cellKey(lat, lng) {
  const { latSize, lngSize } = cellSizeDeg(lat);
  return `${Math.floor(lat / latSize)}:${Math.floor(lng / lngSize)}`;
}

function bboxesFromCtos(ctos) {
  const groups = new Map();
  for (const cto of ctos) {
    const key = cellKey(cto.lat, cto.lng);
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(cto);
  }
  const boxes = [];
  for (const pts of groups.values()) {
    let south = 90;
    let north = -90;
    let west = 180;
    let east = -180;
    for (const p of pts) {
      const dLat = RADIUS_METERS / 111320;
      const dLng = dLat / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
      south = Math.min(south, p.lat - dLat);
      north = Math.max(north, p.lat + dLat);
      west = Math.min(west, p.lng - dLng);
      east = Math.max(east, p.lng + dLng);
    }
    boxes.push({ south, west, north, east });
  }
  return mergeBoxes(boxes);
}

function overlaps(a, b) {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

function mergeBoxes(list) {
  const boxes = list.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (!overlaps(boxes[i], boxes[j])) continue;
        const a = boxes[i];
        const b = boxes[j];
        boxes[i] = {
          south: Math.min(a.south, b.south),
          west: Math.min(a.west, b.west),
          north: Math.max(a.north, b.north),
          east: Math.max(a.east, b.east)
        };
        boxes.splice(j, 1);
        changed = true;
        break;
      }
      if (changed) break;
    }
  }
  return boxes;
}

function gridOf(points) {
  const size = 0.01;
  const map = new Map();
  for (const p of points) {
    const key = `${Math.floor(p.lat / size)}:${Math.floor(p.lng / size)}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(p);
  }
  return { map, size };
}

function hasCtoOutside(ctos, previous) {
  if (!previous?.length) return true;
  const { map, size } = gridOf(previous);
  const reach = Math.ceil((RADIUS_METERS / 111320) / size) + 1;
  for (const c of ctos) {
    const i = Math.floor(c.lat / size);
    const j = Math.floor(c.lng / size);
    let best = Infinity;
    for (let di = -reach; di <= reach; di++) {
      for (let dj = -reach; dj <= reach; dj++) {
        const bucket = map.get(`${i + di}:${j + dj}`);
        if (!bucket) continue;
        for (const q of bucket) {
          const d = haversineMeters(c.lat, c.lng, q.lat, q.lng);
          if (d < best) best = d;
          if (best <= RADIUS_METERS) break;
        }
      }
    }
    if (best > RADIUS_METERS) return true;
  }
  return false;
}

async function fetchCtos() {
  if (!supabase || !isSupabaseAvailable()) {
    throw new Error('Supabase indisponível');
  }
  let datasetId = null;
  try {
    datasetId = await getActiveDatasetId(supabase);
  } catch (err) {
    console.warn('⚠️ [Ruas] Dataset ativo indisponível, lendo a base inteira:', err.message);
  }

  const points = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = supabase.from('ctos').select('latitude, longitude').range(from, from + page - 1);
    if (datasetId) q = q.eq('dataset_id', datasetId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const row of data) {
      const lat = Number(row.latitude);
      const lng = Number(row.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
      points.push({ lat, lng });
    }
    if (data.length < page) break;
  }
  return points;
}

async function overpassOnce(url, query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'ViabilidadeAlares/ruas',
        Accept: 'application/json'
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: ctrl.signal
    });
    if (!res.ok) {
      throw new Error(`Overpass respondeu ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Overpass demorou demais');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function overpass(query) {
  const mirrors = overpassMirrors();
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = mirrors[attempt % mirrors.length];
    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    try {
      console.log(`🛣️ [Ruas] Pedido ao ${host} (tentativa ${attempt + 1}/4)`);
      return await overpassOnce(url, query);
    } catch (err) {
      lastErr = err;
      const wait = [4000, 8000, 12000, 15000][attempt];
      console.warn(`⚠️ [Ruas] ${err.message}. Nova tentativa em ${wait / 1000}s.`);
      await sleep(wait);
    }
  }
  throw lastErr || new Error('Overpass indisponível');
}

function packBoxes(boxes, size = 12) {
  const packs = [];
  for (let i = 0; i < boxes.length; i += size) packs.push(boxes.slice(i, i + size));
  return packs;
}

function waysQuery(boxes, newerIso) {
  const parts = boxes.map((box) => {
    const newer = newerIso ? `(newer:"${newerIso}")` : '';
    return `way["highway"~"${HIGHWAY}"](${bboxClause(box)})${newer};`;
  });
  const out = newerIso ? 'out ids qt;' : 'out geom qt;';
  return `[out:json][timeout:35];(${parts.join('')});${out}`;
}

/** Recorta área grande demais para um único pedido. */
function splitLargeBoxes(boxes) {
  const maxSpan = 0.06;
  const out = [];
  for (const box of boxes) {
    const latSpan = box.north - box.south;
    const lngSpan = box.east - box.west;
    if (latSpan <= maxSpan && lngSpan <= maxSpan) {
      out.push(box);
      continue;
    }
    const latSteps = Math.ceil(latSpan / maxSpan);
    const lngSteps = Math.ceil(lngSpan / maxSpan);
    const dLat = latSpan / latSteps;
    const dLng = lngSpan / lngSteps;
    for (let i = 0; i < latSteps; i++) {
      for (let j = 0; j < lngSteps; j++) {
        out.push({
          south: box.south + i * dLat,
          north: box.south + (i + 1) * dLat,
          west: box.west + j * dLng,
          east: box.west + (j + 1) * dLng
        });
      }
    }
  }
  return out;
}

function bboxClause(box) {
  return `${box.south.toFixed(6)},${box.west.toFixed(6)},${box.north.toFixed(6)},${box.east.toFixed(6)}`;
}

async function streetsChanged(boxes, sinceIso) {
  const packs = packBoxes(boxes, 20);
  for (const pack of packs) {
    const payload = await overpass(waysQuery(pack, sinceIso));
    if (Array.isArray(payload?.elements) && payload.elements.length > 0) return true;
    await sleep(2500);
  }
  return false;
}

function waysFromPayload(payload) {
  const ways = [];
  for (const el of payload?.elements || []) {
    if (el.type === 'way' && Array.isArray(el.geometry)) ways.push(el);
  }
  return ways;
}

async function downloadOne(box) {
  try {
    const payload = await overpass(waysQuery([box]));
    return waysFromPayload(payload);
  } catch (err) {
    const latSpan = box.north - box.south;
    const lngSpan = box.east - box.west;
    if (latSpan < 0.05 && lngSpan < 0.05) throw err;
    const parts = splitLargeBoxes([box]);
    if (parts.length <= 1) throw err;
    console.warn(`⚠️ [Ruas] Área grande falhou. Dividindo em ${parts.length}.`);
    const ways = [];
    for (const part of parts) {
      ways.push(...(await downloadOne(part)));
      await sleep(1500);
    }
    return ways;
  }
}

async function downloadWays(boxes) {
  const ways = [];
  console.log(`🛣️ [Ruas] ${boxes.length} áreas, um pedido por área.`);
  for (let i = 0; i < boxes.length; i++) {
    console.log(`🛣️ [Ruas] Baixando ruas ${i + 1}/${boxes.length}`);
    const batch = await downloadOne(boxes[i]);
    ways.push(...batch);
    console.log(`🛣️ [Ruas] Área ${i + 1}/${boxes.length} pronta, ${batch.length} ruas (total ${ways.length}).`);
    if (i < boxes.length - 1) await sleep(1500);
  }
  return ways;
}

async function writeGraph(payload) {
  const dir = ruasDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const target = ruasFile();
  const next = `${target}.next`;
  const prev = `${target}.prev`;
  await fs.promises.writeFile(next, JSON.stringify(payload));
  await fs.promises.rm(prev, { force: true }).catch(() => {});
  let moved = false;
  try {
    if (fs.existsSync(target)) {
      await fs.promises.rename(target, prev);
      moved = true;
    }
    await fs.promises.rename(next, target);
  } catch (err) {
    if (moved && !fs.existsSync(target) && fs.existsSync(prev)) {
      await fs.promises.rename(prev, target).catch(() => {});
    }
    throw err;
  }
  await fs.promises.rm(prev, { force: true }).catch(() => {});
}

async function refreshStreetGraph(reason) {
  console.log(`🛣️ [Ruas] Checagem após ${reason}`);
  const ctos = await fetchCtos();
  if (!ctos.length) {
    console.warn('⚠️ [Ruas] Nenhuma CTO com coordenada. Arquivo mantido.');
    return;
  }
  const boxes = bboxesFromCtos(ctos);
  const previous = prepared?.ctos || [];
  const uncovered = hasCtoOutside(ctos, previous);
  let changed = false;
  if (!uncovered && prepared?.builtAt) {
    changed = await streetsChanged(boxes, prepared.builtAt);
  }
  if (!uncovered && prepared?.edges?.length && !changed && prepared.builtAt) {
    console.log('🛣️ [Ruas] Sem rua nova e sem CTO fora da área. Arquivo mantido.');
    return;
  }
  const why = !prepared?.edges?.length
    ? 'arquivo ausente'
    : uncovered
      ? 'CTO fora da área'
      : 'rua alterada';
  console.log(`🛣️ [Ruas] Montando arquivo novo (${why}), ${boxes.length} área(s).`);
  const ways = await downloadWays(boxes);
  const built = graphFromWays(ways);
  if (!built.edges.length) {
    throw new Error('Nenhuma rua encontrada. Arquivo anterior permanece.');
  }
  const payload = {
    version: 1,
    radiusMeters: RADIUS_METERS,
    builtAt: new Date().toISOString(),
    ctos: ctos.map((c) => ({ lat: Number(c.lat.toFixed(5)), lng: Number(c.lng.toFixed(5)) })),
    nodes: built.nodes,
    edges: built.edges
  };
  await writeGraph(payload);
  prepared = prepareGraph(payload);
  console.log(
    `🛣️ [Ruas] Arquivo novo no ar. Anterior apagado. ${prepared.coords.length} pontos, ${prepared.edges.length} trechos.`
  );
}

/** Dispara a checagem sem prender a publicação da base. */
export function scheduleStreetGraphRefresh(reason = 'base-publicada') {
  if (!dataDir) dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  if (running) {
    console.log('🛣️ [Ruas] Já existe uma atualização de ruas em andamento. Esta fica de fora.');
    return;
  }
  running = true;
  setTimeout(() => {
    refreshStreetGraph(reason)
      .catch((err) => {
        console.warn(`⚠️ [Ruas] Falha na montagem. Arquivo anterior permanece. ${err.message}`);
      })
      .finally(() => {
        running = false;
      });
  }, 0);
}
