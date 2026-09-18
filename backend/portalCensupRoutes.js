/**
 * API REST — Portal CENSUP (fila de chamados + tabulação IA)
 */
import {
  analisarChamadoById,
  analisarChamadoEmBackground,
  getChamadoById,
  listChamados,
  reconcileChamadosComAgenda,
  registerFeedback,
  salvarRelatorioWorkbench,
  syncFilaToSupabase,
  upsertChamado
} from './lib/portalCensup/chamadosService.js';
import {
  getAgendaBotStatus,
  importAgendaSession,
  startAgendaBot,
  stopAgendaBot,
  syncAgendaBotOnce
} from './lib/portalCensup/agendaBot/index.js';
import {
  getPortalCensupSupabaseConfig,
  testPortalCensupSupabaseConnection
} from './lib/portalCensup/supabaseCensup.js';
import {
  clearCensupSyncPresence,
  getCensupSyncPresenceTtlMs,
  listCensupSyncOnline,
  touchCensupSyncPresence
} from './lib/portalCensup/presenceStore.js';
import {
  getAtribuicoesPorPedidos,
  registrarPedidosNaEsteira,
  atribuirPedidoNaEsteira
} from './lib/portalCensup/filaEsteira.js';

function getUsuarioFromRequest(req) {
  const headerKeys = Object.keys(req.headers || {});
  for (const key of headerKeys) {
    if (key.toLowerCase() === 'x-usuario') {
      return (req.headers[key] || '').trim();
    }
  }
  return (req.body?.usuario || req.query?.usuario || '').trim();
}

function sendError(res, err) {
  const status = err.statusCode || 500;
  res.status(status).json({
    success: false,
    error: err.message || 'Erro interno'
  });
}

/**
 * @param {import('express').Express} app
 */
