// PDF multipágina B2B — capa, cabeçalho, passos + identidade Alares

import { BRAND, TOTAL_PDF_PAGES } from './formularioPdfBranding.js';
import { countAnexoPdfPages } from './formularioPdfAnexos.js';

export { BRAND, TOTAL_PDF_PAGES } from './formularioPdfBranding.js';
export {
  MAX_ANEXO_PDF_MB,
  MAX_ANEXO_PDF_BYTES,
  emptyAnexoPdf,
  createAnexoId,
  countAnexoPdfPages,
  renderPdfFileToPageImages
} from './formularioPdfAnexos.js';

/** Sugestões do campo Objetivo (lista suspensa editável no formulário) */
export const OBJETIVO_OPCOES = ['Gpon', 'Ponto a Ponto', 'Fibra Apagada'];

/** Campos da página 2 — ordem fixa do documento */
export const CABECALHO_FIELDS = [
  { key: 'operacao', label: 'Operação', placeholder: 'Ex: Alares' },
  {
    key: 'objetivo',
    label: 'Objetivo',
    placeholder: 'Selecione ou digite',
    options: OBJETIVO_OPCOES
  },
  {
    key: 'velocidadeContratada',
    label: 'Velocidade contratada',
    placeholder: 'Ex: 200MBS PTP'
  },
  { key: 'cliente', label: 'Cliente', placeholder: 'Ex: Sicred Cambará' },
  { key: 'endereco', label: 'Endereço', placeholder: 'Rua, número, bairro, cidade - UF, CEP' },
  {
    key: 'coordenadaAbordagem',
    label: 'Coordenada do ponto de abordagem (cliente)',
    placeholder: 'Ex: -23.041665, -50.073588'
  },
  { key: 'projetista', label: 'Projetista', placeholder: 'Nome do projetista' },
  {
    key: 'supervisorPlanejamento',
    label: 'Supervisor Planejamento e Engenharia de Redes FTTx',
    placeholder: 'Nome do supervisor'
  },
  { key: 'contatoConsultor', label: 'Nome e Contato do consultor', placeholder: 'Nome e telefone/e-mail' },
  { key: 'contatoCliente', label: 'Nome e Contato do cliente', placeholder: 'Nome e telefone/e-mail' },
  { key: 'contrato', label: 'Contrato', placeholder: 'Ex: 3933511' },
  { key: 'ordemJira', label: 'Ordem Jira', placeholder: 'Ex: ENGT-46557' },
  { key: 'ativacaoPortaSw', label: 'Ativação de porta SW', placeholder: 'Ex: ENGT-47714' },
  { key: 'osProjetoTecB2b', label: 'O.S de Projeto tec. B2B', placeholder: 'Ex: 39048036' },
  { key: 'supervisorRedeExterna', label: 'Supervisor de Rede Externa', placeholder: 'Nome do supervisor' },
  { key: 'projetoOzmap', label: 'Projeto ozmap', placeholder: 'Ex: PR - Cambará - Webby' },
  {
    key: 'metragemFibra',
    label: 'Metragem total percorrida pela fibra',
    placeholder: 'Ex: 650m'
  },
  {
    key: 'observacoesAdicionais',
    label: 'Observações adicionais',
    placeholder: 'Texto livre',
    multiline: true
  }
];

function emptyCabecalho() {
  return Object.fromEntries(CABECALHO_FIELDS.map(({ key }) => [key, '']));
}

/** Bloco de passo ou lista de material (mesma estrutura) */
export function emptyPasso() {
  return {
    tituloPasso: 'XXXXX',
    descricao: '',
    imagemDataUrl: '',
    imagemNome: ''
  };
}

export function emptyListaMaterial() {
  return {
    descricao: ''
  };
}

/** Altura útil do conteúdo em uma folha de passo (alinha ao CSS min-height 277mm) */
export const PDF_PASSO_PAGE_CONTENT_PX = 1046;

/** Layout de páginas de um passo: blocos de texto + página de imagem opcional */
export function defaultPassoLayout(passo) {
  const inner = getPassoDescricaoInnerHtml(passo);
  const hasImage = !!passo?.imagemDataUrl?.trim();
  return {
    textChunkHtmls: [inner],
    hasImagePage: false,
    imageOnFirstPage: hasImage
  };
}

function countPassoPages(layout) {
  if (!layout) return 1;
  const textPages = layout.textChunkHtmls?.length || 1;
  if (layout.imageOnFirstPage) return textPages;
  if (!layout.hasImagePage) return textPages;
  if (textPages > 1) return textPages;
  return textPages + 1;
}

/** Total de páginas: capa + informações + páginas dos passos + lista de material */
export function getPdfPageCount(formData, options = {}) {
  const passos = formData?.passos?.length ? formData.passos : [emptyPasso()];
  const layouts = options.passoLayouts || passos.map((p) => defaultPassoLayout(p));
  let passoPages = 0;
  passos.forEach((passo, i) => {
    passoPages += countPassoPages(layouts[i] || defaultPassoLayout(passo));
  });
  return 2 + passoPages + 1 + countAnexoPdfPages(formData);
}

export function normalizeFormData(data) {
  const base = defaultFormData();
  if (!data || typeof data !== 'object') return base;

  let passos = data.passos;
  if (!Array.isArray(passos) || !passos.length) {
    passos = data.passo1 ? [{ ...emptyPasso(), ...data.passo1 }] : base.passos;
  } else {
    passos = passos.map((p) => ({ ...emptyPasso(), ...p }));
  }

  return {
    ...base,
    ...data,
    capa: { ...base.capa, ...data.capa },
    cabecalho: { ...base.cabecalho, ...data.cabecalho },
    passos,
    listaMaterial: { ...emptyListaMaterial(), ...data.listaMaterial },
    anexosPdf: normalizeAnexosPdf(data.anexosPdf)
  };
}

function normalizeAnexosPdf(anexos) {
  if (!Array.isArray(anexos)) return [];
  return anexos.map((a) => ({
    id: a?.id || `anexo-${Date.now()}`,
    nome: a?.nome || '',
    pageImages: Array.isArray(a?.pageImages)
      ? a.pageImages.filter((img) => typeof img === 'string' && img.startsWith('data:'))
      : []
  }));
}

/** Estado inicial do formulário */
export function defaultFormData() {
  return {
    capa: {
      titulo: '',
      clienteProjeto: '',
      data: '',
      cidade: ''
    },
    cabecalho: emptyCabecalho(),
    passos: [emptyPasso()],
    listaMaterial: emptyListaMaterial(),
    anexosPdf: []
  };
}

export function getPdfPagesMeta(formData, options = {}) {
  const passos = formData?.passos?.length ? formData.passos : [emptyPasso()];
  const layouts = options.passoLayouts || passos.map((p) => defaultPassoLayout(p));
  const pages = [
    { id: 'capa', number: 1, title: 'Capa' },
    { id: 'cabecalho', number: 2, title: 'Informações do projeto' }
  ];
  passos.forEach((passo, i) => {
    const n = i + 1;
    const titulo = passo.tituloPasso?.trim() || 'XXXXX';
    const layout = layouts[i] || defaultPassoLayout(passo);
    const chunkCount = layout.textChunkHtmls?.length || 1;
    for (let t = 0; t < chunkCount; t++) {
      const suffix = t > 0 ? ' (continuação)' : '';
      pages.push({
        id: `passo-${n}${t > 0 ? `-cont-${t}` : ''}`,
        number: pages.length + 1,
        title: `Passo ${n}° — ${titulo}${suffix}`
      });
    }
    if (layout.hasImagePage && chunkCount === 1 && !layout.imageOnFirstPage) {
      pages.push({
        id: `passo-${n}-imagem`,
        number: pages.length + 1,
        title: `Passo ${n}° — ${titulo} (imagem)`
      });
    }
  });
  pages.push({
    id: 'listaMaterial',
    number: pages.length + 1,
    title: 'Lista de Material'
  });
  (formData.anexosPdf || []).forEach((anexo, ai) => {
    const nome = anexo.nome?.trim() || `Anexo ${ai + 1}`;
    (anexo.pageImages || []).forEach((_, pi) => {
      pages.push({
        id: `anexo-${anexo.id || ai}-p${pi + 1}`,
        number: pages.length + 1,
        title: `${nome} — pág. ${pi + 1}`
      });
    });
  });
  return pages;
}

