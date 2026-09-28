/**
 * Desenho da mancha de cobertura no Google Maps.
 *
 * - Formato antigo (geometry = Polygon/MultiPolygon): desenha todos os anéis,
 *   incluindo os furos (áreas sem CTO dentro da mancha).
 * - Formato em blocos (tiles = FeatureCollection): preenchimento num único
 *   polígono sem contorno + linha de contorno só nas bordas reais da mancha
 *   (as divisas entre blocos não aparecem).
 */

export const COVERAGE_STYLE = {
  strokeColor: '#8B7AE8',
  strokeOpacity: 0.8,
  strokeWeight: 1.2,
  fillColor: '#6B8DD6'
};

const EDGE_EPS = 1.5e-6;
const JOIN_CELL = 2e-5;

/** `localStorage.manchaPreview = '1'` mostra a prévia da mancha em blocos. */
export function isCoveragePreview() {
  try {
    return localStorage.getItem('manchaPreview') === '1';
  } catch (_) {
    return false;
  }
}

export function coveragePreviewQuery(prefix = '&') {
  return isCoveragePreview() ? `${prefix}preview=1` : '';
}

/** Geometria desenhável a partir da resposta de /api/coverage/polygon. */
export function coverageGeometryFromResponse(data) {
  if (!data) return null;
  if (data.format === 'tiles') return data.tiles || null;
  return data.geometry || null;
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

function toPath(ring, reverse) {
  const src = reverse ? [...ring].reverse() : ring;
  return src.map((c) => ({ lat: c[1], lng: c[0] }));
}

/** Anel externo anti-horário e furos horário (exigência do Google Maps para recortar). */
function polygonPaths(rings) {
  return rings.map((ring, i) => {
    const ccw = signedArea(ring) > 0;
    return toPath(ring, i === 0 ? !ccw : ccw);
  });
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function extendBounds(bounds, rings) {
  if (!bounds) return;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 8) bounds.extend({ lat: ring[i][1], lng: ring[i][0] });
  }
}

function onTileEdge(a, b, bbox) {
  const [x0, y0, x1, y1] = bbox;
  return (
    (Math.abs(a[0] - x0) < EDGE_EPS && Math.abs(b[0] - x0) < EDGE_EPS) ||
    (Math.abs(a[0] - x1) < EDGE_EPS && Math.abs(b[0] - x1) < EDGE_EPS) ||
    (Math.abs(a[1] - y0) < EDGE_EPS && Math.abs(b[1] - y0) < EDGE_EPS) ||
    (Math.abs(a[1] - y1) < EDGE_EPS && Math.abs(b[1] - y1) < EDGE_EPS)
  );
}

/** Trechos contínuos de um anel que não estão sobre a borda do bloco. */
function ringRuns(ring, bbox) {
  const runs = [];
  let cur = null;
  let cut = false;
  for (let i = 0; i < ring.length - 1; i++) {
    if (onTileEdge(ring[i], ring[i + 1], bbox)) {
      cut = true;
      if (cur) {
        runs.push(cur);
        cur = null;
      }
    } else {
      if (!cur) cur = [ring[i]];
      cur.push(ring[i + 1]);
    }
  }
  if (cur) {
    // O anel é fechado: se começa e termina com trechos válidos, eles se juntam
    if (cut && runs.length && runs[0][0] === ring[0]) {
      runs[0] = cur.concat(runs[0].slice(1));
    } else {
      runs.push(cur);
    }
  }
  return runs;
}

function isClosed(r) {
  const a = r[0];
  const b = r[r.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

/** Junta trechos cujas pontas coincidem (a linha continua no bloco vizinho). */
function joinRuns(runs) {
  const key = (p) => `${Math.round(p[0] / JOIN_CELL)}|${Math.round(p[1] / JOIN_CELL)}`;
  const byStart = new Map();
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (isClosed(r)) continue;
    const k = key(r[0]);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(i);
  }
  const used = new Uint8Array(runs.length);
  const hasPredecessor = new Uint8Array(runs.length);
  const next = new Int32Array(runs.length).fill(-1);
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (isClosed(r)) continue;
    const cands = byStart.get(key(r[r.length - 1]));
    if (!cands) continue;
    for (const j of cands) {
      if (j !== i && !hasPredecessor[j]) {
        next[i] = j;
        hasPredecessor[j] = 1;
        break;
      }
    }
  }
  const out = [];
  const walk = (start) => {
    let line = [];
    let i = start;
    while (i !== -1 && !used[i]) {
      used[i] = 1;
      line = line.length ? line.concat(runs[i].slice(1)) : runs[i].slice();
      i = next[i];
    }
    out.push(line);
  };
  for (let i = 0; i < runs.length; i++) if (!used[i] && !hasPredecessor[i]) walk(i);
  for (let i = 0; i < runs.length; i++) if (!used[i]) walk(i);
  return out;
}

/**
 * Cria os objetos do Google Maps para a mancha.
 * Retorna a lista de overlays (Polygon/Polyline) — todos aceitam setMap e setOptions.
 */
export function drawCoverageOverlays({ google, map, geometry, fillOpacity, zIndex = 1, bounds = null, visible = true }) {
  const overlays = [];
  if (!geometry) return overlays;
  const target = visible ? map : null;

  if (geometry.type === 'FeatureCollection') {
    const fillPaths = [];
    const runs = [];
    for (const f of geometry.features || []) {
      const bbox = f.bbox;
      for (const rings of polygonsOf(f.geometry)) {
        fillPaths.push(...polygonPaths(rings));
        extendBounds(bounds, rings.slice(0, 1));
        if (bbox) {
          for (const ring of rings) runs.push(...ringRuns(ring, bbox));
        }
      }
    }
    if (fillPaths.length) {
      overlays.push(
        new google.maps.Polygon({
          paths: fillPaths,
          strokeWeight: 0,
          strokeOpacity: 0,
          fillColor: COVERAGE_STYLE.fillColor,
          fillOpacity,
          map: target,
          zIndex,
          geodesic: false,
          clickable: false
        })
      );
    }
    for (const line of joinRuns(runs)) {
      if (line.length < 2) continue;
      overlays.push(
        new google.maps.Polyline({
          path: line.map((c) => ({ lat: c[1], lng: c[0] })),
          strokeColor: COVERAGE_STYLE.strokeColor,
          strokeOpacity: COVERAGE_STYLE.strokeOpacity,
          strokeWeight: COVERAGE_STYLE.strokeWeight,
          map: target,
          zIndex: zIndex + 1,
          geodesic: false,
          clickable: false
        })
      );
    }
    return overlays;
  }

  for (const rings of polygonsOf(geometry)) {
    extendBounds(bounds, rings.slice(0, 1));
    overlays.push(
      new google.maps.Polygon({
        paths: polygonPaths(rings),
        strokeColor: COVERAGE_STYLE.strokeColor,
        strokeOpacity: COVERAGE_STYLE.strokeOpacity,
        strokeWeight: COVERAGE_STYLE.strokeWeight,
        fillColor: COVERAGE_STYLE.fillColor,
        fillOpacity,
        map: target,
        zIndex,
        geodesic: true
      })
    );
  }
  return overlays;
}
