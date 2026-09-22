/**
 * Geocodifica (endereço → lat/lng) linhas de condominios_mdu sem coordenadas.
 * Usa a mesma Google Geocoding API do backend.
 *
 * Uso (na pasta backend):
 *   node scripts/geocode-condominios-mdu-missing.js
 *   node scripts/geocode-condominios-mdu-missing.js --dry-run
 *   node scripts/geocode-condominios-mdu-missing.js --limit=50
 *   node scripts/geocode-condominios-mdu-missing.js --delay=250
 *
 * Requer no backend/.env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   GOOGLE_MAPS_API_KEY (ou VITE_GOOGLE_MAPS_API_KEY)
 */
import '../loadEnv.js';
import supabase, { isSupabaseAvailable } from '../supabase.js';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

function maskUrl(url) {
  if (!url) return '(não configurado)';
  try {
    const host = new URL(url).hostname;
    return host.replace(/^([^.]+)/, (m) => `${m.slice(0, 4)}***`);
  } catch {
    return '(URL inválida)';
  }
}

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getMapsApiKey() {
  return (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  ).trim();
}

function buildAddressQuery(row) {
  const tipoLog = String(row.tipo_logradouro || '').trim();
  const nomeLog = String(row.nome_logradouro || '').trim();
  const numero = String(row.numero || '').trim();
  const complemento = String(row.complemento || '').trim();
  const bairro = String(row.bairro || '').trim();
  const cidade = String(row.nome_cidade || '').trim();
  const estado = String(row.estado || '').trim();
  const cep = String(row.cep || '').trim();
  const descricao = String(row.descricao || '').trim();

  const logradouro = [tipoLog, nomeLog].filter(Boolean).join(' ').trim();
  const parts = [
    descricao,
    logradouro,
    numero && !/^s\.?\s*n\.?$/i.test(numero) ? numero : '',
    complemento,
    bairro,
    cidade,
    estado,
    cep ? `CEP ${cep}` : '',
    'Brasil'
  ]
    .map((p) => String(p || '').trim())
    .filter(Boolean);

  return parts.join(', ');
}

function scoreGeocodeResult(result) {
  const locType = result?.geometry?.location_type || '';
  if (locType === 'ROOFTOP') return 100;
  if (locType === 'RANGE_INTERPOLATED') return 80;
  if (locType === 'GEOMETRIC_CENTER') return 50;
  if (locType === 'APPROXIMATE') return 30;
  return 20;
}

async function geocodeAddress(query, { uf } = {}) {
  const key = getMapsApiKey();
  if (!key) {
    throw new Error('GOOGLE_MAPS_API_KEY (ou VITE_GOOGLE_MAPS_API_KEY) não configurada no backend/.env');
  }

  const components = ['country:BR'];
  if (uf) components.push(`administrative_area:${String(uf).trim()}`);

  const url = new URL(GEOCODE_URL);
  url.searchParams.set('address', query);
  url.searchParams.set('key', key);
  url.searchParams.set('language', 'pt-BR');
  url.searchParams.set('region', 'br');
  url.searchParams.set('components', components.join('|'));

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (data.status === 'ZERO_RESULTS') {
    return { ok: false, status: data.status, reason: 'ZERO_RESULTS' };
  }
  if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) {
    return {
      ok: false,
      status: data.status || 'ERROR',
      reason: data.error_message || data.status || 'Falha no geocode'
    };
  }

  const best = [...data.results].sort((a, b) => scoreGeocodeResult(b) - scoreGeocodeResult(a))[0];
  const lat = Number(best?.geometry?.location?.lat);
  const lng = Number(best?.geometry?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, status: data.status, reason: 'Sem lat/lng no resultado' };
  }

  return {
    ok: true,
    latitude: lat,
    longitude: lng,
    locationType: best?.geometry?.location_type || null,
    formattedAddress: best?.formatted_address || null,
    score: scoreGeocodeResult(best)
  };
}

async function fetchMissingRows(supabase, limit) {
  // PostgREST: is.null em lat OU lng
  let query = supabase
    .from('condominios_mdu')
    .select(
      'id,id_endereco,id_mdu,descricao,tipo,numero,complemento,bairro,nome_logradouro,tipo_logradouro,cep,nome_cidade,estado,latitude,longitude'
    )
    .or('latitude.is.null,longitude.is.null')
    .order('id', { ascending: true });

  if (limit > 0) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function main() {
  const dryRun = Boolean(getArg('dry-run', false));
  const limit = Number(getArg('limit', '0')) || 0;
  const delayMs = Math.max(100, Number(getArg('delay', '220')) || 220);

  if (!isSupabaseAvailable() || !supabase) {
    console.error('❌ Configure SUPABASE_URL e SUPABASE_SERVICE_KEY no backend/.env');
    process.exit(1);
  }
  if (!getMapsApiKey()) {
    console.error('❌ Configure GOOGLE_MAPS_API_KEY (ou VITE_GOOGLE_MAPS_API_KEY) no backend/.env');
    process.exit(1);
  }

  console.log(`🛰️  Geocode condominios_mdu sem coordenadas`);
  console.log(`   Supabase: ${maskUrl(process.env.SUPABASE_URL)}`);
  console.log(`   Modo: ${dryRun ? 'DRY-RUN (não grava)' : 'GRAVAR'}`);
  console.log(`   Delay: ${delayMs}ms | Limit: ${limit || 'todos'}`);

  const rows = await fetchMissingRows(supabase, limit);
  console.log(`📋 ${rows.length} registro(s) sem lat e/ou lng`);

  let ok = 0;
  let fail = 0;
  const failures = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const query = buildAddressQuery(row);
    const label = `[${i + 1}/${rows.length}] id=${row.id} mdu=${row.id_mdu ?? '?'} ${row.descricao || ''}`;

    if (!query || query.length < 8) {
      fail += 1;
      failures.push({ id: row.id, reason: 'Endereço fraco/vazio', query });
      console.warn(`⚠️  ${label} — endereço insuficiente`);
      continue;
    }

    try {
      const geo = await geocodeAddress(query, { uf: row.estado });
      if (!geo.ok) {
        fail += 1;
        failures.push({ id: row.id, reason: geo.reason || geo.status, query });
        console.warn(`⚠️  ${label} — ${geo.reason || geo.status}`);
      } else if (dryRun) {
        ok += 1;
        console.log(
          `✅ ${label} → ${geo.latitude}, ${geo.longitude} (${geo.locationType}) [dry-run]`
        );
      } else {
        const { error } = await supabase
          .from('condominios_mdu')
          .update({
            latitude: geo.latitude,
            longitude: geo.longitude
          })
          .eq('id', row.id);
        if (error) throw error;
        ok += 1;
        console.log(`✅ ${label} → ${geo.latitude}, ${geo.longitude} (${geo.locationType})`);
      }
    } catch (err) {
      fail += 1;
      failures.push({ id: row.id, reason: err?.message || String(err), query });
      console.error(`❌ ${label} — ${err?.message || err}`);
    }

    if (i < rows.length - 1) await sleep(delayMs);
  }

  console.log('\n—— Resumo ——');
  console.log(`OK: ${ok}`);
  console.log(`Falhas: ${fail}`);
  if (failures.length) {
    console.log('Falhas (até 20):');
    for (const f of failures.slice(0, 20)) {
      console.log(`  - id=${f.id}: ${f.reason}`);
    }
  }
}

main().catch((err) => {
  console.error('❌ Script falhou:', err?.message || err);
  process.exit(1);
});