/** Área útil para conteúdo dentro de uma folha de passo (px) */
export function getPassoContentAreaHeight(pageEl) {
  if (!pageEl) return PDF_PASSO_PAGE_CONTENT_PX;
  const pageContent = pageEl.querySelector('.page-content');
  if (pageContent && pageContent.clientHeight > 80) {
    return pageContent.clientHeight;
  }
  const pageH = pageEl.clientHeight || PDF_PASSO_PAGE_CONTENT_PX;
  let chrome = 0;
  pageEl.querySelectorAll('.capa-logo-wrap, .page-title, .artwork-page-footer').forEach((el) => {
    chrome += el.offsetHeight || 0;
  });
  const style = pageEl.ownerDocument?.defaultView?.getComputedStyle(pageEl);
  const pad = style
    ? (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
    : 0;
  return Math.max(120, pageH - chrome - pad - 12);
}

function getPassoDescricaoInnerHtml(passo) {
  const full = displayDescricaoValue(passo?.descricao);
  if (full.includes('empty-value')) return '<span class="empty-value">—</span>';
  return full;
}

const PASSO_DESC_MEASURE_CLASS =
  'passo-descricao-body report-info-value-multiline report-info-rich';

const PASSO_DESC_PROBE_STYLE =
  'position:absolute;left:-9999px;top:0;width:170mm;max-width:170mm;visibility:hidden;pointer-events:none;';

/** HTML só do valor da descrição (sem rótulo "Descrição") */
function extractPassoDescricaoContentHtml(innerHtml) {
  if (!innerHtml?.trim()) return '';
  const doc = typeof DOMParser !== 'undefined' ? new DOMParser().parseFromString(innerHtml, 'text/html') : null;
  const root = doc?.body;
  if (root) {
    const valueEl =
      root.querySelector('.report-info-rich') ||
      root.querySelector('.report-info-value-multiline') ||
      root.querySelector('.report-info-value');
    if (valueEl) return valueEl.innerHTML;
  }
  const richMatch = innerHtml.match(
    /class="[^"]*report-info-rich[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i
  );
  if (richMatch) return richMatch[1];
  const multiMatch = innerHtml.match(
    /class="[^"]*report-info-value-multiline[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i
  );
  if (multiMatch) return multiMatch[1];
  return innerHtml;
}

function createPassoDescMeasureProbe(doc) {
  const probe = doc.createElement('div');
  probe.className = PASSO_DESC_MEASURE_CLASS;
  probe.style.cssText = PASSO_DESC_PROBE_STYLE;
  doc.body.appendChild(probe);
  return probe;
}

function measurePassoDescHtmlHeight(html, probe) {
  probe.innerHTML = html || '';
  return probe.scrollHeight;
}

function extractSplitUnitsFromHtml(contentHtml, doc) {
  const temp = doc.createElement('div');
  temp.className = PASSO_DESC_MEASURE_CLASS;
  temp.innerHTML = contentHtml;
  const container =
    temp.querySelector('.report-info-rich, .report-info-value-multiline') || temp;
  const units = [];

  Array.from(container.childNodes).forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (text.trim()) units.push({ html: escapeHtml(text) });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      units.push({ html: node.outerHTML });
    }
  });

  if (!units.length && contentHtml.trim()) {
    units.push({ html: contentHtml });
  }

  return units;
}

function unitsToHtml(units) {
  return units.map((u) => u.html).join('');
}

function splitOversizedHtmlUnit(html, maxHeightPx, probe) {
  const wrap = probe.ownerDocument.createElement('div');
  wrap.className = PASSO_DESC_MEASURE_CLASS;
  wrap.innerHTML = html;
  const paragraphs = Array.from(wrap.querySelectorAll('p'));

  if (paragraphs.length > 1) {
    const chunks = [];
    let batch = [];
    let budget = maxHeightPx;

    const flush = () => {
      if (!batch.length) return;
      const part = unitsToHtml(batch);
      if (part.trim()) chunks.push(part);
      batch = [];
    };

    for (const p of paragraphs) {
      const unit = { html: p.outerHTML };
      const trial = unitsToHtml([...batch, unit]);
      if (measurePassoDescHtmlHeight(trial, probe) <= budget + 4) {
        batch.push(unit);
      } else {
        flush();
        budget = maxHeightPx;
        const aloneH = measurePassoDescHtmlHeight(unit.html, probe);
        if (aloneH > budget + 4) {
          const split = splitPlainTextInHtml(unit.html, budget, probe);
          if (split.fit?.trim()) chunks.push(split.fit);
          if (split.rest?.trim()) batch = [{ html: split.rest }];
        } else {
          batch.push(unit);
        }
      }
    }
    flush();
    if (chunks.length >= 2) {
      return { fit: chunks[0], rest: chunks.slice(1).join('') };
    }
    if (chunks.length === 1) {
      return { fit: chunks[0], rest: '' };
    }
  }

  return splitPlainTextInHtml(html, maxHeightPx, probe);
}

function splitPlainTextInHtml(html, maxHeightPx, probe) {
  const plain = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!plain) return { fit: html, rest: '' };

  const words = plain.split(' ').filter(Boolean);
  if (!words.length) return { fit: html, rest: '' };

  let lo = 0;
  let hi = words.length;
  let best = 0;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid === 0) {
      lo = 1;
      continue;
    }
    const trial = words.slice(0, mid).join(' ');
    const trialHtml = /<p[\s>]/i.test(html) ? `<p>${escapeHtml(trial)}</p>` : escapeHtml(trial);
    if (measurePassoDescHtmlHeight(trialHtml, probe) <= maxHeightPx + 2) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best === 0) best = 1;

  const fitText = words.slice(0, best).join(' ');
  const restText = words.slice(best).join(' ');
  const useP = /<p[\s>]/i.test(html);

  return {
    fit: fitText ? (useP ? `<p>${escapeHtml(fitText)}</p>` : escapeHtml(fitText)) : '',
    rest: restText ? (useP ? `<p>${escapeHtml(restText)}</p>` : escapeHtml(restText)) : ''
  };
}

function splitUnitsByHeights(units, firstBudgetPx, nextBudgetPx, probe) {
  const chunks = [];
  let budget = firstBudgetPx;
  let batch = [];

  const pushChunk = (html) => {
    if (html?.trim()) chunks.push(html);
  };

  const flushBatch = () => {
    if (!batch.length) return;
    pushChunk(unitsToHtml(batch));
    batch = [];
    budget = nextBudgetPx;
  };

  for (let i = 0; i < units.length; i++) {
    let unit = units[i];

    while (true) {
      const trialHtml = unitsToHtml([...batch, unit]);
      const trialH = measurePassoDescHtmlHeight(trialHtml, probe);

      if (trialH <= budget + 4) {
        batch.push(unit);
        break;
      }

      if (batch.length > 0) {
        flushBatch();
        continue;
      }

      const aloneH = measurePassoDescHtmlHeight(unit.html, probe);
      if (aloneH > budget + 4) {
        const { fit, rest } = splitOversizedHtmlUnit(unit.html, budget, probe);
        if (fit?.trim()) pushChunk(fit);
        budget = nextBudgetPx;
        if (rest?.trim()) {
          unit = { html: rest };
          batch = [];
          continue;
        }
        break;
      }

      batch.push(unit);
      break;
    }
  }

  if (batch.length) pushChunk(unitsToHtml(batch));
  return chunks;
}

function splitRichHtmlByMaxHeight(innerHtml, maxHeightPx, doc, splitOptions = {}) {
  if (!doc?.body) return [innerHtml];

  const contentHtml = extractPassoDescricaoContentHtml(innerHtml) || innerHtml;
  const firstPageExtraPx = splitOptions.firstPageExtraPx ?? 0;
  const firstBudget = Math.max(100, maxHeightPx - firstPageExtraPx);
  const nextBudget = maxHeightPx;

  const probe = createPassoDescMeasureProbe(doc);
  const totalH = measurePassoDescHtmlHeight(contentHtml, probe);

  if (totalH <= firstBudget + 6) {
    probe.remove();
    return [contentHtml];
  }

  const units = extractSplitUnitsFromHtml(contentHtml, doc);
  if (!units.length) {
    probe.remove();
    return [contentHtml];
  }

  const chunks = splitUnitsByHeights(units, firstBudget, nextBudget, probe);
  probe.remove();

  return chunks.length ? chunks : [contentHtml];
}

function measurePassoImageAppendHeight(passo, passoNumero, doc) {
  const probe = doc.createElement('div');
  probe.className = 'passo-imagem-apos-texto';
  probe.style.cssText = PASSO_DESC_PROBE_STYLE;
  doc.body.appendChild(probe);
  probe.innerHTML = buildPassoImageBlock(passo, `Imagem do passo ${passoNumero}`, { showLabel: true });
  const h = probe.scrollHeight;
  probe.remove();
  return h + 14;
}