export function registerPortalCensupRoutes(app) {
  testPortalCensupSupabaseConnection()
    .then(async (status) => {
      if (status.success) {
        console.log(`✅ [PortalCENSUP][Supabase] ${status.message}`);
        const sync = await syncFilaToSupabase();
        if (sync.success) {
          console.log(`✅ [PortalCENSUP][Supabase] JSON local alinhado com a table: ${sync.synced} chamado(s)`);
        }
      } else {
        console.warn(`⚠️ [PortalCENSUP][Supabase] ${status.error}`);
      }
    })
    .catch((err) => {
      console.warn('⚠️ [PortalCENSUP][Supabase] Falha ao testar conexão:', err.message);
    });

  app.get('/api/portal-censup/supabase-status', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const connection = await testPortalCensupSupabaseConnection();
      res.json({
        success: connection.success,
        ...getPortalCensupSupabaseConfig(),
        ...connection
      });
    } catch (err) {
      console.error('❌ [PortalCENSUP] GET supabase-status:', err);
      sendError(res, err);
    }
  });

  app.post('/api/portal-censup/sync-supabase', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const result = await syncFilaToSupabase();
      res.status(result.success ? 200 : 503).json({ success: result.success, ...result });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST sync-supabase:', err);
      sendError(res, err);
    }
  });

  app.get('/api/portal-censup/chamados', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const result = await listChamados({
        q: req.query.q || '',
        page: req.query.page,
        limit: req.query.limit,
        view: req.query.view || 'pendentes'
      });

      res.json({ success: true, ...result });
    } catch (err) {
      console.error('❌ [PortalCENSUP] GET chamados:', err);
      sendError(res, err);
    }
  });

  /** Reconcilia fila do Portal com pedidos ativos na Agenda (extensão / bot). */
  app.post('/api/portal-censup/chamados/reconcile', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const pedidos = Array.isArray(req.body?.pedidos) ? req.body.pedidos : [];
      const situacoes = Array.isArray(req.body?.situacoes) ? req.body.situacoes : [];
      const result = await reconcileChamadosComAgenda(pedidos, situacoes);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST chamados/reconcile:', err);
      sendError(res, err);
    }
  });

  /**
   * Presença da extensão: online = Sincronização ligada (heartbeat).
   * Body: { enabled: true|false }
   */
  app.post('/api/portal-censup/presence', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const enabled = req.body?.enabled !== false;
      if (enabled) {
        touchCensupSyncPresence(usuario, { source: req.body?.source || 'extension-sync' });
      } else {
        clearCensupSyncPresence(usuario);
      }

      const online = listCensupSyncOnline();
      res.json({
        success: true,
        enabled,
        onlineCount: online.length,
        online,
        ttlMs: getCensupSyncPresenceTtlMs()
      });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST presence:', err);
      sendError(res, err);
    }
  });

  app.get('/api/portal-censup/presence', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const online = listCensupSyncOnline();
      res.json({
        success: true,
        onlineCount: online.length,
        online,
        ttlMs: getCensupSyncPresenceTtlMs()
      });
    } catch (err) {
      console.error('❌ [PortalCENSUP] GET presence:', err);
      sendError(res, err);
    }
  });

  /**
   * Esteira: registra pedidos vistos na Agenda e atribui a quem está online (sync).
   * Body: { pedidos: [...], syncEnabled?: boolean }
   */
  app.post('/api/portal-censup/fila/registrar', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      // Mesma requisição: se a sync estiver ligada, marca o usuário online antes de atribuir
      // (evita falha por presença só em memória / outra réplica).
      if (req.body?.syncEnabled === true) {
        touchCensupSyncPresence(usuario, { source: req.body?.source || 'extension-sync' });
      }

      const raw = Array.isArray(req.body?.pedidos) ? req.body.pedidos : [];
      const result = registrarPedidosNaEsteira(raw);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST fila/registrar:', err);
      sendError(res, err);
    }
  });

  /** Claim manual (duplo clique na lista): atribui o pedido ao usuário da extensão. */
  app.post('/api/portal-censup/fila/atribuir', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const pedido = String(req.body?.pedido || '').trim();
      const assignment = atribuirPedidoNaEsteira(pedido, usuario);
      res.json({ success: true, pedido, assignment });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST fila/atribuir:', err);
      sendError(res, err);
    }
  });

  /** Consulta atribuições por pedidos (lista da extensão). */
  app.get('/api/portal-censup/fila/atribuicoes', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const raw = String(req.query?.pedidos || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const bodyPedidos = Array.isArray(req.body?.pedidos) ? req.body.pedidos : [];
      const pedidos = raw.length ? raw : bodyPedidos.map((p) => String(p || '').trim()).filter(Boolean);
      const assignments = getAtribuicoesPorPedidos(pedidos);
      res.json({ success: true, assignments });
    } catch (err) {
      console.error('❌ [PortalCENSUP] GET fila/atribuicoes:', err);
      sendError(res, err);
    }
  });

  app.get('/api/portal-censup/chamados/:id', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const chamado = await getChamadoById(req.params.id, { usuario });
      res.json({ success: true, chamado });
    } catch (err) {
      console.error('❌ [PortalCENSUP] GET chamado:', err);
      sendError(res, err);
    }
  });

  app.post('/api/portal-censup/chamados/:id/feedback', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const { correto, tabulacaoCorrigida } = req.body || {};
      if (typeof correto !== 'boolean') {
        return res.status(400).json({ success: false, error: 'Campo correto é obrigatório (boolean)' });
      }

      if (correto === false && !(tabulacaoCorrigida || '').trim()) {
        return res.status(400).json({
          success: false,
          error: 'Informe tabulacaoCorrigida quando a sugestão estiver incorreta'
        });
      }

      const result = await registerFeedback(req.params.id, {
        usuario,
        correto,
        tabulacaoCorrigida: (tabulacaoCorrigida || '').trim() || null
      });

      res.json({ success: true, ...result });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST feedback:', err);
      sendError(res, err);
    }
  });

  /** Endpoint interno para a extensão / bot inserir/atualizar chamados */
  app.post('/api/portal-censup/chamados', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const body = req.body || {};
      const chamado = await upsertChamado({
        ...body,
        analiseStatus: body.analiseStatus || 'aguardando_analise',
        tabulacaoStatus: body.tabulacaoStatus || 'aguardando_analise'
      });

      // Cascata endereço → referência → cobertura (não bloqueia a extensão)
      analisarChamadoEmBackground(chamado.id);

      res.json({
        success: true,
        chamado,
        persistedToSupabase: chamado.persistedToSupabase === true,
        supabaseError: chamado.supabaseError || null
      });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST chamado:', err);
      sendError(res, err);
    }
  });

  app.post('/api/portal-censup/chamados/:id/analisar', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const force = req.body?.force === true || req.query?.force === '1';
      const lat = req.body?.lat != null ? Number(req.body.lat) : null;
      const lng = req.body?.lng != null ? Number(req.body.lng) : null;
      const endereco =
        req.body?.endereco && typeof req.body.endereco === 'object' ? req.body.endereco : null;
      const result = await analisarChamadoById(req.params.id, {
        force,
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        enderecoPatch: endereco
      });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST analisar:', err);
      sendError(res, err);
    }
  });

  app.post('/api/portal-censup/chamados/:id/relatorio', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const persist = req.body?.persist !== false;
      const result = await salvarRelatorioWorkbench(req.params.id, {
        usuario,
        report: req.body || {},
        persist,
        seed: req.body?.seed || null
      });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST relatorio:', err);
      sendError(res, err);
    }
  });

  app.get('/api/portal-censup/agenda-bot/status', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const status = await getAgendaBotStatus();
      res.json({ success: true, status });
    } catch (err) {
      console.error('❌ [PortalCENSUP] GET agenda-bot/status:', err);
      sendError(res, err);
    }
  });

  app.post('/api/portal-censup/agenda-bot/start', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const status = await startAgendaBot({ runImmediately: true });
      res.json({ success: true, status });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST agenda-bot/start:', err);
      sendError(res, err);
    }
  });

  app.post('/api/portal-censup/agenda-bot/stop', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const status = await stopAgendaBot();
      res.json({ success: true, status });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST agenda-bot/stop:', err);
      sendError(res, err);
    }
  });

  app.post('/api/portal-censup/agenda-bot/session', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const { session } = req.body || {};
      if (!session) {
        return res.status(400).json({ success: false, error: 'Campo session é obrigatório' });
      }

      const saved = await importAgendaSession(
        typeof session === 'string' ? session : JSON.stringify(session)
      );
      const status = await getAgendaBotStatus();
      res.json({ success: true, saved, status });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST agenda-bot/session:', err);
      sendError(res, err);
    }
  });

  app.post('/api/portal-censup/agenda-bot/sync', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const status = await syncAgendaBotOnce();
      res.json({ success: true, status });
    } catch (err) {
      console.error('❌ [PortalCENSUP] POST agenda-bot/sync:', err);
      sendError(res, err);
    }
  });
}
