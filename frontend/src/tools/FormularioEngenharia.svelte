<script>
  import { onMount, tick } from 'svelte';
  import {
    defaultFormData,
    normalizeFormData,
    emptyPasso,
    defaultPassoLayout,
    measurePassoLayoutsFromDocument,
    getPassoLayoutWarnings,
    CABECALHO_FIELDS,
    buildFullPdfHtml,
    printEngineeringPdf,
    loadLogoDataUrl,
    loadCapaOndasDataUrl,
    waitForPrintImages,
    sanitizeRichHtml,
    MAX_ANEXO_PDF_MB,
    createAnexoId,
    renderPdfFileToPageImages
  } from './formularioPdfShared.js';

  export let currentUser = '';
  export let userTipo = 'user';
  export let onBackToDashboard = () => {};
  export let onSettingsRequest = null;
  export let onSettingsHover = null;

  let projetistaUserDefaultApplied = false;

  function createInitialFormData(user = '') {
    const data = normalizeFormData(defaultFormData());
    const name = (user ?? '').trim();
    if (!name) return data;
    projetistaUserDefaultApplied = true;
    return {
      ...data,
      cabecalho: { ...data.cabecalho, projetista: name }
    };
  }

  function applyProjetistaDefault(user = '') {
    if (projetistaUserDefaultApplied) return;
    const name = (user ?? '').trim();
    if (!name) return;
    if (formData.cabecalho.projetista?.trim()) {
      projetistaUserDefaultApplied = true;
      return;
    }
    formData = {
      ...formData,
      cabecalho: { ...formData.cabecalho, projetista: name }
    };
    projetistaUserDefaultApplied = true;
  }

  let formData = createInitialFormData(currentUser);

  $: applyProjetistaDefault(currentUser);
  let generatingPDF = false;
  let pdfError = '';
  let expandedSections = {
    capa: false,
    cabecalho: false,
    'passo-0': false,
    listaMaterial: false,
    anexosPdf: false
  };
  let logoDataUrl = '';
  let capaOndasDataUrl = '';
  let assetsReady = false;
  let passoImageInput;
  let anexoPdfInput;
  let processingAnexoPdf = false;
  let previewIframeEl;
  let measureIframeEl;
  let previewFrameWrapperEl;
  /** { type: 'passo', index: number } | { type: 'material' } */
  let uploadTarget = null;
  let armedUploadTarget = null;
  const descricaoEditorEls = {};
  const descricaoEditorReady = {};
  const MAX_PASSO_IMAGE_MB = 8;

  const PREVIEW_DEBOUNCE_MS = 50;
  const MEASURE_DEBOUNCE_MS = 50;
  const FORM_COLUMN_WIDTH_KEY = 'formularioEngenharia_formColumnWidth';
  const FORM_COLUMN_MIN_PX = 320;
  const FORM_COLUMN_MAX_PX = 720;
  const FORM_COLUMN_DEFAULT_PX = 440;

  let formColumnWidth = FORM_COLUMN_DEFAULT_PX;
  let isResizingFormColumn = false;
  let resizeStartX = 0;
  let resizeStartFormWidth = FORM_COLUMN_DEFAULT_PX;

  $: formColumnWidthStyle = `${formColumnWidth}px`;

  let passoLayouts = [];
  let passoLayoutWarnings = [];
  let measureDebounceTimer = null;
  let previewDebounceTimer = null;
  /** HTML aplicado no iframe visível (atualização com debounce) */
  let previewHtmlDisplayed = '';
  /** HTML do iframe oculto só para medição de quebra de página */
  let measureHtml = '';
  /** Seção do formulário em edição — prévia volta sempre para a página correspondente */
  let previewFocusAnchor = 'capa';
  /** Ignora eventos load antigos do iframe quando várias atualizações seguidas */
  let previewApplyGeneration = 0;

  $: previewBaseUrl = typeof window !== 'undefined' ? window.location.origin : '';
  $: layoutsForPreview =
    passoLayouts.length === formData.passos.length
      ? passoLayouts
      : formData.passos.map((p) => defaultPassoLayout(p));

  $: measurePassoKey = assetsReady
    ? JSON.stringify(
        formData.passos.map((p) => [p.tituloPasso, p.descricao, p.imagemDataUrl?.length || 0])
      )
    : '';

  $: formPreviewKey = assetsReady
    ? JSON.stringify({
        capa: formData.capa,
        cabecalho: formData.cabecalho,
        passos: formData.passos,
        listaMaterial: formData.listaMaterial,
        anexosPdf: (formData.anexosPdf || []).map((a) => [a.id, a.pageImages?.length || 0])
      })
    : '';

  function buildPreviewHtmlOptions({ measurePassoLayout = false, measureNonce = '' } = {}) {
    return {
      baseUrl: previewBaseUrl,
      logoDataUrl,
      capaOndasDataUrl,
      passoLayouts: layoutsForPreview,
      measurePassoLayout,
      measureNonce
    };
  }

  function syncPreviewFocusFromTarget(target) {
    if (!target?.closest) return false;

    const editor = target.closest('.rich-editor[data-passo-index]');
    if (editor) {
      previewFocusAnchor = `passo:${editor.dataset.passoIndex ?? '0'}`;
      return true;
    }

    if (target.closest('[data-editor="material"]')) {
      previewFocusAnchor = 'listaMaterial';
      return true;
    }

    const box = target.closest('[data-preview-anchor]');
    if (!box) return false;

    const anchor = box.dataset.previewAnchor;
    if (anchor === 'passo') {
      previewFocusAnchor = `passo:${box.dataset.passoIndex ?? '0'}`;
    } else {
      previewFocusAnchor = anchor;
    }
    return true;
  }

  function handleFormPreviewActivity(event) {
    syncPreviewFocusFromTarget(event.target);
  }

  function findPreviewAnchorPageElement(doc) {
    if (!doc || !previewFocusAnchor) return null;

    if (previewFocusAnchor === 'capa') {
      return doc.querySelector('.pdf-page-capa');
    }
    if (previewFocusAnchor === 'cabecalho') {
      return doc.querySelector('.pdf-page-cabecalho');
    }
    if (previewFocusAnchor === 'listaMaterial') {
      return (
        doc.querySelector('[data-pdf-section="lista-material"]') ||
        doc.querySelector('.pdf-page-lista-material')
      );
    }
    if (previewFocusAnchor === 'anexosPdf' || previewFocusAnchor.startsWith('anexo:')) {
      const anexoId = previewFocusAnchor.startsWith('anexo:')
        ? previewFocusAnchor.split(':')[1]
        : formData.anexosPdf?.[0]?.id;
      if (anexoId) {
        return doc.querySelector(`[data-pdf-section="anexo-${anexoId}"]`);
      }
      return doc.querySelector('.pdf-page-anexo');
    }
    if (previewFocusAnchor.startsWith('passo:')) {
      const passoIndex = previewFocusAnchor.split(':')[1];
      const passoNumero = Number(passoIndex) + 1;
      return (
        doc.querySelector(`.pdf-page-passo[data-passo-index="${passoIndex}"]`) ||
        doc.querySelector(`[data-pdf-section="passo-${passoNumero}"]`)
      );
    }
    return null;
  }

  function scrollPreviewToFocusAnchor(expectedGeneration) {
    if (expectedGeneration != null && expectedGeneration !== previewApplyGeneration) return;

    const doc = previewIframeEl?.contentDocument;
    const win = previewIframeEl?.contentWindow;
    if (!doc || !win) return;

    const pageEl = findPreviewAnchorPageElement(doc);
    if (pageEl) {
      pageEl.scrollIntoView({ block: 'start', behavior: 'auto' });
      return;
    }

    const fallback = doc.querySelector('.pdf-page-capa');
    fallback?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  function applyPreviewHtml() {
    if (!assetsReady) return;
    previewApplyGeneration += 1;
    previewHtmlDisplayed = buildFullPdfHtml(formData, {}, buildPreviewHtmlOptions());
  }

  function schedulePreviewRefresh(immediate = false) {
    if (!assetsReady) return;
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(
      () => {
        applyPreviewHtml();
      },
      immediate ? 0 : PREVIEW_DEBOUNCE_MS
    );
  }

  async function flushPreviewRefresh() {
    clearTimeout(previewDebounceTimer);
    applyPreviewHtml();
    await tick();
    await new Promise((resolve) => {
      if (!previewIframeEl) {
        resolve();
        return;
      }
      const done = () => resolve();
      if (previewIframeEl.contentDocument?.body?.querySelector('.pdf-document')) {
        done();
        return;
      }
      previewIframeEl.addEventListener('load', done, { once: true });
    });
    const doc = previewIframeEl?.contentDocument;
    if (doc) await waitForPrintImages(doc);
    scrollPreviewToFocusAnchor(previewApplyGeneration);
  }

  function toggleSection(sectionId) {
    expandedSections = {
      ...expandedSections,
      [sectionId]: !expandedSections[sectionId]
    };
  }

  async function runPassoLayoutMeasure() {
    if (!measureIframeEl?.contentDocument?.body || !assetsReady) return;

    const doc = measureIframeEl.contentDocument;
    await waitForPrintImages(doc);
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    const next = measurePassoLayoutsFromDocument(doc, formData.passos);
    const changed = JSON.stringify(next) !== JSON.stringify(passoLayouts);

    if (changed) {
      passoLayouts = next;
      schedulePreviewRefresh(true);
      await tick();
      return;
    }

    passoLayoutWarnings = getPassoLayoutWarnings(formData.passos, passoLayouts);
  }

  function schedulePassoLayoutMeasure(immediate = false) {
    if (typeof window === 'undefined' || !assetsReady) return;

    clearTimeout(measureDebounceTimer);
    measureDebounceTimer = setTimeout(
      () => {
        measureHtml = buildFullPdfHtml(
          formData,
          {},
          buildPreviewHtmlOptions({
            measurePassoLayout: true,
            measureNonce: `${measurePassoKey}-m`
          })
        );
      },
      immediate ? 0 : MEASURE_DEBOUNCE_MS
    );
  }

  async function onMeasureIframeLoad() {
    if (!measureIframeEl?.contentDocument?.body || !assetsReady || !measureHtml) return;
    await runPassoLayoutMeasure();
  }

  async function onPreviewIframeLoad() {
    if (!previewIframeEl?.contentDocument?.body || !assetsReady) return;

    const gen = previewApplyGeneration;
    const doc = previewIframeEl.contentDocument;
    await waitForPrintImages(doc);
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    if (gen !== previewApplyGeneration) return;

    scrollPreviewToFocusAnchor(gen);
    passoLayoutWarnings = getPassoLayoutWarnings(formData.passos, passoLayouts);
  }

  $: if (measurePassoKey) {
    schedulePassoLayoutMeasure();
  }

  $: if (formPreviewKey) {
    schedulePreviewRefresh();
  }

  function passoSectionId(index) {
    return `passo-${index}`;
  }

  function updatePasso(index, patch) {
    formData = {
      ...formData,
      passos: formData.passos.map((p, i) => (i === index ? { ...p, ...patch } : p))
    };
  }

  function updateListaMaterial(patch) {
    formData = {
      ...formData,
      listaMaterial: { ...formData.listaMaterial, ...patch }
    };
  }

  function removeAnexoPdf(anexoIndex) {
    formData = {
      ...formData,
      anexosPdf: formData.anexosPdf.filter((_, i) => i !== anexoIndex)
    };
    schedulePreviewRefresh(true);
  }

  async function handleAnexoPdfSelected(event) {
    const file = event.currentTarget?.files?.[0];
    if (event.currentTarget) event.currentTarget.value = '';
    if (!file) return;

    pdfError = '';
    processingAnexoPdf = true;
    try {
      const { nome, pageImages } = await renderPdfFileToPageImages(file);
      if (!pageImages.length) {
        pdfError = 'O PDF selecionado não possui páginas.';
        return;
      }
      const novo = { id: createAnexoId(), nome, pageImages };
      formData = {
        ...formData,
        anexosPdf: [...(formData.anexosPdf || []), novo]
      };
      previewFocusAnchor = `anexo:${novo.id}`;
      schedulePreviewRefresh(true);
    } catch (err) {
      pdfError = err?.message || 'Não foi possível processar o PDF anexado.';
    } finally {
      processingAnexoPdf = false;
    }
  }

  function triggerAnexoPdfPicker() {
    pdfError = '';
    anexoPdfInput?.click();
  }

  function addPasso() {
    const newIndex = formData.passos.length;
    const novoPasso = emptyPasso();
    formData = {
      ...formData,
      passos: [...formData.passos, novoPasso]
    };
    passoLayouts = [...passoLayouts, defaultPassoLayout(novoPasso)];
    expandedSections = {
      ...expandedSections,
      [passoSectionId(newIndex)]: false
    };
    schedulePassoLayoutMeasure(true);
  }

  function removePasso(passoIndex) {
    if (passoIndex < 1 || formData.passos.length <= 1) return;

    const passoExpanded = {};
    formData.passos.forEach((_, i) => {
      if (i === passoIndex) return;
      const newIndex = i < passoIndex ? i : i - 1;
      const oldId = passoSectionId(i);
      if (expandedSections[oldId] !== undefined) {
        passoExpanded[passoSectionId(newIndex)] = expandedSections[oldId];
      }
    });

    expandedSections = {
      capa: expandedSections.capa,
      cabecalho: expandedSections.cabecalho,
      listaMaterial: expandedSections.listaMaterial,
      anexosPdf: expandedSections.anexosPdf,
      ...passoExpanded
    };

    for (const key of Object.keys(descricaoEditorEls)) {
      if (key.startsWith('passo-')) delete descricaoEditorEls[key];
    }
    for (const key of Object.keys(descricaoEditorReady)) {
      if (key.startsWith('passo-')) delete descricaoEditorReady[key];
    }

    formData = {
      ...formData,
      passos: formData.passos.filter((_, i) => i !== passoIndex)
    };

    passoLayouts = passoLayouts.filter((_, i) => i !== passoIndex);
    schedulePassoLayoutMeasure(true);

    if (uploadTarget?.type === 'passo' && uploadTarget.index === passoIndex) {
      uploadTarget = null;
    } else if (uploadTarget?.type === 'passo' && uploadTarget.index > passoIndex) {
      uploadTarget = { type: 'passo', index: uploadTarget.index - 1 };
    }
    if (armedUploadTarget?.type === 'passo' && armedUploadTarget.index === passoIndex) {
      disarmImagePaste();
    } else if (armedUploadTarget?.type === 'passo' && armedUploadTarget.index > passoIndex) {
      armedUploadTarget = { type: 'passo', index: armedUploadTarget.index - 1 };
    }
  }

  function applyImageToTarget(file) {
    if (!file) return false;
    if (!uploadTarget) return false;

    if (!file.type.startsWith('image/')) {
      pdfError = 'Use um arquivo de imagem (PNG, JPG, WEBP ou SVG).';
      return false;
    }

    if (file.size > MAX_PASSO_IMAGE_MB * 1024 * 1024) {
      pdfError = `A imagem deve ter no máximo ${MAX_PASSO_IMAGE_MB} MB.`;
      return false;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const nome =
        file.name?.trim() ||
        `imagem-colada.${(file.type.split('/')[1] || 'png').replace('svg+xml', 'svg')}`;
      const patch = { imagemDataUrl: dataUrl, imagemNome: nome };
      if (uploadTarget.type === 'passo') {
        updatePasso(uploadTarget.index, patch);
        schedulePassoLayoutMeasure(true);
      }
    };
    reader.onerror = () => {
      pdfError = 'Não foi possível ler a imagem. Tente outro arquivo.';
    };
    reader.readAsDataURL(file);
    return true;
  }

  function handlePassoImageChange(event) {
    pdfError = '';
    const file = event.currentTarget?.files?.[0];
    if (!file) return;
    applyImageToTarget(file);
    event.currentTarget.value = '';
  }

  function handleUploadBoxDblClick(event) {
    event.preventDefault();
    event.stopPropagation();
    pdfError = '';
    passoImageInput?.click();
  }

  function setUploadTarget(target) {
    uploadTarget = target;
  }

  function armImagePaste(target) {
    uploadTarget = target;
    armedUploadTarget = target;
  }

  function disarmImagePaste() {
    armedUploadTarget = null;
  }

  function uploadTargetsMatch(a, b) {
    if (!a || !b) return false;
    if (a.type !== 'passo' || b.type !== 'passo') return false;
    return a.index === b.index;
  }

  function fileFromClipboardItem(item) {
    if (!item?.type?.startsWith('image/')) return null;

    const direct = item.getAsFile?.();
    if (direct) return direct;

    if (typeof item.getAsFile === 'function') {
      try {
        return item.getAsFile();
      } catch {
        /* fallback abaixo */
      }
    }
    return null;
  }

  async function readImageFromClipboardApi() {
    if (!navigator.clipboard?.read) return null;

    const items = await navigator.clipboard.read();
    for (const clipItem of items) {
      const imageType = clipItem.types?.find((t) => t.startsWith('image/'));
      if (!imageType) continue;

      const blob = await clipItem.getType(imageType);
      const ext = imageType.split('/')[1]?.replace('svg+xml', 'svg') || 'png';
      return new File([blob], `imagem-colada.${ext}`, { type: imageType });
    }
    return null;
  }

  async function processImagePaste(event) {
    pdfError = '';
    const dt = event?.clipboardData;

    if (dt?.files?.length) {
      for (let i = 0; i < dt.files.length; i++) {
        const file = dt.files[i];
        if (file?.type?.startsWith('image/') && applyImageToTarget(file)) {
          return true;
        }
      }
    }

    if (dt?.items?.length) {
      for (const item of dt.items) {
        const file = fileFromClipboardItem(item);
        if (file && applyImageToTarget(file)) {
          return true;
        }
      }
    }

    try {
      const file = await readImageFromClipboardApi();
      if (file && applyImageToTarget(file)) {
        return true;
      }
    } catch (err) {
      console.warn('Leitura da área de transferência:', err);
    }

    pdfError =
      'Não foi possível colar esta imagem. Clique uma vez no box roxo, depois Ctrl+V — ou use duplo clique para escolher arquivo.';
    return false;
  }

  async function handleImagePaste(event) {
    if (!armedUploadTarget) return;

    event.preventDefault();
    event.stopPropagation();
    uploadTarget = armedUploadTarget;
    await processImagePaste(event);
  }

  function descricaoEditorKey(passoIndex) {
    return `passo-${passoIndex}`;
  }

  function syncDescricaoEditor(passoIndex, el) {
    if (!el) return;
    const html = sanitizeRichHtml(el.innerHTML);
    if (html !== formData.passos[passoIndex].descricao) {
      updatePasso(passoIndex, { descricao: html });
    }
  }

  function syncMaterialDescricaoEditor(el) {
    if (!el) return;
    const html = sanitizeRichHtml(el.innerHTML);
    if (html !== formData.listaMaterial.descricao) {
      updateListaMaterial({ descricao: html });
    }
  }

  function handleDescricaoPaste(event) {
    event.preventDefault();
    const dt = event.clipboardData;
    if (!dt) return;

    const html = dt.getData('text/html');
    const plain = dt.getData('text/plain');

    if (html?.trim()) {
      document.execCommand('insertHTML', false, sanitizeRichHtml(html));
    } else if (plain != null) {
      document.execCommand('insertText', false, plain);
    }
    const target = event.currentTarget;
    if (target?.dataset?.editor === 'material') {
      syncMaterialDescricaoEditor(target);
    } else if (target?.dataset?.passoIndex != null) {
      syncDescricaoEditor(Number(target.dataset.passoIndex), target);
    }
  }

  function handlePassoDescricaoInput(passoIndex, event) {
    previewFocusAnchor = `passo:${passoIndex}`;
    syncDescricaoEditor(passoIndex, event.currentTarget);
    schedulePassoLayoutMeasure();
  }

  function handleMaterialDescricaoInput(event) {
    syncMaterialDescricaoEditor(event.currentTarget);
  }

  async function initDescricaoEditor(passoIndex) {
    const key = descricaoEditorKey(passoIndex);
    const el = descricaoEditorEls[key];
    if (!el) return;
    const html = formData.passos[passoIndex]?.descricao || '';
    if (!descricaoEditorReady[key] || el.innerHTML !== html) {
      el.innerHTML = html;
      descricaoEditorReady[key] = true;
    }
  }

  async function initMaterialDescricaoEditor() {
    const el = descricaoEditorEls.material;
    if (!el) return;
    const html = formData.listaMaterial.descricao || '';
    if (!descricaoEditorReady.material || el.innerHTML !== html) {
      el.innerHTML = html;
      descricaoEditorReady.material = true;
    }
  }

  $: {
    formData.passos.forEach((_, passoIndex) => {
      if (expandedSections[passoSectionId(passoIndex)]) {
        tick().then(() => initDescricaoEditor(passoIndex));
      }
    });
  }

  $: if (expandedSections.listaMaterial) {
    tick().then(initMaterialDescricaoEditor);
  }

  function clearPassoImage(passoIndex) {
    updatePasso(passoIndex, { imagemDataUrl: '', imagemNome: '' });
    schedulePassoLayoutMeasure(true);
  }

  function registerDescricaoEditor(node, params) {
    const key = params?.key;
    if (key) descricaoEditorEls[key] = node;
    return {
      destroy() {
        if (descricaoEditorEls[key] === node) delete descricaoEditorEls[key];
      }
    };
  }

  function loadFormColumnWidthPreference() {
    if (typeof window === 'undefined') return;
    try {
      const saved = localStorage.getItem(FORM_COLUMN_WIDTH_KEY);
      if (!saved) return;
      const parsed = parseInt(saved, 10);
      if (!Number.isNaN(parsed)) {
        formColumnWidth = Math.max(FORM_COLUMN_MIN_PX, Math.min(FORM_COLUMN_MAX_PX, parsed));
      }
    } catch {
      /* ignore */
    }
  }

  function startResizeFormColumn(e) {
    e.preventDefault();
    e.stopPropagation();
    isResizingFormColumn = true;
    resizeStartX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    resizeStartFormWidth = formColumnWidth;
    document.addEventListener('mousemove', handleResizeFormColumn, { passive: false, capture: true });
    document.addEventListener('mouseup', stopResizeFormColumn, { passive: false, capture: true });
    document.addEventListener('touchmove', handleResizeFormColumn, { passive: false, capture: true });
    document.addEventListener('touchend', stopResizeFormColumn, { passive: false, capture: true });
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function handleResizeFormColumn(e) {
    if (!isResizingFormColumn) return;
    e.preventDefault();
    const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? resizeStartX;
    const deltaX = clientX - resizeStartX;
    formColumnWidth = Math.max(
      FORM_COLUMN_MIN_PX,
      Math.min(FORM_COLUMN_MAX_PX, resizeStartFormWidth + deltaX)
    );
  }

  function stopResizeFormColumn() {
    if (!isResizingFormColumn) return;
    isResizingFormColumn = false;
    document.removeEventListener('mousemove', handleResizeFormColumn, { capture: true });
    document.removeEventListener('mouseup', stopResizeFormColumn, { capture: true });
    document.removeEventListener('touchmove', handleResizeFormColumn, { capture: true });
    document.removeEventListener('touchend', stopResizeFormColumn, { capture: true });
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try {
      localStorage.setItem(FORM_COLUMN_WIDTH_KEY, String(formColumnWidth));
    } catch {
      /* ignore */
    }
  }

  async function handleGeneratePdf() {
    if (!assetsReady) {
      pdfError = 'Aguarde o carregamento das imagens da capa antes de gerar o PDF.';
      return;
    }
    generatingPDF = true;
    pdfError = '';
    await flushPreviewRefresh();
    const fileName = `${formData.cabecalho.ordemJira?.trim() || formData.cabecalho.contrato?.trim() || formData.cabecalho.cliente?.trim() || 'Formulario'} - Engenharia.pdf`;
    const printHtml = buildFullPdfHtml(formData, {}, buildPreviewHtmlOptions());
    const result = await printEngineeringPdf(previewIframeEl, printHtml, {
      title: fileName.replace('.pdf', '')
    });
    generatingPDF = false;
    if (!result.success) {
      pdfError =
        result.error === 'popup_blocked'
          ? 'Não foi possível abrir a impressão. Verifique se o bloqueador de pop-ups está desativado.'
          : 'Não foi possível abrir a impressão. Tente novamente.';
    }
  }

  onMount(async () => {
    if (onSettingsRequest && typeof onSettingsRequest === 'function') {
      onSettingsRequest(() => {});
    }
    if (onSettingsHover && typeof onSettingsHover === 'function') {
      onSettingsHover(() => {});
    }

    let removeWindowPaste = null;

    if (typeof window !== 'undefined') {
      loadFormColumnWidthPreference();
      const origin = window.location.origin;
      const [logo, ondas] = await Promise.all([
        loadLogoDataUrl(origin),
        loadCapaOndasDataUrl(origin)
      ]);
      logoDataUrl = logo;
      capaOndasDataUrl = ondas;
      assetsReady = true;
      applyPreviewHtml();
      schedulePassoLayoutMeasure(true);

      const onWindowPaste = (e) => {
        if (!armedUploadTarget) return;
        e.preventDefault();
        e.stopPropagation();
        uploadTarget = armedUploadTarget;
        processImagePaste(e);
      };
      window.addEventListener('paste', onWindowPaste, true);
      removeWindowPaste = () => window.removeEventListener('paste', onWindowPaste, true);
    }

    return () => {
      removeWindowPaste?.();
      disarmImagePaste();
      stopResizeFormColumn();
      clearTimeout(previewDebounceTimer);
      clearTimeout(measureDebounceTimer);
    };
  });
</script>

<div class="formulario-engenharia">
  <div class="workspace">
    <!-- Coluna esquerda: formulário -->
    <aside class="form-column" style="width: {formColumnWidthStyle}; flex: 0 0 auto;">
      <div
        class="form-scroll"
        on:focusin|capture={handleFormPreviewActivity}
        on:input|capture={handleFormPreviewActivity}
      >
        <!-- Box: Capa -->
        <section class="form-box" class:expanded={expandedSections.capa} data-preview-anchor="capa">
          <button
            type="button"
            class="form-box-header"
            on:click={() => toggleSection('capa')}
            aria-expanded={expandedSections.capa}
          >
            <span class="form-box-title">Capa</span>
            <span class="chevron" class:open={expandedSections.capa}>▼</span>
          </button>
          {#if expandedSections.capa}
            <div class="form-box-body">
              <label class="field">
                <span>Título</span>
                <input
                  type="text"
                  bind:value={formData.capa.titulo}
                  placeholder="Ex: Planejamento e Engenharia de Redes FTTx"
                />
              </label>
              <label class="field">
                <span>Cliente / Projeto</span>
                <input
                  type="text"
                  bind:value={formData.capa.clienteProjeto}
                  placeholder="Ex: SICRED CAMBARÁ (ENGT-46557)"
                />
              </label>
              <label class="field">
                <span>Data</span>
                <input
                  type="text"
                  bind:value={formData.capa.data}
                  placeholder="Ex: 04 de Fevereiro - 2026"
                />
              </label>
              <label class="field">
                <span>Cidade</span>
                <input
                  type="text"
                  bind:value={formData.capa.cidade}
                  placeholder="Ex: Cambará – PR"
                />
              </label>
            </div>
          {/if}
        </section>

        <!-- Box: Informações do projeto -->
        <section class="form-box" class:expanded={expandedSections.cabecalho} data-preview-anchor="cabecalho">
          <button
            type="button"
            class="form-box-header"
            on:click={() => toggleSection('cabecalho')}
            aria-expanded={expandedSections.cabecalho}
          >
            <span class="form-box-title">Informações do projeto</span>
            <span class="chevron" class:open={expandedSections.cabecalho}>▼</span>
          </button>
          {#if expandedSections.cabecalho}
            <div class="form-box-body form-box-body-cabecalho">
              {#each CABECALHO_FIELDS as field (field.key)}
                <label class="field">
                  <span>{field.label}</span>
                  {#if field.multiline}
                    <textarea
                      rows="3"
                      bind:value={formData.cabecalho[field.key]}
                      placeholder={field.placeholder}
                    ></textarea>
                  {:else if field.options?.length}
                    <input
                      type="text"
                      class="field-combobox"
                      list="cabecalho-{field.key}-opcoes"
                      bind:value={formData.cabecalho[field.key]}
                      placeholder={field.placeholder}
                    />
                    <datalist id="cabecalho-{field.key}-opcoes">
                      {#each field.options as opcao (opcao)}
                        <option value={opcao}></option>
                      {/each}
                    </datalist>
                  {:else}
                    <input
                      type="text"
                      bind:value={formData.cabecalho[field.key]}
                      placeholder={field.placeholder}
                    />
                  {/if}
                </label>
              {/each}
            </div>
          {/if}
        </section>

        <input
          bind:this={passoImageInput}
          type="file"
          class="file-input-hidden"
          accept="image/png,image/jpeg,image/jpg,image/webp,image/svg+xml,image/*"
          on:change={handlePassoImageChange}
          tabindex="-1"
          aria-hidden="true"
        />

        {#each formData.passos as passo, passoIndex (passoIndex)}
          {@const sectionId = passoSectionId(passoIndex)}
          {@const editorKey = descricaoEditorKey(passoIndex)}
          {@const uploadCtx = { type: 'passo', index: passoIndex }}
          {@const isLastPasso = passoIndex === formData.passos.length - 1}
          {@const canRemovePasso = passoIndex >= 1}
          <section
            class="form-box"
            class:expanded={expandedSections[sectionId]}
            data-preview-anchor="passo"
            data-passo-index={passoIndex}
          >
            <div class="form-box-header-row">
              <button
                type="button"
                class="form-box-header"
                on:click={() => toggleSection(sectionId)}
                aria-expanded={expandedSections[sectionId]}
              >
                <span class="form-box-title"
                  >Passo {passoIndex + 1}° — {passo.tituloPasso || 'XXXXX'}</span
                >
                <span class="chevron" class:open={expandedSections[sectionId]}>▼</span>
              </button>
              {#if canRemovePasso}
                <button
                  type="button"
                  class="btn-remove-passo"
                  title="Remover Passo {passoIndex + 1}°"
                  aria-label="Remover este passo"
                  on:click|stopPropagation={() => removePasso(passoIndex)}
                >
                  −
                </button>
              {/if}
              {#if isLastPasso}
                <button
                  type="button"
                  class="btn-add-passo"
                  title="Adicionar Passo {passoIndex + 2}°"
                  aria-label="Adicionar próximo passo"
                  on:click|stopPropagation={addPasso}
                >
                  +
                </button>
              {/if}
            </div>
            {#if expandedSections[sectionId]}
              <div class="form-box-body">
                <label class="field">
                  <span>Nome do passo (substitui XXXXX)</span>
                  <input
                    type="text"
                    value={passo.tituloPasso}
                    on:input={(e) => updatePasso(passoIndex, { tituloPasso: e.currentTarget.value })}
                    placeholder="XXXXX"
                  />
                </label>
                <label class="field">
                  <span>Descrição</span>
                  <div
                    use:registerDescricaoEditor={{ key: editorKey }}
                    class="rich-editor"
                    contenteditable="true"
                    role="textbox"
                    aria-multiline="true"
                    data-passo-index={passoIndex}
                    data-placeholder="Descrição do passo (suporta negrito e formatação ao colar)"
                    on:input={(e) => handlePassoDescricaoInput(passoIndex, e)}
                    on:paste={handleDescricaoPaste}
                    on:blur={(e) => syncDescricaoEditor(passoIndex, e.currentTarget)}
                  ></div>
                </label>
                <div class="field field-upload">
                  <span>Imagem</span>
                  <div
                    class="upload-box"
                    class:armed={uploadTargetsMatch(armedUploadTarget, uploadCtx)}
                    tabindex="0"
                    role="group"
                    aria-label="Imagem do passo {passoIndex + 1}. Um clique para selecionar e colar com Ctrl+V. Dois cliques para escolher arquivo."
                    on:click={() => armImagePaste(uploadCtx)}
                    on:focus={() => armImagePaste(uploadCtx)}
                    on:blur={disarmImagePaste}
                    on:paste={handleImagePaste}
                    on:dblclick={(e) => {
                      setUploadTarget(uploadCtx);
                      handleUploadBoxDblClick(e);
                    }}
                  >
                    <div class="upload-trigger">
                      <span class="upload-trigger-text">1 clique: selecionar o box e colar (Ctrl+V)</span>
                      <span class="upload-trigger-hint"
                        >2 cliques seguidos: escolher imagem no computador — até {MAX_PASSO_IMAGE_MB} MB</span
                      >
                    </div>
                    {#if passo.imagemDataUrl}
                      <div class="upload-preview-wrap">
                        <img
                          class="upload-preview"
                          src={passo.imagemDataUrl}
                          alt="Prévia da imagem do passo {passoIndex + 1}"
                        />
                        {#if passo.imagemNome}
                          <p class="upload-filename">{passo.imagemNome}</p>
                        {/if}
                        <button
                          type="button"
                          class="btn-remove-image"
                          on:click|stopPropagation={() => clearPassoImage(passoIndex)}
                        >
                          Remover imagem
                        </button>
                      </div>
                    {/if}
                  </div>
                </div>
              </div>
              {#each passoLayoutWarnings.filter((w) => w.passoIndex === passoIndex) as w (w.message)}
                <p class="passo-layout-warning" role="status">{w.message}</p>
              {/each}
            {/if}
          </section>
        {/each}

        <!-- Box: Lista de Material -->
        <section class="form-box" class:expanded={expandedSections.listaMaterial} data-preview-anchor="listaMaterial">
          <button
            type="button"
            class="form-box-header"
            on:click={() => toggleSection('listaMaterial')}
            aria-expanded={expandedSections.listaMaterial}
          >
            <span class="form-box-title">Lista de Material</span>
            <span class="chevron" class:open={expandedSections.listaMaterial}>▼</span>
          </button>
          {#if expandedSections.listaMaterial}
            <div class="form-box-body">
              <label class="field">
                <span>Descrição</span>
                <div
                  use:registerDescricaoEditor={{ key: 'material' }}
                  class="rich-editor"
                  contenteditable="true"
                  role="textbox"
                  aria-multiline="true"
                  data-editor="material"
                  data-placeholder="Descrição da lista de material"
                  on:input={handleMaterialDescricaoInput}
                  on:paste={handleDescricaoPaste}
                  on:blur={(e) => syncMaterialDescricaoEditor(e.currentTarget)}
                ></div>
              </label>
            </div>
          {/if}
        </section>

        <!-- Box: Anexos PDF -->
        <section class="form-box" class:expanded={expandedSections.anexosPdf} data-preview-anchor="anexosPdf">
          <button
            type="button"
            class="form-box-header"
            on:click={() => toggleSection('anexosPdf')}
            aria-expanded={expandedSections.anexosPdf}
          >
            <span class="form-box-title">Anexos PDF</span>
            <span class="chevron" class:open={expandedSections.anexosPdf}>▼</span>
          </button>
          {#if expandedSections.anexosPdf}
            <div class="form-box-body form-box-body-anexos">
              <p class="anexos-pdf-hint">
                Cada PDF anexado vira páginas na prévia e no PDF final, após a Lista de Material. Máximo
                {MAX_ANEXO_PDF_MB} MB por arquivo. Não é possível editar o conteúdo dos anexos.
              </p>

              {#each formData.anexosPdf as anexo, anexoIndex (anexo.id)}
                <div class="anexo-pdf-item">
                  <div class="anexo-pdf-item-header">
                    <span class="anexo-pdf-item-nome" title={anexo.nome}>{anexo.nome}</span>
                    <span class="anexo-pdf-item-meta"
                      >{anexo.pageImages.length} página{anexo.pageImages.length === 1 ? '' : 's'}</span
                    >
                  </div>
                  <button
                    type="button"
                    class="btn-remove-anexo"
                    on:click={() => removeAnexoPdf(anexoIndex)}
                  >
                    Remover anexo
                  </button>
                </div>
              {/each}

              <input
                bind:this={anexoPdfInput}
                type="file"
                class="file-input-hidden"
                accept="application/pdf,.pdf"
                on:change={handleAnexoPdfSelected}
                tabindex="-1"
                aria-hidden="true"
              />

              <button
                type="button"
                class="btn-add-anexo-pdf"
                on:click={triggerAnexoPdfPicker}
                disabled={processingAnexoPdf}
              >
                {processingAnexoPdf ? 'Processando PDF…' : '+ Adicionar PDF anexo'}
              </button>
            </div>
          {/if}
        </section>
      </div>

      <footer class="form-actions">
        {#if pdfError}
          <p class="pdf-error" role="alert">{pdfError}</p>
        {/if}
        <button
          type="button"
          class="btn-generate-pdf"
          on:click={handleGeneratePdf}
          disabled={generatingPDF || !assetsReady}
        >
          {generatingPDF ? 'Abrindo impressão...' : 'Gerar PDF'}
        </button>
      </footer>
    </aside>

    <div
      class="resize-handle resize-handle-vertical"
      class:resizing={isResizingFormColumn}
      role="separator"
      aria-orientation="vertical"
      aria-label="Ajustar largura do formulário e da prévia"
      on:mousedown|stopPropagation={startResizeFormColumn}
      on:touchstart|stopPropagation={startResizeFormColumn}
    ></div>

    <!-- Coluna direita: prévia em tempo real -->
    <main class="preview-column">
      <div class="preview-header">
        <h2>Prévia do PDF</h2>
      </div>
      <div class="preview-frame-wrapper" bind:this={previewFrameWrapperEl}>
        {#if !assetsReady}
          <p class="preview-loading">Carregando imagens da capa…</p>
        {/if}
        <iframe
          bind:this={measureIframeEl}
          title="Medição de layout do PDF"
          class="pdf-measure-iframe"
          srcdoc={measureHtml}
          sandbox="allow-same-origin"
          tabindex="-1"
          aria-hidden="true"
          on:load={onMeasureIframeLoad}
        ></iframe>
        <iframe
          bind:this={previewIframeEl}
          title="Prévia do PDF"
          class="pdf-preview-iframe"
          class:hidden-until-ready={!assetsReady}
          srcdoc={previewHtmlDisplayed}
          sandbox="allow-same-origin allow-modals"
          tabindex="-1"
          on:load={onPreviewIframeLoad}
        ></iframe>
      </div>
    </main>
  </div>
</div>

<style>
  .formulario-engenharia {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #f0f2f8;
  }

  .workspace {
    flex: 1;
    display: flex;
    min-height: 0;
    gap: 0;
  }

  .form-column {
    min-width: 0;
    max-width: none;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #fff;
    box-shadow: 2px 0 12px rgba(0, 0, 0, 0.04);
  }

  .resize-handle {
    flex-shrink: 0;
    align-self: stretch;
    position: relative;
    z-index: 20;
    touch-action: none;
    user-select: none;
    background: transparent;
    transition: background 0.2s;
  }

  .resize-handle-vertical {
    width: 10px;
    margin: 0 -3px;
    cursor: col-resize;
  }

  .resize-handle-vertical::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 3px;
    transform: translateX(-50%);
    background: #e2e8f0;
    border-radius: 2px;
    transition: background 0.2s, width 0.2s;
    pointer-events: none;
  }

  .resize-handle-vertical:hover,
  .resize-handle-vertical.resizing {
    background: rgba(123, 104, 238, 0.08);
  }

  .resize-handle-vertical:hover::before,
  .resize-handle-vertical.resizing::before {
    background: #7b68ee;
    width: 4px;
  }

  /* Rolagem entre os boxes (Capa, Informações, Passo 1) */
  .form-scroll {
    flex: 1;
    min-height: 0;
    min-width: 0;
    width: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    overscroll-behavior: contain;
    box-sizing: border-box;
  }

  .form-box {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 100%;
    border: 1px solid rgba(123, 104, 238, 0.25);
    border-radius: 10px;
    overflow: hidden;
    background: #fafbff;
    min-height: 0;
    box-sizing: border-box;
  }

  .form-box.expanded {
    max-height: min(58vh, 540px);
  }

  .form-box-header-row {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
    width: 100%;
  }

  .form-box-header-row .form-box-header {
    flex: 1;
    min-width: 0;
  }

  .btn-add-passo,
  .btn-remove-passo {
    flex-shrink: 0;
    width: 2.75rem;
    border: none;
    border-left: 1px solid rgba(255, 255, 255, 0.35);
    background: linear-gradient(135deg, #5a4fd4 0%, #7b68ee 100%);
    color: white;
    font-size: 1.35rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    padding: 0;
  }

  .btn-add-passo:hover,
  .btn-remove-passo:hover {
    filter: brightness(1.1);
  }

  .form-box-header {
    flex-shrink: 0;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.85rem 1rem;
    background: linear-gradient(135deg, #7b68ee 0%, #6b5bee 100%);
    color: white;
    border: none;
    cursor: pointer;
    font-size: 0.95rem;
    font-weight: 600;
    text-align: left;
  }

  .form-box-header:hover {
    filter: brightness(1.05);
  }

  .chevron {
    font-size: 0.65rem;
    transition: transform 0.2s ease;
    transform: rotate(-90deg);
  }

  .chevron.open {
    transform: rotate(0deg);
  }

  /* Rolagem interna dentro do box (campos) */
  .form-box-body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    max-height: min(48vh, 460px);
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    box-sizing: border-box;
    padding: 1rem 0.85rem 1rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    -webkit-overflow-scrolling: touch;
  }

  .form-box-body-cabecalho {
    max-height: min(50vh, 480px);
  }

  .form-box-body-anexos {
    max-height: min(40vh, 380px);
  }

  .anexos-pdf-hint {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.45;
    color: #6b7280;
  }

  .anexo-pdf-item {
    padding: 0.75rem;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #f9fafb;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .anexo-pdf-item-header {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .anexo-pdf-item-nome {
    font-size: 0.85rem;
    font-weight: 600;
    color: #374151;
    word-break: break-word;
  }

  .anexo-pdf-item-meta {
    font-size: 0.75rem;
    color: #6b7280;
  }

  .btn-remove-anexo {
    align-self: flex-start;
    border: 1px solid #fca5a5;
    background: #fff;
    color: #b91c1c;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.35rem 0.65rem;
    border-radius: 6px;
    cursor: pointer;
  }

  .btn-remove-anexo:hover {
    background: #fef2f2;
  }

  .btn-add-anexo-pdf {
    width: 100%;
    border: 2px dashed #7b68ee;
    background: #f5f3ff;
    color: #5b21b6;
    font-size: 0.9rem;
    font-weight: 600;
    padding: 0.75rem 1rem;
    border-radius: 8px;
    cursor: pointer;
  }

  .btn-add-anexo-pdf:hover:not(:disabled) {
    background: #ede9fe;
  }

  .btn-add-anexo-pdf:disabled {
    opacity: 0.65;
    cursor: wait;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 0;
    width: 100%;
    max-width: 100%;
  }

  .field span {
    font-size: 0.8rem;
    font-weight: 600;
    color: #5b21b6;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    line-height: 1.35;
    overflow-wrap: break-word;
    word-break: break-word;
  }

  .field input,
  .field textarea {
    display: block;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 0.55rem 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 0.9rem;
    font-family: inherit;
    color: #1f2937;
    background: white;
  }

  .field input:focus,
  .field textarea:focus,
  .rich-editor:focus {
    outline: none;
    border-color: #7b68ee;
    box-shadow: 0 0 0 3px rgba(123, 104, 238, 0.15);
  }

  .rich-editor {
    display: block;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    min-height: 100px;
    max-height: 220px;
    overflow-y: auto;
    box-sizing: border-box;
    padding: 0.55rem 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 0.9rem;
    font-family: inherit;
    color: #1f2937;
    background: white;
    line-height: 1.45;
    word-break: break-word;
  }

  .rich-editor:empty::before {
    content: attr(data-placeholder);
    color: #9ca3af;
    pointer-events: none;
  }

  .field-upload   .upload-box {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    outline: none;
  }

  .upload-box:focus-visible {
    box-shadow: 0 0 0 3px rgba(123, 104, 238, 0.2);
    border-radius: 8px;
  }

  .upload-box:focus-visible .upload-trigger,
  .upload-box:focus .upload-trigger,
  .upload-box.armed .upload-trigger {
    border-color: #7b68ee;
    background: #f5f3ff;
    box-shadow: inset 0 0 0 1px rgba(123, 104, 238, 0.35);
  }

  .file-input-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .upload-trigger {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    width: 100%;
    max-width: 100%;
    min-height: 88px;
    padding: 0.85rem;
    border: 2px dashed rgba(123, 104, 238, 0.45);
    border-radius: 8px;
    background: #fff;
    cursor: pointer;
    text-align: center;
    box-sizing: border-box;
    position: relative;
  }

  .upload-trigger:hover {
    border-color: #7b68ee;
    background: #f5f3ff;
  }

  .upload-trigger-text {
    font-size: 0.875rem;
    font-weight: 600;
    color: #5b21b6;
    pointer-events: none;
  }

  .upload-trigger-hint {
    font-size: 0.75rem;
    color: #6b7280;
    pointer-events: none;
  }

  .upload-preview-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
    max-width: 100%;
    min-width: 0;
  }

  .upload-preview {
    display: block;
    width: 100%;
    max-width: 100%;
    max-height: 200px;
    object-fit: contain;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: #f9fafb;
  }

  .upload-filename {
    margin: 0;
    font-size: 0.75rem;
    color: #6b7280;
    word-break: break-all;
  }

  .btn-remove-image {
    align-self: flex-start;
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    font-family: inherit;
    color: #b91c1c;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 6px;
    cursor: pointer;
  }

  .btn-remove-image:hover {
    background: #fee2e2;
  }

  .form-actions {
    padding: 1rem;
    border-top: 1px solid #e2e8f0;
    background: #f8fafc;
  }

  .btn-generate-pdf {
    width: 100%;
    padding: 0.85rem 1.25rem;
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(123, 104, 238, 0.35);
  }

  .btn-generate-pdf:hover:not(:disabled) {
    filter: brightness(1.06);
  }

  .btn-generate-pdf:disabled {
    opacity: 0.7;
    cursor: wait;
  }

  .pdf-error {
    margin: 0 0 0.5rem;
    font-size: 0.8rem;
    color: #b91c1c;
  }

  .passo-layout-warning {
    margin: 0.65rem 1rem 0;
    padding: 0.5rem 0.65rem;
    font-size: 0.75rem;
    line-height: 1.4;
    color: #92400e;
    background: #fffbeb;
    border: 1px solid #fcd34d;
    border-radius: 6px;
  }

  .preview-column {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: #e8ecf4;
  }

  .preview-header {
    padding: 0.75rem 1.25rem;
    background: white;
    border-bottom: 1px solid #e2e8f0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 1rem;
  }

  .preview-header h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: #4c1d95;
  }

  .preview-frame-wrapper {
    flex: 1;
    padding: 1rem;
    overflow: auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    position: relative;
  }

  .preview-loading {
    margin: 0 0 0.75rem;
    font-size: 0.875rem;
    color: #6b7280;
  }

  .pdf-measure-iframe {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
    visibility: hidden;
    border: 0;
    left: -9999px;
    top: 0;
  }

  .pdf-preview-iframe.hidden-until-ready {
    visibility: hidden;
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .pdf-preview-iframe {
    width: 100%;
    max-width: 240mm;
    height: 100%;
    min-height: 520px;
    border: 2px solid #7b68ee;
    border-radius: 6px;
    background: #e8ecf4;
    box-shadow: 0 4px 20px rgba(123, 104, 238, 0.15);
  }

  @media (max-width: 900px) {
    .workspace {
      flex-direction: column;
    }

    .resize-handle-vertical {
      display: none;
    }

    .form-column {
      width: 100% !important;
      flex: none !important;
      max-height: 45vh;
    }

    .preview-column {
      min-height: 50vh;
    }
  }
</style>
