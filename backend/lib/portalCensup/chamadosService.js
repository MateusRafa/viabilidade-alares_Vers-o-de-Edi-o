import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { analisarLocalizacaoChamado } from './analiseLocalizacao.js';
import { isPortalCensupSupabaseAvailable } from './supabaseCensup.js';
import { dbFindChamado, dbListAllChamados, dbListChamadosNaFila, dbReconcileChamadosComAgenda, dbRestoreChamadosSalvosArquivados, dbUpsertChamado, stripHeavyPersistFields } from './chamadosDb.js';
import { peekAtribuicaoPedido } from './filaEsteira.js';

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

const TZ_BR = 'America/Sao_Paulo';

function parseSituacaoDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;

  // Agenda: relógio de Brasília (sem DST desde 2019)
  const br = raw.match(
    /(\d{2})\/(\d{2})\/(\d{4})(?:,?\s*(\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (br) {
    const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = br;
    const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}-03:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Divide "18/09/2026, 14:18:45" da Agenda sem converter fuso. */
function splitAgendaDataHora(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const m = raw.match(/(\d{2}\/\d{2}\/\d{4})(?:,?\s*(\d{2}:\d{2}(?::\d{2})?))?/);
  if (!m) return null;
  let hora = m[2] || '';
  if (hora && /^\d{2}:\d{2}$/.test(hora)) hora = `${hora}:00`;
  return { data: m[1], hora: hora || null };
}

function formatDataSituacao(value) {
  const split = splitAgendaDataHora(value);
  if (split?.data) return split.data;

  const d = parseSituacaoDate(value);
  if (!d) return value ? String(value) : '—';
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: TZ_BR
  });
}

/** Hora com segundos — Agenda / SALVO EM. */
function formatHoraCompleta(value) {
  const split = splitAgendaDataHora(value);
  if (split?.hora) return split.hora;

  const d = parseSituacaoDate(value);
  if (!d) return '—';
  return d.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: TZ_BR
  });
}

function resolveDataSituacaoSource(item) {
  return item?.dataSituacaoRaw || item?.dataSituacao || null;
}

function resolveHoraFechamentoIso(item) {
  return (
    item?.relatorioSalvoAt ||
    item?.relatorio?.savedAt ||
    item?.geradoEm ||
    (item?.filaStatus === 'finalizada' || item?.relatorioSalvo === true
      ? item?.updatedAt
      : null) ||
    null
  );
}

