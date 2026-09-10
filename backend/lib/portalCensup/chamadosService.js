import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { analisarLocalizacaoChamado } from './analiseLocalizacao.js';
import { isPortalCensupSupabaseAvailable } from './supabaseCensup.js';
import { dbFindChamado, dbListAllChamados, dbListChamadosNaFila, dbReconcileChamadosComAgenda, dbUpsertChamado } from './chamadosDb.js';

const FAKE_SEED_ID = '5303036a-6e14-4ca1-b5a7-46207c301735';
const FAKE_SEED_PEDIDO = '1745000';

function dataFileCandidates() {
  const files = [];
  const envDir = (process.env.DATA_DIR || '').trim();
  if (envDir) files.push(path.join(envDir, 'portal-censup-chamados.json'));
  files.push(path.join(process.cwd(), 'data', 'portal-censup-chamados.json'));
  return [...new Set(files)];
}

function primaryDataFile() {
  return dataFileCandidates()[0];
}

function isFakeSeedChamado(item) {
  if (!item) return false;
  return item.id === FAKE_SEED_ID || String(item.pedido || '') === FAKE_SEED_PEDIDO;
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readStore() {
  const merged = { chamados: [], feedback: [] };
  const seenPedidos = new Set();
  const seenIds = new Set();

  for (const filePath of dataFileCandidates()) {
    const parsed = await readJsonIfExists(filePath);
    if (!parsed) continue;
    const chamados = Array.isArray(parsed.chamados) ? parsed.chamados : [];
    for (const item of chamados) {
      if (isFakeSeedChamado(item)) continue;
      const pedidoKey = item?.pedido != null ? String(item.pedido) : '';
      if (pedidoKey && seenPedidos.has(pedidoKey)) continue;
      if (item?.id && seenIds.has(item.id)) continue;
      if (pedidoKey) seenPedidos.add(pedidoKey);
      if (item?.id) seenIds.add(item.id);
      merged.chamados.push(item);
    }
    const feedback = Array.isArray(parsed.feedback) ? parsed.feedback : [];
    merged.feedback.push(...feedback);
  }

  return merged;
}

async function writeStore(store) {
  const filePath = primaryDataFile();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');
}

function isChamadosTableMissing(err) {
  const message = err?.message || '';
  return (
    err?.code === 'PGRST205' ||
    err?.code === '42P01' ||
    /does not exist|Could not find the table/i.test(message)
  );
}

async function trySupabase(action, fn) {
  if (!isPortalCensupSupabaseAvailable()) return { used: false, data: null };
  try {
    const data = await fn();
    return { used: true, data };
  } catch (err) {
    if (isChamadosTableMissing(err)) {
      console.warn(`⚠️ [PortalCENSUP] Tabela chamados ainda não existe (${action}). Usando JSON local.`);
      return { used: false, data: null };
    }
    console.error(`❌ [PortalCENSUP] Supabase falhou em ${action}:`, err.message);
    throw err;
  }
}

function formatDataSituacao(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function extractAnalistaFromSituacao(situacao) {
  const match = String(situacao || '').match(/em\s+an[aá]lise\s+por\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function isDateLikeSituacao(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'null') return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(raw)) return true;
  const parsed = Date.parse(raw);
  return !Number.isNaN(parsed) && /\d{4}/.test(raw);
}

function isPendenteNaAgenda(situacao) {
  const raw = String(situacao || '').trim();
  if (!raw || raw.toLowerCase() === 'null') return true;
  if (/pendente/i.test(raw)) return true;
  return isDateLikeSituacao(raw);
}

export function formatSituacaoLabel(chamado) {
  const raw = String(chamado?.situacao ?? '').trim();
  const analista = extractAnalistaFromSituacao(raw) || String(chamado?.usuarioAnalise ?? '').trim();

  if (analista) {
    return `Em análise por ${analista}`;
  }

  if (isPendenteNaAgenda(raw)) {
    return 'Pendente Analise';
  }

  return raw || 'Pendente Analise';
}

export async function claimChamadoForAnalise(id, usuario) {
  const chamado = await findChamadoByPedidoOrCode({ id });
  const nome = String(usuario || '').trim();
  if (!chamado || !nome) return chamado;

  if (extractAnalistaFromSituacao(chamado.situacao) || chamado.usuarioAnalise) {
    return chamado;
  }

  if (!isPendenteNaAgenda(chamado.situacao)) {
    return chamado;
  }

  return upsertChamado({
    ...chamado,
    usuarioAnalise: nome
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getMapsApiKey() {
  return (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  ).trim();
}

function formatCep(cep) {
  let digits = String(cep || '').replace(/\D/g, '');
  if (digits.length > 8) digits = digits.slice(0, 8);
  if (digits.length === 8) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return digits || cep || '—';
}

function buildStaticMapUrl(lat, lng) {
  const key = getMapsApiKey();
  if (!key || lat == null || lng == null) return null;
  const params = new URLSearchParams({
    center: `${lat},${lng}`,
    zoom: '17',
    size: '640x400',
    scale: '2',
    maptype: 'hybrid',
    markers: `color:0xEA4335|${lat},${lng}`,
    key
  });
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}

export function buildChamadoPdfHtml(chamado) {
  const end = chamado.endereco || {};
  const resumo = chamado.viabilidadeResumo || {};
  const loc = chamado.localizacao || chamado.mapaCoords || {};
  const lat = loc.lat != null ? Number(loc.lat) : null;
  const lng = loc.lng != null ? Number(loc.lng) : null;
  const pedido = chamado.pedido || '—';
  const alaNumber = `ALA-${pedido}`;
  const viAla =
    chamado.viAla ||
    `VI ALA-${String(pedido).replace(/\D/g, '').padStart(7, '0') || '0000000'}`;

  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR');
  const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  const cidade = end.cidade || chamado.cidade || '—';
  const enderecoCompleto =
    end.completo ||
    [end.logradouro, end.numero, end.bairro, cidade, end.uf, end.cep ? `CEP ${formatCep(end.cep)}` : '']
      .filter(Boolean)
      .join(', ') ||
    '—';
  const numeroEndereco = end.numero || '—';
  const cep = formatCep(end.cep);
  const tabulacao = chamado.tabulacaoFinal || '—';
  const projetista =
    resumo.projetista || chamado.analiseIa?.modelo || currentUserFallback(chamado) || 'Portal CENSUP';

  const ctos = Array.isArray(chamado.ctos) ? chamado.ctos : [];
  const totalCtos = resumo.ctosEncontradas ?? ctos.length;
  const totalPortas =
    resumo.portasDisponiveis ??
    ctos.reduce((sum, cto) => {
      const total = Number(cto.vagas_total ?? cto.totalPortas ?? 0);
      const conectadas = Number(cto.clientes_conectados ?? cto.portasConectadas ?? 0);
      return sum + Math.max(0, total - conectadas);
    }, 0);

  const foraCobertura = resumo.dentroCobertura === false;
  const distCobertura = resumo.distanciaCoberturaMetros;
  let totalEquipamentosTexto = '';
  if (foraCobertura) {
    const distTxt =
      distCobertura != null
        ? distCobertura >= 1000
          ? `${(distCobertura / 1000).toFixed(2)} km`
          : `${Math.round(distCobertura)} m`
        : null;
    totalEquipamentosTexto = distTxt
      ? `<p><strong style="font-weight: bold; color: #F44336;">Fora da área de cobertura:</strong> cerca de <strong style="color:#F44336;">${escapeHtml(distTxt)}</strong> até a mancha mais próxima.</p>`
      : `<p><strong style="font-weight: bold; color: #F44336;">Fora da área de cobertura.</strong></p>`;
  } else if (totalCtos != null && totalCtos > 0) {
    totalEquipamentosTexto = `<p><strong>Total:</strong> <span style="font-weight: bold; color: #000000;">${escapeHtml(totalCtos)}</span> <strong style="font-weight: bold; color: #000000;">${Number(totalCtos) === 1 ? 'Equipamento encontrado' : 'Equipamentos encontrados'} dentro de 250m</strong></p>`;
  } else {
    totalEquipamentosTexto = `<p><strong>Total:</strong> <span style="font-weight: bold; color: #000000;">0</span> <strong style="font-weight: bold; color: #000000;">Equipamentos encontrados dentro de 250m</strong></p>`;
  }

  const mapUrl = buildStaticMapUrl(lat, lng);
  const coordsTxt =
    lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng)
      ? `${lat.toFixed(6)}, ${lng.toFixed(6)}`
      : '—';

  const ctoRows =
    ctos.length > 0
      ? ctos
          .map((cto, index) => {
            const total = Number(cto.vagas_total ?? cto.totalPortas ?? 0);
            const conectadas = Number(cto.clientes_conectados ?? cto.portasConectadas ?? 0);
            const disponiveis = Math.max(0, total - conectadas);
            const distM = Number(cto.distancia_metros ?? cto.distanciaMetros ?? 0);
            const distKm = (distM / 1000).toFixed(3);
            const semPortas = disponiveis === 0;
            const styleColor = semPortas ? ' style="color: #F44336;"' : '';
            return `
          <tr${styleColor}>
            <td${styleColor}>${index + 1}</td>
            <td${styleColor}>${escapeHtml(cto.cidade || cidade)}</td>
            <td${styleColor}>${escapeHtml(cto.pop || '—')}</td>
            <td${styleColor}>${escapeHtml(cto.nome || cto.name || '—')}</td>
            <td${styleColor}>${escapeHtml(cto.id || '—')}</td>
            <td${styleColor}>${escapeHtml(total)}</td>
            <td${styleColor}>${escapeHtml(conectadas)}</td>
            <td${styleColor}>${escapeHtml(disponiveis)}</td>
            <td${styleColor}>${escapeHtml(distM)}m (${escapeHtml(distKm)}km)</td>
          </tr>`;
          })
          .join('')
      : `
          <tr>
            <td colspan="9" style="text-align:center; color:#6b7280; padding: 14px;">
              Nenhum equipamento CTO listado nesta análise ainda.
            </td>
          </tr>`;

  const mapSection = mapUrl
    ? `
              <div class="map-section">
                <h2>Visualização do Mapa</h2>
                <div class="map-wrapper">
                  <div class="map-image-container">
                    <img src="${escapeHtml(mapUrl)}" alt="Mapa com localização do cliente" class="map-image" />
                  </div>
                </div>
              </div>`
    : `
              <div class="map-section">
                <h2>Visualização do Mapa</h2>
                <div class="map-placeholder">
                  Mapa indisponível — execute <strong>Analisar localização</strong> para obter coordenadas.
                </div>
              </div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Relatório de Análise de Viabilidade Técnica - ${escapeHtml(viAla)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
      padding: 8px;
      background: white !important;
      font-size: 13px;
      line-height: 1.4;
      color: #333;
    }
    .pdf-header {
      background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
      color: white;
      padding: 10px 14px;
      border-radius: 4px 4px 0 0;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 6px rgba(123, 104, 238, 0.3);
      gap: 12px;
    }
    .pdf-header h1 {
      font-size: 18px;
      font-weight: 700;
      margin: 0;
      color: white;
      line-height: 1.35;
    }
    .pdf-header .date-info {
      font-size: 11px;
      opacity: 0.95;
      text-align: right;
      font-weight: 500;
      line-height: 1.4;
      flex-shrink: 0;
    }
    .report-container {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
      align-items: stretch;
    }
    .report-header {
      background: linear-gradient(to bottom, #f8f9fa 0%, #ffffff 100%);
      padding: 8px;
      border-radius: 4px;
      border: 1px solid #e0e0e0;
      flex: 0 0 40%;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      display: flex;
      flex-direction: column;
    }
    .report-header h2,
    .map-section h2,
    .table-container h2 {
      color: #7B68EE;
      margin: 0 0 5px;
      font-size: 14px;
      font-weight: 700;
      padding-bottom: 3px;
      border-bottom: 2px solid #7B68EE;
      line-height: 1.3;
    }
    .map-section h2 { text-align: center; width: 100%; }
    .report-info { display: grid; gap: 3px; margin-bottom: 5px; flex: 1; }
    .report-info-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 3px 0;
      border-bottom: 1px solid #f0f0f0;
    }
    .report-info-item:last-child { border-bottom: none; }
    .report-info-label {
      font-weight: 600;
      color: #666;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.2px;
    }
    .report-info-value {
      color: #333;
      font-size: 12px;
      font-weight: 500;
      word-break: break-word;
    }
    .summary-stats {
      margin-top: auto;
      padding-top: 5px;
      border-top: 2px solid #7B68EE;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .summary-stats p { margin: 0; font-size: 11px; color: #333; line-height: 1.35; }
    .summary-stats strong { color: #7B68EE; font-weight: 700; }
    .map-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 0;
    }
    .map-wrapper {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
      max-width: 100%;
    }
    .map-image-container {
      display: block;
      width: 100%;
      border: 2px solid #7B68EE;
      border-radius: 4px;
      overflow: hidden;
      box-shadow: 0 1px 4px rgba(123, 104, 238, 0.2);
      line-height: 0;
      background: #f3f4f6;
    }
    .map-image {
      display: block;
      width: 100%;
      height: auto;
      max-height: 340px;
      object-fit: contain;
    }
    .map-placeholder {
      width: 100%;
      min-height: 220px;
      border: 2px dashed #c4b5fd;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 16px;
      color: #6b7280;
      background: #faf5ff;
      font-size: 12px;
    }
    .table-container {
      margin-top: 6px;
      overflow-x: auto;
      background: white;
      border-radius: 4px;
      padding: 6px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    thead {
      background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
      color: white;
    }
    th, td {
      padding: 6px 5px;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
    }
    th { font-weight: 700; white-space: nowrap; }
    tbody tr:nth-child(even) { background: #f9fafb; }
    .watermark {
      margin-top: 14px;
      text-align: center;
      font-size: 13px;
      color: #333;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="pdf-header">
    <h1>
      Relatório de Análise de Viabilidade Técnica - ${escapeHtml(viAla)}<br>
      <span style="font-size: 14px; font-weight: 500; opacity: 0.95;">Alares Engenharia - ${escapeHtml(alaNumber)}</span>
    </h1>
    <div class="date-info">
      <div style="margin-bottom: 3px;">Gerado em: ${escapeHtml(dateStr)} às ${escapeHtml(timeStr)}</div>
      <div style="font-size: 10px; opacity: 0.85;">Sistema de Viabilidade Técnica</div>
    </div>
  </div>

  <div class="report-container">
    <div class="report-header">
      <h2>Informações do Relatório</h2>
      <div class="report-info">
        <div class="report-info-item">
          <span class="report-info-label">Número do ALA</span>
          <span class="report-info-value">${escapeHtml(alaNumber)}</span>
        </div>
        <div class="report-info-item">
          <span class="report-info-label">Cidade</span>
          <span class="report-info-value">${escapeHtml(cidade)}</span>
        </div>
        <div class="report-info-item">
          <span class="report-info-label">Endereço Completo</span>
          <span class="report-info-value">${escapeHtml(enderecoCompleto)}</span>
        </div>
        <div class="report-info-item">
          <span class="report-info-label">Número do Endereço</span>
          <span class="report-info-value">${escapeHtml(numeroEndereco)}</span>
        </div>
        <div class="report-info-item">
          <span class="report-info-label">CEP do Endereço</span>
          <span class="report-info-value">${escapeHtml(cep)}</span>
        </div>
        <div class="report-info-item">
          <span class="report-info-label">Latitude e Longitude</span>
          <span class="report-info-value">${escapeHtml(coordsTxt)}</span>
        </div>
        <div class="report-info-item">
          <span class="report-info-label">Tabulação Final</span>
          <span class="report-info-value">${escapeHtml(tabulacao)}</span>
        </div>
        <div class="report-info-item">
          <span class="report-info-label">Projetista</span>
          <span class="report-info-value">${escapeHtml(projetista)}</span>
        </div>
      </div>
      <div class="summary-stats">
        ${totalEquipamentosTexto}
        <p><strong>Total de Portas Disponíveis:</strong> <span style="font-weight: bold; color: #000000;">${escapeHtml(totalPortas ?? 0)}</span> <strong style="font-weight: bold; color: #000000;">portas</strong></p>
      </div>
    </div>
    ${mapSection}
  </div>

  <div class="table-container">
    <h2>Equipamentos CTO Encontrados</h2>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Cidade</th>
          <th>POP</th>
          <th>Nome</th>
          <th>ID</th>
          <th>Total de Portas</th>
          <th>Portas Conectadas</th>
          <th>Portas Disponíveis</th>
          <th>Distância</th>
        </tr>
      </thead>
      <tbody>
        ${ctoRows}
      </tbody>
    </table>
  </div>

  <div class="watermark">Setor de Planejamento e Projetos - Engenharia Alares</div>
</body>
</html>`;
}

function currentUserFallback(chamado) {
  return chamado.projetista || chamado.usuarioAnalise || null;
}

function filterChamados(chamados, { q = '', filaStatus = 'na_fila' } = {}) {
  const status = filaStatus === 'finalizada' ? 'finalizada' : 'na_fila';
  const byStatus = (chamados || []).filter((item) => (item.filaStatus || 'na_fila') === status);
  const query = (q || '').trim().toLowerCase();
  if (!query) return byStatus;
  return byStatus.filter((item) => {
    const haystack = [
      item.pedido,
      item.cidade,
      item.uf,
      item.sistema,
      item.pdv,
      item.motivo,
      item.situacao,
      item.tabulacaoFinal,
      item.endereco?.completo,
      item.projetista,
      item.usuarioAnalise,
      item.viabilidadeResumo?.projetista,
      item.analiseIa?.modelo
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

function emptyList({ page = 1, limit = 10, source = 'supabase' } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  return {
    chamados: [],
    total: 0,
    page: safePage,
    limit: safeLimit,
    totalPages: 1,
    source
  };
}

function paginateStore(store, { q = '', page = 1, limit = 10, filaStatus = 'na_fila' } = {}, extra = {}) {
  const filtered = filterChamados(store.chamados, { q, filaStatus });
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const start = (safePage - 1) * safeLimit;
  const items = filtered.slice(start, start + safeLimit).map((item) => ({
    ...item,
    dataSituacaoLabel: formatDataSituacao(item.dataSituacao),
    situacaoLabel: formatSituacaoLabel(item)
  }));

  return {
    chamados: items,
    total: filtered.length,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.max(1, Math.ceil(filtered.length / safeLimit)),
    source: 'json',
    ...extra
  };
}

function withListLabels(chamados) {
  return (chamados || []).map((item) => ({
    ...item,
    dataSituacaoLabel: formatDataSituacao(item.dataSituacao),
    situacaoLabel: formatSituacaoLabel(item)
  }));
}

export function resolvePortalCensupFilaStatus(view = 'pendentes') {
  return view === 'resolvidos' ? 'finalizada' : 'na_fila';
}

export async function listChamados({ q = '', page = 1, limit = 10, view = 'pendentes' } = {}) {
  const filaStatus = resolvePortalCensupFilaStatus(view);

  if (isPortalCensupSupabaseAvailable()) {
    const fromDb = await dbListChamadosNaFila({ q, page, limit, filaStatus });
    syncJsonFromSupabase().catch((err) => {
      console.warn('⚠️ [PortalCENSUP] Não atualizou o JSON local a partir da table:', err.message);
    });
    const dbTotal = fromDb?.total || 0;
    return {
      chamados: withListLabels(fromDb?.chamados),
      total: dbTotal,
      page: fromDb?.page || page,
      limit: fromDb?.limit || limit,
      totalPages: Math.max(1, Math.ceil(dbTotal / (fromDb?.limit || limit || 10))),
      source: 'supabase',
      view: view === 'resolvidos' ? 'resolvidos' : 'pendentes',
      filaStatus
    };
  }

  return paginateStore(await readStore(), { q, page, limit, filaStatus }, {
    view: view === 'resolvidos' ? 'resolvidos' : 'pendentes',
    filaStatus
  });
}

export async function getChamadoById(id, { usuario } = {}) {
  const fromDb = await trySupabase('buscar chamado', () => dbFindChamado({ id, pedido: id }));
  let chamado = isPortalCensupSupabaseAvailable()
    ? fromDb.data
    : fromDb.data ||
      (await readStore()).chamados.find((item) => item.id === id || String(item.pedido) === String(id));

  if (!chamado) {
    const err = new Error('Chamado não encontrado');
    err.statusCode = 404;
    throw err;
  }

  if (usuario) {
    chamado = (await claimChamadoForAnalise(id, usuario)) || chamado;
  }

  return {
    ...chamado,
    dataSituacaoLabel: formatDataSituacao(chamado.dataSituacao),
    situacaoLabel: formatSituacaoLabel(chamado),
    pdfHtml: buildChamadoPdfHtml(chamado)
  };
}

export async function findChamadoByPedidoOrCode({ pedido, agendaCode, id } = {}) {
  const fromDb = await trySupabase('buscar por pedido', () => dbFindChamado({ id, pedido, agendaCode }));
  if (fromDb.data) return fromDb.data;
  if (isPortalCensupSupabaseAvailable()) return null;

  const store = await readStore();
  return (
    store.chamados.find((item) => {
      if (id && item.id === id) return true;
      if (agendaCode && item.agendaCode === agendaCode) return true;
      if (pedido && String(item.pedido) === String(pedido)) return true;
      return false;
    }) || null
  );
}

const TABULACAO_PRESERVE_FIELDS = [
  'tabulacaoFinal',
  'tabulacaoConfianca',
  'tabulacaoStatus',
  'viabilidadeResumo',
  'analiseIa'
];

export async function upsertChamadoFromAgenda(payload) {
  const existing = await findChamadoByPedidoOrCode({
    pedido: payload.pedido,
    agendaCode: payload.agendaCode || payload.id
  });

  const id = payload.id || payload.agendaCode || existing?.id;
  const merged = { ...payload, id };

  if (existing) {
    const preserveTabulacao =
      existing.tabulacaoFinal &&
      existing.tabulacaoStatus &&
      existing.tabulacaoStatus !== 'aguardando_analise';

    if (preserveTabulacao) {
      for (const field of TABULACAO_PRESERVE_FIELDS) {
        if (existing[field] !== undefined && existing[field] !== null) {
          merged[field] = existing[field];
        }
      }
    }

    if (existing.filaStatus === 'executada_agenda') {
      merged.filaStatus = 'na_fila';
    } else if (existing.filaStatus === 'finalizada') {
      merged.filaStatus = 'finalizada';
    }
  }

  return upsertChamado(merged);
}

/**
 * Chamados que sumiram da Agenda (aprovados/reprovados lá) saem das views do Portal.
 * Não vão para Resolvidos — apenas fila_status = executada_agenda (oculto).
 */
export async function reconcileChamadosComAgenda(activePedidos = [], situacoes = []) {
  const activeSet = new Set(
    (activePedidos || []).map((pedido) => String(pedido || '').trim()).filter(Boolean)
  );

  // Mapa pedido → situação vinda da Agenda
  const situacaoMap = new Map();
  for (const item of (situacoes || [])) {
    const pedido = String(item?.pedido || '').trim();
    const situacao = String(item?.situacao || '').trim();
    if (pedido && situacao) situacaoMap.set(pedido, situacao);
  }

  let updated = 0;
  let situacoesAtualizadas = 0;

  if (isPortalCensupSupabaseAvailable()) {
    const dbResult = await dbReconcileChamadosComAgenda(activeSet, situacaoMap);
    updated = dbResult?.updated || 0;
    situacoesAtualizadas = dbResult?.situacoesAtualizadas || 0;
    if (updated > 0 || situacoesAtualizadas > 0) {
      await syncJsonFromSupabase().catch((err) => {
        console.warn('⚠️ [PortalCENSUP] JSON local não atualizado após reconciliação:', err.message);
      });
    }
    return { updated, situacoesAtualizadas, activeInAgenda: activeSet.size };
  }

  const store = await readStore();
  for (const item of store.chamados) {
    const status = item.filaStatus || 'na_fila';
    const pedido = String(item.pedido || '').trim();

    // Atualizar situação se mudou
    if (pedido && situacaoMap.has(pedido)) {
      const novaSituacao = situacaoMap.get(pedido);
      if (novaSituacao && novaSituacao !== item.situacao) {
        item.situacao = novaSituacao;
        situacoesAtualizadas += 1;
      }
    }

    if (status !== 'na_fila' && status !== 'finalizada') continue;
    if (!pedido || activeSet.has(pedido)) continue;
    item.filaStatus = 'executada_agenda';
    item.executadaAgendaAt = new Date().toISOString();
    updated += 1;
  }

  if (updated > 0 || situacoesAtualizadas > 0) {
    await writeStore(store);
    if (updated > 0) {
      console.log(`✅ [PortalCENSUP] ${updated} chamado(s) arquivado(s) — executados na Agenda.`);
    }
    if (situacoesAtualizadas > 0) {
      console.log(`✅ [PortalCENSUP] ${situacoesAtualizadas} situação(ões) atualizada(s) da Agenda.`);
    }
  }

  return { updated, situacoesAtualizadas, activeInAgenda: activeSet.size };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

export async function upsertChamado(payload) {
  const existing = await findChamadoByPedidoOrCode({
    id: payload.id,
    pedido: payload.pedido,
    agendaCode: payload.agendaCode
  });

  const id =
    (isUuid(existing?.id) && existing.id) ||
    (isUuid(payload.id) && payload.id) ||
    crypto.randomUUID();
  const now = new Date().toISOString();
  const previous = existing || {};
  const next = {
    ...previous,
    ...payload,
    id,
    filaStatus: payload.filaStatus || previous.filaStatus || 'na_fila',
    endereco: {
      ...(previous.endereco || {}),
      ...(payload.endereco || {})
    },
    mapaReferencias:
      payload.mapaReferencias?.length > 0
        ? payload.mapaReferencias
        : previous.mapaReferencias || [],
    mapaCoords: payload.mapaCoords || previous.mapaCoords || null,
    updatedAt: now,
    createdAt: previous.createdAt || now
  };

  const store = await readStore();
  const existingIndex = store.chamados.findIndex(
    (item) => item.id === id || (next.pedido && String(item.pedido) === String(next.pedido))
  );
  if (existingIndex >= 0) store.chamados[existingIndex] = { ...store.chamados[existingIndex], ...next };
  else store.chamados.unshift(next);
  await writeStore(store);

  if (!isPortalCensupSupabaseAvailable()) {
    console.warn(
      `⚠️ [PortalCENSUP] Pedido ${next.pedido} salvo só no JSON. Configure PORTAL_CENSUP_SUPABASE_URL e PORTAL_CENSUP_SUPABASE_SERVICE_KEY no backend Railway.`
    );
    next.persistedToSupabase = false;
    next.supabaseError =
      'Supabase CENSUP não configurado neste processo. Confira as variáveis no serviço backend e faça Redeploy.';
    return next;
  }

  try {
    const saved = await dbUpsertChamado(next);
    console.log(`✅ [PortalCENSUP] Pedido ${next.pedido} gravado na tabela chamados do Supabase`);
    return { ...(saved || next), persistedToSupabase: true };
  } catch (err) {
    console.error(`❌ [PortalCENSUP] Pedido ${next.pedido} NÃO gravou no Supabase:`, err.message);
    next.persistedToSupabase = false;
    next.supabaseError = err.message;
    return next;
  }
}

export async function syncJsonFromSupabase() {
  if (!isPortalCensupSupabaseAvailable()) {
    return {
      success: false,
      synced: 0,
      total: 0,
      error: 'Supabase CENSUP não configurado.'
    };
  }

  const chamados = await dbListAllChamados();
  const store = await readStore();
  store.chamados = chamados;
  await writeStore(store);
  return {
    success: true,
    synced: chamados.length,
    total: chamados.length,
    errors: []
  };
}

/** A table é a fonte da verdade. O JSON só espelha o que está no Supabase. */
export async function syncFilaToSupabase() {
  return syncJsonFromSupabase();
}

export async function analisarChamadoById(
  id,
  { force = false, lat = null, lng = null, enderecoPatch = null } = {}
) {
  const chamado = await findChamadoByPedidoOrCode({ id });
  if (!chamado) {
    const err = new Error('Chamado não encontrado');
    err.statusCode = 404;
    throw err;
  }

  const jaRevisado =
    chamado.tabulacaoStatus === 'aprovada' || chamado.tabulacaoStatus === 'corrigida';

  if (jaRevisado && !force) {
    return {
      chamado: await getChamadoById(id),
      skipped: true,
      reason: 'Tabulação já revisada pelo usuário'
    };
  }

  const hasManualCoords =
    lat != null &&
    lng != null &&
    Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lng));

  const baseForUpsert = {
    ...chamado,
    ...(hasManualCoords
      ? {
          mapaCoords: { lat: Number(lat), lng: Number(lng) },
          localizacao: {
            ...(chamado.localizacao || {}),
            lat: Number(lat),
            lng: Number(lng),
            metodo: 'ajuste_manual_casinha'
          }
        }
      : {}),
    ...(enderecoPatch
      ? {
          endereco: {
            ...(chamado.endereco || {}),
            ...(enderecoPatch.completo != null ? { completo: enderecoPatch.completo } : {}),
            ...(enderecoPatch.cidade != null ? { cidade: enderecoPatch.cidade } : {}),
            ...(enderecoPatch.numero != null ? { numero: enderecoPatch.numero } : {}),
            ...(enderecoPatch.cep != null ? { cep: enderecoPatch.cep } : {})
          }
        }
      : {}),
    analiseStatus: 'processando',
    updatedAt: new Date().toISOString()
  };

  await upsertChamado(baseForUpsert);

  try {
    const current = await findChamadoByPedidoOrCode({ id });
    const learned = await findLearnedTabulacaoForChamado(current);
    const result = await analisarLocalizacaoChamado(current, { learned });
    await upsertChamado({
      ...current,
      analiseStatus: result.analiseStatus,
      localizacao: result.localizacao,
      passosAnalise: result.passos,
      viabilidadeResumo: result.viabilidadeResumo,
      tabulacaoFinal: result.tabulacaoFinal ?? current.tabulacaoFinal,
      tabulacaoConfianca: result.tabulacaoConfianca ?? current.tabulacaoConfianca,
      tabulacaoStatus: result.tabulacaoStatus || current.tabulacaoStatus,
      analiseIa: result.analiseIa,
      updatedAt: new Date().toISOString()
    });

    return {
      chamado: await getChamadoById(id),
      skipped: false,
      result
    };
  } catch (err) {
    const current = (await findChamadoByPedidoOrCode({ id })) || chamado;
    await upsertChamado({
      ...current,
      analiseStatus: 'falhou',
      analiseIa: {
        modelo: 'cascata-localizacao-v1',
        motivoSugestao: err.message || 'Falha ao analisar localização'
      },
      updatedAt: new Date().toISOString()
    });
    throw err;
  }
}

/** Dispara análise sem bloquear a resposta do upsert (best-effort). */
export function analisarChamadoEmBackground(id) {
  setTimeout(() => {
    analisarChamadoById(id).catch((err) => {
      console.error('❌ [PortalCENSUP] Análise em background:', err.message || err);
    });
  }, 50);
}

export async function registerFeedback(id, { usuario, correto, tabulacaoCorrigida = null, enderecoSnapshot = null, cidadeSnapshot = null, origem = 'manual', tabulacaoSugeridaOverride = null }) {
  const chamado = await findChamadoByPedidoOrCode({ id });
  if (!chamado) {
    const err = new Error('Chamado não encontrado');
    err.statusCode = 404;
    throw err;
  }

  const end = chamado.endereco || {};
  const feedbackEntry = {
    id: crypto.randomUUID(),
    chamadoId: id,
    pedido: chamado.pedido,
    usuario,
    correto: correto === true,
    tabulacaoSugerida:
      tabulacaoSugeridaOverride ||
      chamado.analiseIa?.tabulacaoSugerida ||
      chamado.tabulacaoFinal ||
      null,
    tabulacaoCorrigida: correto === true
      ? (tabulacaoSugeridaOverride || chamado.tabulacaoFinal)
      : tabulacaoCorrigida,
    endereco:
      enderecoSnapshot ||
      end.completo ||
      null,
    cidade: cidadeSnapshot || end.cidade || chamado.cidade || null,
    origem: origem || 'manual',
    createdAt: new Date().toISOString()
  };

  const next = {
    ...chamado,
    updatedAt: feedbackEntry.createdAt
  };

  if (correto === true) {
    next.tabulacaoStatus = 'aprovada';
    next.filaStatus = 'finalizada';
  } else if (tabulacaoCorrigida) {
    next.tabulacaoFinal = tabulacaoCorrigida;
    next.tabulacaoStatus = 'corrigida';
    next.filaStatus = 'finalizada';
  }

  await upsertChamado(next);

  const store = await readStore();
  store.feedback = Array.isArray(store.feedback) ? store.feedback : [];
  store.feedback.unshift(feedbackEntry);
  store.feedback = store.feedback.slice(0, 2000);
  await writeStore(store);

  return {
    chamado: await getChamadoById(id),
    feedback: feedbackEntry
  };
}

function normalizeLearnText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function findLearnedTabulacaoForChamado(chamado) {
  const store = await readStore();
  const feedback = Array.isArray(store.feedback) ? store.feedback : [];
  if (!feedback.length) return null;

  const endereco = normalizeLearnText(chamado?.endereco?.completo);
  const cidade = normalizeLearnText(chamado?.endereco?.cidade || chamado?.cidade);

  const exact = feedback.find((fb) => {
    if (!fb?.tabulacaoCorrigida || fb.correto === true) return false;
    const fbEnd = normalizeLearnText(fb.endereco);
    return endereco && fbEnd && fbEnd === endereco;
  });
  if (exact) {
    return {
      tabulacaoFinal: exact.tabulacaoCorrigida,
      confianca: 0.88,
      motivo: `Mesmo endereço já corrigido anteriormente para “${exact.tabulacaoCorrigida}”.`
    };
  }

  const byCityCounts = {};
  for (const fb of feedback) {
    if (!fb?.tabulacaoCorrigida || fb.correto === true) continue;
    const fbCity = normalizeLearnText(fb.cidade);
    if (!fbCity || fbCity !== cidade) continue;
    byCityCounts[fb.tabulacaoCorrigida] = (byCityCounts[fb.tabulacaoCorrigida] || 0) + 1;
  }

  if (cidade) {
    const ranked = Object.entries(byCityCounts).sort((a, b) => b[1] - a[1]);
    if (ranked[0] && ranked[0][1] >= 3) {
      return {
        tabulacaoFinal: ranked[0][0],
        confianca: 0.72,
        motivo: `Padrão de correções na cidade ${chamado?.cidade || cidade}: “${ranked[0][0]}”.`
      };
    }
  }

  return null;
}

export async function salvarRelatorioWorkbench(id, { usuario, report = {}, persist = true } = {}) {
  const chamado = await findChamadoByPedidoOrCode({ id });
  if (!chamado) {
    const err = new Error('Chamado não encontrado');
    err.statusCode = 404;
    throw err;
  }

  const numeroALA = String(report.numeroALA || chamado.pedido || '').replace(/\D/g, '');
  const cidade = String(report.cidade || chamado.endereco?.cidade || chamado.cidade || '').trim();
  const enderecoCompleto = String(report.enderecoCompleto || chamado.endereco?.completo || '').trim();
  const numeroEndereco = String(report.numeroEndereco || chamado.endereco?.numero || '').trim();
  const cep = String(report.cep || chamado.endereco?.cep || '').trim();
  const tabulacaoFinal = String(report.tabulacaoFinal || '').trim();
  const projetista = String(report.projetista || usuario || '').trim();
  const sugeridaOriginal = String(
    report.tabulacaoSugeridaOriginal ||
      chamado.analiseIa?.tabulacaoSugerida ||
      chamado.tabulacaoFinal ||
      ''
  ).trim();

  if (!tabulacaoFinal) {
    const err = new Error('Tabulação Final é obrigatória');
    err.statusCode = 400;
    throw err;
  }

  const next = {
    ...chamado,
    pedido: numeroALA || chamado.pedido,
    cidade: cidade || chamado.cidade,
    endereco: {
      ...(chamado.endereco || {}),
      completo: enderecoCompleto || chamado.endereco?.completo || null,
      numero: numeroEndereco || chamado.endereco?.numero || null,
      cep: cep || chamado.endereco?.cep || null,
      cidade: cidade || chamado.endereco?.cidade || null
    },
    tabulacaoFinal,
    viabilidadeResumo: {
      ...(chamado.viabilidadeResumo || {}),
      projetista: projetista || chamado.viabilidadeResumo?.projetista || null
    },
    relatorio: {
      numeroALA: numeroALA || null,
      cidade,
      enderecoCompleto,
      numeroEndereco,
      cep,
      tabulacaoFinal,
      projetista,
      savedAt: new Date().toISOString(),
      savedBy: usuario || null
    },
    updatedAt: new Date().toISOString()
  };

  const pdfHtml = buildChamadoPdfHtml(next);
  next.pdfHtml = pdfHtml;

  let corrected = false;
  if (persist) {
    const suggested = sugeridaOriginal || chamado.tabulacaoFinal || '';
    corrected =
      !!suggested &&
      normalizeLearnText(suggested) !== normalizeLearnText(tabulacaoFinal);

    next.tabulacaoStatus = corrected ? 'corrigida' : 'aprovada';
    next.filaStatus = 'finalizada';
    next.relatorioSalvo = true;
    next.relatorioSalvoAt = next.updatedAt;

    await upsertChamado(next);

    if (corrected) {
      await registerFeedback(id, {
        usuario,
        correto: false,
        tabulacaoCorrigida: tabulacaoFinal,
        tabulacaoSugeridaOverride: suggested,
        enderecoSnapshot: enderecoCompleto,
        cidadeSnapshot: cidade,
        origem: 'workbench_implicito'
      });
    } else {
      await registerFeedback(id, {
        usuario,
        correto: true,
        tabulacaoSugeridaOverride: suggested || tabulacaoFinal,
        enderecoSnapshot: enderecoCompleto,
        cidadeSnapshot: cidade,
        origem: 'workbench_implicito'
      });
    }
  }

  return {
    chamado: persist ? await getChamadoById(id) : { ...next, pdfHtml },
    pdfHtml,
    corrected,
    persisted: persist === true
  };
}