/** Altura do bloco de texto do passo (rótulo + descrição + imagem opcional) */
function measurePassoTextBlockHeight(chunkHtml, passo, passoNumero, doc, { includeImage = false } = {}) {
  const probe = doc.createElement('div');
  probe.className = 'passo-texto-bloco';
  probe.style.cssText = PASSO_DESC_PROBE_STYLE;
  doc.body.appendChild(probe);
  const imageHtml = includeImage
    ? `<div class="passo-imagem-apos-texto">${buildPassoImageBlock(passo, `Imagem do passo ${passoNumero}`, { showLabel: true })}</div>`
    : '';
  probe.innerHTML = `
    <span class="report-info-label">Descrição</span>
    <div class="passo-descricao-body">
      <div class="${PASSO_DESC_MEASURE_CLASS}">${chunkHtml}</div>
    </div>
    ${imageHtml}`;
  const h = probe.scrollHeight;
  probe.remove();
  return h;
}

/** Mede na prévia (passo em folha única para medição) quantas páginas de texto e se há página de imagem */
export function measurePassoLayoutsFromDocument(doc, passos = []) {
  if (!doc?.body) return passos.map((p) => defaultPassoLayout(p));

  return passos.map((passo, i) => {
    const hasImage = !!passo?.imagemDataUrl?.trim();
    const passoNumero = i + 1;
    const page = doc.querySelector(`.pdf-page-passo[data-passo-index="${i}"]`);

    if (!page) {
      return defaultPassoLayout(passo);
    }

    const pageContent = page.querySelector('.page-content');
    const available = pageContent?.clientHeight || getPassoContentAreaHeight(page);
    const descEl = page.querySelector('.passo-descricao-body');
    const innerRaw = descEl?.innerHTML?.trim()
      ? descEl.innerHTML
      : getPassoDescricaoInnerHtml(passo);
    const labelEl = page.querySelector('.passo-descricao-body .report-info-label');
    const labelReserve = (labelEl?.offsetHeight || 0) + 10;
    const contentHtml = extractPassoDescricaoContentHtml(innerRaw) || getPassoDescricaoInnerHtml(passo);
    let textChunkHtmls = splitRichHtmlByMaxHeight(contentHtml, available, doc, {
      firstPageExtraPx: labelReserve
    });

    let imageOnFirstPage = false;
    let hasImagePage = false;

    if (hasImage) {
      const imageReserve = measurePassoImageAppendHeight(passo, passoNumero, doc);

      if (textChunkHtmls.length === 1) {
        const chunk = textChunkHtmls[0];
        const textOnlyH = measurePassoTextBlockHeight(chunk, passo, passoNumero, doc, {
          includeImage: false
        });

        if (textOnlyH > available + 8) {
          textChunkHtmls = splitRichHtmlByMaxHeight(contentHtml, available, doc, {
            firstPageExtraPx: labelReserve
          });
        }
      }

      if (textChunkHtmls.length === 1) {
        imageOnFirstPage = true;
        hasImagePage = false;
      } else if (textChunkHtmls.length > 1) {
        hasImagePage = true;
        imageOnFirstPage = false;
        const probe = createPassoDescMeasureProbe(doc);
        const continLabelReserve = 24;
        const lastChunk = textChunkHtmls[textChunkHtmls.length - 1];
        const lastTextH = measurePassoDescHtmlHeight(lastChunk, probe);

        if (lastTextH + imageReserve > available + 8) {
          const lastBudget = Math.max(100, available - imageReserve - continLabelReserve);
          const reSplit = splitRichHtmlByMaxHeight(lastChunk, lastBudget, doc, {
            firstPageExtraPx: continLabelReserve
          });
          textChunkHtmls = [...textChunkHtmls.slice(0, -1), ...reSplit];
        }
        probe.remove();
      }
    }

    return {
      textChunkHtmls: textChunkHtmls.length ? textChunkHtmls : [contentHtml],
      hasImagePage,
      imageOnFirstPage
    };
  });
}

/** @deprecated Use measurePassoLayoutsFromDocument */
export function measurePassoSplitsFromDocument(doc, passos = []) {
  return measurePassoLayoutsFromDocument(doc, passos).map(
    (l) => l.hasImagePage || (l.textChunkHtmls?.length || 0) > 1
  );
}

export function getPassoLayoutWarnings(passos, passoLayouts) {
  const warnings = [];

  passos.forEach((passo, i) => {
    const n = i + 1;
    const layout = passoLayouts[i] || defaultPassoLayout(passo);
    const textPages = layout.textChunkHtmls?.length || 1;

    if (textPages > 1) {
      warnings.push({
        passoIndex: i,
        message: `Passo ${n}°: o texto continua em ${textPages - 1} página(s) adicional(is) com o mesmo layout.`
      });
    }

    if (layout.hasImagePage && !layout.imageOnFirstPage) {
      const msg =
        textPages > 1
          ? `Passo ${n}°: a imagem ficará na mesma página da continuação do texto, abaixo do trecho que passou do limite.`
          : `Passo ${n}°: a imagem ficará na página seguinte, após o texto.`;
      warnings.push({
        passoIndex: i,
        message: msg
      });
    }
  });

  return warnings;
}

/** @deprecated Prefer getPdfPagesMeta(formData) */
export const PDF_PAGES = [
  { id: 'capa', number: 1, title: 'Capa', formKey: 'capa' },
  { id: 'cabecalho', number: 2, title: 'Informações do projeto', formKey: 'cabecalho' },
  { id: 'passo1', number: 3, title: 'Passo 1°', formKey: 'passo1' }
];

export const CAPA_RODAPE_FIXO = BRAND.rodape;
export const CAPA_LOGO_PATH = BRAND.logoPath;

function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** URL segura em atributos src/style (preserva data: URLs) */
function attrUrl(value) {
  if (value == null || value === '') return '';
  return String(value).replace(/"/g, '&quot;');
}

function displayValue(value) {
  const text = (value ?? '').toString().trim();
  return text ? escapeHtml(text) : '<span class="empty-value">—</span>';
}

/** Preserva quebras de linha e parágrafos (espaços em branco do textarea) */
function displayMultilineValue(value) {
  const text = (value ?? '').toString();
  if (!text.trim()) return '<span class="empty-value">—</span>';
  return escapeHtml(text);
}

const RICH_HTML_ALLOWED = new Set([
  'B',
  'STRONG',
  'I',
  'EM',
  'U',
  'BR',
  'P',
  'DIV',
  'UL',
  'OL',
  'LI',
  'SPAN'
]);

/** Remove tags/atributos perigosos; mantém negrito, itálico, listas e quebras */
export function sanitizeRichHtml(html) {
  const raw = (html ?? '').toString();
  if (!raw.trim()) return '';

  if (typeof DOMParser === 'undefined') {
    return escapeHtml(raw).replace(/\n/g, '<br>');
  }

  const doc = new DOMParser().parseFromString(raw, 'text/html');

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeHtml(node.textContent || '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName;
    if (!RICH_HTML_ALLOWED.has(tag)) {
      return Array.from(node.childNodes).map(walk).join('');
    }

    const inner = Array.from(node.childNodes).map(walk).join('');
    if (tag === 'BR') return '<br>';
    return `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`;
  }

  return Array.from(doc.body.childNodes)
    .map(walk)
    .join('')
    .trim();
}

function hasRichMarkup(value) {
  return /<[a-z][\s\S]*>/i.test(String(value || ''));
}

/** Descrição: HTML sanitizado (negrito etc.) ou texto simples com quebras */
function displayDescricaoValue(value) {
  const raw = (value ?? '').toString();
  if (!raw.trim()) return '<span class="empty-value">—</span>';
  if (!hasRichMarkup(raw)) {
    return displayMultilineValue(raw);
  }
  const safe = sanitizeRichHtml(raw);
  return safe || '<span class="empty-value">—</span>';
}

export function getFormattedDateTime() {
  const now = new Date();
  return {
    dateStr: now.toLocaleDateString('pt-BR'),
    timeStr: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  };
}

export function resolveAssetUrl(path, baseUrl = '') {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
    return path;
  }
  const base = (baseUrl || '').replace(/\/$/, '');
  const clean = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${clean}` : clean;
}

/** Carrega asset público como data URL (prévia em iframe srcdoc + impressão) */
export async function loadAssetDataUrl(paths, baseUrl = '') {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  for (const path of list) {
    const url = resolveAssetUrl(path, baseUrl);
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => resolve('');
        reader.readAsDataURL(blob);
      });
      if (dataUrl) return dataUrl;
    } catch {
      /* tenta próximo */
    }
  }
  return '';
}

/** Logo da capa — Imagem1.svg com fallback PNG */
export async function loadLogoDataUrl(baseUrl = '') {
  return loadAssetDataUrl([BRAND.logoPath, BRAND.logoPathPngFallback], baseUrl);
}

/** Fundo de ondas da capa — Imagem2.svg com fallback leve */
export async function loadCapaOndasDataUrl(baseUrl = '') {
  return loadAssetDataUrl([BRAND.capaOndasPath, '/images/capa-ondas.svg'], baseUrl);
}

/** Assinatura do supervisor na Lista de Material */
export async function loadAssinaturaSupervisorDataUrl(baseUrl = '') {
  return loadAssetDataUrl([BRAND.assinaturaSupervisorPath], baseUrl);
}

function getLogoUrl(options = {}) {
  if (options.logoDataUrl) return options.logoDataUrl;
  return resolveAssetUrl(BRAND.logoPath, options.baseUrl || '');
}

function getCapaOndasUrl(options = {}) {
  if (options.capaOndasDataUrl) return options.capaOndasDataUrl;
  return resolveAssetUrl(BRAND.capaOndasPath, options.baseUrl || '');
}

function getAssinaturaSupervisorUrl(options = {}) {
  if (options.assinaturaSupervisorDataUrl) return options.assinaturaSupervisorDataUrl;
  return resolveAssetUrl(BRAND.assinaturaSupervisorPath, options.baseUrl || '');
}

function getClientLabel(formData) {
  return (
    formData.capa?.clienteProjeto?.trim() ||
    formData.cabecalho?.cliente?.trim() ||
    ''
  );
}

function buildBrandLayers(logoUrl, variant = 'inner') {
  const capaClass = variant === 'capa' ? ' brand-layer-capa' : '';
  const logoBg = logoUrl
    ? `background-image: url('${logoUrl.replace(/'/g, '%27')}');`
    : '';

  return `
    <div class="pdf-brand-waves${capaClass}" aria-hidden="true"></div>
    <div class="pdf-watermark-text" aria-hidden="true">
      <span>${escapeHtml(BRAND.marcaAgua)}</span>
    </div>
    ${
      logoUrl
        ? `<div class="pdf-watermark-logo${capaClass}" style="${logoBg}" aria-hidden="true"></div>`
        : ''
    }
    <div class="pdf-watermark-confidential" aria-hidden="true">${escapeHtml(BRAND.avisoConfidencial)}</div>
  `;
}

