/**
 * Upload Excel → substitui condominios_mdu → geocodifica linhas sem lat/lng.
 */
import XLSX from 'xlsx';
import { dualWrite, getWriteClients } from '../supabaseCluster/dualWrite.js';
import { buildDeleteQuery } from '../supabaseCluster/tables.js';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const INSERT_BATCH_SIZE = 200;
const GEOCODE_DELAY_MS = 220;

const HEADER_ALIASES = {
  id_endereco: ['idendereco', 'id_endereco', 'id endereco', 'idendereço', 'id endereço'],
  data_cadastro: ['datacadastro', 'data_cadastro', 'data cadastro'],
  hora_cadastro: ['horacadastro', 'hora_cadastro', 'hora cadastro'],
  estado: ['estado', 'uf'],
  nome_cidade: ['nomedacidade', 'nome_cidade', 'nome cidade', 'cidade'],
  id_mdu: ['idmdu', 'id_mdu', 'id mdu'],
  controle_mdu: ['controlemdu', 'controle_mdu', 'controle mdu'],
  descricao: ['descricao', 'descrição', 'nome', 'nome_predio', 'nomepredio'],
  tipo: ['tipo'],
  numero: ['numero', 'número', 'num'],
  complemento: ['complemento'],
  bairro: ['bairro'],
  nome_logradouro: ['nomelogradouro', 'nome_logradouro', 'nome logradouro', 'logradouro'],
  tipo_logradouro: ['tipodologradouro', 'tipo_logradouro', 'tipo logradouro', 'tipologradouro'],
  id_cep: ['idcep', 'id_cep', 'id cep'],
  cep: ['cep'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lng', 'lon', 'long']
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeHeaderKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_./\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s/g, '');
}

function buildHeaderMap(headers) {
  const normalizedHeaders = headers.map((h) => ({
    raw: h,
    key: normalizeHeaderKey(h)
  }));

  const map = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasKeys = aliases.map(normalizeHeaderKey);
    const hit = normalizedHeaders.find((h) => aliasKeys.includes(h.key));
    if (hit) map[field] = hit.raw;
  }
  return map;
}

function getMapsApiKey() {
  return (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  ).trim();
}

function parseCoord(value) {
  if (value === null || value === undefined || value === '') return null;

  // Número JS direto (célula Excel numérica)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Serial de data Excel costuma ser > 20000; coordenada geográfica ≤ 180
    if (Math.abs(value) > 180) return null;
    return value;
  }

  if (typeof value === 'boolean') return null;

  // Objeto célula / rich text
  if (typeof value === 'object') {
    if (value.v !== undefined) return parseCoord(value.v);
    if (value.w !== undefined) return parseCoord(value.w);
    if (value.result !== undefined) return parseCoord(value.result);
    if (Array.isArray(value.r)) {
      const text = value.r.map((p) => p?.t || '').join('');
      return parseCoord(text);
    }
    return null;
  }

  let s = String(value).trim();
  if (!s || /^n\/?a$/i.test(s) || s === '-' || s === '—' || s === '#N/A') return null;

  // Sinais unicode → ASCII; remover lixo
  s = s
    .replace(/[\u2212\u2013\u2014\uFE63\uFF0D]/g, '-') // − – — ﹣ －
    .replace(/\u00a0/g, ' ')
    .replace(/["'`°º]/g, '')
    .replace(/\s+/g, '')
    .replace(/^\(+/, '')
    .replace(/\)+$/, '');

  // Extrair o primeiro número assinado da string (ex.: "lat:-5,78" / "S 5.78")
  const extracted = s.match(/[+-]?\d+[.,]?\d*(?:[eE][+-]?\d+)?/);
  if (extracted) s = extracted[0];
  else return null;

  // Notação científica
  if (/^[+-]?\d+[.,]?\d*[eE][+-]?\d+$/.test(s)) {
    const n = Number(s.replace(',', '.'));
    if (!Number.isFinite(n) || Math.abs(n) > 180) return null;
    return n;
  }

  // Formato BR: milhar com ponto + decimal com vírgula (−35.201.650,35)
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1) {
    // Vários pontos: juntar milhares e manter último grupo como decimal
    const sign = s.startsWith('-') ? '-' : s.startsWith('+') ? '' : '';
    const abs = s.replace(/^[+-]/, '');
    const parts = abs.split('.');
    if (parts.length > 2) {
      const last = parts[parts.length - 1];
      s = `${sign}${parts.slice(0, -1).join('')}.${last}`;
    }
  }

  // Último recurso: só dígitos/ponto/sinal
  s = s.replace(/[^0-9.+-]/g, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;

  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > 180) return null;
  return n;
}

