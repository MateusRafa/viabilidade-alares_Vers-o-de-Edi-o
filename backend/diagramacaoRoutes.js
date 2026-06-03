/**
 * Rotas — IA de Auditoria de Diagramação
 */
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import multer from 'multer';
import { analyzePdfFile } from './lib/diagramacao/analyzePdf.js';
import { classifyDiagramacao } from './lib/diagramacao/classify.js';

const jobs = new Map();
const MAX_FILES = 200;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * @param {import('express').Express} app
 * @param {{ DATA_DIR: string }} options
 */
function getUsuarioFromRequest(req) {
  const headerKeys = Object.keys(req.headers || {});
  for (const key of headerKeys) {
    if (key.toLowerCase() === 'x-usuario') {
      return (req.headers[key] || '').trim();
    }
  }
  return (req.body?.usuario || req.query?.usuario || '').trim();
}

function sendRelatoriosError(res, err) {
  const status = err.statusCode || 500;
  res.status(status).json({
    success: false,
    error: err.message || 'Erro interno'
  });
}

/**
 * Registra rotas de Relatórios B2B via import dinâmico (evita crash se lib ausente no deploy).
 * @param {import('express').Express} app
 */
async function registerRelatoriosB2bRoutesSafe(app) {
  try {
    const [
      { listRelatorios, getRelatorioById, createRelatorio, updateRelatorio, deleteRelatorio },
      { PAYLOAD_TIPO, RELATORIO_STATUS, SETOR_ORIGEM }
    ] = await Promise.all([
      import('./lib/relatoriosB2b/relatoriosService.js'),
      import('./lib/relatoriosB2b/constants.js')
    ]);

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
        sendRelatoriosError(res, err);
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
        sendRelatoriosError(res, err);
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
        sendRelatoriosError(res, err);
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
        sendRelatoriosError(res, err);
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
        sendRelatoriosError(res, err);
      }
    });

    console.log('✅ [RelatoriosB2B] Rotas registradas (/api/relatorios-b2b/*)');
  } catch (err) {
    console.warn('⚠️ [RelatoriosB2B] Rotas não registradas (módulos ausentes no deploy):', err.message);
  }
}

export async function registerDiagramacaoRoutes(app, { DATA_DIR }) {
  const DIAG_DIR = path.join(DATA_DIR, 'diagramacao-jobs');
  const TEMP_DIR = path.join(DATA_DIR, 'temp', 'diagramacao-upload');

  if (!fs.existsSync(DIAG_DIR)) fs.mkdirSync(DIAG_DIR, { recursive: true });
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  const uploadLote = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, TEMP_DIR),
      filename: (_req, file, cb) => {
        const safe = (file.originalname || 'arquivo.pdf').replace(/[^\w.\- ()[\]]+/g, '_');
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
      }
    }),
    limits: {
      fileSize: MAX_FILE_BYTES,
      files: MAX_FILES
    }
  });

  app.post('/api/diagramacao/analisar-lote', (req, res) => {
    uploadLote.array('pdfs', MAX_FILES)(req, res, async (err) => {
      if (err) {
        console.error('❌ [Diagramacao] Multer:', err.message);
        return res.status(400).json({ success: false, error: err.message });
      }

      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({ success: false, error: 'Envie ao menos um PDF.' });
      }

      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const job = {
        id: jobId,
        status: 'processando',
        total: files.length,
        processados: 0,
        criadoEm: new Date().toISOString(),
        resultados: [],
        erros: []
      };
      jobs.set(jobId, job);

      res.json({
        success: true,
        jobId,
        total: files.length,
        message: 'Lote em processamento. Consulte o status pelo jobId.'
      });

      processJob(job, files, DIAG_DIR).catch((e) => {
        console.error('❌ [Diagramacao] Job falhou:', e);
        job.status = 'erro';
        job.erro = e.message;
      });
    });
  });

  app.get('/api/diagramacao/lote/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job não encontrado.' });
    }
    res.json({
      success: true,
      job: {
        id: job.id,
        status: job.status,
        total: job.total,
        processados: job.processados,
        criadoEm: job.criadoEm,
        resultados: job.resultados,
        erros: job.erros,
        erro: job.erro || null,
        resumo: job.resumo || null
      }
    });
  });

  console.log('✅ Rotas de diagramação registradas (/api/diagramacao/*)');

  await registerRelatoriosB2bRoutesSafe(app);
}

async function processJob(job, files, diagDir) {
  const jobDir = path.join(diagDir, job.id);
  await fsPromises.mkdir(jobDir, { recursive: true });

  const resumo = { nivel1: 0, nivel2: 0, nivel3: 0 };

  for (const file of files) {
    const nomeOriginal = file.originalname || path.basename(file.path);
    try {
      const metrics = await analyzePdfFile(file.path);
      if (!metrics.ok) {
        job.erros.push({ arquivo: nomeOriginal, erro: metrics.erro });
        job.resultados.push({
          arquivo: nomeOriginal,
          nivel_diagramacao: null,
          nivel_diagramacao_label: 'Erro',
          erro: metrics.erro
        });
      } else {
        const classified = classifyDiagramacao(metrics, nomeOriginal);
        const nivel = classified.nivel_diagramacao;
        if (nivel === 1) resumo.nivel1++;
        else if (nivel === 2) resumo.nivel2++;
        else if (nivel === 3) resumo.nivel3++;

        job.resultados.push({
          arquivo: nomeOriginal,
          ...classified,
          rule_version: classified.rule_version,
          projeto: metrics.projeto || null
        });
      }
    } catch (e) {
      job.erros.push({ arquivo: nomeOriginal, erro: e.message });
      job.resultados.push({
        arquivo: nomeOriginal,
        nivel_diagramacao: null,
        nivel_diagramacao_label: 'Erro',
        erro: e.message
      });
    } finally {
      job.processados++;
      try {
        await fsPromises.unlink(file.path);
      } catch {
        /* ignore */
      }
    }
  }

  try {
    await fsPromises.writeFile(
      path.join(jobDir, 'resultado.json'),
      JSON.stringify({ resultados: job.resultados, resumo: job.resumo }, null, 2),
      'utf8'
    );
  } catch {
    /* ignore */
  }

  job.resumo = resumo;
  job.status = 'concluido';

  // Limpar jobs antigos da memória após 2h
  setTimeout(() => jobs.delete(job.id), 2 * 60 * 60 * 1000);
}
