/**
 * Scraping da Agenda (Arrastadinhas) via Playwright.
 */
import fs from 'fs/promises';

export function parseDataSituacaoBr(text) {
  const raw = (text || '').trim();
  if (!raw) return null;

  const match = raw.match(/(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return raw;

  const [, dd, mm, yyyy, hh, mi, ss = '00'] = match;
  const date = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toISOString();
}

export function parseCidadeUf(cidadeRaw) {
  const text = (cidadeRaw || '').trim();
  if (!text) return { cidade: '', uf: '' };
  const parts = text.split('/').map((p) => p.trim());
  if (parts.length >= 2) {
    return { cidade: parts[0], uf: parts[parts.length - 1] };
  }
  return { cidade: text, uf: '' };
}

function normalizeHref(baseUrl, href) {
  if (!href) return null;
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('/')) return `${baseUrl}${href}`;
  return `${baseUrl}/${href}`;
}

export function extractAgendaCodeFromUrl(url) {
  const match = (url || '').match(/mapa\/code\/([^/?#]+)/i);
  return match?.[1] || null;
}

export async function sessionFileExists(sessionFile) {
  try {
    await fs.access(sessionFile);
    return true;
  } catch {
    return false;
  }
}

export function isLikelyLoginPage(url, title = '', bodyText = '') {
  const u = (url || '').toLowerCase();
  const t = (title || '').toLowerCase();
  const b = (bodyText || '').toLowerCase();

  // Se a fila da Agenda está visível, não é login
  if (
    b.includes('arrastadinhas') ||
    b.includes('sem dados na tabela') ||
    (b.includes('pedido') && b.includes('cidade') && b.includes('motivo'))
  ) {
    return false;
  }

  return (
    u.includes('/login') ||
    u.includes('signin') ||
    u.includes('/sso') ||
    u.includes('oauth') ||
    t.includes('sign in') ||
    t.includes('entrar') ||
    t.includes('login') ||
    b.includes('sign in') ||
    b.includes('senha') && b.includes('usuário') ||
    b.includes('authenticate')
  );
}

export async function readPageAuthSignals(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page
    .locator('body')
    .innerText({ timeout: 5000 })
    .catch(() => '');
  return {
    url,
    title,
    bodyPreview: (bodyText || '').slice(0, 500),
    isLogin: isLikelyLoginPage(url, title, bodyText)
  };
}

export async function clickAtualizar(page) {
  const selectors = [
    'button:has-text("Atualizar")',
    'a:has-text("Atualizar")',
    '[title*="Atualizar"]',
    'button.refresh',
    '.fa-sync',
    '.fa-refresh'
  ];

  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if (await el.count()) {
      try {
        await el.click({ timeout: 3000 });
        return true;
      } catch {
        // tenta próximo seletor
      }
    }
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  return true;
}

export async function waitForListTable(page, timeoutMs) {
  await page.waitForSelector('table tbody tr, .dataTables_empty', { timeout: timeoutMs });
}

export async function scrapeListRows(page, baseUrl) {
  return page.evaluate(({ baseUrl: base }) => {
    function text(el) {
      return (el?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function extractCodeFromCell(cell) {
      if (!cell) return { href: null, code: null };
      const link =
        cell.querySelector('a[href*="mapa/code"]') ||
        cell.querySelector('a[href*="/code/"]') ||
        cell.querySelector('a');
      const href = link?.getAttribute('href') || null;
      const codeMatch = (href || '').match(/mapa\/code\/([^/?#]+)/i);
      return { href, code: codeMatch?.[1] || null };
    }

    const tables = [...document.querySelectorAll('table')];
    let bestRows = [];

    for (const table of tables) {
      const headerCells = [...table.querySelectorAll('thead th, thead td')].map(text);
      const headerText = headerCells.join(' ').toLowerCase();
      if (!headerText.includes('pedido')) continue;

      const bodyRows = [...table.querySelectorAll('tbody tr')];
      const parsed = bodyRows
        .map((tr) => {
          const cells = [...tr.querySelectorAll('td')].map(text);
          if (!cells.length) return null;

          const emptyRow = cells.some((c) => /sem dados na tabela/i.test(c));
          if (emptyRow) return null;

          const actionCell = tr.querySelector('td:last-child');
          const { href, code } = extractCodeFromCell(actionCell);

          const pedidoIdx = headerCells.findIndex((h) => /pedido/i.test(h));
          const ufIdx = headerCells.findIndex((h) => /^uf$/i.test(h));
          const cidadeIdx = headerCells.findIndex((h) => /cidade/i.test(h));
          const sistemaIdx = headerCells.findIndex((h) => /sistema/i.test(h));
          const dataIdx = headerCells.findIndex((h) => /data/i.test(h));
          const pdvIdx = headerCells.findIndex((h) => /^pdv$/i.test(h));
          const motivoIdx = headerCells.findIndex((h) => /motivo/i.test(h));
          const situacaoIdx = headerCells.findIndex((h) => /situa/i.test(h));

          const pick = (idx, fallbackIdx) => {
            if (idx >= 0 && cells[idx] != null) return cells[idx];
            if (fallbackIdx >= 0 && cells[fallbackIdx] != null) return cells[fallbackIdx];
            return '';
          };

          const pedido = pick(pedidoIdx, 3);
          if (!pedido) return null;

          return {
            uf: pick(ufIdx, 0),
            cidade: pick(cidadeIdx, 1),
            sistema: pick(sistemaIdx, 2),
            pedido,
            dataSituacaoRaw: pick(dataIdx, 4),
            pdv: pick(pdvIdx, 5),
            motivo: pick(motivoIdx, 6),
            situacao: pick(situacaoIdx, 7),
            detailHref: href,
            agendaCode: code
          };
        })
        .filter(Boolean);

      if (parsed.length > bestRows.length) {
        bestRows = parsed;
      }
    }

    return bestRows.map((row) => ({
      ...row,
      detailUrl: row.detailHref
        ? row.detailHref.startsWith('http')
          ? row.detailHref
          : `${base}${row.detailHref.startsWith('/') ? '' : '/'}${row.detailHref}`
        : null
    }));
  }, { baseUrl });
}

export async function scrapeDetailFields(page) {
  return page.evaluate(() => {
    function clean(text) {
      return (text || '').replace(/\s+/g, ' ').trim();
    }

    function valueAfterLabel(labelRegex, scope) {
      const root = scope || document.body;
      const nodes = root.querySelectorAll('div, span, p, td, th, label, strong, b, h1, h2, h3, h4');

      for (const node of nodes) {
        const text = clean(node.textContent);
        if (!text || text.length > 120) continue;

        if (labelRegex.test(text)) {
          const sibling = node.nextElementSibling;
          if (sibling) {
            const v = clean(sibling.textContent);
            if (v && v !== text) return v;
          }

          const parent = node.parentElement;
          if (parent) {
            const parts = clean(parent.textContent).split(/\n+/).map(clean).filter(Boolean);
            const idx = parts.findIndex((p) => labelRegex.test(p));
            if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
          }
        }
      }

      return '';
    }

    const header =
      document.querySelector('header') ||
      document.querySelector('[class*="header"]') ||
      document.body;

    const fullText = clean(header.innerText || document.body.innerText);

    function fromRegex(regex) {
      const m = fullText.match(regex);
      return m?.[1]?.trim() || '';
    }

    const pedido = valueAfterLabel(/^pedido$/i, header) || fromRegex(/pedido\s*[\n:]\s*(\d+)/i);
    const enderecoCompleto =
      valueAfterLabel(/^endere[cç]o$/i, header) || fromRegex(/endere[cç]o\s*[\n:]\s*(.+?)(?=\s*(bairro|cep|pedido|cidade)\s*[\n:]|$)/i);
    const bairro = valueAfterLabel(/^bairro$/i, header) || fromRegex(/bairro\s*[\n:]\s*([^\n]+)/i);
    const cepRaw = valueAfterLabel(/^cep$/i, header) || fromRegex(/cep\s*[\n:]\s*(\d{5}-?\d{3}|\d{8})/i);
    const cidadeRaw = valueAfterLabel(/^cidade$/i, header) || fromRegex(/cidade\s*[\n:]\s*([^\n]+)/i);

    const numeroMatch = enderecoCompleto.match(/\b[Nnº°]\s*(\d+\w*)/);
    const logradouro = enderecoCompleto
      .replace(/\b[Nnº°]\s*\d+\w*.*$/i, '')
      .replace(/,\s*SG\s*$/i, '')
      .trim();

    return {
      pedido,
      enderecoCompleto,
      logradouro,
      numero: numeroMatch?.[1] || '',
      bairro,
      cep: (() => {
        const digits = (cepRaw || '').replace(/\D/g, '');
        return digits.length > 8 ? digits.slice(0, 8) : digits;
      })(),
      cidadeRaw
    };
  });
}

export async function openDetailFromRow(page, row, baseUrl) {
  if (row.detailUrl) {
    await page.goto(row.detailUrl, { waitUntil: 'domcontentloaded' });
    return page.url();
  }

  const pedido = row.pedido;
  const rowLocator = page.locator('table tbody tr').filter({ hasText: pedido }).first();
  const actionButton = rowLocator.locator('td:last-child a, td:last-child button').first();

  if (await actionButton.count()) {
    await actionButton.click();
    await page.waitForLoadState('domcontentloaded');
    return page.url();
  }

  throw new Error(`Não foi possível abrir o chamado ${pedido} (link da lupa não encontrado).`);
}

export function buildChamadoPayload(listRow, detail, detailUrl) {
  const agendaCode = listRow.agendaCode || extractAgendaCodeFromUrl(detailUrl);
  const cidadeParsed = parseCidadeUf(detail.cidadeRaw || listRow.cidade);
  const uf = listRow.uf || cidadeParsed.uf;
  const cidade = cidadeParsed.cidade || listRow.cidade;

  const enderecoCompleto =
    detail.enderecoCompleto ||
    [detail.logradouro, detail.numero ? `N ${detail.numero}` : ''].filter(Boolean).join(' ');

  return {
    id: agendaCode || undefined,
    agendaCode,
    uf,
    cidade: (cidade || '').toUpperCase(),
    sistema: listRow.sistema,
    pedido: detail.pedido || listRow.pedido,
    dataSituacao: parseDataSituacaoBr(listRow.dataSituacaoRaw) || listRow.dataSituacaoRaw,
    pdv: listRow.pdv,
    motivo: listRow.motivo,
    situacao: listRow.situacao,
    endereco: {
      logradouro: detail.logradouro || enderecoCompleto,
      numero: detail.numero || '',
      bairro: detail.bairro || '',
      cidade: cidadeParsed.cidade || cidade,
      uf,
      cep: detail.cep || '',
      completo: enderecoCompleto
    },
    origem: 'agenda-bot',
    agendaUrl: detailUrl,
    tabulacaoStatus: 'aguardando_analise'
  };
}

export { normalizeHref };
