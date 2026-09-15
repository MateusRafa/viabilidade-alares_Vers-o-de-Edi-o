/**
 * Presença dos usuários da extensão com Sincronização ligada.
 * Persistida em disco (DATA_DIR) para sobreviver a restart e múltiplas réplicas
 * no mesmo volume.
 */
import fs from 'fs';
import path from 'path';

const ONLINE_TTL_MS = 120_000;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'portal-censup-sync-presence.json');

/** @type {Map<string, { usuario: string, lastSeen: number, source: string }>} */
const memory = new Map();
let rrIndex = 0;
let lastLoadAt = 0;

function normalizeUsuario(usuario) {
  return String(usuario || '').trim();
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const sessions = parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    const now = Date.now();
    memory.clear();
    for (const [key, entry] of Object.entries(sessions)) {
      const lastSeen = Number(entry?.lastSeen) || 0;
      const usuario = normalizeUsuario(entry?.usuario || key);
      if (!usuario || !lastSeen || now - lastSeen > ONLINE_TTL_MS) continue;
      memory.set(usuario.toLowerCase(), {
        usuario,
        lastSeen,
        source: String(entry?.source || 'extension-sync')
      });
    }
    lastLoadAt = now;
  } catch {
    /* ignore */
  }
}

function saveToDisk() {
  try {
    ensureDir();
    const sessions = {};
    for (const [key, entry] of memory.entries()) {
      sessions[key] = {
        usuario: entry.usuario,
        lastSeen: entry.lastSeen,
        source: entry.source
      };
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify({ sessions, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch (err) {
    console.warn('⚠️ [PortalCENSUP] Não gravou presença sync:', err?.message || err);
  }
}

function refreshFromDiskIfStale() {
  const now = Date.now();
  // Relê do disco com frequência para ver heartbeats de outras réplicas
  if (now - lastLoadAt > 2000) {
    loadFromDisk();
  }
}

// Carga inicial
loadFromDisk();

export function touchCensupSyncPresence(usuario, { source = 'extension-sync' } = {}) {
  refreshFromDiskIfStale();
  const nome = normalizeUsuario(usuario);
  if (!nome) return null;
  const entry = {
    usuario: nome,
    lastSeen: Date.now(),
    source: String(source || 'extension-sync')
  };
  memory.set(nome.toLowerCase(), entry);
  saveToDisk();
  return entry;
}

export function clearCensupSyncPresence(usuario) {
  refreshFromDiskIfStale();
  const nome = normalizeUsuario(usuario);
  if (!nome) return false;
  const ok = memory.delete(nome.toLowerCase());
  if (ok) saveToDisk();
  return ok;
}

export function listCensupSyncOnline({ ttlMs = ONLINE_TTL_MS } = {}) {
  refreshFromDiskIfStale();
  const now = Date.now();
  let changed = false;
  const online = [];
  for (const [key, entry] of memory.entries()) {
    if (!entry || now - entry.lastSeen > ttlMs) {
      memory.delete(key);
      changed = true;
      continue;
    }
    online.push({
      usuario: entry.usuario,
      lastSeen: new Date(entry.lastSeen).toISOString(),
      source: entry.source
    });
  }
  if (changed) saveToDisk();
  online.sort((a, b) => a.usuario.localeCompare(b.usuario, 'pt-BR'));
  return online;
}

/** Round-robin entre quem está online agora. Null se ninguém online. */
export function pickNextCensupSyncAssignee() {
  const online = listCensupSyncOnline();
  if (!online.length) return null;
  rrIndex = rrIndex % online.length;
  const chosen = online[rrIndex];
  rrIndex = (rrIndex + 1) % online.length;
  return chosen.usuario;
}

export function getCensupSyncPresenceTtlMs() {
  return ONLINE_TTL_MS;
}