/** Aceita lat/lng de valor cru ou formatado (Excel). */
function parseCoordLoose(...values) {
  for (const v of values) {
    const n = parseCoord(v);
    if (n != null) return n;
  }
  return null;
}

/** Se lat/lng parecerem trocados (comum em planilhas), corrige. */
function normalizeLatLngPair(lat, lng) {
  if (lat == null || lng == null) return { latitude: lat, longitude: lng, swapped: false };
  // Brasil: lat ≈ -35..5 , lng ≈ -75..-30
  const latOk = lat >= -35 && lat <= 6;
  const lngOk = lng >= -75 && lng <= -30;
  if (latOk && lngOk) return { latitude: lat, longitude: lng, swapped: false };

  const swapLatOk = lng >= -35 && lng <= 6;
  const swapLngOk = lat >= -75 && lat <= -30;
  if ((!latOk || !lngOk) && swapLatOk && swapLngOk) {
    return { latitude: lng, longitude: lat, swapped: true };
  }
  return { latitude: lat, longitude: lng, swapped: false };
}

function parseNullableBigInt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const s = String(value).trim().replace(/[^\d-]/g, '');
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function excelSerialToDate(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  // Excel epoch 1899-12-30
  const utc = Date.UTC(1899, 11, 30) + Math.round(serial * 86400000);
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return excelSerialToDate(value);
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const br = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (br) {
    const day = br[1].padStart(2, '0');
    const month = br[2].padStart(2, '0');
    let year = br[3];
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}`;
  }
  return null;
}

function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const totalSeconds = Math.round((value % 1) * 86400);
    const hh = String(Math.floor(totalSeconds / 3600) % 24).padStart(2, '0');
    const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const ss = String(totalSeconds % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}${m[3] ? `:${m[3]}` : ':00'}`;
}

function cellText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

