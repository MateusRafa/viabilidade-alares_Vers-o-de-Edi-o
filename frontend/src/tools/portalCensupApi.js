import { getApiUrl } from '../config.js';

function authHeaders(usuario) {
  return {
    'Content-Type': 'application/json',
    'X-Usuario': usuario || ''
  };
}

export async function fetchPortalCensupSupabaseStatus(usuario) {
  const response = await fetch(getApiUrl('/api/portal-censup/supabase-status'), {
    headers: authHeaders(usuario)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === undefined) {
    throw new Error(data.error || `Erro ao consultar Supabase (${response.status})`);
  }
  return data;
}

export async function syncPortalCensupSupabase(usuario) {
  const response = await fetch(getApiUrl('/api/portal-censup/sync-supabase'), {
    method: 'POST',
    headers: authHeaders(usuario)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !data) {
    throw new Error(`Erro ao sincronizar Supabase (${response.status})`);
  }
  return data;
}

export async function fetchPortalCensupChamados(usuario, { q = '', page = 1, limit = 10, view = 'pendentes' } = {}) {
  const params = new URLSearchParams({
    q,
    page: String(page),
    limit: String(limit),
    view
  });

  const response = await fetch(getApiUrl(`/api/portal-censup/chamados?${params}`), {
    headers: authHeaders(usuario)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Erro ao carregar chamados (${response.status})`);
  }

  return data;
}

export async function fetchPortalCensupChamadoById(usuario, id) {
  const response = await fetch(getApiUrl(`/api/portal-censup/chamados/${encodeURIComponent(id)}`), {
    headers: authHeaders(usuario)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Erro ao carregar chamado (${response.status})`);
  }

  return data.chamado;
}

export async function sendPortalCensupFeedback(usuario, id, { correto, tabulacaoCorrigida }) {
  const response = await fetch(getApiUrl(`/api/portal-censup/chamados/${encodeURIComponent(id)}/feedback`), {
    method: 'POST',
    headers: authHeaders(usuario),
    body: JSON.stringify({ correto, tabulacaoCorrigida })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Erro ao registrar feedback (${response.status})`);
  }

  return data;
}

export async function analisarPortalCensupChamado(
  usuario,
  id,
  { force = false, lat = null, lng = null, endereco = null } = {}
) {
  const body = { force };
  if (lat != null && lng != null && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng))) {
    body.lat = Number(lat);
    body.lng = Number(lng);
  }
  if (endereco && typeof endereco === 'object') {
    body.endereco = endereco;
  }

  const response = await fetch(
    getApiUrl(`/api/portal-censup/chamados/${encodeURIComponent(id)}/analisar`),
    {
      method: 'POST',
      headers: authHeaders(usuario),
      body: JSON.stringify(body)
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Erro ao analisar chamado (${response.status})`);
  }

  return data;
}

export async function fetchTabulacoesList() {
  const response = await fetch(getApiUrl('/api/tabulacoes'), {
    cache: 'no-store',
    headers: { Accept: 'application/json' }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    // Fallback mínimo — a lista real vem do Supabase/API (igual ao oficial)
    return [
      'Aprovado Com Portas',
      'Aprovado Com Alívio de Rede/Cleanup',
      'Aprovado Prédio Não Cabeado',
      'Aprovado - Endereço não Localizado',
      'Fora da Área de Cobertura',
      'MDU não adequada'
    ];
  }
  return Array.isArray(data.tabulacoes) ? data.tabulacoes : [];
}

export async function fetchAgendaBotStatus(usuario) {
  const response = await fetch(getApiUrl('/api/portal-censup/agenda-bot/status'), {
    headers: authHeaders(usuario)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Erro ao consultar bot (${response.status})`);
  }
  return data.status;
}

export async function startAgendaBot(usuario) {
  const response = await fetch(getApiUrl('/api/portal-censup/agenda-bot/start'), {
    method: 'POST',
    headers: authHeaders(usuario)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Erro ao iniciar bot (${response.status})`);
  }
  return data.status;
}

export async function stopAgendaBot(usuario) {
  const response = await fetch(getApiUrl('/api/portal-censup/agenda-bot/stop'), {
    method: 'POST',
    headers: authHeaders(usuario)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Erro ao parar bot (${response.status})`);
  }
  return data.status;
}

export async function syncAgendaBot(usuario) {
  const response = await fetch(getApiUrl('/api/portal-censup/agenda-bot/sync'), {
    method: 'POST',
    headers: authHeaders(usuario)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Erro ao sincronizar bot (${response.status})`);
  }
  return data.status;
}

export async function uploadAgendaBotSession(usuario, session) {
  const response = await fetch(getApiUrl('/api/portal-censup/agenda-bot/session'), {
    method: 'POST',
    headers: authHeaders(usuario),
    body: JSON.stringify({ session })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Erro ao salvar sessão (${response.status})`);
  }
  return data;
}
