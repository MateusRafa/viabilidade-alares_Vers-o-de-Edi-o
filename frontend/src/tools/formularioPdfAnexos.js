/**
 * Anexos PDF — renderização de páginas para prévia e impressão.
 */

import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

/** Limite do arquivo .pdf (não do número de páginas). PDFs “leves” em páginas mas pesados (imagens embutidas) são comuns. */
export const MAX_ANEXO_PDF_MB = 60;
export const MAX_ANEXO_PDF_BYTES = MAX_ANEXO_PDF_MB * 1024 * 1024;

/** Largura alvo da rasterização (~210 mm em 150 DPI efetivo na prévia) */
const RENDER_TARGET_WIDTH_PX = 1240;
/** Qualidade JPEG na conversão — páginas viram imagens menores ao salvar (o .pdf original pode ser bem maior). */
const ANEXO_JPEG_QUALITY = 0.82;

export function emptyAnexoPdf() {
  return {
    id: '',
    nome: '',
    pageImages: []
  };
}

export function createAnexoId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `anexo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function countAnexoPdfPages(formData) {
  const anexos = formData?.anexosPdf;
  if (!Array.isArray(anexos)) return 0;
  return anexos.reduce((sum, a) => sum + (a.pageImages?.length || 0), 0);
}

/**
 * Converte um arquivo PDF em imagens (data URL JPEG) — uma por página.
 * @param {File} file
 * @returns {Promise<{ nome: string, pageImages: string[] }>}
 */
export async function renderPdfFileToPageImages(file) {
  if (!file) {
    throw new Error('Nenhum arquivo selecionado.');
  }
  if (file.type !== 'application/pdf' && !file.name?.toLowerCase().endsWith('.pdf')) {
    throw new Error('Selecione um arquivo PDF válido.');
  }
  if (file.size > MAX_ANEXO_PDF_BYTES) {
    throw new Error(`O PDF deve ter no máximo ${MAX_ANEXO_PDF_MB} MB.`);
  }

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageImages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = RENDER_TARGET_WIDTH_PX / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Não foi possível renderizar o PDF neste navegador.');
    }

    await page.render({ canvasContext: ctx, viewport }).promise;
    pageImages.push(canvas.toDataURL('image/jpeg', ANEXO_JPEG_QUALITY));
  }

  return {
    nome: file.name?.trim() || 'anexo.pdf',
    pageImages
  };
}
