/**
 * API REST — Relatórios B2B (Projetos + Implantação)
 */
import {
  listRelatorios,
  getRelatorioById,
  createRelatorio,
  updateRelatorio,
  deleteRelatorio
} from './lib/relatoriosB2b/relatoriosService.js';
import { PAYLOAD_TIPO, RELATORIO_STATUS, SETOR_ORIGEM } from './lib/relatoriosB2b/constants.js';

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
export function registerRelatoriosB2bRoutes(app) {
  app.get('/api/relatorios-b2b', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const status = req.query.status || null;
      const q = req.query.q || '';
      const limit = parseInt(req.query.limit, 10) || 50;
      const setorOrigem = req.query.setorOrigem || null;

      const relatorios = await listRelatorios({ status, q, limit, setorOrigem });
      res.json({ success: true, relatorios });
    } catch (err) {
      console.error('❌ [RelatoriosB2B] GET lista:', err);
      sendError(res, err);
    }
  });

  app.get('/api/relatorios-b2b/:id', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const payloadTipo =
        req.query.payloadTipo === PAYLOAD_TIPO.IMPLANTACAO
          ? PAYLOAD_TIPO.IMPLANTACAO
          : PAYLOAD_TIPO.PROJETOS;

      const relatorio = await getRelatorioById(req.params.id, { payloadTipo });
      res.json({ success: true, relatorio });
    } catch (err) {
      console.error('❌ [RelatoriosB2B] GET id:', err);
      sendError(res, err);
    }
  });

  app.post('/api/relatorios-b2b', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const { payload, payloadTipo, status, setorOrigem } = req.body || {};
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ success: false, error: 'Campo payload é obrigatório' });
      }

      const tipo =
        payloadTipo === PAYLOAD_TIPO.IMPLANTACAO ? PAYLOAD_TIPO.IMPLANTACAO : PAYLOAD_TIPO.PROJETOS;

      const validStatus = status && Object.values(RELATORIO_STATUS).includes(status) ? status : undefined;

      const validSetor =
        setorOrigem && Object.values(SETOR_ORIGEM).includes(setorOrigem) ? setorOrigem : undefined;

      const relatorio = await createRelatorio({
        usuario,
        payload,
        payloadTipo: tipo,
        status: validStatus,
        setorOrigem: validSetor
      });

      res.status(201).json({ success: true, relatorio });
    } catch (err) {
      console.error('❌ [RelatoriosB2B] POST:', err);
      sendError(res, err);
    }
  });

  app.put('/api/relatorios-b2b/:id', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const { payload, payloadTipo, status, setorOrigem } = req.body || {};
      const tipo =
        payloadTipo === PAYLOAD_TIPO.IMPLANTACAO ? PAYLOAD_TIPO.IMPLANTACAO : PAYLOAD_TIPO.PROJETOS;

      const validStatus = status && Object.values(RELATORIO_STATUS).includes(status) ? status : undefined;
      const validSetor =
        setorOrigem && Object.values(SETOR_ORIGEM).includes(setorOrigem) ? setorOrigem : undefined;

      const relatorio = await updateRelatorio(req.params.id, {
        usuario,
        payload,
        payloadTipo: payload ? tipo : undefined,
        status: validStatus,
        setorOrigem: validSetor
      });

      res.json({ success: true, relatorio });
    } catch (err) {
      console.error('❌ [RelatoriosB2B] PUT:', err);
      sendError(res, err);
    }
  });

  app.delete('/api/relatorios-b2b/:id', async (req, res) => {
    try {
      const usuario = getUsuarioFromRequest(req);
      if (!usuario) {
        return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
      }

      const result = await deleteRelatorio(req.params.id);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('❌ [RelatoriosB2B] DELETE:', err);
      sendError(res, err);
    }
  });
}