function buildInnerPageHeader(logoUrl, clientLabel, sectionTitle) {
  const clientHtml = clientLabel
    ? `<span class="page-header-client">${escapeHtml(clientLabel)}</span>`
    : '';

  return `
    <header class="page-header-bar">
      <div class="page-header-left">
        ${logoUrl ? `<img class="page-header-logo" src="${attrUrl(logoUrl)}" alt="${escapeHtml(BRAND.nome)}" />` : ''}
        <span class="page-header-brand">${escapeHtml(BRAND.subtituloMarca)}</span>
      </div>
      <div class="page-header-right">
        ${clientHtml}
        <span class="page-header-section">${escapeHtml(sectionTitle)}</span>
      </div>
    </header>
  `;
}

function buildInnerPageFooter(pageNum) {
  return `
    <footer class="page-footer-bar">
      <span class="page-footer-brand">${escapeHtml(BRAND.rodape)}</span>
      <span class="page-footer-pagina">${pageNum}</span>
    </footer>
  `;
}

/** Rodapé páginas internas — texto da capa + número da página */
function buildArtworkPageFooter(pageNum) {
  return `
    <footer class="artwork-page-footer">
      <p class="capa-rodape">${escapeHtml(BRAND.rodape)}</p>
      <span class="artwork-page-num">${pageNum}</span>
    </footer>
  `;
}

