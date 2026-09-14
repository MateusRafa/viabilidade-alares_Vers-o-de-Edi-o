import fs from 'fs';
import path from 'path';
import { isClusterEnabled } from './flags.js';

export const CLUSTER_MODES = ['primary', 'replica'];
export const DEFAULT_CLUSTER_MODE = 'primary';

let dataDir = null;
let cachedMode = null;

function resolveDataDir() {
  if (dataDir) return dataDir;
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getModeFilePath() {
  return path.join(resolveDataDir(), 'cluster-mode.json');
}

function normalizeMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  // Legado: "alternate" vira primary
  if (normalized === 'alternate') return 'primary';
  return CLUSTER_MODES.includes(normalized) ? normalized : null;
}

function readModeFromDisk() {
  // Arquivo gravado pelo admin tem prioridade (evita ficar travado em B2 por env)
  try {
    const filePath = getModeFilePath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const fromFile = normalizeMode(parsed?.mode);
      if (fromFile) return fromFile;
    }
  } catch {
    // segue para env / default
  }

  const envMode = normalizeMode(process.env.SUPABASE_CLUSTER_MODE);
  if (envMode) return envMode;

  return DEFAULT_CLUSTER_MODE;
}

/** Inicializa persistência do modo (chamar após DATA_DIR estar definido). */
export function initClusterMode(dir) {
  if (dir) dataDir = dir;
  cachedMode = readModeFromDisk();

  // Cluster off → só B1. Reseta arquivo/cache se ainda estiver em replica.
  if (!isClusterEnabled() && cachedMode !== 'primary') {
    try {
      setClusterMode('primary');
      console.log('🔹 [Cluster] Cluster desabilitado — modo forçado para primary (B1)');
    } catch (err) {
      cachedMode = 'primary';
      console.warn(
        '⚠️ [Cluster] Cluster off, mas não gravou primary no disco:',
        err?.message || err
      );
    }
  }

  console.log(`🔹 [Cluster] Modo admin: ${cachedMode}`);
}

export function getClusterMode() {
  if (!cachedMode) cachedMode = readModeFromDisk();
  // Com cluster desligado, leituras/gravações e a UI tratam como B1
  if (!isClusterEnabled()) return 'primary';
  return cachedMode;
}

export function setClusterMode(mode) {
  const normalized = normalizeMode(mode);
  if (!normalized) {
    throw new Error(`Modo inválido: ${mode}. Use: ${CLUSTER_MODES.join(', ')}`);
  }

  const dir = resolveDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload = {
    mode: normalized,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(getModeFilePath(), JSON.stringify(payload, null, 2), 'utf8');
  cachedMode = normalized;
  console.log(`✅ [Cluster] Modo alterado para: ${normalized}`);
  return payload;
}

export function getClusterModeInfo() {
  return {
    mode: getClusterMode(),
    availableModes: CLUSTER_MODES,
    defaultMode: DEFAULT_CLUSTER_MODE,
    clusterEnabled: isClusterEnabled()
  };
}
