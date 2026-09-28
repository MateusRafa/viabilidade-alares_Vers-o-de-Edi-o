/**
 * Mancha de cobertura em blocos (grade adaptativa).
 *
 * Cada bloco une só as CTOs próximas (CTOs do bloco + margem), simplifica e
 * recorta na borda do bloco. Nenhuma consulta monta um polígono único gigante,
 * então o tempo por chamada fica em milissegundos/poucos segundos.
 *
 * Executor: Postgres direto (sem limite de 8s do PostgREST) com fallback para
 * RPC via API. Blocos densos ou que estouram tempo são divididos em 4.
 */
import { resolvePgUrlForActiveWrite } from './ctoCoverageDatasets.js';

export const TILES_NOTES = 'tiles';

const DEFAULTS = {
  cellDeg: 0.05,
  splitThreshold: 3000,
  maxDepth: 4,
  concurrency: 3,
  radiusM: 250,
  marginM: 350,
  detailTol: 0.00001,
  displayTol: 0.0001,
  tileTimeoutMs: 60_000,
  planTimeoutMs: 120_000
};

const DEFAULT_POOLER_HOST = 'aws-0-sa-east-1.pooler.supabase.com';

// -----------------------------------------------------------------------------
// Erros
// -----------------------------------------------------------------------------

function errText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.message || err.details || err.hint || err.code || err);
}

export function isTimeoutError(err) {
  const code = err?.code;
  const msg = errText(err);
  return code === '57014' || /statement timeout|canceling statement due to/i.test(msg);
}

export function isTransientError(err) {
  const code = String(err?.code || '');
  const msg = errText(err);
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P03', '08006', '08003', '08001'].includes(code)) {
    return true;
  }
  return /<html|cloudflare|\b5\d\d\b|web server is down|bad gateway|gateway time|fetch failed|socket hang up|terminat|Connection terminated|network|ECONNRESET|timeout exceeded when trying to connect/i.test(
    msg
  );
}

/** Mensagem curta para a interface (nunca devolve HTML). */
export function shortCoverageError(err) {
  const msg = errText(err);
  if (/<html|cloudflare/i.test(msg)) {
    const m = msg.match(/\b(5\d\d)\b[^<]{0,40}/);
    return `Banco de dados indisponível no momento (${m ? m[0].replace(/\s+/g, ' ').trim() : 'erro Cloudflare'}). Tente novamente em alguns minutos.`;
  }
  if (isTimeoutError(err)) return 'Tempo limite do banco excedido ao calcular a mancha.';
  return msg.replace(/\s+/g, ' ').trim().slice(0, 240) || 'Erro desconhecido';
}

// -----------------------------------------------------------------------------
// Executores
// -----------------------------------------------------------------------------

function refFromSupabaseUrl(url) {
  return (String(url || '').toLowerCase().match(/https:\/\/([a-z0-9]+)\.supabase/) || [])[1] || null;
}

function refFromDbUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const hostRef = (host.match(/^db\.([a-z0-9]+)\.supabase\.co$/) || [])[1];
    if (hostRef) return hostRef;
    const userRef = (decodeURIComponent(u.username).match(/^postgres\.([a-z0-9]+)$/i) || [])[1];
    return userRef ? userRef.toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

function poolerConfigFromDirectUrl(directUrl) {
  const ref = refFromDbUrl(directUrl);
  if (!ref) return null;
  const u = new URL(directUrl);
  return {
    label: 'pooler',
    config: {
      host: (process.env.SUPABASE_POOLER_HOST || DEFAULT_POOLER_HOST).trim(),
      port: Number(process.env.SUPABASE_POOLER_PORT || 5432),
      user: `postgres.${ref}`,
      password: decodeURIComponent(u.password),
      database: (u.pathname || '/postgres').slice(1) || 'postgres',
      ssl: { rejectUnauthorized: false }
    },
    ref
  };
}

/**
 * Candidatos de conexão Postgres para o banco do SUPABASE_URL (ou o `dbUrl` informado).
 * Ordem: COVERAGE_PG_URL → URL direta → pooler derivado da URL direta.
 */