export function parseMduExcelBuffer(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('O arquivo Excel não contém planilhas.');
  }
  const worksheet = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');

  // Mapear campo → índice da coluna (mais confiável que sheet_to_json)
  const headerByCol = [];
  const headers = [];
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })];
    const headerValue = cell ? String(cell.v ?? cell.w ?? '').trim() : '';
    headerByCol[col] = headerValue;
    if (headerValue) headers.push(headerValue);
  }

  const headerMap = buildHeaderMap(headers);
  const fieldToCol = {};
  for (const [field, rawHeader] of Object.entries(headerMap)) {
    const colIdx = headerByCol.findIndex((h) => h === rawHeader);
    if (colIdx >= 0) fieldToCol[field] = colIdx;
  }

  // Fallback: achar colunas lat/lng por nome parcial se alias não bateu
  if (fieldToCol.latitude == null) {
    const col = headerByCol.findIndex((h) => /lat/i.test(normalizeHeaderKey(h)) && !/placa|relat/i.test(h));
    if (col >= 0) fieldToCol.latitude = col;
  }
  if (fieldToCol.longitude == null) {
    const col = headerByCol.findIndex((h) => /long|lng|lon/i.test(normalizeHeaderKey(h)));
    if (col >= 0) fieldToCol.longitude = col;
  }

  const missingCols = [];
  if (!headerMap.descricao && !headerMap.id_mdu && fieldToCol.descricao == null && fieldToCol.id_mdu == null) {
    missingCols.push('descricao (ou ID MDU)');
  }
  if (missingCols.length) {
    throw new Error(
      `Colunas insuficientes na planilha MDU. Faltando: ${missingCols.join(', ')}. ` +
        `Cabeçalhos encontrados: ${headers.join(', ') || '(nenhum)'}`
    );
  }

  const readCell = (rowIdx, field) => {
    const col = fieldToCol[field];
    if (col == null) return { v: '', w: '' };
    const cell = worksheet[XLSX.utils.encode_cell({ r: rowIdx, c: col })];
    if (!cell) return { v: '', w: '' };
    return { v: cell.v ?? '', w: cell.w ?? '' };
  };

  const records = [];
  const seenKeys = new Set();
  let skippedDuplicates = 0;
  let skippedEmpty = 0;
  let withCoordinates = 0;
  let coordsFixed = 0;
  let coordsSwapped = 0;
  const sampleRawCoords = [];

  for (let rowIdx = range.s.r + 1; rowIdx <= range.e.r; rowIdx++) {
    const latCell = readCell(rowIdx, 'latitude');
    const lngCell = readCell(rowIdx, 'longitude');
    let latitude = parseCoordLoose(latCell.v, latCell.w);
    let longitude = parseCoordLoose(lngCell.v, lngCell.w);

    if (sampleRawCoords.length < 5 && (latCell.v !== '' || lngCell.v !== '' || latCell.w || lngCell.w)) {
      sampleRawCoords.push({
        row: rowIdx + 1,
        lat_v: latCell.v,
        lat_w: latCell.w,
        lng_v: lngCell.v,
        lng_w: lngCell.w,
        lat_parsed: latitude,
        lng_parsed: longitude
      });
    }

    const pair = normalizeLatLngPair(latitude, longitude);
    if (pair.swapped) {
      coordsSwapped += 1;
      coordsFixed += 1;
    }
    latitude = pair.latitude;
    longitude = pair.longitude;
    if (
      (latitude != null || longitude != null) &&
      (latitude !== parseCoordLoose(latCell.v, latCell.w) ||
        longitude !== parseCoordLoose(lngCell.v, lngCell.w) ||
        pair.swapped)
    ) {
      // contado acima no swap; se só parse salvou valor antes null, marca fix
      if (!pair.swapped && latitude != null && longitude != null) coordsFixed += 1;
    }

    const descricao =
      cellText(readCell(rowIdx, 'descricao').v) || cellText(readCell(rowIdx, 'descricao').w);
    const idMdu = parseNullableBigInt(readCell(rowIdx, 'id_mdu').v);
    const idEndereco = parseNullableBigInt(readCell(rowIdx, 'id_endereco').v);

    if (!descricao && idMdu == null && latitude == null && longitude == null) {
      // linha totalmente vazia?
      const tipo = cellText(readCell(rowIdx, 'tipo').v);
      const logradouro = cellText(readCell(rowIdx, 'nome_logradouro').v);
      if (!tipo && !logradouro) {
        skippedEmpty += 1;
        continue;
      }
    }

    const dedupeKey =
      idEndereco != null && idMdu != null
        ? `e:${idEndereco}|m:${idMdu}`
        : idMdu != null
          ? `m:${idMdu}|d:${descricao || ''}`
          : null;

    if (dedupeKey) {
      if (seenKeys.has(dedupeKey)) {
        skippedDuplicates += 1;
        continue;
      }
      seenKeys.add(dedupeKey);
    }

    if (latitude != null && longitude != null) withCoordinates += 1;

    const dataCadastro =
      parseDate(readCell(rowIdx, 'data_cadastro').v) ||
      parseDate(readCell(rowIdx, 'data_cadastro').w);
    const horaCadastro =
      parseTime(readCell(rowIdx, 'hora_cadastro').v) ||
      parseTime(readCell(rowIdx, 'hora_cadastro').w);
    let cadastradoEm = null;
    if (dataCadastro) {
      cadastradoEm = `${dataCadastro}T${horaCadastro || '00:00:00'}`;
    }

    records.push({
      id_endereco: idEndereco,
      id_mdu: idMdu,
      controle_mdu: parseNullableBigInt(readCell(rowIdx, 'controle_mdu').v),
      descricao,
      tipo: cellText(readCell(rowIdx, 'tipo').v) || cellText(readCell(rowIdx, 'tipo').w),
      numero: cellText(readCell(rowIdx, 'numero').v) || cellText(readCell(rowIdx, 'numero').w),
      complemento:
        cellText(readCell(rowIdx, 'complemento').v) || cellText(readCell(rowIdx, 'complemento').w),
      bairro: cellText(readCell(rowIdx, 'bairro').v) || cellText(readCell(rowIdx, 'bairro').w),
      nome_logradouro:
        cellText(readCell(rowIdx, 'nome_logradouro').v) ||
        cellText(readCell(rowIdx, 'nome_logradouro').w),
      tipo_logradouro:
        cellText(readCell(rowIdx, 'tipo_logradouro').v) ||
        cellText(readCell(rowIdx, 'tipo_logradouro').w),
      id_cep: parseNullableBigInt(readCell(rowIdx, 'id_cep').v),
      cep: cellText(readCell(rowIdx, 'cep').v) || cellText(readCell(rowIdx, 'cep').w),
      nome_cidade:
        cellText(readCell(rowIdx, 'nome_cidade').v) || cellText(readCell(rowIdx, 'nome_cidade').w),
      estado: cellText(readCell(rowIdx, 'estado').v) || cellText(readCell(rowIdx, 'estado').w),
      latitude,
      longitude,
      data_cadastro: dataCadastro,
      hora_cadastro: horaCadastro,
      cadastrado_em: cadastradoEm
    });
  }

  if (!records.length) {
    throw new Error('Nenhum registro MDU válido encontrado na planilha.');
  }

  // Não bloqueia mais: ajusta o que der e o restante vai para geocode
  if (withCoordinates === 0) {
    console.warn(
      '⚠️ [MDU Upload] Nenhuma coordenada válida na planilha — seguirá com geocode por endereço.',
      { headers, sampleRawCoords, fieldToCol }
    );
  } else if (withCoordinates / records.length < 0.5) {
    console.warn(
      `⚠️ [MDU Upload] Só ${withCoordinates}/${records.length} com lat/lng — restante será geocodificado.`,
      { sampleRawCoords }
    );
  }

  return {
    headers,
    headerMap,
    fieldToCol,
    records,
    skippedDuplicates,
    skippedEmpty,
    totalRowsInSheet: Math.max(0, range.e.r - range.s.r),
    withCoordinates,
    coordsFixed,
    coordsSwapped,
    sampleRawCoords,
    needsGeocode: records.length - withCoordinates
  };
}

