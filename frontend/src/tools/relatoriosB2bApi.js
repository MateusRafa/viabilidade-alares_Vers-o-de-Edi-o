import { getApiUrl } from '../config.js';

function authHeaders(currentUser) {
  return {
    'Content-Type': 'application/json',
    'X-Usuario': currentUser || ''
  };
}

async function parseJsonResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Erro HTTP ${res.status}`);
  }
  return data;
}

/** Lista relatórios para os dashboards (filtro por status, setor e busca). */
export async function fetchRelatoriosB2b(currentUser, { status, q, limit, setorOrigem } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  if (limit) params.set('limit', String(limit));
  if (setorOrigem) params.set('setorOrigem', setorOrigem);

  const qs = params.toString();
  const url = getApiUrl(`/api/relatorios-b2b${qs ? `?${qs}` : ''}`);

  const res = await fetch(url, { headers: authHeaders(currentUser) });
  const data = await parseJsonResponse(res);
  return data.relatorios || [];
}

/** Carrega um relatório completo para editar no formulário. */
export async function fetchRelatorioB2bById(currentUser, id, { payloadTipo = 'projetos' } = {}) {
  const url = getApiUrl(
    `/api/relatorios-b2b/${encodeURIComponent(id)}?payloadTipo=${encodeURIComponent(payloadTipo)}`
  );
  const res = await fetch(url, { headers: authHeaders(currentUser) });
  const data = await parseJsonResponse(res);
  return data.relatorio;
}

/** Cria relatório novo (payload = formData do front). */
export async function createRelatorioB2b(
  currentUser,
  { payload, payloadTipo = 'projetos', status = 'em_analise', setorOrigem }
) {
  const res = await fetch(getApiUrl('/api/relatorios-b2b'), {
    method: 'POST',
    headers: authHeaders(currentUser),
    body: JSON.stringify({ payload, payloadTipo, status, setorOrigem })
  });
  const data = await parseJsonResponse(res);
  return data.relatorio;
}

/** Exclui relatório permanentemente. */
export async function deleteRelatorioB2b(currentUser, id) {
  const res = await fetch(getApiUrl(`/api/relatorios-b2b/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: authHeaders(currentUser)
  });
  return parseJsonResponse(res);
}

/** Atualiza relatório existente. */
export async function updateRelatorioB2b(
  currentUser,
  id,
  { payload, payloadTipo, status, setorOrigem } = {}
) {
  const body = {};
  if (payload !== undefined) body.payload = payload;
  if (payloadTipo !== undefined) body.payloadTipo = payloadTipo;
  if (status !== undefined) body.status = status;
  if (setorOrigem !== undefined) body.setorOrigem = setorOrigem;

  const res = await fetch(getApiUrl(`/api/relatorios-b2b/${encodeURIComponent(id)}`), {
    method: 'PUT',
    headers: authHeaders(currentUser),
    body: JSON.stringify(body)
  });
  const data = await parseJsonResponse(res);
  return data.relatorio;
}

export const RELATORIO_STATUS = {
  EM_ANALISE: 'em_analise',
  EM_IMPLANTACAO: 'em_implantacao',
  FINALIZADO: 'finalizado'
};

export const PAYLOAD_TIPO = {
  PROJETOS: 'projetos',
  IMPLANTACAO: 'implantacao'
};

export const SETOR_ORIGEM = {
  PROJETOS: 'projetos',
  IMPLANTACAO: 'implantacao'
};

/** Disparado após salvar/atualizar/transferir relatório — dashboards escutam para recarregar a lista. */
export const RELATORIOS_B2B_ATUALIZADOS_EVENT = 'relatorios-b2b-atualizados';

const RELATORIOS_B2B_BC_NAME = 'relatorios-b2b-sync';
/** @type {BroadcastChannel | null} */
let relatoriosB2bBc = null;

function getRelatoriosB2bBroadcastChannel() {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!relatoriosB2bBc) {
    relatoriosB2bBc = new BroadcastChannel(RELATORIOS_B2B_BC_NAME);
  }
  return relatoriosB2bBc;
}

export function notifyRelatoriosB2bAtualizados() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(RELATORIOS_B2B_ATUALIZADOS_EVENT));
  }
  getRelatoriosB2bBroadcastChannel()?.postMessage({ type: RELATORIOS_B2B_ATUALIZADOS_EVENT });
}

/** Inscreve recarga dos dashboards (mesma aba + outras abas). Retorna função para cancelar. */
export function subscribeRelatoriosB2bAtualizados(callback) {
  if (typeof window === 'undefined') return () => {};

  let dedupe = false;
  const run = () => {
    if (dedupe) return;
    dedupe = true;
    queueMicrotask(() => {
      dedupe = false;
      callback();
    });
  };

  window.addEventListener(RELATORIOS_B2B_ATUALIZADOS_EVENT, run);

  const bc = getRelatoriosB2bBroadcastChannel();
  const onBc = (event) => {
    if (event.data?.type === RELATORIOS_B2B_ATUALIZADOS_EVENT) run();
  };
  bc?.addEventListener('message', onBc);

  return () => {
    window.removeEventListener(RELATORIOS_B2B_ATUALIZADOS_EVENT, run);
    bc?.removeEventListener('message', onBc);
  };
}

export function statusLabelForList(status) {
  if (status === RELATORIO_STATUS.EM_IMPLANTACAO) return 'Em Implantação';
  if (status === RELATORIO_STATUS.FINALIZADO) return 'Projetos Finalizados';
  return 'Em Análise';
}

/** Atualiza a lista no cliente após transferir, finalizar ou excluir (sem piscar o layout). */
export function applyRelatorioListAction(relatorios, type, item) {
  if (type === 'excluir') {
    return relatorios.filter((r) => r.id !== item.id);
  }
  if (type === 'transferirParaEdicao') {
    return relatorios.filter((r) => r.id !== item.id);
  }
  const nextStatus =
    type === 'transferir' ? RELATORIO_STATUS.EM_IMPLANTACAO : RELATORIO_STATUS.FINALIZADO;
  return relatorios.map((r) =>
    r.id === item.id
      ? { ...r, status: nextStatus, statusLabel: statusLabelForList(nextStatus) }
      : r
  );
}
