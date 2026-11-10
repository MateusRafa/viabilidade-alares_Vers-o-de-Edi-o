/**
 * Arquivo de ruas no disco do backend (DATA_DIR/ruas).
 * O mapa da região é baixado uma vez e cortado aqui, em volta das CTOs.
 * Depois da base + mancha, só refaz se o mapa mudou ou se entrou CTO fora da área.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import supabase, { isSupabaseAvailable } from '../../supabase.js';
import { getActiveDatasetId } from '../ctoCoverageDatasets.js';
import { RADIUS_METERS, graphFromWays, haversineMeters, prepareGraph } from './streetGraph.js';

const require = createRequire(import.meta.url);
const createOsmParser = require('osm-pbf-parser');

const HIGHWAY =
  /^(footway|path|pedestrian|steps|residential|living_street|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|trunk|trunk_link|cycleway|road)$/;

const DEFAULT_PBF_URL =
  'https://download.geofabrik.de/south-america/brazil/nordeste-latest.osm.pbf';

let dataDir = '';
let prepared = null;
let running = false;

function ruasDir() {
  return path.join(dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'ruas');
}

function ruasFile() {
  return path.join(ruasDir(), 'ruas.json');
}

function pbfFile() {
  return path.join(ruasDir(), 'mapa-regiao.osm.pbf');
}

function pbfUrl() {
  return (process.env.OSM_PBF_URL || DEFAULT_PBF_URL).trim();
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
  const reach = Math.ceil(RADIUS_METERS / 111320 / size) + 1;
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

function buildNearIndex(ctos) {
  const size = RADIUS_METERS / 111320;
  const map = new Map();
  for (const c of ctos) {
    const key = `${Math.floor(c.lat / size)}:${Math.floor(c.lng / size)}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(c);
  }
  return { map, size };
}

function isNearCto(index, lat, lng) {
  const { map, size } = index;
  const i = Math.floor(lat / size);
  const j = Math.floor(lng / size);
  for (let di = -2; di <= 2; di++) {
    for (let dj = -2; dj <= 2; dj++) {
      const bucket = map.get(`${i + di}:${j + dj}`);
      if (!bucket) continue;
      for (const c of bucket) {
        if (haversineMeters(lat, lng, c.lat, c.lng) <= RADIUS_METERS) return true;
      }
    }
  }
  return false;
}

function sortNodes(ids, lats, lngs) {
  const n = ids.length;
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => ids[a] - ids[b]);
  const sIds = new Float64Array(n);
  const sLats = new Float64Array(n);
  const sLngs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = order[i];
    sIds[i] = ids[j];
    sLats[i] = lats[j];
    sLngs[i] = lngs[j];
  }
  return { sIds, sLats, sLngs };
}

function lookupNode(table, id) {
  const ids = table.sIds;
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = ids[mid];
    if (value === id) return { lat: table.sLats[mid], lng: table.sLngs[mid] };
    if (value < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
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

async function remoteStamp(url) {
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) throw new Error(`Mapa da região respondeu ${res.status}`);
  return {
    etag: res.headers.get('etag') || '',
    lastModified: res.headers.get('last-modified') || '',
    bytes: Number(res.headers.get('content-length') || 0)
  };
}

function sameStamp(a, b) {
  if (!a || !b) return false;
  if (a.etag && b.etag) return a.etag === b.etag;
  return Boolean(a.lastModified) && a.lastModified === b.lastModified && a.bytes > 0 && a.bytes === b.bytes;
}

async function downloadPbf(url, dest) {
  const part = `${dest}.part`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Mapa da região respondeu ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const file = fs.createWriteStream(part);
  const reader = res.body.getReader();
  let got = 0;
  let lastLog = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (!file.write(Buffer.from(value))) {
        await new Promise((resolve, reject) => {
          file.once('drain', resolve);
          file.once('error', reject);
        });
      }
      if (got - lastLog >= 20 * 1024 * 1024) {
        lastLog = got;
        const mb = Math.round(got / (1024 * 1024));
        const tot = total ? Math.round(total / (1024 * 1024)) : 0;
        console.log(`🛣️ [Ruas] Baixando mapa ${mb}${tot ? `/${tot}` : ''} MB`);
      }
    }
  } catch (err) {
    file.destroy();
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw err;
  }
  await new Promise((resolve, reject) => {
    file.once('error', reject);
    file.end(() => resolve());
  });
  await fs.promises.rename(part, dest);
  console.log(`🛣️ [Ruas] Mapa da região salvo (${Math.round(got / (1024 * 1024))} MB).`);
}

function boundsOf(ctos) {
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const c of ctos) {
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lng < minLng) minLng = c.lng;
    if (c.lng > maxLng) maxLng = c.lng;
  }
  const pad = (RADIUS_METERS + 200) / 111320;
  return { minLat: minLat - pad, maxLat: maxLat + pad, minLng: minLng - pad, maxLng: maxLng + pad };
}

function waysNearCtos(file, ctos) {
  const near = buildNearIndex(ctos);
  const box = boundsOf(ctos);
  const ids = [];
  const lats = [];
  const lngs = [];
  const ways = [];
  let table = null;
  let seenNodes = 0;
  let keptNodes = 0;
  let seenWays = 0;

  const parser = createOsmParser();
  const transform = new Transform({
    objectMode: true,
    transform(batch, _enc, callback) {
      try {
        const items = Array.isArray(batch) ? batch : [batch];
        for (const item of items) {
          if (!item || item.type === 'node') {
            if (!item) continue;
            seenNodes += 1;
            if (seenNodes % 5000000 === 0) {
              console.log(`🛣️ [Ruas] Lendo mapa: ${seenNodes / 1000000} milhões de pontos`);
            }
            if (table) continue;
            if (item.lat < box.minLat || item.lat > box.maxLat || item.lon < box.minLng || item.lon > box.maxLng) {
              continue;
            }
            if (!isNearCto(near, item.lat, item.lon)) continue;
            ids.push(item.id);
            lats.push(item.lat);
            lngs.push(item.lon);
            keptNodes += 1;
            continue;
          }
          if (item.type !== 'way') continue;
          if (!table) {
            console.log(`🛣️ [Ruas] ${keptNodes} pontos perto das CTOs. Ordenando para o corte.`);
            table = sortNodes(ids, lats, lngs);
            ids.length = 0;
            lats.length = 0;
            lngs.length = 0;
          }
          seenWays += 1;
          if (seenWays % 250000 === 0) {
            console.log(`🛣️ [Ruas] Ruas lidas: ${seenWays}. Trechos úteis: ${ways.length}.`);
          }
          if (!HIGHWAY.test(item.tags?.highway || '')) continue;
          const refs = item.refs || [];
          let geom = [];
          for (const ref of refs) {
            const coord = lookupNode(table, ref);
            if (!coord) {
              if (geom.length >= 2) ways.push({ geometry: geom });
              geom = [];
              continue;
            }
            geom.push({ lat: coord.lat, lon: coord.lng });
          }
          if (geom.length >= 2) ways.push({ geometry: geom });
        }
        callback();
      } catch (err) {
        callback(err);
      }
    }
  });

  return pipeline(fs.createReadStream(file), parser, transform).then(() => {
    console.log(`🛣️ [Ruas] Corte local pronto: ${ways.length} trechos de rua.`);
    return ways;
  });
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

  const previous = prepared?.ctos || [];
  const uncovered = hasCtoOutside(ctos, previous);
  let stamp = null;
  try {
    stamp = await remoteStamp(pbfUrl());
  } catch (err) {
    console.warn(`⚠️ [Ruas] Não deu para consultar a data do mapa: ${err.message}`);
  }
  const localReady = fs.existsSync(pbfFile());
  const mapSame = localReady && sameStamp(prepared?.source, stamp);
  const canSkip =
    !uncovered &&
    prepared?.edges?.length &&
    (mapSame || (!stamp && prepared?.source && localReady));

  if (canSkip) {
    console.log('🛣️ [Ruas] Mapa da região sem mudança e sem CTO fora da área. Arquivo mantido.');
    return;
  }

  console.log(`🛣️ [Ruas] Montando arquivo novo (${reason}).`);
  await fs.promises.mkdir(ruasDir(), { recursive: true });
  if (!mapSame || !localReady) {
    console.log('🛣️ [Ruas] Baixando o mapa da região em um arquivo único.');
    await downloadPbf(pbfUrl(), pbfFile());
  } else {
    console.log('🛣️ [Ruas] Mapa da região já está no disco. Cortando em volta das CTOs.');
  }

  const ways = await waysNearCtos(pbfFile(), ctos);
  const built = graphFromWays(ways);
  if (!built.edges.length) {
    throw new Error('Nenhuma rua encontrada. Arquivo anterior permanece.');
  }
  const payload = {
    version: 1,
    radiusMeters: RADIUS_METERS,
    builtAt: new Date().toISOString(),
    source: stamp,
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
