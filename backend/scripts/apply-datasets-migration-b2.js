/**
 * Aplica migration de datasets no B2 (SUPABASE_DB_URL) de forma explícita.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  // last wins
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const url = (process.env.SUPABASE_DB_URL || '').trim();
if (!url) {
  console.error('Falta SUPABASE_DB_URL');
  process.exit(1);
}
const host = new URL(url).host;
console.log('Destino:', host);
if (!host.includes('nkicerkehhpilvvydlwr')) {
  console.error('Abortado: esperado B2 (nkicer...). Host:', host);
  process.exit(1);
}

const sql = fs.readFileSync(
  path.join(root, 'sql/migrations/2026-09-21_cto_coverage_datasets.sql'),
  'utf8'
);
const c = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 0
});
await c.connect();
console.log('Aplicando migration…');
await c.query(sql);
const tables = await c.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname='public'
    AND tablename IN ('data_datasets','app_runtime_config')
`);
console.log('tabelas:', tables.rows.map((r) => r.tablename));
const cfg = await c.query(
  `SELECT key, value_uuid FROM app_runtime_config WHERE key='active_ctos_coverage_dataset'`
);
console.log('config:', cfg.rows);
const cnt = await c.query(
  `SELECT count(*)::int AS n FROM ctos WHERE dataset_id IS NOT NULL`
);
console.log('ctos com dataset_id:', cnt.rows[0].n);
await c.query(`NOTIFY pgrst, 'reload schema'`);
await c.query(`NOTIFY pgrst, 'reload config'`);
console.log('NOTIFY pgrst ok');
await c.end();
console.log('OK B2');