/** CSS — documento B2B */
export const FORMULARIO_PDF_STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
    background: #e8ecf4 !important;
    margin: 0;
    padding: 12px 0;
    font-size: 13px;
    line-height: 1.4;
    color: ${BRAND.cores.texto};
  }
  .pdf-document {
    width: 100%;
    max-width: 210mm;
    margin: 0 auto;
  }
  .pdf-page {
    width: 100%;
    min-height: 277mm;
    background: white;
    padding: 0;
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-sizing: border-box;
  }
  .pdf-page:not(.pdf-page-capa) {
    height: 277mm;
    max-height: 277mm;
  }
  .pdf-page + .pdf-page { margin-top: 12px; }

  /* —— Camadas de marca (todas as páginas) —— */
  .pdf-brand-waves {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    opacity: 0.28;
    background:
      radial-gradient(ellipse 120% 80% at 10% 20%, rgba(180, 190, 210, 0.4) 0%, transparent 55%),
      radial-gradient(ellipse 100% 70% at 90% 60%, rgba(190, 200, 215, 0.35) 0%, transparent 50%),
      radial-gradient(ellipse 90% 60% at 50% 95%, rgba(175, 185, 200, 0.3) 0%, transparent 45%);
  }
  .pdf-brand-waves.brand-layer-capa { opacity: 0.45; }
  .pdf-watermark-text {
    position: absolute;
    inset: 0;
    z-index: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    overflow: hidden;
  }
  .pdf-watermark-text span {
    font-size: 72pt;
    font-weight: 800;
    letter-spacing: 0.12em;
    color: ${BRAND.cores.primaria};
    opacity: 0.045;
    transform: rotate(-32deg);
    user-select: none;
    white-space: nowrap;
  }
  .pdf-watermark-logo {
    position: absolute;
    left: 50%;
    top: 48%;
    width: 280px;
    height: 120px;
    transform: translate(-50%, -50%);
    z-index: 0;
    pointer-events: none;
    background-repeat: no-repeat;
    background-position: center;
    background-size: contain;
    opacity: 0.055;
  }
  .pdf-watermark-logo.brand-layer-capa {
    width: 320px;
    height: 140px;
    opacity: 0.04;
  }
  .pdf-watermark-confidential {
    position: absolute;
    bottom: 22mm;
    right: 14mm;
    z-index: 0;
    font-size: 7pt;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: ${BRAND.cores.secundaria};
    opacity: 0.55;
    pointer-events: none;
  }
  .pdf-page-capa .pdf-watermark-confidential {
    display: none;
  }
  .capa-ondas-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center bottom;
    z-index: 0;
    pointer-events: none;
    opacity: 1;
  }
  .pdf-page-capa .pdf-brand-waves.brand-layer-capa,
  .pdf-page-capa .pdf-watermark-logo,
  .pdf-page-capa .pdf-watermark-text {
    display: none;
  }

  /* —— Páginas internas — visual alinhado à capa (Imagem1 + Imagem2) —— */
  .pdf-page-cabecalho,
  .pdf-page-passo1,
  .pdf-page-passo,
  .pdf-page-lista-material,
  .pdf-page-anexo {
    padding: 18mm 16mm 14mm;
  }
  .page-shell-artwork {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    height: 100%;
  }
  .page-body-artwork {
    flex: 1;
    min-height: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .pdf-page-cabecalho .page-content,
  .pdf-page-passo .page-content,
  .pdf-page-passo-imagem .page-content,
  .pdf-page-lista-material .page-content,
  .pdf-page-anexo .page-content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .page-shell-artwork .capa-logo-wrap {
    margin-bottom: 6mm;
  }
  .page-top-client {
    margin: 0 0 8mm;
    font-size: 10pt;
    font-weight: 700;
    color: ${BRAND.cores.primaria};
    text-transform: uppercase;
    letter-spacing: 0.02em;
    line-height: 1.35;
  }
  .artwork-page-footer {
    position: relative;
    z-index: 2;
    margin-top: auto;
    padding-top: 6mm;
  }
  .artwork-page-footer .capa-rodape {
    margin-top: 0;
    padding-top: 0;
  }
  .artwork-page-num {
    position: absolute;
    right: 0;
    bottom: 0;
    font-size: 9.5pt;
    font-weight: 600;
    color: ${BRAND.cores.secundaria};
    letter-spacing: 0.02em;
  }

  /* —— Cabeçalho / rodapé páginas internas —— */
  .page-header-bar {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10mm 14mm 4mm;
    border-bottom: 2px solid ${BRAND.cores.accent};
    background: linear-gradient(180deg, #fafbff 0%, #ffffff 100%);
  }
  .page-header-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .page-header-logo {
    height: 32px;
    width: auto;
    max-width: 140px;
    object-fit: contain;
    object-position: left center;
    image-rendering: -webkit-optimize-contrast;
    image-rendering: crisp-edges;
  }
  .page-header-brand {
    font-size: 8pt;
    font-weight: 600;
    color: ${BRAND.cores.secundaria};
    text-transform: uppercase;
    letter-spacing: 0.05em;
    line-height: 1.2;
  }
  .page-header-right {
    text-align: right;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .page-header-client {
    font-size: 9pt;
    font-weight: 700;
    color: ${BRAND.cores.primaria};
    text-transform: uppercase;
    letter-spacing: 0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 95mm;
  }
  .page-header-section {
    font-size: 8pt;
    font-weight: 600;
    color: ${BRAND.cores.secundaria};
  }
  .page-body-inner {
    position: relative;
    z-index: 1;
    flex: 1;
    padding: 8mm 14mm 6mm;
    display: flex;
    flex-direction: column;
  }
  .page-footer-bar {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 4mm 14mm 10mm;
    border-top: 1px solid rgba(123, 104, 238, 0.25);
    background: #fafbff;
  }
  .page-footer-brand {
    font-size: 8pt;
    font-weight: 600;
    color: ${BRAND.cores.secundaria};
  }
  .page-footer-pagina {
    font-size: 8pt;
    font-weight: 600;
    color: ${BRAND.cores.primaria};
  }

  .page-title {
    color: ${BRAND.cores.accent};
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 10px;
    padding-bottom: 5px;
    border-bottom: 2px solid ${BRAND.cores.accent};
    line-height: 1.3;
  }
  .page-content { flex: 1; }
  .report-info {
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .report-info-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 0;
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
  .report-info-value-multiline {
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;
  }
  .report-info-rich {
    white-space: normal;
  }
  .report-info-rich strong,
  .report-info-rich b {
    font-weight: 700;
  }
  .report-info-rich em,
  .report-info-rich i {
    font-style: italic;
  }
  .report-info-rich u {
    text-decoration: underline;
  }
  .report-info-rich ul,
  .report-info-rich ol {
    margin: 0.35em 0 0.35em 1.2em;
    padding: 0;
  }
  .report-info-rich p,
  .report-info-rich div {
    margin: 0 0 0.5em;
  }
  .report-info-rich p:last-child,
  .report-info-rich div:last-child {
    margin-bottom: 0;
  }
  .empty-value { color: #aaa; font-style: italic; }

  /* Informações do projeto — rótulo e valor na mesma linha (Operação: Alares) */
  .pdf-page-cabecalho .report-info-cabecalho {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .pdf-page-cabecalho .report-info-line {
    display: block;
    margin: 0;
    padding: 5px 0 6px;
    border-bottom: 1px solid #f0f0f0;
    font-size: 13px;
    line-height: 1.5;
    color: #111;
  }
  .pdf-page-cabecalho .report-info-line:last-child {
    border-bottom: none;
  }
  .pdf-page-cabecalho .report-info-line .report-info-label {
    display: inline;
    font-weight: 700;
    color: #111;
    font-size: 13px;
    text-transform: none;
    letter-spacing: 0;
  }
  .pdf-page-cabecalho .report-info-line .report-info-colon {
    display: inline;
    font-weight: 700;
    font-size: 13px;
    color: #111;
  }
  .pdf-page-cabecalho .report-info-line .report-info-value {
    display: inline;
    font-weight: 400;
    font-size: 13px;
    color: #111;
    word-break: break-word;
  }
  .pdf-page-cabecalho .report-info-line .empty-value {
    color: #aaa;
    font-style: italic;
  }
  .pdf-page-cabecalho .report-info-line-multiline .report-info-value-multiline {
    display: inline;
    white-space: pre-wrap;
  }

  .pdf-page-lista-material .page-content-lista-material {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .pdf-page-lista-material .lista-material-body {
    flex: 1;
    min-height: 0;
    margin-top: 2mm;
    overflow: hidden;
  }
  .pdf-page-lista-material .lista-material-conteudo {
    font-size: 12px;
    line-height: 1.5;
    color: #333;
  }
  .lista-material-assinatura {
    flex-shrink: 0;
    margin-top: auto;
    padding-top: 10mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    width: 100%;
  }
  .lista-material-assinatura-img {
    display: block;
    max-width: 60mm;
    max-height: 24mm;
    width: auto;
    height: auto;
    object-fit: contain;
    object-position: center bottom;
    margin: 0 auto 2mm;
  }
  .lista-material-assinatura-linha {
    width: 72mm;
    max-width: 85%;
    border-bottom: 1px solid #1f2937;
    margin: 0 0 2.5mm;
  }
  .lista-material-assinatura-cargo {
    margin: 0;
    padding: 0 4mm;
    font-size: 10px;
    font-weight: 600;
    line-height: 1.35;
    color: #374151;
    letter-spacing: 0.02em;
  }

  .pdf-page-anexo .page-content-anexo {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    min-height: 0;
    flex: 1;
  }
  .anexo-pdf-cabecalho {
    flex-shrink: 0;
    margin-bottom: 4mm;
    padding-bottom: 3mm;
    border-bottom: 1px solid #e5e7eb;
  }
  .anexo-pdf-titulo {
    font-size: 11px;
    font-weight: 600;
    color: ${BRAND.cores.secundaria};
    margin: 0 0 2px;
    word-break: break-word;
  }
  .anexo-pdf-subtitulo {
    font-size: 9px;
    color: #6b7280;
    margin: 0;
  }
  .anexo-pdf-pagina-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .anexo-pdf-pagina {
    display: block;
    max-width: 100%;
    max-height: 230mm;
    width: auto;
    height: auto;
    object-fit: contain;
    object-position: center center;
    border: 1px solid #e5e7eb;
    border-radius: 2px;
    background: #fff;
  }

  .passo-conteudo-bloco {
    page-break-inside: avoid;
    break-inside: avoid-page;
  }
  .pdf-page-passo .passo-descricao-body {
    page-break-inside: avoid;
    break-inside: avoid-page;
  }
  .pdf-page-passo-imagem .passo-imagem-body {
    page-break-inside: avoid;
    break-inside: avoid-page;
  }
  .passo1-imagem-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #f0f0f0;
  }
  .pdf-page-passo-imagem .passo1-imagem-wrap {
    margin-top: 4mm;
    padding-top: 0;
    border-top: none;
  }
  .passo1-imagem {
    display: block;
    max-width: 100%;
    max-height: 140mm;
    width: auto;
    height: auto;
    object-fit: contain;
    object-position: left top;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    background: #fff;
  }
  .pdf-page-passo-imagem .passo1-imagem {
    max-height: 200mm;
  }
  .passo-subtitulo-imagem {
    font-size: 12px;
    font-weight: 600;
    color: ${BRAND.cores.secundaria};
    margin: 0 0 6px;
  }
  .passo-imagem-measure-only {
    position: absolute;
    left: -9999px;
    width: 1px;
    height: 1px;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
  }
  .passo-continuacao-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: ${BRAND.cores.secundaria};
  }
  .pdf-page-passo-texto .passo-texto-bloco {
    page-break-inside: avoid;
    break-inside: avoid-page;
  }
  .passo-imagem-apos-texto {
    margin-top: 10px;
    flex-shrink: 0;
  }
  .passo-imagem-apos-texto .passo1-imagem {
    max-width: 100%;
    max-height: 120mm;
    object-fit: contain;
  }

  /* —— Capa —— */
  .pdf-page-capa {
    padding: 18mm 16mm 14mm;
    display: flex;
    flex-direction: column;
  }
  .capa-inner {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    min-height: 100%;
    flex: 1;
  }
  .capa-logo-wrap { margin-bottom: 10mm; }
  .capa-logo {
    height: 64px;
    width: auto;
    max-width: 280px;
    object-fit: contain;
    object-position: left center;
    display: block;
    image-rendering: auto;
  }
  .capa-main-block {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 6mm 4mm 0;
  }
  .capa-titulo {
    font-size: 17pt;
    font-weight: 700;
    color: ${BRAND.cores.primaria};
    line-height: 1.35;
    max-width: 95%;
    margin: 0 0 10px;
  }
  .capa-cliente {
    font-size: 13pt;
    font-weight: 700;
    color: #111;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    line-height: 1.35;
    max-width: 95%;
  }
  .capa-meta-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 10mm 0 14mm;
    gap: 4px;
  }
  .capa-data, .capa-cidade {
    font-size: 13pt;
    font-weight: 700;
    color: #111;
    line-height: 1.35;
  }
  .capa-rodape {
    margin-top: auto;
    text-align: center;
    font-size: 9.5pt;
    font-weight: 600;
    color: ${BRAND.cores.secundaria};
    padding-top: 6mm;
    letter-spacing: 0.02em;
  }

  @page {
    size: A4 portrait;
    margin: 10mm;
  }
  @media print {
    * {
      print-color-adjust: exact !important;
      -webkit-print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
    html,
    body {
      margin: 0 !important;
      padding: 0 !important;
      background: white !important;
    }
    .pdf-document {
      width: 100% !important;
      max-width: none !important;
      margin: 0 !important;
    }
    .pdf-page {
      width: 100% !important;
      min-height: 277mm !important;
      margin: 0 !important;
      page-break-after: always !important;
      break-after: page !important;
      page-break-inside: avoid !important;
      break-inside: avoid-page !important;
      box-shadow: none !important;
    }
    .pdf-page:not(.pdf-page-capa) {
      height: 277mm !important;
      max-height: 277mm !important;
      overflow: hidden !important;
    }
    .pdf-page:last-child {
      page-break-after: auto !important;
      break-after: auto !important;
    }
    .pdf-page + .pdf-page {
      margin-top: 0 !important;
    }
    .pdf-page-cabecalho,
    .pdf-page-passo,
    .pdf-page-passo-imagem,
    .pdf-page-anexo {
      page-break-inside: avoid !important;
      break-inside: avoid-page !important;
    }
    .anexo-pdf-pagina {
      max-height: 230mm !important;
    }
    .pdf-page-cabecalho .report-info-cabecalho {
      gap: 4px !important;
    }
    .pdf-page-cabecalho .report-info-line {
      padding: 4px 0 5px !important;
      font-size: 12px !important;
      line-height: 1.5 !important;
    }
    .pdf-page-cabecalho .report-info-line .report-info-label,
    .pdf-page-cabecalho .report-info-line .report-info-colon,
    .pdf-page-cabecalho .report-info-line .report-info-value {
      font-size: 12px !important;
    }
    .passo-conteudo-bloco,
    .passo-descricao-body,
    .passo-imagem-body {
      page-break-inside: avoid !important;
      break-inside: avoid-page !important;
    }
    .passo1-imagem {
      max-height: 140mm !important;
    }
    .pdf-page-passo-imagem .passo1-imagem {
      max-height: 200mm !important;
    }
    .pdf-watermark-text span { opacity: 0.04; }
    .pdf-watermark-logo { opacity: 0.05; }
  }
`;

function buildCabecalhoInfoLine(label, valueHtml, { multiline = false } = {}) {
  const lineClass = multiline ? 'report-info-line report-info-line-multiline' : 'report-info-line';
  const valueClass = multiline
    ? 'report-info-value report-info-value-multiline'
    : 'report-info-value';
  return `
      <p class="${lineClass}">
        <span class="report-info-label">${escapeHtml(label)}</span><span class="report-info-colon">: </span><span class="${valueClass}">${valueHtml}</span>
      </p>`;
}

function buildSectionFields(items, options = {}) {
  const inline = options.inline === true;

  return items
    .map(({ label, value, multiline, rich }) => {
      if (inline) {
        if (rich) {
          const valueHtml = displayDescricaoValue(value);
          return buildCabecalhoInfoLine(label, valueHtml, { multiline: true });
        }
        const valueHtml = multiline ? displayMultilineValue(value) : displayValue(value);
        return buildCabecalhoInfoLine(label, valueHtml, { multiline });
      }

      if (rich) {
        const valueHtml = displayDescricaoValue(value);
        const isEmpty = valueHtml.includes('empty-value');
        const valueClass = isEmpty
          ? 'report-info-value report-info-value-multiline'
          : 'report-info-value report-info-value-multiline report-info-rich';
        const tag = isEmpty ? 'span' : 'div';
        return `
      <div class="report-info-item">
        <span class="report-info-label">${escapeHtml(label)}</span>
        <${tag} class="${valueClass}">${valueHtml}</${tag}>
      </div>`;
      }

      const valueClass = multiline
        ? 'report-info-value report-info-value-multiline'
        : 'report-info-value';
      const valueHtml = multiline ? displayMultilineValue(value) : displayValue(value);
      const valueTag = multiline ? 'div' : 'span';
      return `
      <div class="report-info-item">
        <span class="report-info-label">${escapeHtml(label)}</span>
        <${valueTag} class="${valueClass}">${valueHtml}</${valueTag}>
      </div>`;
    })
    .join('');
}

function buildPageCapa(formData, options = {}) {
  const logoUrl = getLogoUrl(options);
  const ondasUrl = getCapaOndasUrl(options);
  const tituloDefault = 'Planejamento e Engenharia de Redes FTTx';
  const ondasImg = ondasUrl
    ? `<img class="capa-ondas-svg" src="${attrUrl(ondasUrl)}" alt="" aria-hidden="true" />`
    : '';

  return `
    <div class="pdf-page pdf-page-capa" data-pdf-page="1">
      ${ondasImg}
      ${buildBrandLayers(logoUrl, 'capa')}
      <div class="capa-inner">
        <div class="capa-logo-wrap">
          ${logoUrl ? `<img class="capa-logo" src="${attrUrl(logoUrl)}" alt="${escapeHtml(BRAND.nome)}" />` : ''}
        </div>
        <div class="capa-main-block">
          <h1 class="capa-titulo">${displayValue(formData.capa.titulo?.trim() || tituloDefault)}</h1>
          <p class="capa-cliente">${displayValue(formData.capa.clienteProjeto)}</p>
        </div>
        <div class="capa-meta-block">
          <p class="capa-data">${displayValue(formData.capa.data)}</p>
          <p class="capa-cidade">${displayValue(formData.capa.cidade)}</p>
        </div>
        <footer class="capa-rodape">${escapeHtml(BRAND.rodape)}</footer>
      </div>
    </div>
  `;
}

function buildPageCabecalho(formData, options = {}) {
  const logoUrl = getLogoUrl(options);
  const ondasUrl = getCapaOndasUrl(options);
  const ondasImg = ondasUrl
    ? `<img class="capa-ondas-svg" src="${attrUrl(ondasUrl)}" alt="" aria-hidden="true" />`
    : '';

  return `
    <div class="pdf-page pdf-page-cabecalho" data-pdf-page="2" data-pdf-section="cabecalho">
      ${ondasImg}
      <div class="page-shell-artwork">
        <div class="capa-logo-wrap">
          ${logoUrl ? `<img class="capa-logo" src="${attrUrl(logoUrl)}" alt="${escapeHtml(BRAND.nome)}" />` : ''}
        </div>
        <div class="page-body-inner page-body-artwork">
          <h2 class="page-title">Informações do projeto</h2>
          <div class="page-content">
            <div class="report-info report-info-cabecalho">
              ${buildSectionFields(
                CABECALHO_FIELDS.map(({ key, label, multiline }) => ({
                  label,
                  value: formData.cabecalho[key],
                  multiline
                })),
                { inline: true }
              )}
            </div>
          </div>
        </div>
        ${buildArtworkPageFooter(2, options.totalPages)}
      </div>
    </div>
  `;
}

function buildPassoImageBlock(passo = {}, altFallback = 'Imagem', { showLabel = true } = {}) {
  const src = passo.imagemDataUrl?.trim();
  if (!src) {
    return `
      <div class="passo1-imagem-wrap passo-imagem-body">
        ${showLabel ? '<span class="report-info-label">Imagem</span>' : ''}
        <span class="report-info-value">${displayValue('')}</span>
      </div>`;
  }
  return `
    <div class="passo1-imagem-wrap passo-imagem-body">
      ${showLabel ? '<span class="report-info-label">Imagem</span>' : ''}
      <img
        class="passo1-imagem"
        src="${attrUrl(src)}"
        alt="${escapeHtml(passo.imagemNome || altFallback)}"
      />
    </div>`;
}

function buildPassoPageShell({
  pageNum,
  passoIndex,
  passoNumero,
  pageClass,
  tituloHtml,
  bodyHtml,
  options
}) {
  const logoUrl = getLogoUrl(options);
  const ondasUrl = getCapaOndasUrl(options);
  const ondasImg = ondasUrl
    ? `<img class="capa-ondas-svg" src="${attrUrl(ondasUrl)}" alt="" aria-hidden="true" />`
    : '';

  const passoIndexAttr =
    passoIndex != null && passoIndex !== '' ? ` data-passo-index="${passoIndex}"` : '';

  return `
    <div class="pdf-page ${pageClass}" data-pdf-page="${pageNum}" data-pdf-section="passo-${passoNumero}"${passoIndexAttr}>
      ${ondasImg}
      <div class="page-shell-artwork">
        <div class="capa-logo-wrap">
          ${logoUrl ? `<img class="capa-logo" src="${attrUrl(logoUrl)}" alt="${escapeHtml(BRAND.nome)}" />` : ''}
        </div>
        <div class="page-body-inner page-body-artwork">
          ${tituloHtml}
          <div class="page-content">
            ${bodyHtml}
          </div>
        </div>
        ${buildArtworkPageFooter(pageNum, options.totalPages)}
      </div>
    </div>
  `;
}

/** Página rasterizada de um PDF anexado (somente leitura na prévia/impressão) */
function buildPageAnexoPdf({
  pageNum,
  totalPages,
  anexoId,
  anexoNome,
  pageIndex,
  pageTotal,
  imageDataUrl,
  options = {}
}) {
  const logoUrl = getLogoUrl(options);
  const ondasUrl = getCapaOndasUrl(options);
  const ondasImg = ondasUrl
    ? `<img class="capa-ondas-svg" src="${attrUrl(ondasUrl)}" alt="" aria-hidden="true" />`
    : '';
  const nome = anexoNome?.trim() || 'Anexo PDF';

  return `
    <div class="pdf-page pdf-page-anexo" data-pdf-page="${pageNum}" data-pdf-section="anexo-${escapeHtml(anexoId)}" data-anexo-page="${pageIndex + 1}">
      ${ondasImg}
      <div class="page-shell-artwork">
        <div class="capa-logo-wrap">
          ${logoUrl ? `<img class="capa-logo" src="${attrUrl(logoUrl)}" alt="${escapeHtml(BRAND.nome)}" />` : ''}
        </div>
        <div class="page-body-inner page-body-artwork">
          <div class="page-content page-content-anexo">
            <div class="anexo-pdf-cabecalho">
              <p class="anexo-pdf-titulo">Anexo: ${escapeHtml(nome)}</p>
              <p class="anexo-pdf-subtitulo">Página ${pageIndex + 1} de ${pageTotal} do anexo · documento somente leitura</p>
            </div>
            <div class="anexo-pdf-pagina-wrap">
              <img class="anexo-pdf-pagina" src="${attrUrl(imageDataUrl)}" alt="${escapeHtml(nome)} — página ${pageIndex + 1}" />
            </div>
          </div>
        </div>
        ${buildArtworkPageFooter(pageNum, totalPages)}
      </div>
    </div>
  `;
}

/** Página única para medição na prévia (texto completo + imagem oculta) */
function buildPagePassoMeasure(passo, passoNumero, passoIndex, pageNum, options) {
  const tituloPasso = passo.tituloPasso?.trim() || 'XXXXX';
  const descHtml = getPassoDescricaoInnerHtml(passo);
  const bodyHtml = `
            <div class="report-info passo-conteudo-bloco passo-texto-bloco">
              <span class="report-info-label">Descrição</span>
              <div class="passo-descricao-body">
                <div class="${PASSO_DESC_MEASURE_CLASS}">${descHtml}</div>
              </div>
              ${
                passo.imagemDataUrl?.trim()
                  ? `<div class="passo-imagem-apos-texto passo-imagem-measure-only" aria-hidden="true">${buildPassoImageBlock(passo, `Imagem do passo ${passoNumero}`, { showLabel: true })}</div>`
                  : ''
              }
            </div>`;

  return buildPassoPageShell({
    pageNum,
    passoIndex,
    passoNumero,
    pageClass: 'pdf-page-passo pdf-page-passo-measure',
    tituloHtml: `<h2 class="page-title">Passo ${passoNumero}° — ${escapeHtml(tituloPasso)}</h2>`,
    bodyHtml,
    options
  });
}

function buildPagePassoTextChunk(
  passo,
  passoNumero,
  passoIndex,
  pageNum,
  chunkHtml,
  chunkIndex,
  options,
  chunkOptions = {}
) {
  const tituloPasso = passo.tituloPasso?.trim() || 'XXXXX';
  const suffix = chunkIndex > 0 ? ' (continuação)' : '';
  const showLabel = chunkIndex === 0;
  const labelHtml = showLabel
    ? '<span class="report-info-label">Descrição</span>'
    : '<span class="report-info-label passo-continuacao-label">Continuação</span>';
  const appendImage = chunkOptions.appendImage === true;
  const imageHtml = appendImage
    ? `<div class="passo-imagem-apos-texto">${buildPassoImageBlock(passo, `Imagem do passo ${passoNumero}`, { showLabel: true })}</div>`
    : '';

  const bodyHtml = `
            <div class="report-info passo-conteudo-bloco passo-texto-bloco">
              ${labelHtml}
              <div class="passo-descricao-body">
                <div class="${PASSO_DESC_MEASURE_CLASS}">${chunkHtml}</div>
              </div>
              ${imageHtml}
            </div>`;

  return buildPassoPageShell({
    pageNum,
    passoIndex: chunkIndex === 0 ? passoIndex : null,
    passoNumero,
    pageClass: 'pdf-page-passo pdf-page-passo-texto',
    tituloHtml: `<h2 class="page-title">Passo ${passoNumero}° — ${escapeHtml(tituloPasso)}${escapeHtml(suffix)}</h2>`,
    bodyHtml,
    options
  });
}

function buildPagePassoImageOnly(passo, passoNumero, passoIndex, pageNum, options) {
  const tituloPasso = passo.tituloPasso?.trim() || 'XXXXX';
  const bodyHtml = `
            <div class="report-info passo-conteudo-bloco">
              <p class="passo-subtitulo-imagem">Imagem</p>
              ${buildPassoImageBlock(passo, `Imagem do passo ${passoNumero}`, { showLabel: false })}
            </div>`;

  return buildPassoPageShell({
    pageNum,
    passoIndex: null,
    passoNumero,
    pageClass: 'pdf-page-passo pdf-page-passo-imagem',
    tituloHtml: `<h2 class="page-title">Passo ${passoNumero}° — ${escapeHtml(tituloPasso)}</h2>`,
    bodyHtml,
    options
  });
}

function buildPassoPagesHtml(passo, passoNumero, passoIndex, startPageNum, options) {
  if (options.measurePassoLayout) {
    return {
      html: buildPagePassoMeasure(passo, passoNumero, passoIndex, startPageNum, options),
      nextPageNum: startPageNum + 1
    };
  }

  const layout = options.passoLayouts?.[passoIndex] || defaultPassoLayout(passo);
  const chunks = layout.textChunkHtmls?.length
    ? layout.textChunkHtmls
    : [getPassoDescricaoInnerHtml(passo)];

  let html = '';
  let pageNum = startPageNum;

  const imageOnContinuation = layout.hasImagePage && chunks.length > 1;
  const imageOnFirstPage = layout.imageOnFirstPage === true;

  chunks.forEach((chunkHtml, chunkIndex) => {
    pageNum += 1;
    const isLastChunk = chunkIndex === chunks.length - 1;
    const appendImage =
      (imageOnFirstPage && chunkIndex === 0) || (imageOnContinuation && isLastChunk);
    html += buildPagePassoTextChunk(
      passo,
      passoNumero,
      passoIndex,
      pageNum,
      chunkHtml,
      chunkIndex,
      options,
      { appendImage }
    );
  });

  if (layout.hasImagePage && !imageOnContinuation && !imageOnFirstPage) {
    pageNum += 1;
    html += buildPagePassoImageOnly(passo, passoNumero, passoIndex, pageNum, options);
  }

  return { html, nextPageNum: pageNum };
}

function buildSupervisorAssinaturaHtml(options = {}) {
  const assinaturaUrl = getAssinaturaSupervisorUrl(options);
  const cargo = (BRAND.supervisorCargo || '').trim();
  const imgHtml = assinaturaUrl
    ? `<img class="lista-material-assinatura-img" src="${attrUrl(assinaturaUrl)}" alt="" aria-hidden="true" />`
    : '';
  if (!imgHtml && !cargo) return '';
  return `
    <div class="lista-material-assinatura" role="group" aria-label="Assinatura do supervisor">
      ${imgHtml}
      <div class="lista-material-assinatura-linha" aria-hidden="true"></div>
      ${cargo ? `<p class="lista-material-assinatura-cargo">${escapeHtml(cargo)}</p>` : ''}
    </div>
  `;
}

function buildListaMaterialConteudoHtml(material) {
  const valueHtml = displayDescricaoValue(material.descricao);
  const isEmpty = valueHtml.includes('empty-value');
  const valueClass = isEmpty
    ? 'report-info-value report-info-value-multiline lista-material-conteudo'
    : 'report-info-value report-info-value-multiline report-info-rich lista-material-conteudo';
  const tag = isEmpty ? 'span' : 'div';
  return `<${tag} class="${valueClass}">${valueHtml}</${tag}>`;
}

function buildPageListaMaterial(formData, pageNum, options = {}) {
  const logoUrl = getLogoUrl(options);
  const ondasUrl = getCapaOndasUrl(options);
  const material = formData.listaMaterial || emptyListaMaterial();
  const ondasImg = ondasUrl
    ? `<img class="capa-ondas-svg" src="${attrUrl(ondasUrl)}" alt="" aria-hidden="true" />`
    : '';

  return `
    <div class="pdf-page pdf-page-lista-material" data-pdf-page="${pageNum}" data-pdf-section="lista-material">
      ${ondasImg}
      <div class="page-shell-artwork">
        <div class="capa-logo-wrap">
          ${logoUrl ? `<img class="capa-logo" src="${attrUrl(logoUrl)}" alt="${escapeHtml(BRAND.nome)}" />` : ''}
        </div>
        <div class="page-body-inner page-body-artwork">
          <h2 class="page-title">Lista de Material</h2>
          <div class="page-content page-content-lista-material">
            <div class="lista-material-body">
              ${buildListaMaterialConteudoHtml(material)}
            </div>
            ${buildSupervisorAssinaturaHtml(options)}
          </div>
        </div>
        ${buildArtworkPageFooter(pageNum, options.totalPages)}
      </div>
    </div>
  `;
}

export function buildPdfBodyHtml(formData, meta = {}, options = {}) {
  const totalPages = options.totalPages ?? getPdfPageCount(formData, options);
  const buildOpts = { ...options, totalPages };
  const passos = formData.passos?.length ? formData.passos : [emptyPasso()];
  let pageNum = 2;
  let passosHtml = '';
  passos.forEach((passo, index) => {
    const built = buildPassoPagesHtml(passo, index + 1, index, pageNum + 1, buildOpts);
    passosHtml += built.html;
    pageNum = built.nextPageNum;
  });
  const listaMaterialHtml = buildPageListaMaterial(formData, pageNum + 1, buildOpts);
  pageNum += 1;

  let anexosHtml = '';
  (formData.anexosPdf || []).forEach((anexo) => {
    const images = anexo.pageImages || [];
    const pageTotal = images.length;
    images.forEach((imageDataUrl, pageIndex) => {
      pageNum += 1;
      anexosHtml += buildPageAnexoPdf({
        pageNum,
        totalPages,
        anexoId: anexo.id,
        anexoNome: anexo.nome,
        pageIndex,
        pageTotal,
        imageDataUrl,
        options: buildOpts
      });
    });
  });

  return `
    <div class="pdf-document">
      ${buildPageCapa(formData, buildOpts)}
      ${buildPageCabecalho(formData, buildOpts)}
      ${passosHtml}
      ${listaMaterialHtml}
      ${anexosHtml}
    </div>
  `;
}

export function buildFullPdfHtml(formData, meta = {}, options = {}) {
  const measureNonce = options.measureNonce ?? '';
  const fileBase =
    formData.cabecalho.ordemJira?.trim() ||
    formData.cabecalho.contrato?.trim() ||
    formData.cabecalho.cliente?.trim() ||
    'Formulario-Engenharia';
  const title = `${fileBase} - Engenharia`;
  const baseUrl = options.baseUrl || '';
  const baseTag = baseUrl
    ? `<base href="${escapeHtml(baseUrl.replace(/\/$/, '') + '/')}">`
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8">
    ${baseTag}
    <title>${escapeHtml(title)}</title>
    <style>${FORMULARIO_PDF_STYLES}</style>
  </head>
  <body data-measure-nonce="${escapeHtml(measureNonce)}">
    ${buildPdfBodyHtml(formData, meta, options)}
  </body>
</html>`;
}

export function waitForPrintImages(doc, timeoutMs = 12000) {
  const pending = Array.from(doc.querySelectorAll('img')).filter((img) => !img.complete);

  if (!pending.length) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = 0;
    let settled = false;
    const finishAll = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const finishOne = () => {
      done += 1;
      if (done >= pending.length) finishAll();
    };
    const timer = setTimeout(finishAll, timeoutMs);

    pending.forEach((img) => {
      img.onload = finishOne;
      img.onerror = finishOne;
    });
  });
}

const PDF_PRINT_HINT =
  'Na impressão: destino "Salvar como PDF", margens "Padrão" (ou "Nenhuma") e desmarque "Cabeçalhos e rodapés" do navegador.';

/** Imprime o mesmo HTML da prévia (iframe oculto, sem pop-up). */
export function printPdfHtml(html, options = {}) {
  if (typeof document === 'undefined') {
    return Promise.resolve({ success: false, error: 'no_document' });
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('title', 'Impressão do formulário');
  iframe.style.cssText =
    'position:fixed;left:-9999px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(iframe);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      setTimeout(() => iframe.remove(), 8000);
      resolve(result);
    };

    const runPrint = async () => {
      try {
        const doc = iframe.contentDocument;
        const win = iframe.contentWindow;
        if (!doc?.body || !win) {
          finish({ success: false, error: 'iframe_failed' });
          return;
        }
        if (options.title) doc.title = options.title;
        await waitForPrintImages(doc);
        win.focus();
        win.print();
        finish({ success: true, printHint: PDF_PRINT_HINT });
      } catch (err) {
        console.error('Erro ao imprimir PDF:', err);
        finish({ success: false, error: 'print_failed' });
      }
    };

    iframe.onload = () => setTimeout(runPrint, 200);
    iframe.onerror = () => finish({ success: false, error: 'iframe_failed' });
    iframe.srcdoc = html;
  });
}

