/**
 * Staging + swap para CTOs + mancha (zero downtime na leitura).
 *
 * - Leituras → dataset active
 * - Upload → grava em dataset staging (não mexe no active)
 * - Após mancha no staging → swap_active_ctos_dataset
 */
import { isSupabaseAvailable } from '../supabase.js';

const CONFIG_KEY = 'active_ctos_coverage_dataset';

let featureCache = { checkedAt: 0, enabled: false };

/** Detecta se a migration de datasets foi aplicada. */
export async function isDatasetStagingEnabled(client) {
  if (!client) return false;
  const now = Date.now();
  if (now - featureCache.checkedAt < 60_000) return featureCache.enabled;

  try {
    const { error } = await client.from('data_datasets').select('id').limit(1);
    featureCache = {
      checkedAt: now,
      enabled: !error || !/does not exist|PGRST/i.test(error.message || '')
    };
    if (error && /does not exist/i.test(error.message || '')) {
      featureCache.enabled = false;
    } else if (!error) {
      featureCache.enabled = true;
    } else if (error.code === 'PGRST116') {
      featureCache.enabled = true;
    } else if (error.code === '42P01') {
      featureCache.enabled = false;
    } else {
      // tabela existe mas vazia / RLS etc.
      featureCache.enabled = !/relation .* does not exist/i.test(error.message || '');
    }
  } catch (err) {
    featureCache = { checkedAt: now, enabled: false };
    console.warn('⚠️ [Datasets] feature check:', err.message);
  }
  return featureCache.enabled;
}

export function invalidateDatasetFeatureCache() {
  featureCache = { checkedAt: 0, enabled: false };
}

export async function getActiveDatasetId(client) {
  if (!(await isDatasetStagingEnabled(client))) return null;

  const { data, error } = await client
    .from('app_runtime_config')
    .select('value_uuid')
    .eq('key', CONFIG_KEY)
    .maybeSingle();

  if (error) throw new Error(`getActiveDatasetId: ${error.message}`);
  if (data?.value_uuid) return data.value_uuid;

  // Bootstrap via RPC se config vazia
  const { data: rpcId, error: rpcErr } = await client.rpc('get_active_ctos_dataset_id');
  if (rpcErr) throw new Error(`get_active_ctos_dataset_id: ${rpcErr.message}`);
  return rpcId || null;
}