export function coveragePgCandidates({ dbUrl = null, expectedRef = null } = {}) {
  const ref = expectedRef || refFromSupabaseUrl(process.env.SUPABASE_URL) || null;
  const list = [];
  const push = (label, url) => {
    if (!url) return;
    const r = refFromDbUrl(url);
    if (ref && r && r !== ref) return;
    list.push({ label, config: { connectionString: url, ssl: { rejectUnauthorized: false } }, ref: r });
  };
  push('COVERAGE_PG_URL', (process.env.COVERAGE_PG_URL || '').trim());
  const direct = dbUrl || resolvePgUrlForActiveWrite();
  push('direct', direct);
  if (direct) {
    const pooler = poolerConfigFromDirectUrl(direct);
    if (pooler && (!ref || pooler.ref === ref)) list.push(pooler);
  }
  return list;
}

async function createPgExecutor(candidate, concurrency) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({
    ...candidate.config,
    max: concurrency + 1,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000
  });
  pool.on('error', () => {});
  const probe = await pool.connect();
  try {
    await probe.query('SELECT 1');
  } finally {
    probe.release();
  }

  async function run(sql, params, timeoutMs) {
    const client = await pool.connect();
    let broken = null;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(timeoutMs))}`);
      const r = await client.query(sql, params);
      await client.query('COMMIT');
      return r.rows;
    } catch (err) {
      broken = isTransientError(err) && !isTimeoutError(err) ? err : null;
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        broken = broken || err;
      }
      throw err;
    } finally {
      client.release(broken || undefined);
    }
  }

  const named = (args) => {
    const keys = Object.keys(args);
    return {
      list: keys.map((k, i) => `${k} => $${i + 1}`).join(', '),
      values: keys.map((k) => args[k])
    };
  };

  return {
    kind: 'pg',
    label: candidate.label,
    async scalar(fn, args, { timeoutMs }) {
      const { list, values } = named(args);
      const rows = await run(`SELECT public.${fn}(${list}) AS v`, values, timeoutMs);
      return rows[0]?.v ?? null;
    },
    async rows(fn, args, { timeoutMs }) {
      const { list, values } = named(args);
      return run(`SELECT * FROM public.${fn}(${list})`, values, timeoutMs);
    },
    async close() {
      await pool.end().catch(() => {});
    }
  };
}

export function createApiExecutor(supabase) {
  const call = async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) {
      const e = new Error(errText(error));
      e.code = error.code;
      throw e;
    }
    return data;
  };
  return {
    kind: 'api',
    label: 'api',
    async scalar(fn, args) {
      return call(fn, args);
    },
    async rows(fn, args) {
      const data = await call(fn, args);
      return Array.isArray(data) ? data : data ? [data] : [];
    },
    async close() {}
  };
}

/** Postgres direto quando possível; senão RPC via API. */
export async function createCoverageExecutor({ supabase = null, dbUrl = null, expectedRef = null, concurrency = DEFAULTS.concurrency, log = console.log } = {}) {
  for (const cand of coveragePgCandidates({ dbUrl, expectedRef })) {
    try {
      const ex = await createPgExecutor(cand, concurrency);
      log(`🧩 [Mancha blocos] Conexão Postgres: ${cand.label}`);
      return ex;
    } catch (err) {
      log(`⚠️ [Mancha blocos] Conexão ${cand.label} indisponível: ${shortCoverageError(err)}`);
    }
  }
  if (!supabase) throw new Error('Nenhuma conexão com o banco disponível para a mancha');
  log('🧩 [Mancha blocos] Usando RPC via API (sem conexão Postgres direta)');
  return createApiExecutor(supabase);
}

// -----------------------------------------------------------------------------
// Cálculo
// -----------------------------------------------------------------------------

const round9 = (v) => Math.round(v * 1e9) / 1e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function splitTask(task) {
  const midLng = round9((task.minLng + task.maxLng) / 2);
  const midLat = round9((task.minLat + task.maxLat) / 2);
  const q = [
    [task.minLng, task.minLat, midLng, midLat],
    [midLng, task.minLat, task.maxLng, midLat],
    [task.minLng, midLat, midLng, task.maxLat],
    [midLng, midLat, task.maxLng, task.maxLat]
  ];
  return q.map(([minLng, minLat, maxLng, maxLat], i) => ({
    key: `${task.key}.${i}`,
    minLng,
    minLat,
    maxLng,
    maxLat,
    depth: task.depth + 1,
    n: null
  }));
}

/**
 * Calcula uma mancha de blocos para o dataset e deixa o cabeçalho pronto (inativo).
 * Em caso de falha remove o cabeçalho parcial e relança o erro.
 */
export async function buildCoverageTiles({
  exec,
  datasetId,
  onProgress = null,
  shouldAbort = null,
  log = console.log,
  options = {}
}) {
  const o = { ...DEFAULTS, ...options };
  const apiMode = exec.kind === 'api';
  const tileTimeout = apiMode ? 8000 : o.tileTimeoutMs;
  const startedAt = Date.now();

  const withRetry = async (label, fn) => {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        attempt += 1;
        if (isTimeoutError(err) || !isTransientError(err) || attempt > 5) throw err;
        const wait = Math.min(30_000, 2000 * 2 ** (attempt - 1));
        log(`⏳ [Mancha blocos] ${label}: ${shortCoverageError(err)} — nova tentativa em ${wait / 1000}s (${attempt}/5)`);
        await sleep(wait);
      }
    }
  };

  const planText = await withRetry('planejamento', () =>
    exec.scalar('coverage_tiles_plan', { p_dataset_id: datasetId, p_cell_deg: o.cellDeg, p_margin_m: o.marginM }, { timeoutMs: o.planTimeoutMs })
  );
  const plan = typeof planText === 'string' ? JSON.parse(planText) : planText;
  const totalCtos = Number(plan?.total || 0);
  const cells = Array.isArray(plan?.cells) ? plan.cells : [];
  if (!totalCtos || !cells.length) throw new Error('Nenhuma CTO válida encontrada para calcular a mancha');

  const headerRows = await withRetry('cabeçalho', () =>
    exec.rows('coverage_tiles_create_header', { p_dataset_id: datasetId, p_total_ctos: totalCtos }, { timeoutMs: 30_000 })
  );
  const polygonId = Number(headerRows[0]?.polygon_id);
  const version = Number(headerRows[0]?.polygon_version);
  if (!polygonId) throw new Error('Falha ao criar o registro da mancha');
  log(`🧩 [Mancha blocos] Mancha #${polygonId} v${version}: ${totalCtos} CTOs, ${cells.length} células (${exec.label})`);

  const queue = cells.map(([gy, gx, n]) => ({
    key: `${gy}_${gx}`,
    minLng: round9(gx * o.cellDeg),
    minLat: round9(gy * o.cellDeg),
    maxLng: round9((gx + 1) * o.cellDeg),
    maxLat: round9((gy + 1) * o.cellDeg),
    depth: 0,
    n: Number(n)
  }));
  queue.sort((a, b) => b.n - a.n);

  const stats = { done: 0, planned: queue.length, tiles: 0, insideCtos: 0, areaKm2: 0, displayPoints: 0, splits: 0 };
  let lastReport = 0;
  const report = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < 1000) return;
    lastReport = now;
    onProgress({
      ...stats,
      polygonId,
      version,
      totalCtos,
      percent: Math.min(99, Math.round((stats.insideCtos / totalCtos) * 100)),
      elapsedMs: now - startedAt
    });
  };

  const countBox = (t) =>
    withRetry(`contagem ${t.key}`, () =>
      exec.scalar(
        'coverage_tiles_count_bbox',
        { p_dataset_id: datasetId, p_min_lng: t.minLng, p_min_lat: t.minLat, p_max_lng: t.maxLng, p_max_lat: t.maxLat, p_margin_m: o.marginM },
        { timeoutMs: tileTimeout }
      )
    );

  const splitAndQueue = async (task, withCounts) => {
    const children = splitTask(task);
    if (withCounts) {
      for (const ch of children) ch.n = Number(await countBox(ch));
    }
    stats.splits += 1;
    stats.planned += children.length - 1;
    queue.unshift(...children.filter((ch) => ch.n === null || ch.n > 0));
    stats.planned -= children.filter((ch) => ch.n === 0).length;
  };

  let fatal = null;

  const processTask = async (task) => {
    if (task.n === null) task.n = Number(await countBox(task));
    if (task.n === 0) {
      stats.done += 1;
      return;
    }
    if (task.n > o.splitThreshold && task.depth < o.maxDepth) {
      await splitAndQueue(task, true);
      return;
    }

    let timeouts = 0;
    for (;;) {
      try {
        const rows = await withRetry(`bloco ${task.key}`, () =>
          exec.rows(
            'coverage_tiles_compute',
            {
              p_polygon_id: polygonId,
              p_dataset_id: datasetId,
              p_tile_key: task.key,
              p_min_lng: task.minLng,
              p_min_lat: task.minLat,
              p_max_lng: task.maxLng,
              p_max_lat: task.maxLat,
              p_radius_m: o.radiusM,
              p_margin_m: o.marginM,
              p_detail_tol: o.detailTol,
              p_display_tol: o.displayTol
            },
            { timeoutMs: tileTimeout }
          )
        );
        const r = rows[0] || {};
        stats.insideCtos += Number(r.inside_ctos || 0);
        if (!r.is_empty) {
          stats.tiles += 1;
          stats.areaKm2 += Number(r.area_km2 || 0);
          stats.displayPoints += Number(r.display_points || 0);
        }
        stats.done += 1;
        return;
      } catch (err) {
        if (!isTimeoutError(err)) throw err;
        if (task.depth < o.maxDepth) {
          log(`✂️ [Mancha blocos] Bloco ${task.key} excedeu o tempo — dividindo em 4`);
          await splitAndQueue(task, false);
          return;
        }
        timeouts += 1;
        if (timeouts > 2) throw err;
      }
    }
  };

  const worker = async () => {
    while (!fatal) {
      if (shouldAbort && shouldAbort()) {
        fatal = new Error('Cálculo da mancha cancelado');
        return;
      }
      const task = queue.shift();
      if (!task) return;
      try {
        await processTask(task);
        report();
      } catch (err) {
        fatal = err;
        return;
      }
    }
  };

  try {
    // Workers terminam quando a fila esvazia; divisões podem reabastecer a fila,
    // então repete enquanto houver tarefas pendentes.
    while (queue.length && !fatal) {
      await Promise.all(Array.from({ length: o.concurrency }, () => worker()));
    }
    if (fatal) throw fatal;

    if (stats.insideCtos !== totalCtos) {
      throw new Error(`Verificação falhou: ${stats.insideCtos} de ${totalCtos} CTOs incluídas nos blocos`);
    }

    // Opcional: sem a geometria única o mapa desenha os blocos (mais pesado, mas correto)
    let merged = null;
    try {
      const rows = await withRetry('geometria de exibição', () =>
        exec.rows('coverage_tiles_build_display', { p_polygon_id: polygonId, p_tolerance: o.displayTol }, { timeoutMs: apiMode ? 8000 : 180_000 })
      );
      merged = rows[0] || null;
    } catch (err) {
      log(`⚠️ [Mancha blocos] Geometria única de exibição não gerada (mapa usará os blocos): ${shortCoverageError(err)}`);
    }

    const fin = await withRetry('finalização', () =>
      exec.rows('coverage_tiles_finalize_header', { p_polygon_id: polygonId, p_total_ctos: totalCtos }, { timeoutMs: 60_000 })
    );
    const f = fin[0] || {};
    const result = {
      polygonId,
      version,
      totalCtos,
      tiles: Number(f.tiles || stats.tiles),
      areaKm2: Number(f.area_km2 || stats.areaKm2),
      displayPoints: merged ? Number(merged.points) : Number(f.display_points || stats.displayPoints),
      displayParts: merged ? Number(merged.parts) : null,
      splits: stats.splits,
      elapsedMs: Date.now() - startedAt,
      executor: exec.label
    };
    report(true);
    log(
      `✅ [Mancha blocos] #${polygonId} pronta: ${result.tiles} blocos, ${result.areaKm2.toFixed(1)} km², ${result.displayPoints} pontos, ${(result.elapsedMs / 1000).toFixed(1)}s`
    );
    return result;
  } catch (err) {
    try {
      await exec.rows('coverage_tiles_delete_header', { p_polygon_id: polygonId }, { timeoutMs: 120_000 });
    } catch (delErr) {
      log(`⚠️ [Mancha blocos] Não foi possível remover a mancha parcial #${polygonId}: ${shortCoverageError(delErr)}`);
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Publicação
// -----------------------------------------------------------------------------

/** Ativa a mancha e remove outras manchas de blocos inativas do mesmo dataset. */
export async function activateTilesPolygon(exec, { polygonId, datasetId }) {
  await exec.scalar('coverage_activate_polygon', { p_polygon_id: polygonId }, { timeoutMs: 30_000 });
  try {
    await exec.scalar('coverage_tiles_delete_other_headers', { p_dataset_id: datasetId, p_keep_id: polygonId }, { timeoutMs: 120_000 });
  } catch (err) {
    console.warn('⚠️ [Mancha blocos] Limpeza de manchas antigas:', shortCoverageError(err));
  }
}