function withPortalListLabels(item) {
  const chegada = resolveDataSituacaoSource(item);
  return {
    ...item,
    dataSituacaoLabel: formatDataSituacao(chegada),
    horaAberturaLabel: formatHoraCompleta(chegada),
    horaFechamentoLabel: formatHoraCompleta(resolveHoraFechamentoIso(item)),
    situacaoLabel: formatSituacaoLabel(item)
  };
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

export function resolveResultadoFinal(chamado) {
  const explicit = String(chamado?.resultadoFinal || chamado?.relatorio?.resultadoFinal || '')
    .trim()
    .toLowerCase();
  if (explicit === 'aprovado' || explicit === 'reprovado') return explicit;

  const tab = String(
    chamado?.tabulacaoFinal || chamado?.relatorio?.tabulacaoFinal || ''
  ).trim();
  if (!tab) return null;
  return /^aprovado\b/i.test(tab) ? 'aprovado' : 'reprovado';
}

export function formatSituacaoLabel(chamado) {
  const fila = chamado?.filaStatus || 'na_fila';
  const salvo = chamado?.relatorioSalvo === true || fila === 'finalizada';

  if (salvo) {
    const resultado = resolveResultadoFinal(chamado);
    if (resultado === 'aprovado') return 'Aprovado';
    if (resultado === 'reprovado') return 'Reprovado';
    return 'Finalizado';
  }

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

/** Evita gravar/exibir o texto literal "null" / "undefined". */
function cleanText(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || /^null$/i.test(s) || /^undefined$/i.test(s)) return null;
  return s;
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
      const conectadas = Math.max(0, Number(cto.clientes_conectados ?? cto.portasConectadas ?? 0));
      let total = Math.max(0, Number(cto.vagas_total ?? cto.totalPortas ?? 0));
      if (total < conectadas) total = conectadas;
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
  const mapPreviewRaw =
    chamado.mapPreviewImage ||
    chamado.relatorio?.mapPreviewImage ||
    chamado.previewImage ||
    '';
  // data:image base64 do Workbench — usar sem escape que quebre o data URL
  const mapPreviewSrc =
    typeof mapPreviewRaw === 'string' && mapPreviewRaw.startsWith('data:image')
      ? mapPreviewRaw
      : mapPreviewRaw
        ? escapeHtml(mapPreviewRaw)
        : '';
  const coordsTxt =
    lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng)
      ? `${lat.toFixed(6)}, ${lng.toFixed(6)}`
      : '—';

  const ctoRows =
    ctos.length > 0
      ? ctos
          .map((cto, index) => {
            const conectadas = Math.max(0, Number(cto.clientes_conectados ?? cto.portasConectadas ?? 0));
            let total = Math.max(0, Number(cto.vagas_total ?? cto.totalPortas ?? 0));
            // Base inconsistente (ex.: total 0 e conectadas 8) → total = conectadas
            if (total < conectadas) total = conectadas;
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

  const mapImgSrc = mapPreviewSrc || (mapUrl ? escapeHtml(mapUrl) : '');
  const mapSection = mapImgSrc
    ? `
              <div class="map-section">
                <h2>Visualização do Mapa</h2>
                <div class="map-wrapper">
                  <div class="map-image-container">
                    <img src="${mapImgSrc}" alt="Mapa com localização do cliente" class="map-image" />
                  </div>
                </div>
              </div>`
    : `
              <div class="map-section">
                <h2>Visualização do Mapa</h2>
                <div class="map-placeholder">
                  Mapa indisponível — o relatório ainda não tem prévia capturada.
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
  const items = filtered.slice(start, start + safeLimit).map((item) => withPortalListLabels(item));

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
  return (chamados || []).map((item) => {
    const light = { ...item };
    delete light.pdfHtml;
    delete light.mapPreviewImage;
    delete light.previewImage;
    if (light.relatorio && typeof light.relatorio === 'object') {
      const rel = { ...light.relatorio };
      delete rel.mapPreviewImage;
      delete rel.previewImage;
      delete rel.pdfHtml;
      light.relatorio = rel;
    }
    return withPortalListLabels(light);
  });
}

export function resolvePortalCensupFilaStatus(view = 'pendentes') {
  return view === 'resolvidos' ? 'finalizada' : 'na_fila';
}

export async function listChamados({ q = '', page = 1, limit = 10, view = 'pendentes' } = {}) {
  const filaStatus = resolvePortalCensupFilaStatus(view);

  if (isPortalCensupSupabaseAvailable()) {
    // Recupera salvos que o reconcile antigo marcou como executada_agenda
    if (filaStatus === 'finalizada') {
      try {
        await dbRestoreChamadosSalvosArquivados();
      } catch (err) {
        console.warn('⚠️ [PortalCENSUP] Falha ao restaurar salvos arquivados:', err.message);
      }
    }

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

  // JSON local: restaurar salvos arquivados por engano
  if (filaStatus === 'finalizada') {
    const store = await readStore();
    let restored = 0;
    for (const item of store.chamados) {
      const isSalvo =
        item.relatorioSalvo === true ||
        !!(item.pdfHtml || item.relatorio);
      if (item.filaStatus === 'executada_agenda' && isSalvo) {
        item.filaStatus = 'finalizada';
        restored += 1;
      }
    }
    if (restored > 0) {
      await writeStore(store);
      console.log(`✅ [PortalCENSUP] ${restored} relatório(s) salvo(s) restaurado(s) no JSON local.`);
    }
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
    const jaFinalizado =
      chamado.filaStatus === 'finalizada' || chamado.relatorioSalvo === true;
    if (!jaFinalizado) {
      chamado = (await claimChamadoForAnalise(id, usuario)) || chamado;
    }
  }

  // Relatório finalizado: prévia montada sob demanda (não depende de pdfHtml no banco)
  const savedPdfHtml =
    chamado.relatorioSalvo && typeof chamado.pdfHtml === 'string' && chamado.pdfHtml.trim()
      ? chamado.pdfHtml
      : null;

  return {
    ...withPortalListLabels(chamado),
    // Preferir HTML salvo legado se ainda existir; senão remontar (mapa estático leve)
    pdfHtml: savedPdfHtml || buildChamadoPdfHtml(chamado)
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
 * Chamados que sumiram da Agenda saem da fila pendente (na_fila → executada_agenda).
 * Relatórios finalizados/salvos NUNCA são arquivados — ficam no Portal para sempre.
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
    const isSalvo =
      item.relatorioSalvo === true ||
      status === 'finalizada' ||
      !!(item.pdfHtml || item.relatorio);

    // Atualizar situação da Agenda só em pendentes (não sobrescrever arquivo salvo)
    if (!isSalvo && pedido && situacaoMap.has(pedido)) {
      const novaSituacao = situacaoMap.get(pedido);
      if (novaSituacao && novaSituacao !== item.situacao) {
        item.situacao = novaSituacao;
        situacoesAtualizadas += 1;
      }
    }

    // Só arquiva pendentes da fila — nunca finalizados/salvos
    if (status !== 'na_fila' || isSalvo) continue;
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

  // Esteira: se o pedido já foi atribuído na Agenda, grava no chamado
  let esteiraUsuario = previous.usuarioFila || payload.usuarioFila || null;
  let esteiraEm = previous.filaAtribuidaEm || payload.filaAtribuidaEm || null;
  if (!esteiraUsuario && payload.pedido) {
    try {
      const atr = peekAtribuicaoPedido(payload.pedido);
      if (atr?.usuarioFila) {
        esteiraUsuario = atr.usuarioFila;
        esteiraEm = atr.atribuidoEm || now;
      }
    } catch {
      /* ignore */
    }
  }

  const next = {
    ...previous,
    ...payload,
    id,
    filaStatus: payload.filaStatus || previous.filaStatus || 'na_fila',
    usuarioFila: esteiraUsuario || previous.usuarioFila || null,
    filaAtribuidaEm: esteiraEm || previous.filaAtribuidaEm || null,
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

  const toPersist = stripHeavyPersistFields(next);

  const store = await readStore();
  const existingIndex = store.chamados.findIndex(
    (item) => item.id === id || (toPersist.pedido && String(item.pedido) === String(toPersist.pedido))
  );
  if (existingIndex >= 0) {
    store.chamados[existingIndex] = {
      ...stripHeavyPersistFields(store.chamados[existingIndex]),
      ...toPersist
    };
  } else store.chamados.unshift(toPersist);
  await writeStore(store);

  if (!isPortalCensupSupabaseAvailable()) {
    console.warn(
      `⚠️ [PortalCENSUP] Pedido ${toPersist.pedido} salvo só no JSON. Configure PORTAL_CENSUP_SUPABASE_URL e PORTAL_CENSUP_SUPABASE_SERVICE_KEY no backend Railway.`
    );
    toPersist.persistedToSupabase = false;
    toPersist.supabaseError =
      'Supabase CENSUP não configurado neste processo. Confira as variáveis no serviço backend e faça Redeploy.';
    return toPersist;
  }

  try {
    const saved = await dbUpsertChamado(toPersist);
    console.log(`✅ [PortalCENSUP] Pedido ${toPersist.pedido} gravado na tabela chamados do Supabase`);
    return { ...(saved || toPersist), persistedToSupabase: true };
  } catch (err) {
    console.error(`❌ [PortalCENSUP] Pedido ${toPersist.pedido} NÃO gravou no Supabase:`, err.message);
    toPersist.persistedToSupabase = false;
    toPersist.supabaseError = err.message;
    return toPersist;
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

export async function salvarRelatorioWorkbench(id, { usuario, report = {}, persist = true, seed = null } = {}) {
  let chamado = await findChamadoByPedidoOrCode({ id, pedido: id });

  // Primeira finalização: cria o chamado no Portal só agora (não na abertura da extensão)
  if (!chamado) {
    const pedido =
      String(report.numeroALA || seed?.pedido || id || '')
        .replace(/\D/g, '') || String(id || '').trim();
    if (!pedido) {
      const err = new Error('Chamado não encontrado e sem pedido para criar');
      err.statusCode = 404;
      throw err;
    }

    const seedEnd = seed?.endereco && typeof seed.endereco === 'object' ? seed.endereco : {};
    const lat =
      report.latitude != null
        ? Number(report.latitude)
        : seed?.mapaCoords?.lat ?? seed?.localizacao?.lat ?? seed?.lat ?? null;
    const lng =
      report.longitude != null
        ? Number(report.longitude)
        : seed?.mapaCoords?.lng ?? seed?.localizacao?.lng ?? seed?.lng ?? null;

    chamado = await upsertChamado({
      pedido,
      agendaCode: cleanText(seed?.agendaCode) || null,
      uf: cleanText(seed?.uf) || cleanText(seedEnd.uf) || null,
      cidade:
        cleanText(report.cidade) ||
        cleanText(seed?.cidade) ||
        cleanText(seedEnd.cidade) ||
        null,
      sistema: cleanText(seed?.sistema) || null,
      pdv: cleanText(seed?.pdv) || null,
      motivo: cleanText(seed?.motivo) || null,
      situacao: cleanText(seed?.situacao) || null,
      dataSituacao:
        parseSituacaoDate(seed?.dataSituacao || seed?.dataSituacaoRaw)?.toISOString() ||
        seed?.dataSituacao ||
        seed?.dataSituacaoRaw ||
        null,
      dataSituacaoRaw: cleanText(seed?.dataSituacaoRaw || seed?.dataSituacao) || null,
      endereco: {
        ...seedEnd,
        completo:
          cleanText(report.enderecoCompleto) ||
          cleanText(seedEnd.completo) ||
          cleanText(seed?.enderecoCompleto) ||
          null,
        numero:
          cleanText(report.numeroEndereco) ||
          cleanText(seedEnd.numero) ||
          cleanText(seed?.numeroEndereco) ||
          null,
        cep: cleanText(report.cep) || cleanText(seedEnd.cep) || cleanText(seed?.cep) || null,
        cidade:
          cleanText(report.cidade) ||
          cleanText(seedEnd.cidade) ||
          cleanText(seed?.cidade) ||
          null,
        uf: cleanText(seed?.uf) || cleanText(seedEnd.uf) || null
      },
      mapaCoords:
        lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng)
          ? { lat, lng }
          : seed?.mapaCoords || seed?.localizacao || null,
      origem: 'workbench-finalize',
      agendaUrl: cleanText(seed?.agendaUrl) || null,
      filaStatus: 'na_fila'
    });
  }

  // Completa meta vazia com o seed (casos já criados sem UF/PDV/etc.)
  if (seed && typeof seed === 'object') {
    const seedEnd = seed.endereco && typeof seed.endereco === 'object' ? seed.endereco : {};
    chamado = {
      ...chamado,
      uf: cleanText(chamado.uf) || cleanText(seed.uf) || cleanText(seedEnd.uf) || null,
      sistema: cleanText(chamado.sistema) || cleanText(seed.sistema) || null,
      pdv: cleanText(chamado.pdv) || cleanText(seed.pdv) || null,
      motivo: cleanText(chamado.motivo) || cleanText(seed.motivo) || null,
      situacao: cleanText(chamado.situacao) || cleanText(seed.situacao) || null,
      dataSituacao:
        chamado.dataSituacao ||
        parseSituacaoDate(seed.dataSituacao || seed.dataSituacaoRaw)?.toISOString() ||
        seed.dataSituacao ||
        seed.dataSituacaoRaw ||
        null,
      dataSituacaoRaw:
        cleanText(chamado.dataSituacaoRaw) ||
        cleanText(seed.dataSituacaoRaw || seed.dataSituacao) ||
        null,
      cidade:
        cleanText(chamado.cidade) ||
        cleanText(seed.cidade) ||
        cleanText(seedEnd.cidade) ||
        null
    };
  }

  const numeroALA = String(report.numeroALA || chamado.pedido || '').replace(/\D/g, '');
  const cidade = cleanText(report.cidade) || cleanText(chamado.endereco?.cidade) || cleanText(chamado.cidade) || '';
  const enderecoCompleto =
    cleanText(report.enderecoCompleto) || cleanText(chamado.endereco?.completo) || '';
  const numeroEndereco =
    cleanText(report.numeroEndereco) || cleanText(chamado.endereco?.numero) || '';
  const cep = cleanText(report.cep) || cleanText(chamado.endereco?.cep) || '';
  const tabulacaoFinal = cleanText(report.tabulacaoFinal) || '';
  const projetista = cleanText(report.projetista) || cleanText(usuario) || '';
  const sugeridaOriginal = cleanText(
    report.tabulacaoSugeridaOriginal ||
      chamado.analiseIa?.tabulacaoSugerida ||
      chamado.tabulacaoFinal ||
      ''
  ) || '';

  if (!tabulacaoFinal) {
    const err = new Error('Tabulação Final é obrigatória');
    err.statusCode = 400;
    throw err;
  }

  const mapPreviewImage = String(
    report.mapPreviewImage || report.previewImage || chamado.mapPreviewImage || ''
  ).trim();
  const clientPdfHtml = String(report.pdfHtml || '').trim();
  const resultadoFinal =
    resolveResultadoFinal({ tabulacaoFinal }) || 'reprovado';
  const fechamentoIso = (() => {
    const geradoEmDate = parseSituacaoDate(report.geradoEm || report.geradoEmAt || null);
    return geradoEmDate ? geradoEmDate.toISOString() : new Date().toISOString();
  })();

  const next = {
    ...chamado,
    pedido: numeroALA || chamado.pedido,
    uf: cleanText(chamado.uf) || null,
    sistema: cleanText(chamado.sistema) || null,
    pdv: cleanText(chamado.pdv) || null,
    motivo: cleanText(chamado.motivo) || null,
    cidade: cidade || cleanText(chamado.cidade) || null,
    endereco: {
      ...(chamado.endereco || {}),
      completo: enderecoCompleto || chamado.endereco?.completo || null,
      numero: numeroEndereco || chamado.endereco?.numero || null,
      cep: cep || chamado.endereco?.cep || null,
      cidade: cidade || chamado.endereco?.cidade || null
    },
    tabulacaoFinal,
    resultadoFinal,
    viabilidadeResumo: {
      ...(chamado.viabilidadeResumo || {}),
      projetista: projetista || chamado.viabilidadeResumo?.projetista || null
    },
    // Mapa base64 só em memória para montar a resposta — NÃO vai para o banco
    ...(mapPreviewImage ? { mapPreviewImage } : {}),
    geradoEm: fechamentoIso,
    relatorioSalvoAt: fechamentoIso,
    relatorio: {
      numeroALA: numeroALA || null,
      cidade,
      enderecoCompleto,
      numeroEndereco,
      cep,
      tabulacaoFinal,
      projetista,
      resultadoFinal,
      savedAt: fechamentoIso,
      savedBy: usuario || null
      // sem mapPreviewImage — economiza dezenas/centenas de MB no JSONB
    },
    updatedAt: fechamentoIso
  };

  // HTML completo só para a resposta (SharePoint/Workbench); persistência é leve
  const pdfHtml = clientPdfHtml || buildChamadoPdfHtml(next);
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
    next.relatorioSalvoAt = fechamentoIso;

    // Grava metadados + CTOs/resumo; remove pdfHtml e mapa base64
    await upsertChamado(stripHeavyPersistFields(next));

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
    chamado: persist
      ? await getChamadoById(id)
      : { ...stripHeavyPersistFields(next), pdfHtml },
    pdfHtml,
    corrected,
    persisted: persist === true
  };
}