export async function getStagingDataset(client) {
  if (!(await isDatasetStagingEnabled(client))) return null;

  const { data, error } = await client
    .from('data_datasets')
    .select('id, status, label, created_at, meta')
    .eq('kind', 'ctos_coverage')
    .eq('status', 'staging')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getStagingDataset: ${error.message}`);
  return data || null;
}

/**
 * Garante dataset active + backfill (caso migration não tenha preenchido).
 */
export async function ensureActiveDataset(client, { label = 'bootstrap-runtime' } = {}) {
  if (!(await isDatasetStagingEnabled(client))) return null;

  let activeId = null;
  try {
    activeId = await getActiveDatasetId(client);
  } catch (_) {
    activeId = null;
  }

  if (activeId) return activeId;

  const { data: created, error: createErr } = await client
    .from('data_datasets')
    .insert([{ status: 'active', label, activated_at: new Date().toISOString(), meta: { source: 'runtime_bootstrap' } }])
    .select('id')
    .single();

  if (createErr) throw new Error(`ensureActiveDataset create: ${createErr.message}`);
  activeId = created.id;

  const { error: cfgErr } = await client.from('app_runtime_config').upsert({
    key: CONFIG_KEY,
    value_uuid: activeId,
    updated_at: new Date().toISOString()
  });
  if (cfgErr) throw new Error(`ensureActiveDataset config: ${cfgErr.message}`);

  // Backfill best-effort
  await client.from('ctos').update({ dataset_id: activeId }).is('dataset_id', null);
  await client.from('coverage_polygons').update({ dataset_id: activeId }).is('dataset_id', null);

  console.log(`✅ [Datasets] Active bootstrap: ${activeId}`);
  return activeId;
}

/**
 * Cria novo staging; arquiva/falha stagings anteriores pendentes.
 */
export async function createStagingDataset(client, { label = null, meta = {} } = {}) {
  await ensureActiveDataset(client);

  const previous = await getStagingDataset(client);
  if (previous?.id) {
    await client
      .from('data_datasets')
      .update({ status: 'failed', meta: { ...(previous.meta || {}), replaced_at: new Date().toISOString() } })
      .eq('id', previous.id);
    // remove CTOs/polígonos do staging antigo para liberar espaço
    await client.from('ctos').delete().eq('dataset_id', previous.id);
    await client.from('coverage_polygons').delete().eq('dataset_id', previous.id);
  }

  const { data, error } = await client
    .from('data_datasets')
    .insert([
      {
        status: 'staging',
        label: label || `staging-${new Date().toISOString()}`,
        meta: { ...meta, created_by: 'upload-base' }
      }
    ])
    .select('id, status, label, created_at')
    .single();

  if (error) throw new Error(`createStagingDataset: ${error.message}`);
  console.log(`🆕 [Datasets] Staging criado: ${data.id}`);
  return data;
}

export async function markDatasetFailed(client, datasetId, reason) {
  if (!datasetId) return;
  await client
    .from('data_datasets')
    .update({
      status: 'failed',
      meta: { failed_at: new Date().toISOString(), reason: String(reason || '') }
    })
    .eq('id', datasetId);
}

export async function swapActiveDataset(client, stagingId) {
  const { data, error } = await client.rpc('swap_active_ctos_dataset', {
    p_new_dataset_id: stagingId
  });
  if (error) throw new Error(`swapActiveDataset: ${error.message}`);
  invalidateDatasetFeatureCache();
  console.log(`🔀 [Datasets] Swap OK → active=${data || stagingId}`);
  return data || stagingId;
}

/** Dataset alvo do cálculo de mancha: staging se existir com CTOs, senão active. */
export async function resolveCoverageTargetDataset(client) {
  const enabled = await isDatasetStagingEnabled(client);
  if (!enabled) return { enabled: false, datasetId: null, mode: 'legacy' };

  const staging = await getStagingDataset(client);
  if (staging?.id) {
    const { count, error } = await client
      .from('ctos')
      .select('id', { count: 'exact', head: true })
      .eq('dataset_id', staging.id);
    if (!error && (count || 0) > 0) {
      return { enabled: true, datasetId: staging.id, mode: 'staging', shouldSwap: true };
    }
  }

  const activeId = await ensureActiveDataset(client);
  return { enabled: true, datasetId: activeId, mode: 'active', shouldSwap: false };
}

/** Aplica filtro de dataset em query builder Supabase (no-op se id null). */
export function applyDatasetFilter(query, datasetId) {
  if (!datasetId) return query;
  return query.eq('dataset_id', datasetId);
}

export function resolvePgUrlForActiveWrite() {
  const api = (process.env.SUPABASE_URL || '').toLowerCase();
  const repApi = (process.env.SUPABASE_REPLICA_URL || '').toLowerCase();
  const dbPrimary = (process.env.SUPABASE_DB_URL || '').trim();
  const dbReplica = (process.env.SUPABASE_REPLICA_DB_URL || '').trim();
  const apiRef = (api.match(/https:\/\/([a-z0-9]+)\.supabase/) || [])[1];
  if (apiRef && dbReplica.includes(apiRef)) return dbReplica;
  if (apiRef && dbPrimary.includes(apiRef)) return dbPrimary;
  if (repApi && api && api === repApi && dbReplica) return dbReplica;
  return dbPrimary || dbReplica || null;
}

export async function countCtosForDataset(client, datasetId) {
  let q = client.from('ctos').select('id', { count: 'exact', head: true });
  if (datasetId) q = q.eq('dataset_id', datasetId);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

/**
 * Clona CTOs de um dataset para outro (sem PK id).
 * Preferência: Postgres direto; fallback: API em lotes.
 */
export async function cloneCtosBetweenDatasets(client, fromDatasetId, toDatasetId, { onProgress = null, pgUrl = null } = {}) {
  if (!fromDatasetId || !toDatasetId) {
    throw new Error('cloneCtosBetweenDatasets: from/to obrigatórios');
  }
  if (fromDatasetId === toDatasetId) return { cloned: 0 };

  const url = (pgUrl || process.env.SUPABASE_DB_URL || process.env.SUPABASE_REPLICA_DB_URL || '').trim();
  if (url) {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await c.connect();
    try {
      const colsRes = await c.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ctos'
          AND column_name NOT IN ('id')
        ORDER BY ordinal_position
      `);
      const cols = colsRes.rows.map((r) => r.column_name);
      if (!cols.includes('dataset_id')) {
        throw new Error('Coluna dataset_id ausente em ctos');
      }
      const selectCols = cols
        .map((col) => (col === 'dataset_id' ? '$1 AS dataset_id' : `"${col}"`))
        .join(', ');
      const insertCols = cols.map((col) => `"${col}"`).join(', ');
      const result = await c.query(
        `
        INSERT INTO public.ctos (${insertCols})
        SELECT ${selectCols}
        FROM public.ctos
        WHERE dataset_id = $2
        `,
        [toDatasetId, fromDatasetId]
      );
      const cloned = result.rowCount || 0;
      if (onProgress) onProgress({ cloned, total: cloned, percent: 100 });
      console.log(`✅ [Datasets] Clone PG: ${cloned} CTOs ${fromDatasetId} → ${toDatasetId}`);
      return { cloned, method: 'pg' };
    } finally {
      await c.end();
    }
  }

  // Fallback API
  let lastId = 0;
  let cloned = 0;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await client
      .from('ctos')
      .select('*')
      .eq('dataset_id', fromDatasetId)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(500);
    if (error) throw new Error(`clone API read: ${error.message}`);
    if (!data?.length) break;

    const rows = data.map((row) => {
      const copy = { ...row, dataset_id: toDatasetId };
      delete copy.id;
      return copy;
    });
    const { error: insErr } = await client.from('ctos').insert(rows);
    if (insErr) throw new Error(`clone API insert: ${insErr.message}`);

    cloned += rows.length;
    lastId = data[data.length - 1].id;
    hasMore = data.length === 500;
    if (onProgress) onProgress({ cloned, percent: null });
  }
  console.log(`✅ [Datasets] Clone API: ${cloned} CTOs ${fromDatasetId} → ${toDatasetId}`);
  return { cloned, method: 'api' };
}

export function assertDbAvailable() {
  if (!isSupabaseAvailable()) {
    throw new Error('Supabase não disponível');
  }
}
