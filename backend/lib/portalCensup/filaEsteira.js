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

/**
 * Registra pedidos vistos na Agenda.
 * - Pedido sem dono + há online → atribui (esteira)
 * - Pedido sem dono + ninguém online → data/hora na lista
 * - Pedido já com usuarioFila → mantém (não troca dono)
 */
export function registrarPedidosNaEsteira(items = []) {
  const store = readStore();
  const onlineCount = listCensupSyncOnline().length;
  let created = 0;
  let assigned = 0;
  let changed = false;
  const map = {};

  for (const item of items || []) {
    const pedido = normalizePedido(item?.pedido);
    if (!pedido) continue;

    const existing = store.assignments[pedido];

    // Já tem dono: só devolve
    if (existing?.usuarioFila) {
      map[pedido] = {
        usuarioFila: existing.usuarioFila,
        atribuidoEm: existing.atribuidoEm || null,
        vistoEm: existing.vistoEm || null,
        dataSituacao: existing.dataSituacao || item.dataSituacao || null,
        situacaoAgenda: existing.situacaoAgenda || item.situacao || null
      };
      continue;
    }

    // Sem dono (novo ou órfão): atribui se houver alguém online agora
    const assignee = onlineCount > 0 ? pickNextCensupSyncAssignee() : null;
    const now = new Date().toISOString();

    if (existing) {
      if (assignee) {
        existing.usuarioFila = assignee;
        existing.atribuidoEm = now;
        existing.onlineNoMomento = onlineCount;
        assigned += 1;
        changed = true;
      }
      if (item.dataSituacao || item.dataSituacaoRaw) {
        existing.dataSituacao = item.dataSituacao || item.dataSituacaoRaw;
      }
      if (item.situacao) existing.situacaoAgenda = item.situacao;
      map[pedido] = {
        usuarioFila: existing.usuarioFila || null,
        atribuidoEm: existing.atribuidoEm || null,
        vistoEm: existing.vistoEm || null,
        dataSituacao: existing.dataSituacao || null,
        situacaoAgenda: existing.situacaoAgenda || null
      };
      continue;
    }

    const entry = {
      pedido,
      usuarioFila: assignee,
      atribuidoEm: assignee ? now : null,
      vistoEm: now,
      dataSituacao: item.dataSituacao || item.dataSituacaoRaw || null,
      situacaoAgenda: item.situacao || null,
      motivo: item.motivo || null,
      onlineNoMomento: onlineCount
    };
    store.assignments[pedido] = entry;
    created += 1;
    changed = true;
    if (assignee) assigned += 1;
    map[pedido] = {
      usuarioFila: entry.usuarioFila,
      atribuidoEm: entry.atribuidoEm,
      vistoEm: entry.vistoEm,
      dataSituacao: entry.dataSituacao,
      situacaoAgenda: entry.situacaoAgenda
    };
  }

  if (changed) writeStore(store);

  return {
    created,
    assigned,
    onlineCount,
    assignments: map
  };
}

export function getAtribuicoesPorPedidos(pedidos = []) {
  const store = readStore();
  const map = {};
  for (const raw of pedidos || []) {
    const pedido = normalizePedido(raw);
    if (!pedido) continue;
    const existing = store.assignments[pedido];
    if (!existing) continue;
    map[pedido] = {
      usuarioFila: existing.usuarioFila || null,
      atribuidoEm: existing.atribuidoEm || null,
      vistoEm: existing.vistoEm || null,
      dataSituacao: existing.dataSituacao || null,
      situacaoAgenda: existing.situacaoAgenda || null
    };
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
