/**
 * Alinhamento da sequência VI ALA entre dois Supabases (B1 + B2).
 * Independente do antigo "cluster": se SUPABASE_REPLICA_* estiver configurado,
 * next/insert/list usam o MAIOR número entre os dois e gravam nos dois.
 */
import { createClient } from '@supabase/supabase-js';

function trimEnv(name) {
  return (process.env[name] || '').trim();
}

function maskUrl(url) {
  if (!url) return '(não configurado)';
  try {
    const host = new URL(url).hostname;
    return host.replace(/^([^.]+)/, (m) => `${m.slice(0, 4)}***`);
  } catch {
    return '(URL inválida)';
  }
}

function createServiceClient(url, serviceKey) {
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: 'public' }
  });
}

let localClient = null;
let peerClient = null;
let initDone = false;

function initClients() {
  if (initDone) return;
  initDone = true;

  const localUrl = trimEnv('SUPABASE_URL');
  const localKey = trimEnv('SUPABASE_SERVICE_KEY');
  const peerUrl = trimEnv('SUPABASE_REPLICA_URL');
  const peerKey = trimEnv('SUPABASE_REPLICA_SERVICE_KEY');

  localClient = createServiceClient(localUrl, localKey);

  if (peerUrl && peerUrl === localUrl) {
    console.warn('⚠️ [VI ALA dual] SUPABASE_REPLICA_URL igual a SUPABASE_URL — peer ignorado');
    peerClient = null;
  } else {
    peerClient = createServiceClient(peerUrl, peerKey);
  }

  if (localClient && peerClient) {
    console.log(
      `✅ [VI ALA dual] Sequência alinhada entre local=${maskUrl(localUrl)} e peer=${maskUrl(peerUrl)}`
    );
  } else if (localClient) {
    console.log(`ℹ️ [VI ALA dual] Só DB local (${maskUrl(localUrl)}) — configure SUPABASE_REPLICA_* para alinhar sequência`);
  }
}

/** Clients para next/insert/list: local (+ peer se configurado). */
export function getViAlaSyncClients() {
  initClients();
  const clients = [];
  if (localClient) clients.push({ label: 'local', client: localClient });
  if (peerClient) clients.push({ label: 'peer', client: peerClient });
  return clients;
}

export function isViAlaPeerConfigured() {
  initClients();
  return Boolean(localClient && peerClient);
}

export function parseVIALANumber(viAla) {
  if (!viAla || typeof viAla !== 'string') return 0;
  const match = viAla.match(/VI\s*ALA[-\s]*(\d+)/i);
  if (!match) return 0;
  const number = parseInt(match[1], 10);
  return Number.isFinite(number) ? number : 0;
}

export async function getMaxVIALANumberFromClient(client, label = 'supabase') {
  if (!client) return 0;

  try {
    const { data, error } = await client
      .from('vi_ala')
      .select('vi_ala')
      .order('vi_ala', { ascending: false })
      .limit(50);

    if (!error && data?.length) {
      let maxNumber = 0;
      for (const row of data) {
        maxNumber = Math.max(maxNumber, parseVIALANumber(row.vi_ala || ''));
      }
      if (maxNumber > 0) {
        console.log(`✅ [VI ALA/${label}] Max por vi_ala desc: ${maxNumber}`);
        return maxNumber;
      }
    }
  } catch (err) {
    console.warn(`⚠️ [VI ALA/${label}] Falha ao ordenar por vi_ala:`, err?.message || err);
  }

  try {
    const { data, error } = await client
      .from('vi_ala')
      .select('vi_ala')
      .order('id', { ascending: false })
      .limit(500);

    if (!error && data?.length) {
      let maxNumber = 0;
      for (const row of data) {
        maxNumber = Math.max(maxNumber, parseVIALANumber(row.vi_ala || ''));
      }
      console.log(`✅ [VI ALA/${label}] Max por id recente: ${maxNumber} (amostra ${data.length})`);
      return maxNumber;
    }
  } catch (err) {
    console.warn(`⚠️ [VI ALA/${label}] Falha ao buscar por id:`, err?.message || err);
  }

  return 0;
}

/** Próximo VI ALA = max(local, peer) + 1. */
export async function getNextVIALANumberUnified() {
  const clients = getViAlaSyncClients();
  if (!clients.length) return null;

  let maxNumber = 0;
  for (const { client, label } of clients) {
    const n = await getMaxVIALANumberFromClient(client, label);
    if (n > maxNumber) maxNumber = n;
  }

  const nextNumber = maxNumber + 1;
  const nextVIALA = `VI ALA-${String(nextNumber).padStart(7, '0')}`;
  console.log(
    `✅ [VI ALA dual] Próximo: ${nextVIALA} (max visto: ${maxNumber}, DBs: ${clients.map((c) => c.label).join('+')})`
  );
  return nextVIALA;
}

/**
 * Executa fn(client, label) em todos os clients de sync.
 * Exige pelo menos 1 sucesso; loga falhas parciais.
 */
export async function writeViAlaToAllClients(fn) {
  const clients = getViAlaSyncClients();
  if (!clients.length) {
    throw new Error('Nenhum cliente Supabase disponível para VI ALA');
  }

  const settled = await Promise.allSettled(
    clients.map(({ client, label }) => Promise.resolve(fn(client, label)))
  );

  const values = [];
  const failures = [];
  settled.forEach((result, i) => {
    const label = clients[i].label;
    if (result.status === 'fulfilled') {
      values.push({ label, value: result.value });
    } else {
      failures.push({ label, error: result.reason });
      console.error(`❌ [VI ALA] write ${label}:`, result.reason?.message || result.reason);
    }
  });

  if (values.length === 0) {
    const first = failures[0]?.error;
    throw first instanceof Error ? first : new Error(first?.message || 'Falha ao gravar VI ALA');
  }
  if (failures.length) {
    console.warn(
      `⚠️ [VI ALA] Gravado parcialmente (${values.map((v) => v.label).join(', ')}); falhas: ${failures
        .map((f) => f.label)
        .join(', ')}`
    );
  }
  return values;
}

