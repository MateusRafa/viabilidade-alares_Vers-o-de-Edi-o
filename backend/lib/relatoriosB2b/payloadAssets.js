import { RELATORIOS_B2B_BUCKET, SIGNED_URL_TTL_SEC } from './constants.js';

function extFromMime(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf'
  };
  return map[mime] || 'bin';
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  try {
    return {
      mime: match[1],
      buffer: Buffer.from(match[2], 'base64')
    };
  } catch {
    return null;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

async function uploadBuffer(supabase, storagePath, buffer, mime) {
  const { error } = await supabase.storage.from(RELATORIOS_B2B_BUCKET).upload(storagePath, buffer, {
    contentType: mime,
    upsert: true
  });
  if (error) throw new Error(`Falha ao enviar arquivo (${storagePath}): ${error.message}`);
}

/**
 * Converte formData do front (com dataUrl) para payload persistível (storagePath).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} relatorioId
 * @param {object} formData
 */
export async function persistFormPayloadAssets(supabase, relatorioId, formData) {
  const payload = cloneJson(formData);
  if (!payload || typeof payload !== 'object') return {};

  if (Array.isArray(payload.passos)) {
    for (let passoIndex = 0; passoIndex < payload.passos.length; passoIndex++) {
      const passo = payload.passos[passoIndex];
      if (Array.isArray(passo.imagens)) {
        passo.imagens = await persistImagensList(
          supabase,
          relatorioId,
          `passos/${passoIndex}`,
          passo.imagens
        );
      }
      if (Array.isArray(passo.descricoesAposImagem)) {
        for (let blockIndex = 0; blockIndex < passo.descricoesAposImagem.length; blockIndex++) {
          const block = passo.descricoesAposImagem[blockIndex];
          if (Array.isArray(block.imagens)) {
            block.imagens = await persistImagensList(
              supabase,
              relatorioId,
              `passos/${passoIndex}/blocos/${block.id || blockIndex}`,
              block.imagens
            );
          }
        }
      }
    }
  }

  if (Array.isArray(payload.anexosPdf)) {
    for (const anexo of payload.anexosPdf) {
      const anexoId = anexo.id || `anexo-${Date.now()}`;
      anexo.id = anexoId;
      if (Array.isArray(anexo.pageImages)) {
        const nextPages = [];
        for (let pageIndex = 0; pageIndex < anexo.pageImages.length; pageIndex++) {
          const page = anexo.pageImages[pageIndex];
          if (typeof page === 'string' && page.startsWith('data:')) {
            const parsed = parseDataUrl(page);
            if (!parsed) continue;
            const storagePath = `${relatorioId}/anexos/${anexoId}/page-${String(pageIndex + 1).padStart(3, '0')}.${extFromMime(parsed.mime)}`;
            await uploadBuffer(supabase, storagePath, parsed.buffer, parsed.mime);
            nextPages.push({ storagePath });
          } else if (page && typeof page === 'object' && page.storagePath) {
            nextPages.push({ storagePath: page.storagePath });
          }
        }
        anexo.pageImages = nextPages;
      }
    }
  }

  return payload;
}

async function persistImagensList(supabase, relatorioId, prefix, imagens) {
  const out = [];
  for (const img of imagens || []) {
    if (!img) continue;
    const imgId = img.id || `img-${Date.now()}`;

    if (img.storagePath && !img.dataUrl?.startsWith('data:')) {
      out.push({
        id: imgId,
        nome: img.nome || '',
        storagePath: img.storagePath
      });
      continue;
    }

    if (!img.dataUrl?.startsWith('data:')) continue;

    const parsed = parseDataUrl(img.dataUrl);
    if (!parsed) continue;

    const storagePath = `${relatorioId}/${prefix}/${imgId}.${extFromMime(parsed.mime)}`;
    await uploadBuffer(supabase, storagePath, parsed.buffer, parsed.mime);
    out.push({
      id: imgId,
      nome: img.nome || '',
      storagePath
    });
  }
  return out;
}

async function signedUrlForPath(supabase, storagePath) {
  if (!storagePath) return '';
  const { data, error } = await supabase.storage
    .from(RELATORIOS_B2B_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);
  if (error) {
    console.warn(`⚠️ [RelatoriosB2B] URL assinada falhou (${storagePath}):`, error.message);
    return '';
  }
  return data?.signedUrl || '';
}

/**
 * Hidrata payload do banco para o front (dataUrl = URL assinada para img/iframe).
 */
export async function hydrateFormPayloadAssets(supabase, formData) {
  const payload = cloneJson(formData);
  if (!payload || typeof payload !== 'object') return {};

  if (Array.isArray(payload.passos)) {
    for (const passo of payload.passos) {
      if (Array.isArray(passo.imagens)) {
        passo.imagens = await hydrateImagensList(supabase, passo.imagens);
      }
      if (Array.isArray(passo.descricoesAposImagem)) {
        for (const block of passo.descricoesAposImagem) {
          if (Array.isArray(block.imagens)) {
            block.imagens = await hydrateImagensList(supabase, block.imagens);
          }
        }
      }
    }
  }

  if (Array.isArray(payload.anexosPdf)) {
    for (const anexo of payload.anexosPdf) {
      if (!Array.isArray(anexo.pageImages)) continue;
      const pages = [];
      for (const page of anexo.pageImages) {
        if (typeof page === 'string' && page.startsWith('http')) {
          pages.push(page);
          continue;
        }
        const path = typeof page === 'string' ? null : page?.storagePath;
        if (!path) continue;
        const url = await signedUrlForPath(supabase, path);
        if (url) pages.push(url);
      }
      anexo.pageImages = pages;
    }
  }

  return payload;
}

async function hydrateImagensList(supabase, imagens) {
  const out = [];
  for (const img of imagens || []) {
    if (!img) continue;
    if (img.dataUrl?.startsWith('data:') || img.dataUrl?.startsWith('http')) {
      out.push(img);
      continue;
    }
    if (!img.storagePath) continue;
    const url = await signedUrlForPath(supabase, img.storagePath);
    if (!url) continue;
    out.push({
      id: img.id,
      nome: img.nome || '',
      dataUrl: url,
      storagePath: img.storagePath
    });
  }
  return out;
}

/** Remove todos os arquivos do relatório no bucket de storage. */
export async function deleteRelatorioStorageAssets(supabase, relatorioId) {
  if (!relatorioId) return;

  const paths = [];

  async function walk(folderPath) {
    const { data, error } = await supabase.storage.from(RELATORIOS_B2B_BUCKET).list(folderPath, {
      limit: 1000
    });
    if (error) {
      console.warn(`⚠️ [RelatoriosB2B] list storage (${folderPath}):`, error.message);
      return;
    }
    for (const item of data || []) {
      const fullPath = folderPath ? `${folderPath}/${item.name}` : item.name;
      if (item.id == null) {
        await walk(fullPath);
      } else {
        paths.push(fullPath);
      }
    }
  }

  await walk(relatorioId);

  if (paths.length === 0) return;

  const batchSize = 100;
  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize);
    const { error } = await supabase.storage.from(RELATORIOS_B2B_BUCKET).remove(batch);
    if (error) {
      console.warn('⚠️ [RelatoriosB2B] remove storage batch:', error.message);
    }
  }
}

export function extractSearchMetaFromPayload(formData) {
  const capa = formData?.capa || {};
  const cabecalho = formData?.cabecalho || {};
  return {
    titulo: (capa.titulo || '').trim() || null,
    cliente_projeto: (capa.clienteProjeto || '').trim() || null,
    cidade: (capa.cidade || '').trim() || null,
    projetista: (cabecalho.projetista || '').trim() || null
  };
}
