/**
 * Calcula a mancha de cobertura em blocos direto no banco (sem passar pelo Railway).
 * Por padrão gera uma PRÉVIA inativa — o mapa continua mostrando a mancha atual.
 *
 * Uso:
 *   node scripts/coverage-tiles-build.js b1              (prévia)
 *   node scripts/coverage-tiles-build.js b1 --publish    (calcula e ativa)
 *   node scripts/coverage-tiles-build.js b1 --concurrency=4
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const TARGETS = {
  b1: 'SUPABASE_REPLICA_DB_URL',
  b2: 'SUPABASE_DB_URL',
  b3: 'SUPABASE_B3_DB_URL'
};

const target = String(process.argv[2] || '').toLowerCase();
const publish = process.argv.includes('--publish');
const concArg = process.argv.find((a) => a.startsWith('--concurrency='));
const concurrency = concArg ? Math.max(1, Number(concArg.split('=')[1]) || 3) : 3;
const envKey = TARGETS[target];
if (!envKey || !process.env[envKey]) {
  console.error('Informe o destino (b1, b2 ou b3) e configure a URL do banco no .env');
  process.exit(1);
}
const dbUrl = process.env[envKey].trim();
const expectedRef = (new URL(dbUrl).hostname.match(/^db\.([a-z0-9]+)\./) || [])[1] || null;

const { createCoverageExecutor, buildCoverageTiles, activateTilesPolygon } = await import('../lib/coverageTiles.js');

const exec = await createCoverageExecutor({ dbUrl, expectedRef, concurrency });
try {
  const cfg = await exec.rows('get_active_ctos_dataset_id', {}, { timeoutMs: 30_000 }).catch(() => []);
  const datasetId = cfg[0]?.get_active_ctos_dataset_id || null;
  console.log(`Banco ${target} (${expectedRef}) — dataset ativo: ${datasetId || '(sem staging)'}`);

  const result = await buildCoverageTiles({
    exec,
    datasetId,
    options: { concurrency },
    onProgress: (p) => {
      process.stdout.write(
        `\r  ${p.percent}% | tarefas ${p.done}/${p.planned} | blocos ${p.tiles} | CTOs ${p.insideCtos}/${p.totalCtos} | divisões ${p.splits} | ${(p.elapsedMs / 1000).toFixed(0)}s   `
      );
    }
  });
  process.stdout.write('\n');
  console.log(JSON.stringify(result, null, 2));

  if (publish) {
    await activateTilesPolygon(exec, { polygonId: result.polygonId, datasetId });
    console.log(`Mancha #${result.polygonId} ativada.`);
  } else {
    console.log(`Prévia #${result.polygonId} criada (inativa). Publique pela API ou rode com --publish.`);
  }
} finally {
  await exec.close();
}