/** Imprime a partir do iframe de prévia (WYSIWYG) ou replica o HTML em iframe oculto. */
export async function printEngineeringPdf(previewIframe, html, options = {}) {
  if (previewIframe?.contentWindow?.document?.body) {
    try {
      await waitForPrintImages(previewIframe.contentDocument);
      previewIframe.contentWindow.focus();
      previewIframe.contentWindow.print();
      return { success: true, printHint: PDF_PRINT_HINT };
    } catch (err) {
      console.warn('Impressão pela prévia falhou, usando cópia do HTML:', err);
    }
  }

  if (html) {
    return printPdfHtml(html, options);
  }

  return { success: false, error: 'no_html' };
}

export async function openPdfPrintWindow(formData, options = {}) {
  const baseUrl =
    options.baseUrl ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  const html =
    options.html ||
    buildFullPdfHtml(formData, {}, {
      baseUrl,
      logoDataUrl: options.logoDataUrl,
      capaOndasDataUrl: options.capaOndasDataUrl,
      assinaturaSupervisorDataUrl: options.assinaturaSupervisorDataUrl
    });
  const fileName =
    options.fileName ||
    `${formData.cabecalho.ordemJira?.trim() || formData.cabecalho.contrato?.trim() || formData.cabecalho.cliente?.trim() || 'Formulario'} - Engenharia.pdf`;

  const previewResult = await printEngineeringPdf(options.previewIframe, html, {
    title: fileName.replace('.pdf', '')
  });
  if (previewResult.success) return previewResult;

  const iframeResult = await printPdfHtml(html, {
    title: fileName.replace('.pdf', '')
  });
  if (iframeResult.success) return iframeResult;

  const printWindow = window.open('', '_blank');
  if (!printWindow || !printWindow.document) {
    return { success: false, error: 'popup_blocked' };
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.document.title = fileName.replace('.pdf', '');

  const runPrint = async () => {
    if (printWindow.closed) return;
    try {
      if (printWindow.document?.body) {
        await waitForPrintImages(printWindow.document);
      }
      printWindow.focus();
      printWindow.print();
    } catch (err) {
      console.error('Erro ao imprimir PDF:', err);
    }
  };

  if (printWindow.document.readyState === 'complete') {
    setTimeout(runPrint, 500);
  } else {
    printWindow.onload = () => setTimeout(runPrint, 500);
  }

  return { success: true, printHint: PDF_PRINT_HINT };
}
