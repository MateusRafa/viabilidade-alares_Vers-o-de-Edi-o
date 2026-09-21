/**
 * Ajusta B2 para login/API: desliga RLS nas tabelas app e recarrega PostgREST.
 */
import './loadEnvShim.js';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const replicaUrl = process.env.SUPABASE_REPLICA_DB_URL;
const apiUrl = process.env.SUPABASE_REPLICA_URL;
const apiKey = process.env.SUPABASE_REPLICA_SERVICE_KEY;

const c = new pg.Client({
  connectionString: replicaUrl,
  ssl: { rejectUnauthorized: false }
});
await c.connect();

const { rows: tables } = await c.query(`
  SELECT c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      JOIN pg_extension e ON d.refobjid = e.oid
      WHERE d.objid = c.oid AND d.deptype = 'e'
    )
  ORDER BY 1
`);

console.log(`Ajustando ${tables.length} tabelas no B2...`);

for (const { relname } of tables) {
  const q = `"${relname.replace(/"/g, '""')}"`;
  await c.query(`ALTER TABLE public.${q} DISABLE ROW LEVEL SECURITY`);
  await c.query(`GRANT ALL ON TABLE public.${q} TO anon, authenticated, service_role`);
  console.log(`  ✅ ${relname}: RLS off + GRANT`);
}

await c.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role`);
await c.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role`);
await c.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role`);

try {
  await c.query(`NOTIFY pgrst, 'reload schema'`);
  console.log('✅ PostgREST schema reload solicitado');
} catch (e) {
  console.warn('⚠️ NOTIFY pgrst:', e.message);
}

await c.end();

const b2 = createClient(apiUrl, apiKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const { data, error } = await b2
  .from('projetistas')
  .select('nome, senha, tipo')
  .ilike('nome', 'Mateus Rafá')
  .limit(1);

if (error) {
  console.error('❌ Login simulado falhou:', error.message);
  process.exit(1);
}

const ok = data?.[0]?.senha === 'mateus20';
console.log(ok ? '✅ Login Mateus Rafá / mateus20 OK no B2' : '❌ Senha não bate', data);
