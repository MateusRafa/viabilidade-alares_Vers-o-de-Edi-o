/**
 * Tipos de chamado (motivo da Agenda) liberados para análise — por usuário.
 * Padrão = allowlist histórica; cada usuário liga/desliga os próprios tipos.
 * Tipos conhecidos são aprendidos da fila da Agenda (lista dinâmica).
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'portal-censup-motivos-usuario.json');

export const DEFAULT_MOTIVOS_LIBERADOS = [
  'analise de arrastadinhas',
  'analise de complemento',
  'analise de distancia',
  'similaridade de endereco'
];

const SEED_LABELS = [
  'Análise de Arrastadinhas',
  'Análise de Complemento',
  'Análise de Distância',
  'Similaridade de Endereço',
  'Unidade MDU'
];

let cache = null;
let cacheAt = 0;

export function normalizeMotivoKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizePersonKey(value) {
  return normalizeMotivoKey(value);
}

function isJunkMotivo(value) {
  const v = String(value || '').trim();
  if (!v) return true;
  if (/\?{2,}/.test(v)) return true;
  if (/^(null|undefined|n\/a|—|-)$/i.test(v)) return true;
  if (/^[\s?\-–—.,:]+$/i.test(v)) return true;
  return false;
}

function cleanLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function emptyStore() {
  const known = {};
  for (const label of SEED_LABELS) known[normalizeMotivoKey(label)] = label;
  return { known, users: {} };
}

function readStore() {
  const now = Date.now();
  if (cache && now - cacheAt < 2000) return cache;
  const base = emptyStore();
  try {
    if (fs.existsSync(STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      if (parsed?.known && typeof parsed.known === 'object') Object.assign(base.known, parsed.known);
      if (parsed?.users && typeof parsed.users === 'object') base.users = parsed.users;
    }
  } catch {
    /* ignore */
  }
  cache = base;
  cacheAt = now;
  return cache;
}

function writeStore(store) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({ ...store, updatedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
    cache = store;
    cacheAt = Date.now();
  } catch (err) {
    console.warn('⚠️ [PortalCENSUP] Não gravou tipos por usuário:', err?.message || err);
  }
}

function isDefaultLiberado(key) {
  return DEFAULT_MOTIVOS_LIBERADOS.some((ok) => key === ok || key.includes(ok));
}

function findOverride(overrides, key) {
  if (!overrides || !key) return undefined;
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  const hit = Object.keys(overrides).find((k) => k && key.includes(k));
  return hit ? overrides[hit] : undefined;
}

/** Aprende tipos novos vindos da fila da Agenda. */
export function registrarMotivosConhecidos(labels = []) {
  const store = readStore();
  let changed = false;
  for (const raw of labels || []) {
    if (isJunkMotivo(raw)) continue;
    const label = cleanLabel(raw);
    const key = normalizeMotivoKey(label);
    if (!key || store.known[key]) continue;
    store.known[key] = label;
    changed = true;
  }
  if (changed) writeStore(store);
  return changed;
}

export function isMotivoLiberadoParaUsuario(usuario, motivoRaw) {
  if (isJunkMotivo(motivoRaw)) return true;
  const key = normalizeMotivoKey(motivoRaw);
  if (!key) return true;
  const user = readStore().users[normalizePersonKey(usuario)];
  const override = findOverride(user?.overrides, key);
  if (typeof override === 'boolean') return override;
  return isDefaultLiberado(key);
}

export function getMotivosConfigUsuario(usuario) {
  const store = readStore();
  const user = store.users[normalizePersonKey(usuario)];
  const overrides = user?.overrides && typeof user.overrides === 'object' ? { ...user.overrides } : {};
  const tipos = Object.entries(store.known)
    .map(([key, label]) => {
      const padrao = isDefaultLiberado(key);
      const override = findOverride(overrides, key);
      return {
        key,
        label,
        padrao,
        liberado: typeof override === 'boolean' ? override : padrao
      };
    })
    .sort((a, b) => {
      if (a.padrao !== b.padrao) return a.padrao ? -1 : 1;
      return a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' });
    });
  return { overrides, defaults: DEFAULT_MOTIVOS_LIBERADOS, tipos };
}

/** Só o próprio usuário altera (a rota usa o usuário da requisição). */
export function setMotivoUsuario(usuario, motivoRaw, liberado) {
  const personKey = normalizePersonKey(usuario);
  const label = cleanLabel(motivoRaw);
  const key = normalizeMotivoKey(label);
  if (!personKey || !key || isJunkMotivo(label)) {
    const err = new Error('Usuário e tipo de chamado são obrigatórios');
    err.statusCode = 400;
    throw err;
  }
  const store = readStore();
  if (!store.known[key]) store.known[key] = label;
  const user = store.users[personKey] || { usuario: String(usuario).trim(), overrides: {} };
  user.usuario = String(usuario).trim();
  user.overrides = user.overrides && typeof user.overrides === 'object' ? user.overrides : {};
  if (liberado === isDefaultLiberado(key)) delete user.overrides[key];
  else user.overrides[key] = liberado === true;
  user.updatedAt = new Date().toISOString();
  store.users[personKey] = user;
  writeStore(store);
  return getMotivosConfigUsuario(usuario);
}
