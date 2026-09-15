/**
 * Esteira de atribuição de pedidos da Agenda → usuários com sync ligada.
 * Persistido em JSON local (sobrevive a restart do processo).
 */
import fs from 'fs';
import path from 'path';
import { pickNextCensupSyncAssignee, listCensupSyncOnline } from './presenceStore.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'portal-censup-fila-atribuicoes.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { assignments: {} };
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      assignments:
        parsed?.assignments && typeof parsed.assignments === 'object' ? parsed.assignments : {}
    };
  } catch {
    return { assignments: {} };
  }
}

function writeStore(store) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function normalizePedido(pedido) {
  return String(pedido || '').trim();
}

function normalizePersonName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function sameEsteiraPerson(a, b) {
  const na = normalizePersonName(a);
  const nb = normalizePersonName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Truncamento no badge ("Mateus T...") ou nome completo vs parcial
  if (na.startsWith(nb) || nb.startsWith(na)) return true;
  return false;
}

export function extractAnalistaFromSituacaoAgenda(situacao) {
  const match = String(situacao || '').match(/em\s+an[aá]lise\s+por\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function toPublicAssignment(entry, item = {}) {
  return {
    usuarioFila: entry?.usuarioFila || null,
    atribuidoEm: entry?.atribuidoEm || null,
    vistoEm: entry?.vistoEm || null,
    dataSituacao: entry?.dataSituacao || item.dataSituacao || null,
    situacaoAgenda: entry?.situacaoAgenda || item.situacao || null,
    liberadoPorAgenda: entry?.liberadoPorAgenda || null
  };
}

/**
 * Registra pedidos vistos na Agenda.
 * - Pedido sem dono + há online → atribui (esteira)
 * - Pedido sem dono + ninguém online → data/hora na lista
 * - Pedido com dono → mantém, exceto se Agenda mostrar "Em análise por" outra pessoa → vira órfão
 * - Órfão liberado pela Agenda não volta sozinho para a esteira (só via atribuição manual)
 */
export function registrarPedidosNaEsteira(items = []) {
  const store = readStore();
  const onlineCount = listCensupSyncOnline().length;
  let created = 0;
  let assigned = 0;
  let released = 0;
  let changed = false;
  const map = {};

  for (const item of items || []) {
    const pedido = normalizePedido(item?.pedido);
    if (!pedido) continue;

    const existing = store.assignments[pedido];
    const analistaAgenda = extractAnalistaFromSituacaoAgenda(item?.situacao);
    const now = new Date().toISOString();

    if (existing) {
      if (item.dataSituacao || item.dataSituacaoRaw) {
        existing.dataSituacao = item.dataSituacao || item.dataSituacaoRaw;
      }
      if (item.situacao) existing.situacaoAgenda = item.situacao;

      // Outro usuário pegou na Agenda → libera (padrão órfão)
      if (
        existing.usuarioFila &&
        analistaAgenda &&
        !sameEsteiraPerson(analistaAgenda, existing.usuarioFila)
      ) {
        existing.usuarioFila = null;
        existing.atribuidoEm = null;
        existing.liberadoPorAgenda = analistaAgenda;
        existing.liberadoEm = now;
        released += 1;
        changed = true;
      }

      // Já tem dono (ou acabou de liberar): não reaplica esteira automática
      if (existing.usuarioFila || existing.liberadoPorAgenda) {
        map[pedido] = toPublicAssignment(existing, item);
        continue;
      }

      // Sem dono e nunca liberado pela Agenda: pode atribuir se houver online
      const assignee = onlineCount > 0 ? pickNextCensupSyncAssignee() : null;
      if (assignee) {
        existing.usuarioFila = assignee;
        existing.atribuidoEm = now;
        existing.onlineNoMomento = onlineCount;
        existing.liberadoPorAgenda = null;
        existing.liberadoEm = null;
        assigned += 1;
        changed = true;
      }
      map[pedido] = toPublicAssignment(existing, item);
      continue;
    }

    const assignee = onlineCount > 0 ? pickNextCensupSyncAssignee() : null;
    const entry = {
      pedido,
      usuarioFila: assignee,
      atribuidoEm: assignee ? now : null,
      vistoEm: now,
      dataSituacao: item.dataSituacao || item.dataSituacaoRaw || null,
      situacaoAgenda: item.situacao || null,
      motivo: item.motivo || null,
      onlineNoMomento: onlineCount,
      liberadoPorAgenda: null,
      liberadoEm: null
    };

    // Se já chega "Em análise por" de alguém, não força esteira — fica órfão até claim
    if (analistaAgenda && (!assignee || !sameEsteiraPerson(analistaAgenda, assignee))) {
      entry.usuarioFila = null;
      entry.atribuidoEm = null;
      entry.liberadoPorAgenda = analistaAgenda;
      entry.liberadoEm = now;
    }

    store.assignments[pedido] = entry;
    created += 1;
    changed = true;
    if (entry.usuarioFila) assigned += 1;
    map[pedido] = toPublicAssignment(entry, item);
  }

  if (changed) writeStore(store);

  return {
    created,
    assigned,
    released,
    onlineCount,
    assignments: map
  };
}

/** Duplo clique / claim manual: dono passa a ser o usuário da extensão. */
export function atribuirPedidoNaEsteira(pedido, usuario) {
  const pedidoKey = normalizePedido(pedido);
  const nome = String(usuario || '').trim();
  if (!pedidoKey || !nome) {
    const err = new Error('Pedido e usuário são obrigatórios');
    err.statusCode = 400;
    throw err;
  }

  const store = readStore();
  const now = new Date().toISOString();
  const existing = store.assignments[pedidoKey] || {
    pedido: pedidoKey,
    vistoEm: now,
    dataSituacao: null,
    situacaoAgenda: null,
    motivo: null,
    onlineNoMomento: listCensupSyncOnline().length
  };

  existing.usuarioFila = nome;
  existing.atribuidoEm = now;
  existing.liberadoPorAgenda = null;
  existing.liberadoEm = null;
  existing.claimManual = true;
  store.assignments[pedidoKey] = existing;
  writeStore(store);

  return toPublicAssignment(existing);
}

export function getAtribuicoesPorPedidos(pedidos = []) {
  const store = readStore();
  const map = {};
  for (const raw of pedidos || []) {
    const pedido = normalizePedido(raw);
    if (!pedido) continue;
    const existing = store.assignments[pedido];
    if (!existing) continue;
    map[pedido] = toPublicAssignment(existing);
  }
  return map;
}

/** Ao criar chamado no Portal, aplica atribuição já decidida pela esteira (se houver). */
export function peekAtribuicaoPedido(pedido) {
  const pedidoKey = normalizePedido(pedido);
  if (!pedidoKey) return null;
  const store = readStore();
  return store.assignments[pedidoKey] || null;
}