async function deleteAllMdu(client) {
  // Preferência: delete em massa
  try {
    const { error } = await buildDeleteQuery(client, 'condominios_mdu')();
    if (!error) return;
    console.warn('⚠️ [MDU Upload] delete em massa falhou, tentando por lotes:', error.message);
  } catch (err) {
    console.warn('⚠️ [MDU Upload] delete em massa exception:', err?.message || err);
  }

  let hasMore = true;
  while (hasMore) {
    const { data: batch, error: selErr } = await client
      .from('condominios_mdu')
      .select('id')
      .limit(1000);
    if (selErr) throw selErr;
    if (!batch?.length) break;
    const { error: delErr } = await client
      .from('condominios_mdu')
      .delete()
      .in(
        'id',
        batch.map((r) => r.id)
      );
    if (delErr) throw delErr;
    if (batch.length < 1000) hasMore = false;
  }
}

async function insertMduBatches(client, records, onProgress) {
  let inserted = 0;
  for (let i = 0; i < records.length; i += INSERT_BATCH_SIZE) {
    // Datas opcionais às vezes quebram o insert (tipos TIME/DATE do Excel) — mapa não depende delas
    const batch = records.slice(i, i + INSERT_BATCH_SIZE).map((row) => {
      const {
        data_cadastro,
        hora_cadastro,
        cadastrado_em,
        ...core
      } = row;
      const out = { ...core };
      if (data_cadastro) out.data_cadastro = data_cadastro;
      if (hora_cadastro && /^\d{2}:\d{2}:\d{2}$/.test(hora_cadastro)) out.hora_cadastro = hora_cadastro;
      if (cadastrado_em && /^\d{4}-\d{2}-\d{2}T/.test(cadastrado_em)) out.cadastrado_em = cadastrado_em;
      return out;
    });
    const { error } = await client.from('condominios_mdu').insert(batch);
    if (error) throw error;
    inserted += batch.length;
    if (onProgress) {
      onProgress({
        inserted,
        total: records.length,
        percent: Math.round((inserted / records.length) * 100)
      });
    }
  }
  return inserted;
}

function buildAddressQuery(row) {
  const tipoLog = String(row.tipo_logradouro || '').trim();
  const nomeLog = String(row.nome_logradouro || '').trim();
  const numero = String(row.numero || '').trim();
  const complemento = String(row.complemento || '').trim();
  const bairro = String(row.bairro || '').trim();
  const cidade = String(row.nome_cidade || '').trim();
  const estado = String(row.estado || '').trim();
  const cep = String(row.cep || '').trim();
  const descricao = String(row.descricao || '').trim();

  const logradouro = [tipoLog, nomeLog].filter(Boolean).join(' ').trim();
  const parts = [
    descricao,
    logradouro,
    numero && !/^s\.?\s*n\.?$/i.test(numero) ? numero : '',
    complemento,
    bairro,
    cidade,
    estado,
    cep ? `CEP ${cep}` : '',
    'Brasil'
  ]
    .map((p) => String(p || '').trim())
    .filter(Boolean);

  return parts.join(', ');
}

