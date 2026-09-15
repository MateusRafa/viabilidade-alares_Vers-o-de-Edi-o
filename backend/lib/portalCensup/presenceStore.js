/**
 * Presença dos usuários da extensão com Sincronização ligada.
 * Persistida em disco (DATA_DIR) para sobreviver a restart e múltiplas réplicas
 * no mesmo volume.
 *
 * Esteira: ordem = quem ficou online primeiro; empate = alfabético;
 * nunca o mesmo usuário duas vezes seguidas se houver 2+ online.
 */
import fs from 'fs';
import path from 'path';

const ONLINE_TTL_MS = 120_000;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'portal-censup-sync-presence.json');

/** @type {Map<string, { usuario: string, lastSeen: number, onlineSince: number, source: string }>} */
const memory = new Map();
/** Último usuário que recebeu chamado automático da esteira */
let lastEsteiraAssignee = null;
let lastLoadAt = 0;

function normalizeUsuario(usuario) {
  return String(usuario || '').trim();
}

function normalizePersonKey(value) {
  return normalizeUsuario(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
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
      const onlineSince = Number(entry?.onlineSince) || lastSeen;
      memory.set(usuario.toLowerCase(), {
        usuario,
        lastSeen,
        onlineSince,
        source: String(entry?.source || 'extension-sync')
      });
    }
    lastEsteiraAssignee = normalizeUsuario(parsed?.lastEsteiraAssignee) || null;
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
        onlineSince: entry.onlineSince,
        source: entry.source
      };
    }
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify(
        {
          sessions,
          lastEsteiraAssignee,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      ),
      'utf8'
    );
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
  const key = nome.toLowerCase();
  const prev = memory.get(key);
  const now = Date.now();
  const entry = {
    usuario: nome,
    lastSeen: now,
    // Mantém a ordem de chegada enquanto a sessão online não expira
    onlineSince: prev?.onlineSince || now,
    source: String(source || 'extension-sync')
  };
  memory.set(key, entry);
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

/**
 * Lista online ordenada pela esteira:
 * 1) quem ficou online primeiro
 * 2) empate → ordem alfabética do nome
 */
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
      onlineSince: entry.onlineSince || entry.lastSeen,
      source: entry.source
    });
  }
  if (changed) saveToDisk();
  online.sort((a, b) => {
    const ta = Number(a.onlineSince) || 0;
    const tb = Number(b.onlineSince) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.usuario).localeCompare(String(b.usuario), 'pt-BR', { sensitivity: 'base' });
  });
  return online;
}

export function getLastEsteiraAssignee() {
  refreshFromDiskIfStale();
  return lastEsteiraAssignee;
}

/** Atualiza o “último da esteira” (também em claim manual). */
export function setLastEsteiraAssignee(usuario) {
  refreshFromDiskIfStale();
  lastEsteiraAssignee = normalizeUsuario(usuario) || null;
  saveToDisk();
  return lastEsteiraAssignee;
}

/**
 * Próximo da esteira.
 * - Ordem: chegada online (depois alfabética)
 * - Com 2+ online: nunca o mesmo usuário duas vezes seguidas
 */
export function pickNextCensupSyncAssignee() {
  const online = listCensupSyncOnline();
  if (!online.length) return null;

  if (online.length === 1) {
    const only = online[0].usuario;
    lastEsteiraAssignee = only;
    saveToDisk();
    return only;
  }

  const lastKey = normalizePersonKey(lastEsteiraAssignee);
  let start = 0;
  if (lastKey) {
    const idx = online.findIndex((u) => normalizePersonKey(u.usuario) === lastKey);
    start = idx >= 0 ? (idx + 1) % online.length : 0;
  }

  // Garante que não repete o último se ainda estiver na lista
  let chosen = online[start];
  if (lastKey && normalizePersonKey(chosen.usuario) === lastKey) {
    chosen = online[(start + 1) % online.length];
  }

  lastEsteiraAssignee = chosen.usuario;
  saveToDisk();
  return chosen.usuario;
}

export function getCensupSyncPresenceTtlMs() {
  return ONLINE_TTL_MS;
}
