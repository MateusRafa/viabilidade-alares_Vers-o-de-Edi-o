/**
 * Presença dos usuários da extensão com Sincronização ligada.
 * Independente do /api/users/online da Viabilidade.
 */

const ONLINE_TTL_MS = 90_000;
/** @type {Map<string, { usuario: string, lastSeen: number, source: string }>} */
const sessions = new Map();
let rrIndex = 0;

function normalizeUsuario(usuario) {
  return String(usuario || '').trim();
}

export function touchCensupSyncPresence(usuario, { source = 'extension-sync' } = {}) {
  const nome = normalizeUsuario(usuario);
  if (!nome) return null;
  const entry = {
    usuario: nome,
    lastSeen: Date.now(),
    source: String(source || 'extension-sync')
  };
  sessions.set(nome.toLowerCase(), entry);
  return entry;
}

export function clearCensupSyncPresence(usuario) {
  const nome = normalizeUsuario(usuario);
  if (!nome) return false;
  return sessions.delete(nome.toLowerCase());
}

export function listCensupSyncOnline({ ttlMs = ONLINE_TTL_MS } = {}) {
  const now = Date.now();
  const online = [];
  for (const [key, entry] of sessions.entries()) {
    if (!entry || now - entry.lastSeen > ttlMs) {
      sessions.delete(key);
      continue;
    }
    online.push({
      usuario: entry.usuario,
      lastSeen: new Date(entry.lastSeen).toISOString(),
      source: entry.source
    });
  }
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