function scoreGeocodeResult(result) {
  const locType = result?.geometry?.location_type || '';
  if (locType === 'ROOFTOP') return 100;
  if (locType === 'RANGE_INTERPOLATED') return 80;
  if (locType === 'GEOMETRIC_CENTER') return 50;
  if (locType === 'APPROXIMATE') return 30;
  return 20;
}

async function geocodeAddress(query, { uf } = {}) {
  const key = getMapsApiKey();
  if (!key) {
    return { ok: false, reason: 'GOOGLE_MAPS_API_KEY não configurada' };
  }

  const components = ['country:BR'];
  if (uf) components.push(`administrative_area:${String(uf).trim()}`);

  const url = new URL(GEOCODE_URL);
  url.searchParams.set('address', query);
  url.searchParams.set('key', key);
  url.searchParams.set('language', 'pt-BR');
  url.searchParams.set('region', 'br');
  url.searchParams.set('components', components.join('|'));

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (data.status === 'ZERO_RESULTS') {
    return { ok: false, status: data.status, reason: 'ZERO_RESULTS' };
  }
  if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) {
    return {
      ok: false,
      status: data.status || 'ERROR',
      reason: data.error_message || data.status || 'Falha no geocode'
    };
  }

  const best = [...data.results].sort((a, b) => scoreGeocodeResult(b) - scoreGeocodeResult(a))[0];
  const lat = Number(best?.geometry?.location?.lat);
  const lng = Number(best?.geometry?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, status: data.status, reason: 'Sem lat/lng no resultado' };
  }

  return {
    ok: true,
    latitude: lat,
    longitude: lng,
    locationType: best?.geometry?.location_type || null
  };
}

export async function fetchMissingMduCoords(client, limit = 0) {
  const pageSize = 1000;
  const all = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    let query = client
      .from('condominios_mdu')
      .select(
        'id,id_endereco,id_mdu,descricao,tipo,numero,complemento,bairro,nome_logradouro,tipo_logradouro,cep,nome_cidade,estado,latitude,longitude'
      )
      .or('latitude.is.null,longitude.is.null')
      .order('id', { ascending: true })
      .range(from, to);

    const { data, error } = await query;
    if (error) throw error;
    const chunk = data || [];
    all.push(...chunk);

    if (limit > 0 && all.length >= limit) {
      return all.slice(0, limit);
    }
    if (chunk.length < pageSize) break;
    from += pageSize;
    // Segurança: não carregar mais de 50k em memória num request
    if (all.length >= 50000) break;
  }

  return all;
}

export async function geocodeMissingMduRows(client, { delayMs = GEOCODE_DELAY_MS, onProgress } = {}) {
  const rows = await fetchMissingMduCoords(client);
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const query = buildAddressQuery(row);

    if (!query || query.length < 8) {
      fail += 1;
    } else {
      try {
        const geo = await geocodeAddress(query, { uf: row.estado });
        if (!geo.ok) {
          fail += 1;
        } else {
          const { error } = await client
            .from('condominios_mdu')
            .update({ latitude: geo.latitude, longitude: geo.longitude })
            .eq('id', row.id);
          if (error) throw error;
          ok += 1;
        }
      } catch {
        fail += 1;
      }
    }

    if (onProgress) {
      onProgress({
        processed: i + 1,
        total: rows.length,
        ok,
        fail,
        percent: rows.length ? Math.round(((i + 1) / rows.length) * 100) : 100
      });
    }

    if (i < rows.length - 1) await sleep(delayMs);
  }

  return { missing: rows.length, ok, fail };
}

/**
 * Substitui a base condominios_mdu e geocodifica faltantes.
 * @param {Buffer} fileBuffer
 * @param {{ onProgress?: Function }} options
 */
