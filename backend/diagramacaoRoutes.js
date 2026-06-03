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
