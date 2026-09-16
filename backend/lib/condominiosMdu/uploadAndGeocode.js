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
    // Rejeitar serial de data/hora do Excel disfarçado de coordenada
    if (Math.abs(value) > 180) return null;
    return value;
  }

  let s = String(value).trim();
  if (!s) return null;

  // Remover lixo comum (aspas, grau, NBSP)
  s = s
    .replace(/\u00a0/g, '')
    .replace(/["'`°]/g, '')
    .replace(/\s+/g, '')
    .replace(/^[^\d+-]+/, '')
    .replace(/[^\dEe.+-]+$/g, '');

  if (!s) return null;

  // Notação científica
  if (/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || Math.abs(n) > 180) return null;
    return n;
  }

  // Formato BR: milhar com ponto e decimal com vírgula (−35.201.650,35)
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    // Só vírgula → decimal BR (−5,786723923)
    s = s.replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1) {
    // Vários pontos sem vírgula: se o último grupo tem 1–6 dígitos, tratar como decimal
    // ex.: -35.201.65035 → inválido; -35.20165035 com 1 ponto → ok já cai no ramo normal
    // ex. quebrado: -35.2168636.3 → null
    const parts = s.replace(/^-/, '').split('.');
    const last = parts[parts.length - 1];
    if (last.length <= 8 && parts.length === 2) {
      // na prática não entra aqui com length>1 de match
    } else if (parts.length > 2) {
      // Dois+ pontos: juntar milhares e usar último como decimal se fizer sentido
      if (last.length >= 1 && last.length <= 10) {
        const sign = s.startsWith('-') ? '-' : '';
        s = `${sign}${parts.slice(0, -1).join('')}.${last}`;
      } else {
        return null;
      }
    }
  }

  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
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
  const headers = [];
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: 0, c: col })];
    const headerValue = cell ? String(cell.v || '').trim() : '';
    if (headerValue) headers.push(headerValue);
  }

  const headerMap = buildHeaderMap(headers);
  const missingCols = [];
  if (!headerMap.descricao && !headerMap.id_mdu) {
    missingCols.push('descricao (ou ID MDU)');
  }
  if (!headerMap.latitude) missingCols.push('latitude');
  if (!headerMap.longitude) missingCols.push('longitude');
  if (missingCols.length) {
    throw new Error(
      `Colunas insuficientes na planilha MDU. Faltando: ${missingCols.join(', ')}. ` +
        `Cabeçalhos encontrados: ${headers.join(', ') || '(nenhum)'}`
    );
  }

  // raw = valor numérico da célula; formatted = texto exibido (útil p/ decimal BR)
  const rowsRaw = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: true });
  const rowsFmt = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });
  if (!rowsRaw.length) {
    throw new Error('O arquivo Excel está vazio ou não contém dados válidos.');
  }

  const records = [];
  const seenKeys = new Set();
  let skippedDuplicates = 0;
  let skippedEmpty = 0;
  let withCoordinates = 0;

  for (let idx = 0; idx < rowsRaw.length; idx++) {
    const row = rowsRaw[idx];
    const rowFmt = rowsFmt[idx] || {};
    const get = (field) => {
      const col = headerMap[field];
      if (!col) return '';
      return row[col];
    };
    const getFmt = (field) => {
      const col = headerMap[field];
      if (!col) return '';
      return rowFmt[col];
    };

    const descricao = cellText(get('descricao')) || cellText(getFmt('descricao'));
    const idMdu = parseNullableBigInt(get('id_mdu'));
    const idEndereco = parseNullableBigInt(get('id_endereco'));
    const latitude = parseCoordLoose(get('latitude'), getFmt('latitude'));
    const longitude = parseCoordLoose(get('longitude'), getFmt('longitude'));

    if (!descricao && idMdu == null && latitude == null && longitude == null) {
      skippedEmpty += 1;
      continue;
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

    const dataCadastro = parseDate(get('data_cadastro')) || parseDate(getFmt('data_cadastro'));
    const horaCadastro = parseTime(get('hora_cadastro')) || parseTime(getFmt('hora_cadastro'));
    let cadastradoEm = null;
    if (dataCadastro) {
      cadastradoEm = `${dataCadastro}T${horaCadastro || '00:00:00'}`;
    }

    records.push({
      id_endereco: idEndereco,
      id_mdu: idMdu,
      controle_mdu: parseNullableBigInt(get('controle_mdu')),
      descricao,
      tipo: cellText(get('tipo')) || cellText(getFmt('tipo')),
      numero: cellText(get('numero')) || cellText(getFmt('numero')),
      complemento: cellText(get('complemento')) || cellText(getFmt('complemento')),
      bairro: cellText(get('bairro')) || cellText(getFmt('bairro')),
      nome_logradouro: cellText(get('nome_logradouro')) || cellText(getFmt('nome_logradouro')),
      tipo_logradouro: cellText(get('tipo_logradouro')) || cellText(getFmt('tipo_logradouro')),
      id_cep: parseNullableBigInt(get('id_cep')),
      cep: cellText(get('cep')) || cellText(getFmt('cep')),
      nome_cidade: cellText(get('nome_cidade')) || cellText(getFmt('nome_cidade')),
      estado: cellText(get('estado')) || cellText(getFmt('estado')),
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

  const coordRatio = withCoordinates / records.length;
  if (withCoordinates === 0) {
    throw new Error(
      'Nenhuma linha com latitude/longitude válida na planilha. ' +
        'A base atual NÃO foi alterada. Verifique se as colunas latitude/longitude estão numéricas (use ponto decimal).'
    );
  }
  if (coordRatio < 0.5) {
    throw new Error(
      `Só ${withCoordinates} de ${records.length} linhas (${Math.round(coordRatio * 100)}%) têm lat/lng válidas. ` +
        'A base atual NÃO foi alterada. Corrija as coordenadas na planilha e tente de novo.'
    );
  }

  return {
    headers,
    headerMap,
    records,
    skippedDuplicates,
    skippedEmpty,
    totalRowsInSheet: rowsRaw.length,
    withCoordinates
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
    message: `Planilha ok: ${parsed.records.length} registros (${parsed.withCoordinates} com coordenadas). Limpando base atual...`,
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
  // Geocode só faltantes pontuais (ex.: < 500). Base grande sem coord = problema na planilha.
  const GEOCODE_MAX = 500;
  if (missingCount > 0) {
    if (missingCount > GEOCODE_MAX) {
      report({
        stage: 'geocoding',
        percent: 90,
        message:
          `Importação ok, mas ${missingCount} ficaram sem lat/lng (acima do limite de geocode automático ${GEOCODE_MAX}). ` +
          'Corrija a planilha ou rode o script geocode:condominios-mdu.',
        missingBeforeGeocode: missingCount,
        geocodedOk: 0,
        geocodedFail: missingCount
      });
      geoResult = { missing: missingCount, ok: 0, fail: missingCount, skippedTooMany: true };
    } else if (!getMapsApiKey()) {
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
      geoResult = await geocodeMissingMduRows(primaryClient, {
        onProgress: ({ processed, total, ok, fail, percent }) => {
          const mapped = 72 + Math.round((percent / 100) * 25);
          report({
            stage: 'geocoding',
            percent: mapped,
            message: `Geocodificando ${processed}/${total} (ok: ${ok}, falhas: ${fail})...`,
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
    skippedDuplicates: parsed.skippedDuplicates,
    skippedEmpty: parsed.skippedEmpty,
    totalRowsInSheet: parsed.totalRowsInSheet,
    missingBeforeGeocode: geoResult.missing,
    geocodedOk: geoResult.ok,
    geocodedFail: geoResult.fail,
    skippedGeocodeNoKey: Boolean(geoResult.skippedNoKey),
    skippedGeocodeTooMany: Boolean(geoResult.skippedTooMany)
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
  if (summary.missingBeforeGeocode > 0) {
    parts.push(
      `${summary.geocodedOk} geocodificado(s)`,
      `${summary.geocodedFail} sem coordenada`
    );
  } else {
    parts.push('todas as coordenadas já vinham na planilha');
  }
  if (summary.skippedGeocodeNoKey) {
    parts.push('(geocode pulado: API key ausente)');
  }
  if (summary.skippedGeocodeTooMany) {
    parts.push('(geocode automático limitado — use o script se precisar)');
  }
  return parts.join(' · ');
}

export { getMapsApiKey, buildAddressQuery };
