/**
 * Espelho da fila da Agenda (scrape da extensão → app mobile).
 * Snapshot global: a Agenda é compartilhada; o último publish vence.
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'portal-censup-fila-espelho.json');

/** @type {{ rows: object[], updatedAt: string|null, publishedBy: string, source: string }} */
let memory = {
  rows: [],
  updatedAt: null,
  publishedBy: '',
  source: ''
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
      source: String(parsed?.source || '')
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
 * Publica o snapshot atual da Agenda (vindo da extensão).
 * @param {{ rows?: object[], publishedBy?: string, source?: string }} payload
 */
export function setFilaEspelho(payload = {}) {
  loadFromDisk();
  const rows = (Array.isArray(payload.rows) ? payload.rows : [])
    .map(slimRow)
    .filter(Boolean);

  memory = {
    rows,
    updatedAt: new Date().toISOString(),
    publishedBy: String(payload.publishedBy || '').trim(),
    source: String(payload.source || 'extension').trim() || 'extension'
  };
  persist();
  return {
    count: memory.rows.length,
    updatedAt: memory.updatedAt,
    publishedBy: memory.publishedBy
  };
}

export function getFilaEspelho() {
  loadFromDisk();
  return {
    rows: memory.rows.slice(),
    updatedAt: memory.updatedAt,
    publishedBy: memory.publishedBy,
    source: memory.source,
    count: memory.rows.length
  };
}
