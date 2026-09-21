import './loadEnvShim.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(__dirname, '../../sql/migrations/2026-09-21_cto_coverage_datasets.sql');
const target = (process.argv[2] || 'replica').toLowerCase();
const url =
  target === 'primary' ? process.env.SUPABASE_DB_URL : process.env.SUPABASE_REPLICA_DB_URL;

if (!url) {
  console.error('URL ausente para', target);
  process.exit(1);
}

const sql = fs.readFileSync(sqlPath, 'utf8');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
console.log('Aplicando migration em', target, '...');
await c.query(sql);
const cfg = await c.query(
  `select key, value_uuid from app_runtime_config where key='active_ctos_coverage_dataset'`
);
const cnt = await c.query(
  `select count(*)::int as n from ctos where dataset_id is not null`
);
console.log('config:', cfg.rows);
console.log('ctos com dataset_id:', cnt.rows[0].n);
await c.end();
console.log('OK');
