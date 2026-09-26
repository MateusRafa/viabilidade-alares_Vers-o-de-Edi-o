import { getPortalCensupSupabase, isPortalCensupSupabaseAvailable } from './supabaseCensup.js';
import crypto from 'crypto';

const TABLE = 'chamados';

const CORE_KEYS = new Set([
  'id',
  'agendaCode',
  'pedido',
  'uf',
  'cidade',
  'sistema',
  'pdv',
  'motivo',
  'situacao',
  'dataSituacao',
  'endereco',
  'mapaCoords',
  'mapaReferencias',
  'origem',
  'agendaUrl',
  'filaStatus',
  'tabulacaoStatus',
  'tabulacaoFinal',
  'pdfPath',
  'createdAt',
  'updatedAt',
  'dataSituacaoLabel',
  'persistedToSupabase',
  'supabaseError'
]);

function parseDataSituacao(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const raw = String(value).trim();
  if (!raw) return null;

  const br = raw.match(
    /(\d{2})\/(\d{2})\/(\d{4})(?:,?\s*(\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (br) {
    const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = br;
    const date = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}-03:00`);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Campos que incham o JSONB (HTML/print e mapa base64) — não persistir. */
const HEAVY_EXTRAS_KEYS = ['pdfHtml', 'mapPreviewImage', 'previewImage'];

/**
 * Remove HTML/print e imagens base64 antes de gravar no Supabase/JSON.
 * Mantém metadados do relatório (tabulação, endereço, CTOs, etc.).
 */
export function stripHeavyPersistFields(chamado) {
  if (!chamado || typeof chamado !== 'object') return chamado;
  const next = { ...chamado };
  for (const key of HEAVY_EXTRAS_KEYS) {
    delete next[key];
  }
  if (next.relatorio && typeof next.relatorio === 'object') {
    const rel = { ...next.relatorio };
    for (const key of HEAVY_EXTRAS_KEYS) {
      delete rel[key];
    }
    next.relatorio = rel;
  }
  return next;
}

export function chamadoToRow(chamado) {
  const light = stripHeavyPersistFields(chamado);
  const extras = {};
  for (const [key, value] of Object.entries(light || {})) {
    if (!CORE_KEYS.has(key) && value !== undefined) extras[key] = value;
  }

  const clean = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || /^null$/i.test(s) || /^undefined$/i.test(s)) return null;
    return s;
  };

  // Preserva texto BR da Agenda mesmo se data_situacao for gravado em ISO
  const rawAgenda =
    clean(light.dataSituacaoRaw) ||
    (typeof light.dataSituacao === 'string' && /\d{2}\/\d{2}\/\d{4}/.test(light.dataSituacao)
      ? clean(light.dataSituacao)
      : null);
  if (rawAgenda && !extras.dataSituacaoRaw) {
    extras.dataSituacaoRaw = rawAgenda;
  }

  return {
    id: light.id,
    agenda_code: clean(light.agendaCode),
    pedido: light.pedido != null ? String(light.pedido) : null,
    uf: clean(light.uf),
    cidade: clean(light.cidade),
    sistema: clean(light.sistema),
    pdv: clean(light.pdv),
    motivo: clean(light.motivo),
    situacao: clean(light.situacao),
    data_situacao: parseDataSituacao(light.dataSituacao || rawAgenda),
    endereco: light.endereco && typeof light.endereco === 'object' ? light.endereco : {},
    mapa_coords: light.mapaCoords || null,
    mapa_referencias: Array.isArray(light.mapaReferencias) ? light.mapaReferencias : [],
    origem: light.origem || 'extensao',
    agenda_url: light.agendaUrl || null,
    fila_status: light.filaStatus || 'na_fila',
    tabulacao_status: light.tabulacaoStatus || 'aguardando_analise',
    tabulacao_final: clean(light.tabulacaoFinal),
    pdf_path: light.pdfPath || null,
    extras,
    updated_at: new Date().toISOString(),
    created_at: light.createdAt || new Date().toISOString()
  };
}

export function rowToChamado(row) {
  if (!row) return null;
  const extras = row.extras && typeof row.extras === 'object' ? row.extras : {};
  return {
    ...extras,
    id: row.id,
    agendaCode: row.agenda_code,
    pedido: row.pedido,
    uf: row.uf,
    cidade: row.cidade,
    sistema: row.sistema,
    pdv: row.pdv,
    motivo: row.motivo,
    situacao: row.situacao,
    dataSituacao: row.data_situacao,
    endereco: row.endereco || {},
    mapaCoords: row.mapa_coords,
    mapaReferencias: row.mapa_referencias || [],
    origem: row.origem,
    agendaUrl: row.agenda_url,
    filaStatus: row.fila_status,
    tabulacaoStatus: row.tabulacao_status,
    tabulacaoFinal: row.tabulacao_final,
    pdfPath: row.pdf_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Remove HTML/print/base64 da listagem — evita 502 por payload gigante. */
export function stripHeavyChamadoFields(chamado, { keepFlags = true } = {}) {
  if (!chamado || typeof chamado !== 'object') return chamado;
  const next = { ...chamado };
  const hadPdf = typeof next.pdfHtml === 'string' && next.pdfHtml.trim().length > 0;
  const hadPreview =
    typeof next.mapPreviewImage === 'string' && next.mapPreviewImage.trim().length > 0;

  delete next.pdfHtml;
  delete next.mapPreviewImage;
  delete next.previewImage;

  if (next.relatorio && typeof next.relatorio === 'object') {
    const rel = { ...next.relatorio };
    delete rel.mapPreviewImage;
    delete rel.previewImage;
    delete rel.pdfHtml;
    next.relatorio = rel;
  }

  if (keepFlags) {
    if (hadPdf || next.relatorioSalvo) next.relatorioSalvo = true;
    if (hadPdf) next.hasPdfHtml = true;
    if (hadPreview) next.hasMapPreview = true;
  }

  return next;
}

function client() {
  const supabaseCensup = getPortalCensupSupabase();
  if (!supabaseCensup) {
    const err = new Error('Cliente Supabase CENSUP indisponível');
    err.code = 'CENSUP_SUPABASE_UNAVAILABLE';
    throw err;
  }
  return supabaseCensup;
}

function throwIfError(error, action) {
  if (!error) return;
  const parts = [error.message || `Falha ao ${action} no Supabase CENSUP`];
  if (error.code) parts.push(`code=${error.code}`);
  if (error.details) parts.push(error.details);
  if (error.hint) parts.push(error.hint);
  const err = new Error(parts.join(' — '));
  err.cause = error;
  err.code = error.code;
  throw err;
}

export async function dbFindChamado({ id, pedido, agendaCode } = {}) {
  if (!isPortalCensupSupabaseAvailable()) return null;

  if (id && isUuid(id)) {
    const { data, error } = await client().from(TABLE).select('*').eq('id', id).maybeSingle();
    throwIfError(error, 'buscar chamado por id');
    if (data) return rowToChamado(data);
  }

  if (agendaCode) {
    const { data, error } = await client()
      .from(TABLE)
      .select('*')
      .eq('agenda_code', agendaCode)
      .maybeSingle();
    throwIfError(error, 'buscar chamado por agenda_code');
    if (data) return rowToChamado(data);
  }

  const pedidoKey = pedido || (id && !isUuid(id) ? id : null);
  if (pedidoKey) {
    const { data, error } = await client()
      .from(TABLE)
      .select('*')
      .eq('pedido', String(pedidoKey))
      .maybeSingle();
    throwIfError(error, 'buscar chamado por pedido');
    if (data) return rowToChamado(data);
  }

  return null;
}

export async function dbListAllChamados() {
  if (!isPortalCensupSupabaseAvailable()) return [];

  const { data, error } = await client()
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false });
  throwIfError(error, 'listar todos os chamados');
  return (data || []).map((row) => stripHeavyChamadoFields(rowToChamado(row)));
}

export async function dbListChamadosNaFila({ q = '', page = 1, limit = 10, filaStatus = 'na_fila' } = {}) {
  if (!isPortalCensupSupabaseAvailable()) return null;

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const from = (safePage - 1) * safeLimit;
  const to = from + safeLimit - 1;
  const query = (q || '').trim();
  const status = filaStatus === 'finalizada' ? 'finalizada' : 'na_fila';

  // Sem extras completos: pdfHtml em JSONB derruba a API.
  // Puxa só chaves leves para Data Situação (Agenda) e SALVO EM.
  let builder = client()
    .from(TABLE)
    .select(
      [
        'id',
        'agenda_code',
        'pedido',
        'uf',
        'cidade',
        'sistema',
        'pdv',
        'motivo',
        'situacao',
        'data_situacao',
        'endereco',
        'mapa_coords',
        'mapa_referencias',
        'origem',
        'agenda_url',
        'fila_status',
        'tabulacao_status',
        'tabulacao_final',
        'pdf_path',
        'created_at',
        'updated_at',
        'dataSituacaoRaw:extras->>dataSituacaoRaw',
        'relatorioSalvoAt:extras->>relatorioSalvoAt',
        'geradoEm:extras->>geradoEm',
        'relatorioSavedAt:extras->relatorio->>savedAt'
      ].join(', '),
      { count: 'exact' }
    )
    .eq('fila_status', status)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (query) {
    const like = `%${query}%`;
    builder = builder.or(
      [
        `pedido.ilike.${like}`,
        `cidade.ilike.${like}`,
        `uf.ilike.${like}`,
        `sistema.ilike.${like}`,
        `pdv.ilike.${like}`,
        `motivo.ilike.${like}`,
        `situacao.ilike.${like}`,
        `tabulacao_final.ilike.${like}`
      ].join(',')
    );
  }

  const { data, error, count } = await builder;
  throwIfError(error, 'listar fila');

  const chamados = (data || []).map((row) => {
    const {
      dataSituacaoRaw,
      relatorioSalvoAt,
      geradoEm,
      relatorioSavedAt,
      ...coreRow
    } = row || {};
    const item = stripHeavyChamadoFields(rowToChamado({ ...coreRow, extras: {} }));

    if (dataSituacaoRaw) item.dataSituacaoRaw = dataSituacaoRaw;
    if (!item.dataSituacao && dataSituacaoRaw) {
      item.dataSituacao = parseDataSituacao(dataSituacaoRaw) || dataSituacaoRaw;
    }
    if (relatorioSalvoAt) item.relatorioSalvoAt = relatorioSalvoAt;
    if (geradoEm) item.geradoEm = geradoEm;
    if (relatorioSavedAt) {
      item.relatorio = { ...(item.relatorio || {}), savedAt: relatorioSavedAt };
    }

    // Lista de finalizados = relatório salvo (extras pesados não vêm neste select)
    if (item.filaStatus === 'finalizada') {
      item.relatorioSalvo = true;
    }
    return item;
  });

  return {
    chamados,
    total: count || 0,
    page: safePage,
    limit: safeLimit
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

export async function dbReconcileChamadosComAgenda(activePedidos = new Set(), situacaoMap = new Map()) {
  if (!isPortalCensupSupabaseAvailable()) return { updated: 0, situacoesAtualizadas: 0 };

  const activeSet =
    activePedidos instanceof Set
      ? activePedidos
      : new Set(
          (activePedidos || []).map((pedido) => String(pedido || '').trim()).filter(Boolean)
        );

  const { data, error } = await client()
    .from(TABLE)
    .select('id, pedido, fila_status, situacao')
    .eq('fila_status', 'na_fila');
  throwIfError(error, 'listar chamados para reconciliação com Agenda');

  const toArchive = (data || []).filter((row) => {
    const pedido = String(row.pedido || '').trim();
    return pedido && !activeSet.has(pedido);
  });

  let updated = 0;
  if (toArchive.length) {
    const ids = toArchive.map((row) => row.id);
    const now = new Date().toISOString();
    const { error: updateError } = await client()
      .from(TABLE)
      .update({ fila_status: 'executada_agenda', updated_at: now })
      .eq('fila_status', 'na_fila')
      .in('id', ids);
    throwIfError(updateError, 'arquivar chamados executados na Agenda');

    console.log(`✅ [PortalCENSUP][Supabase] ${ids.length} chamado(s) arquivado(s) — executados na Agenda.`);
    updated = ids.length;
  }

  // Atualizar situação dos chamados ativos cuja situação mudou na Agenda
  let situacoesAtualizadas = 0;
  if (situacaoMap.size > 0) {
    const now = new Date().toISOString();
    for (const row of (data || [])) {
      const pedido = String(row.pedido || '').trim();
      if (!pedido || !situacaoMap.has(pedido)) continue;
      const novaSituacao = situacaoMap.get(pedido);
      if (!novaSituacao || novaSituacao === (row.situacao || '')) continue;

      const { error: upErr } = await client()
        .from(TABLE)
        .update({ situacao: novaSituacao, updated_at: now })
        .eq('id', row.id);
      if (upErr) {
        console.warn(`⚠️ [PortalCENSUP][Supabase] Falha ao atualizar situação do pedido ${pedido}:`, upErr.message);
        continue;
      }
      situacoesAtualizadas += 1;
    }
    if (situacoesAtualizadas > 0) {
      console.log(`✅ [PortalCENSUP][Supabase] ${situacoesAtualizadas} situação(ões) atualizada(s) da Agenda.`);
    }
  }

  return { updated, situacoesAtualizadas };
}

let lastRestoreAt = 0;
const RESTORE_COOLDOWN_MS = 5 * 60 * 1000;

export async function dbRestoreChamadosSalvosArquivados() {
  if (!isPortalCensupSupabaseAvailable()) return { restored: 0 };

  const nowMs = Date.now();
  if (nowMs - lastRestoreAt < RESTORE_COOLDOWN_MS) {
    return { restored: 0, skipped: true };
  }
  lastRestoreAt = nowMs;

  // Só IDs — nunca baixar extras/pdfHtml (payload enorme → 502)
  const { data, error } = await client()
    .from(TABLE)
    .select('id')
    .eq('fila_status', 'executada_agenda')
    .or(
      [
        'extras->>relatorioSalvo.eq.true',
        'extras->pdfHtml.not.is.null',
        'extras->relatorio.not.is.null'
      ].join(',')
    );
  throwIfError(error, 'listar salvos arquivados por engano');

  const toRestore = data || [];
  if (!toRestore.length) return { restored: 0 };

  const ids = toRestore.map((row) => row.id);
  const now = new Date().toISOString();
  const { error: updateError } = await client()
    .from(TABLE)
    .update({ fila_status: 'finalizada', updated_at: now })
    .in('id', ids);
  throwIfError(updateError, 'restaurar chamados salvos no Portal');

  console.log(
    `✅ [PortalCENSUP][Supabase] ${ids.length} relatório(s) salvo(s) restaurado(s) para finalizada.`
  );
  return { restored: ids.length };
}

export async function dbUpsertChamado(chamado) {
  if (!isPortalCensupSupabaseAvailable()) return null;

  const existing = await dbFindChamado({
    id: isUuid(chamado.id) ? chamado.id : null,
    pedido: chamado.pedido,
    agendaCode: chamado.agendaCode
  });

  const id = existing?.id || (isUuid(chamado.id) ? chamado.id : crypto.randomUUID());
  const row = chamadoToRow({
    ...chamado,
    id,
    createdAt: existing?.createdAt || chamado.createdAt
  });
  if (!row.created_at) row.created_at = new Date().toISOString();

  if (existing) {
    const { id: _ignoreId, created_at: _ignoreCreated, ...patch } = row;
    const { data, error } = await client()
      .from(TABLE)
      .update(patch)
      .eq('id', existing.id)
      .select('*')
      .single();
    throwIfError(error, 'atualizar chamado');
    return rowToChamado(data);
  }

  const { data, error } = await client().from(TABLE).insert(row).select('*').single();
  throwIfError(error, 'inserir chamado');
  return rowToChamado(data);
}
