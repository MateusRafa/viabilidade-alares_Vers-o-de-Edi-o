/**
 * Espelho da fila da Agenda (scrape da extensão → app mobile).
 * Snapshot global: a Agenda é compartilhada; o último publish vence.
 * Inclui syncNextAt/pollSeconds para o app alinhar o countdown da extensão.
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'portal-censup-fila-espelho.json');

/** @type {{
 *  rows: object[],
 *  updatedAt: string|null,
 *  publishedBy: string,
 *  source: string,
 *  syncNextAt: string|null,
 *  pollSeconds: number,
 *  syncEnabled: boolean
 * }} */
let memory = {
  rows: [],
  updatedAt: null,
  publishedBy: '',
  source: '',
  syncNextAt: null,
  pollSeconds: 30,
  syncEnabled: false
};
let loaded = false;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    memory = {
      rows: Array.isArray(parsed?.rows) ? parsed.rows : [],
      updatedAt: parsed?.updatedAt || null,
      publishedBy: String(parsed?.publishedBy || ''),
      source: String(parsed?.source || ''),
      syncNextAt: parsed?.syncNextAt || null,
      pollSeconds: Math.max(5, Number(parsed?.pollSeconds) || 30),
      syncEnabled: parsed?.syncEnabled === true
    };
  } catch {
    /* ignore */
  }
}

function persist() {
  try {
    ensureDir();
    fs.writeFileSync(STORE_PATH, JSON.stringify(memory, null, 2), 'utf8');
  } catch (err) {
    console.warn('[PortalCENSUP] fila/espelho persist:', err?.message || err);
  }
}

function slimRow(row) {
  if (!row || typeof row !== 'object') return null;
  const pedido = String(row.pedido || '').trim();
  if (!pedido) return null;
  return {
    pedido,
    uf: String(row.uf || '').trim(),
    cidade: String(row.cidade || '').trim(),
    sistema: String(row.sistema || '').trim(),
    motivo: String(row.motivo || '').trim(),
    situacao: String(row.situacao || '').trim(),
    dataSituacaoRaw: String(row.dataSituacaoRaw || row.dataSituacao || '').trim(),
    pdv: String(row.pdv || '').trim(),
    usuarioFila: row.usuarioFila ? String(row.usuarioFila).trim() : '',
    filaAtribuidaEm: row.filaAtribuidaEm || null,
    liberadoPorAgenda: row.liberadoPorAgenda || null,
    emAnaliseOutro: row.emAnaliseOutro === true
  };
}

/**
 * Publica snapshot e/ou timing de sync da extensão.
 * Se `rows` não vier, mantém a fila anterior e só atualiza meta de sync.
 * `rows: []` só zera a fila com `confirmedEmpty: true` (anti-flicker).
 */
export function setFilaEspelho(payload = {}) {
  loadFromDisk();
  const hasRows = Array.isArray(payload.rows);
  const incoming = hasRows
    ? payload.rows.map(slimRow).filter(Boolean)
    : null;

  const replaceRows =
    hasRows && (incoming.length > 0 || payload.confirmedEmpty === true);

  const nextSync =
    payload.syncNextAt === undefined
      ? memory.syncNextAt
      : payload.syncNextAt
        ? String(payload.syncNextAt)
        : null;

  const pollSeconds =
    payload.pollSeconds != null
      ? Math.max(5, Number(payload.pollSeconds) || 30)
      : memory.pollSeconds;

  const syncEnabled =
    payload.syncEnabled === undefined
      ? memory.syncEnabled
      : payload.syncEnabled === true;

  memory = {
    rows: replaceRows ? incoming : memory.rows,
    updatedAt: replaceRows
      ? new Date().toISOString()
      : memory.updatedAt || new Date().toISOString(),
    publishedBy: String(payload.publishedBy || memory.publishedBy || '').trim(),
    source: String(payload.source || memory.source || 'extension').trim() || 'extension',
    syncNextAt: nextSync,
    pollSeconds,
    syncEnabled
  };
  persist();
  return {
    count: memory.rows.length,
    updatedAt: memory.updatedAt,
    publishedBy: memory.publishedBy,
    syncNextAt: memory.syncNextAt,
    pollSeconds: memory.pollSeconds,
    syncEnabled: memory.syncEnabled
  };
}

export function getFilaEspelho() {
  loadFromDisk();
  return {
    rows: memory.rows.slice(),
    updatedAt: memory.updatedAt,
    publishedBy: memory.publishedBy,
    source: memory.source,
    count: memory.rows.length,
    syncNextAt: memory.syncNextAt,
    pollSeconds: memory.pollSeconds,
    syncEnabled: memory.syncEnabled
  };
}
