/**
 * Links de SharePoint usados por toda a equipe da extensão.
 * Quem deixa a caixa vazia recebe estes links. Quem salvou o próprio não é alterado.
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'portal-censup-sharepoint-links.json');

const EMPTY = {
  sharePointFolderUrl: '',
  sharePointBackupFolderUrl: '',
  updatedAt: 0,
  updatedBy: ''
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 2000) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return text;
  } catch {
    return '';
  }
}

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { ...EMPTY };
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      sharePointFolderUrl: normalizeUrl(parsed?.sharePointFolderUrl),
      sharePointBackupFolderUrl: normalizeUrl(parsed?.sharePointBackupFolderUrl),
      updatedAt: Number(parsed?.updatedAt) || 0,
      updatedBy: String(parsed?.updatedBy || '').trim()
    };
  } catch {
    return { ...EMPTY };
  }
}

function writeStore(data) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

export function getSharePointLinks() {
  const data = readStore();
  return {
    sharePointFolderUrl: data.sharePointFolderUrl,
    sharePointBackupFolderUrl: data.sharePointBackupFolderUrl,
    updatedAt: data.updatedAt,
    updatedBy: data.updatedBy
  };
}

/**
 * Só grava links http(s) não vazios. Caixa vazia não apaga o link da equipe.
 * @param {{ sharePointFolderUrl?: string, sharePointBackupFolderUrl?: string }} patch
 * @param {string} usuario
 */
export function publishSharePointLinks(patch = {}, usuario = '') {
  const current = readStore();
  const next = { ...current };
  for (const key of ['sharePointFolderUrl', 'sharePointBackupFolderUrl']) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const url = normalizeUrl(patch[key]);
    if (!url) continue;
    next[key] = url;
  }
  next.updatedAt = Date.now();
  next.updatedBy = String(usuario || '').trim();
  writeStore(next);
  return getSharePointLinks();
}