export async function replaceMduBaseFromExcel(fileBuffer, { onProgress } = {}) {
  const report = (patch) => {
    if (onProgress) onProgress(patch);
  };

  report({ stage: 'parsing', percent: 5, message: 'Lendo planilha Excel...' });
  const parsed = parseMduExcelBuffer(fileBuffer);

  report({
    stage: 'deleting',
    percent: 15,
    message:
      parsed.withCoordinates > 0
        ? `Planilha ok: ${parsed.records.length} registros (${parsed.withCoordinates} com coordenadas). Limpando base atual...`
        : `Planilha lida: ${parsed.records.length} registros sem lat/lng válidas — serão ajustadas via geocode. Limpando base atual...`,
    imported: 0,
    totalRows: parsed.records.length,
    withCoordinates: parsed.withCoordinates
  });

  await dualWrite(async (client, label) => {
    console.log(`🗑️ [MDU Upload][${label}] Limpando condominios_mdu...`);
    await deleteAllMdu(client);
  });

  report({
    stage: 'inserting',
    percent: 25,
    message: `Inserindo ${parsed.records.length} condomínio(s) MDU...`,
    totalRows: parsed.records.length,
    processedRows: 0
  });

  await dualWrite(async (client, label) => {
    console.log(`➕ [MDU Upload][${label}] Inserindo ${parsed.records.length} registros...`);
    await insertMduBatches(client, parsed.records, ({ inserted, total, percent }) => {
      // Progresso de insert: 25% → 70%
      const mapped = 25 + Math.round((percent / 100) * 45);
      report({
        stage: 'inserting',
        percent: mapped,
        message: `Inserindo ${inserted}/${total}...`,
        processedRows: inserted,
        totalRows: total,
        imported: inserted
      });
    });
  });

  const writeClients = getWriteClients();
  const primaryClient = writeClients[0]?.client;
  if (!primaryClient) {
    throw new Error('Cliente Supabase indisponível após insert');
  }

  const missingRows = await fetchMissingMduCoords(primaryClient);
  const missingCount = missingRows.length;

  report({
    stage: 'geocoding',
    percent: 72,
    message:
      missingCount > 0
        ? `Geocodificando ${missingCount} registro(s) sem lat/lng...`
        : 'Nenhum registro sem coordenadas. Finalizando...',
    missingBeforeGeocode: missingCount,
    geocodedOk: 0,
    geocodedFail: 0
  });

  let geoResult = { missing: missingCount, ok: 0, fail: 0 };
  if (missingCount > 0) {
    if (!getMapsApiKey()) {
      report({
        stage: 'geocoding',
        percent: 90,
        message:
          `Importação ok, mas GOOGLE_MAPS_API_KEY não está configurada. ` +
          `${missingCount} registro(s) ficaram sem coordenadas.`,
        missingBeforeGeocode: missingCount,
        geocodedOk: 0,
        geocodedFail: missingCount
      });
      geoResult = { missing: missingCount, ok: 0, fail: missingCount, skippedNoKey: true };
    } else {
      report({
        stage: 'geocoding',
        percent: 72,
        message: `Ajustando coordenadas: geocodificando ${missingCount} registro(s)...`,
        missingBeforeGeocode: missingCount
      });
      geoResult = await geocodeMissingMduRows(primaryClient, {
        onProgress: ({ processed, total, ok, fail, percent }) => {
          const mapped = 72 + Math.round((percent / 100) * 25);
          report({
            stage: 'geocoding',
            percent: mapped,
            message: `Ajustando lat/lng ${processed}/${total} (ok: ${ok}, falhas: ${fail})...`,
            missingBeforeGeocode: missingCount,
            geocodedOk: ok,
            geocodedFail: fail,
            processedRows: processed,
            totalRows: total
          });
        }
      });
    }
  }

  const summary = {
    imported: parsed.records.length,
    withCoordinates: parsed.withCoordinates,
    coordsFixed: parsed.coordsFixed || 0,
    coordsSwapped: parsed.coordsSwapped || 0,
    skippedDuplicates: parsed.skippedDuplicates,
    skippedEmpty: parsed.skippedEmpty,
    totalRowsInSheet: parsed.totalRowsInSheet,
    missingBeforeGeocode: geoResult.missing,
    geocodedOk: geoResult.ok,
    geocodedFail: geoResult.fail,
    skippedGeocodeNoKey: Boolean(geoResult.skippedNoKey)
  };

  report({
    stage: 'completed',
    percent: 100,
    message: buildSuccessMessage(summary),
    ...summary
  });

  return summary;
}

export function buildSuccessMessage(summary) {
  const parts = [
    `${summary.imported} condomínio(s) MDU importado(s)`
  ];
  if (summary.withCoordinates != null) {
    parts.push(`${summary.withCoordinates} com lat/lng na planilha`);
  }
  if (summary.coordsSwapped) {
    parts.push(`${summary.coordsSwapped} lat/lng corrigidos (trocados)`);
  }
  if (summary.missingBeforeGeocode > 0) {
    parts.push(
      `${summary.geocodedOk} ajustado(s) por geocode`,
      `${summary.geocodedFail} sem coordenada`
    );
  } else {
    parts.push('todas as coordenadas ok');
  }
  if (summary.skippedGeocodeNoKey) {
    parts.push('(geocode pulado: API key ausente)');
  }
  return parts.join(' · ');
}

export { getMapsApiKey, buildAddressQuery };
