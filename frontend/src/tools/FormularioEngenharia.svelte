<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import Loading from '../Loading.svelte';
  import InfoDialog from '../components/InfoDialog.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import {
    defaultFormData,
    normalizeFormData,
    emptyPasso,
    defaultPassoLayout,
    measurePassoLayoutsFromDocument,
    getPassoLayoutWarnings,
    CABECALHO_FIELDS,
    getCabecalhoFieldsForDisplay,
    buildFullPdfHtml,
    getEngineeringPdfDocumentTitle,
    printPdfHtmlNamed,
    loadLogoDataUrl,
    loadCapaOndasDataUrl,
    loadAssinaturaSupervisorDataUrl,
    waitForPrintImages,
    sanitizeRichHtml,
    MAX_ANEXO_PDF_MB,
    createAnexoId,
    createPassoImagemId,
    createPassoDescricaoAposId,
    emptyPassoBlocoApos,
    getPassoImagens,
    getPassoBlocoImagens,
    getPassoDescricoesAposImagem,
    renderPdfFileToPageImages
  } from './formularioPdfShared.js';
  import {
    createRelatorioB2b,
    updateRelatorioB2b,
    fetchRelatorioB2bById,
    fetchRelatoriosB2b,
    PAYLOAD_TIPO,
    SETOR_ORIGEM,
    RELATORIO_STATUS,
    notifyRelatoriosB2bAtualizados
  } from './relatoriosB2bApi.js';
  import { runDuringTransition } from './transitionLoading.js';

  export let currentUser = '';
  export let userTipo = 'user';
  export let onBackToDashboard = () => {};
  /** Navega para outra ferramenta do portal (ex.: dashboard-projetos). */
  export let onOpenTool = null;
  export let onSettingsRequest = null;
  export let onSettingsHover = null;
  /** Registra o handler do botão voltar do header (App.svelte). */
  export let onBackRequest = null;
  /** @type {{ relatorioId?: string, mode?: 'edit'|'print', prefetchedRelatorio?: object } | null} */
  export let toolOpenOptions = null;

  const DASHBOARD_PROJETOS_ID = 'dashboard-projetos';
  const TRANSITION_LOADING_MS = 2000;

  let isTransitionLoading = false;
  let loadingMessage = '';
  let exitWithoutSaveDialogOpen = false;
  /** Snapshot do formulário após Salvar PDF ou carregar — Gerar PDF não atualiza. */
  let lastPersistedFormJson = '';
  /** Só true após Salvar PDF ou ao abrir relatório já existente para edição. */
  let formSavedViaSalvarButton = false;

  function syncPersistedSnapshot() {
    lastPersistedFormJson = JSON.stringify(normalizeFormData(formData));
  }

  function hasUnsavedChanges() {
    if (formReadonly) return false;
    return JSON.stringify(normalizeFormData(formData)) !== lastPersistedFormJson;
  }

  /** Exige Salvar PDF; Gerar PDF grava no servidor mas não libera saída sem aviso. */
  function shouldPromptExitWithoutSave() {
    if (formReadonly) return false;
    if (!formSavedViaSalvarButton) return true;
    return hasUnsavedChanges();
  }

  function solicitarVoltarParaDashboardProjetos(event) {
    event?.preventDefault();
    event?.stopPropagation();
    event?.stopImmediatePropagation?.();

    if (isTransitionLoading) return;

    if (shouldPromptExitWithoutSave()) {
      saveSuccessDialogOpen = false;
      exitWithoutSaveDialogOpen = true;
      return;
    }

    void executarVoltarParaDashboardProjetos();
  }

  function closeExitWithoutSaveDialog() {
    exitWithoutSaveDialogOpen = false;
  }

  function confirmExitWithoutSave() {
    exitWithoutSaveDialogOpen = false;
    void executarVoltarParaDashboardProjetos();
  }

  async function executarVoltarParaDashboardProjetos() {
    if (isTransitionLoading) return;

    saveSuccessDialogOpen = false;
    isTransitionLoading = true;
    loadingMessage = 'Voltando ao Dashboard Projetos…';
    await tick();

    if (typeof onOpenTool !== 'function') {
      isTransitionLoading = false;
      onBackToDashboard();
      return;
    }

    try {
      const initialRelatorios = await runDuringTransition(
        () =>
          fetchRelatoriosB2b(currentUser, {
            setorOrigem: SETOR_ORIGEM.PROJETOS,
            limit: 100
          }),
        TRANSITION_LOADING_MS
      );
      onOpenTool(DASHBOARD_PROJETOS_ID, {
        refreshRelatorios: true,
        initialRelatorios
      });
    } catch (err) {
      alert(err?.message || 'Não foi possível carregar o dashboard.');
    } finally {
      isTransitionLoading = false;
    }
  }

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
  let savingPDF = false;
  let pdfError = '';
  let saveSuccessDialogOpen = false;
  let gerarPdfDialogOpen = false;
  let syncingRelatorioData = false;
  let relatorioSalvoId = null;
  let relatorioStatus = RELATORIO_STATUS.EM_ANALISE;
  let formReadonly = false;
  let expandedSections = {
    capa: false,
    cabecalho: false,
    'passo-0': false,
    listaMaterial: false,
    anexosPdf: false
  };
  let logoDataUrl = '';
  let capaOndasDataUrl = '';
  let assinaturaSupervisorDataUrl = '';
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
  let imagePasteInFlight = false;
  const descricaoEditorEls = {};
  const descricaoEditorReady = {};
  /** Evita resetar innerHTML enquanto o usuário digita (cursor não pula para o início). */
  let focusedDescricaoEditorKey = null;
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
  /** Seção do formulário em edição — prévia volta para a página correspondente */
  let previewFocusAnchor = 'capa';
  /** Restaura rolagem da prévia após atualização automática (mesma seção em edição) */
  let previewScrollRestore = null;
  /** Ao digitar descrição longa, rolar para a última folha de texto do passo */
  let previewPreferTailScroll = false;
  /** Ignora eventos load antigos do iframe quando várias atualizações seguidas */
  let previewApplyGeneration = 0;

  $: cabecalhoFieldsVisible = getCabecalhoFieldsForDisplay(formData.cabecalho);

  $: previewBaseUrl = typeof window !== 'undefined' ? window.location.origin : '';
  $: layoutsForPreview =
    passoLayouts.length === formData.passos.length
      ? passoLayouts
      : formData.passos.map((p) => defaultPassoLayout(p));

  $: measurePassoKey = assetsReady
    ? JSON.stringify(
        formData.passos.map((p) => [
          p.tituloPasso,
          p.descricao,
          p.tituloImagem,
          (p.imagens || []).map((img) => [img.id, img.dataUrl?.length || 0]),
          (p.descricoesAposImagem || []).map((b) => [
            b.id,
            b.descricao,
            b.tituloImagem,
            (b.imagens || []).map((img) => [img.id, img.dataUrl?.length || 0])
          ])
        ])
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
      assinaturaSupervisorDataUrl,
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
    const editorApos = target.closest('.rich-editor[data-desc-apos-id]');
    if (editorApos) {
      previewFocusAnchor = `passo:${editorApos.dataset.passoIndex ?? '0'}`;
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

  function capturePreviewScroll() {
    const win = previewIframeEl?.contentWindow;
    if (!win) return;
    previewScrollRestore = {
      top: win.scrollY,
      left: win.scrollX,
      anchor: previewFocusAnchor
    };
  }

  function findPreviewAnchorPageElement(doc, { preferTail = false } = {}) {
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
      const textPages = doc.querySelectorAll(
        `[data-pdf-section="passo-${passoNumero}"].pdf-page-passo-texto`
      );
      if (textPages.length) {
        return preferTail ? textPages[textPages.length - 1] : textPages[0];
      }
      const passoPages = doc.querySelectorAll(`[data-pdf-section="passo-${passoNumero}"]`);
      if (passoPages.length) {
        return preferTail ? passoPages[passoPages.length - 1] : passoPages[0];
      }
      return doc.querySelector(`.pdf-page-passo[data-passo-index="${passoIndex}"]`);
    }
    return null;
  }

  function scrollPreviewToFocusAnchor(expectedGeneration) {
    if (expectedGeneration != null && expectedGeneration !== previewApplyGeneration) return;

    const doc = previewIframeEl?.contentDocument;
    const win = previewIframeEl?.contentWindow;
    if (!doc || !win) return;

    if (
      previewScrollRestore &&
      previewScrollRestore.anchor === previewFocusAnchor &&
      !previewPreferTailScroll
    ) {
      win.scrollTo({
        top: previewScrollRestore.top,
        left: previewScrollRestore.left,
        behavior: 'auto'
      });
      previewScrollRestore = null;
      previewPreferTailScroll = false;
      return;
    }

    const pageEl = findPreviewAnchorPageElement(doc, { preferTail: previewPreferTailScroll });
    previewPreferTailScroll = false;
    previewScrollRestore = null;

    if (pageEl) {
      pageEl.scrollIntoView({ block: 'start', behavior: 'auto' });
      return;
    }

    const fallback = doc.querySelector('.pdf-page-capa');
    fallback?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  function applyPreviewHtml() {
    if (!assetsReady) return;
    capturePreviewScroll();
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

  function readImageFileAsDataUrl(file) {
    return new Promise((resolve) => {
      if (!file?.type?.startsWith('image/')) {
        resolve(null);
        return;
      }
      if (file.size > MAX_PASSO_IMAGE_MB * 1024 * 1024) {
        pdfError = `Cada imagem deve ter no máximo ${MAX_PASSO_IMAGE_MB} MB.`;
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        const nome =
          file.name?.trim() ||
          `imagem-colada.${(file.type.split('/')[1] || 'png').replace('svg+xml', 'svg')}`;
        resolve(dataUrl ? { dataUrl, nome } : null);
      };
      reader.onerror = () => {
        pdfError = 'Não foi possível ler a imagem. Tente outro arquivo.';
        resolve(null);
      };
      reader.readAsDataURL(file);
    });
  }

  function dedupeImageFiles(files) {
    const out = [];
    const seen = new Set();
    for (const file of files || []) {
      if (!file?.type?.startsWith('image/')) continue;
      const key = `${file.size}:${file.type}:${file.name || ''}:${file.lastModified || 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
    return out;
  }

  /** Clipboard costuma expor a mesma imagem em items e em files — usar só uma fonte. */
  function collectClipboardImageFiles(dt) {
    if (!dt) return [];

    const fromItems = [];
    if (dt.items?.length) {
      for (const item of dt.items) {
        if (!item.type?.startsWith('image/')) continue;
        const file = fileFromClipboardItem(item);
        if (file?.type?.startsWith('image/')) fromItems.push(file);
      }
    }
    if (fromItems.length) return dedupeImageFiles(fromItems);

    const fromFiles = [];
    if (dt.files?.length) {
      for (let i = 0; i < dt.files.length; i++) {
        const file = dt.files[i];
        if (file?.type?.startsWith('image/')) fromFiles.push(file);
      }
    }
    return dedupeImageFiles(fromFiles);
  }

  async function appendImagesToPasso(passoIndex, files, blockId = null) {
    const list = dedupeImageFiles(Array.from(files || []));
    if (!list.length) return false;

    const results = await Promise.all(list.map(readImageFileAsDataUrl));
    const valid = results.filter(Boolean);
    if (!valid.length) return false;

    const novas = valid.map(({ dataUrl, nome }) => ({
      id: createPassoImagemId(),
      dataUrl,
      nome
    }));

    if (blockId) {
      const blocks = getPassoDescricoesAposImagem(formData.passos[passoIndex]);
      updatePasso(passoIndex, {
        descricoesAposImagem: blocks.map((b) =>
          b.id === blockId ? { ...b, imagens: [...(b.imagens || []), ...novas] } : b
        )
      });
    } else {
      const passo = formData.passos[passoIndex];
      updatePasso(passoIndex, { imagens: [...(passo.imagens || []), ...novas] });
    }
    schedulePassoLayoutMeasure(true);
    return true;
  }

  function handlePassoImageChange(event) {
    pdfError = '';
    const files = event.currentTarget?.files;
    if (!files?.length || uploadTarget?.type !== 'passo') return;
    appendImagesToPasso(uploadTarget.index, files, uploadTarget.blockId ?? null);
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
    return a.index === b.index && (a.blockId ?? null) === (b.blockId ?? null);
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
    if (uploadTarget?.type !== 'passo') return false;
    const passoIndex = uploadTarget.index;
    const files = collectClipboardImageFiles(event?.clipboardData);

    const blockId = uploadTarget.blockId ?? null;
    if (files.length) {
      return appendImagesToPasso(passoIndex, files, blockId);
    }

    try {
      const file = await readImageFromClipboardApi();
      if (file) {
        return appendImagesToPasso(passoIndex, [file], blockId);
      }
    } catch (err) {
      console.warn('Leitura da área de transferência:', err);
    }

    pdfError =
      'Não foi possível colar esta imagem. Clique uma vez no box roxo, depois Ctrl+V — ou use duplo clique para escolher arquivo.';
    return false;
  }

  function descricaoEditorKey(passoIndex) {
    return `passo-${passoIndex}`;
  }

  function descricaoAposEditorKey(passoIndex, blockId) {
    return `passo-${passoIndex}-apos-${blockId}`;
  }

  function richHtmlEquivalent(a, b) {
    return sanitizeRichHtml(a || '') === sanitizeRichHtml(b || '');
  }

  function isDescricaoEditorFocused(key) {
    if (focusedDescricaoEditorKey === key) return true;
    const el = descricaoEditorEls[key];
    return !!(el && typeof document !== 'undefined' && el.contains(document.activeElement));
  }

  function syncDescricaoEditor(passoIndex, el) {
    if (!el) return;
    const html = sanitizeRichHtml(el.innerHTML);
    if (html !== formData.passos[passoIndex].descricao) {
      updatePasso(passoIndex, { descricao: html });
    }
  }

  function syncDescricaoAposEditor(passoIndex, blockId, el) {
    if (!el) return;
    const html = sanitizeRichHtml(el.innerHTML);
    const blocks = getPassoDescricoesAposImagem(formData.passos[passoIndex]);
    const current = blocks.find((b) => b.id === blockId);
    if (!current || html === current.descricao) return;
    updatePasso(passoIndex, {
      descricoesAposImagem: blocks.map((b) =>
        b.id === blockId ? { ...b, descricao: html } : b
      )
    });
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
    } else if (target?.dataset?.descAposId) {
      syncDescricaoAposEditor(
        Number(target.dataset.passoIndex),
        target.dataset.descAposId,
        target
      );
    } else if (target?.dataset?.passoIndex != null) {
      syncDescricaoEditor(Number(target.dataset.passoIndex), target);
    }
  }

  function handlePassoDescricaoInput(passoIndex, event) {
    previewFocusAnchor = `passo:${passoIndex}`;
    previewPreferTailScroll = true;
    syncDescricaoEditor(passoIndex, event.currentTarget);
    schedulePassoLayoutMeasure();
  }

  function handlePassoDescricaoAposInput(passoIndex, blockId, event) {
    previewFocusAnchor = `passo:${passoIndex}`;
    previewPreferTailScroll = true;
    syncDescricaoAposEditor(passoIndex, blockId, event.currentTarget);
    schedulePassoLayoutMeasure();
  }

  function updatePassoBlocoTituloImagem(passoIndex, blockId, tituloImagem) {
    const blocks = getPassoDescricoesAposImagem(formData.passos[passoIndex]);
    updatePasso(passoIndex, {
      descricoesAposImagem: blocks.map((b) =>
        b.id === blockId ? { ...b, tituloImagem } : b
      )
    });
    schedulePassoLayoutMeasure();
  }

  function addDescricaoAposImagem(passoIndex) {
    const blocks = getPassoDescricoesAposImagem(formData.passos[passoIndex]);
    const novo = emptyPassoBlocoApos();
    updatePasso(passoIndex, {
      descricoesAposImagem: [...blocks, novo]
    });
    schedulePassoLayoutMeasure(true);
    tick().then(() => initDescricaoAposEditor(passoIndex, novo.id));
  }

  function removePassoBlocoImagem(passoIndex, blockId, imagemId) {
    const blocks = getPassoDescricoesAposImagem(formData.passos[passoIndex]);
    updatePasso(passoIndex, {
      descricoesAposImagem: blocks.map((b) =>
        b.id === blockId
          ? { ...b, imagens: (b.imagens || []).filter((img) => img.id !== imagemId) }
          : b
      )
    });
    schedulePassoLayoutMeasure(true);
  }

  function clearPassoBlocoImages(passoIndex, blockId) {
    const blocks = getPassoDescricoesAposImagem(formData.passos[passoIndex]);
    updatePasso(passoIndex, {
      descricoesAposImagem: blocks.map((b) => (b.id === blockId ? { ...b, imagens: [] } : b))
    });
    schedulePassoLayoutMeasure(true);
  }

  function removeDescricaoAposImagem(passoIndex, blockId) {
    const key = descricaoAposEditorKey(passoIndex, blockId);
    delete descricaoEditorEls[key];
    delete descricaoEditorReady[key];
    const blocks = getPassoDescricoesAposImagem(formData.passos[passoIndex]).filter(
      (b) => b.id !== blockId
    );
    updatePasso(passoIndex, { descricoesAposImagem: blocks });
    schedulePassoLayoutMeasure(true);
  }

  function handleMaterialDescricaoInput(event) {
    previewPreferTailScroll = true;
    syncMaterialDescricaoEditor(event.currentTarget);
  }

  async function initDescricaoEditor(passoIndex) {
    const key = descricaoEditorKey(passoIndex);
    const el = descricaoEditorEls[key];
    if (!el || isDescricaoEditorFocused(key)) return;

    const html = formData.passos[passoIndex]?.descricao || '';
    if (!descricaoEditorReady[key]) {
      el.innerHTML = html;
      descricaoEditorReady[key] = true;
      return;
    }
    if (!richHtmlEquivalent(el.innerHTML, html)) {
      el.innerHTML = html;
    }
  }

  async function initDescricaoAposEditor(passoIndex, blockId) {
    const key = descricaoAposEditorKey(passoIndex, blockId);
    const el = descricaoEditorEls[key];
    if (!el || isDescricaoEditorFocused(key)) return;

    const block = getPassoDescricoesAposImagem(formData.passos[passoIndex]).find(
      (b) => b.id === blockId
    );
    const html = block?.descricao || '';
    if (!descricaoEditorReady[key]) {
      el.innerHTML = html;
      descricaoEditorReady[key] = true;
      return;
    }
    if (!richHtmlEquivalent(el.innerHTML, html)) {
      el.innerHTML = html;
    }
  }

  async function initMaterialDescricaoEditor() {
    const el = descricaoEditorEls.material;
    if (!el || isDescricaoEditorFocused('material')) return;

    const html = formData.listaMaterial.descricao || '';
    if (!descricaoEditorReady.material) {
      el.innerHTML = html;
      descricaoEditorReady.material = true;
      return;
    }
    if (!richHtmlEquivalent(el.innerHTML, html)) {
      el.innerHTML = html;
    }
  }

  /** Só reidrata editores ao expandir passos ou mudar quantidade — não a cada tecla na descrição. */
  $: passoEditorsHydrateKey = `${formData.passos.length}|${Object.entries(expandedSections)
    .filter(([id, open]) => open && id.startsWith('passo-'))
    .map(([id]) => id)
    .join(',')}`;

  $: if (passoEditorsHydrateKey) {
    formData.passos.forEach((passo, passoIndex) => {
      if (expandedSections[passoSectionId(passoIndex)]) {
        tick().then(() => {
          initDescricaoEditor(passoIndex);
          getPassoDescricoesAposImagem(passo).forEach((block) => {
            initDescricaoAposEditor(passoIndex, block.id);
          });
        });
      }
    });
  }

  $: if (expandedSections.listaMaterial) {
    tick().then(initMaterialDescricaoEditor);
  }

  function removePassoImagem(passoIndex, imagemId) {
    const passo = formData.passos[passoIndex];
    updatePasso(passoIndex, {
      imagens: (passo.imagens || []).filter((img) => img.id !== imagemId)
    });
    schedulePassoLayoutMeasure(true);
  }

  function clearPassoImages(passoIndex) {
    updatePasso(passoIndex, { imagens: [] });
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

  const FORM_DATA_SYNC_KEYS = ['capa', 'cabecalho', 'passos', 'listaMaterial', 'anexosPdf'];

  function mergeFormDataPreservandoEdicoesLocais(local, server) {
    let persisted = normalizeFormData(defaultFormData());
    try {
      if (lastPersistedFormJson) {
        persisted = normalizeFormData(JSON.parse(lastPersistedFormJson));
      }
    } catch {
      /* ignore */
    }

    const serverNorm = normalizeFormData(server);
    const localNorm = normalizeFormData(local);
    const merged = { ...serverNorm };

    for (const key of FORM_DATA_SYNC_KEYS) {
      const localChanged = JSON.stringify(localNorm[key]) !== JSON.stringify(persisted[key]);
      if (localChanged) {
        merged[key] = localNorm[key];
      }
    }

    return normalizeFormData(merged);
  }

  /** Busca no servidor alterações feitas em paralelo (outro usuário ou outra aba). */
  async function sincronizarDadosRelatorio() {
    const usuario = (currentUser || '').trim();
    if (!usuario || !relatorioSalvoId) return;

    const rel = await fetchRelatorioB2bById(usuario, relatorioSalvoId, {
      payloadTipo: PAYLOAD_TIPO.PROJETOS
    });

    relatorioStatus = rel.status || relatorioStatus;
    formReadonly = relatorioStatus === RELATORIO_STATUS.FINALIZADO;

    if (rel.formData && Object.keys(rel.formData).length) {
      formData = mergeFormDataPreservandoEdicoesLocais(formData, rel.formData);
    }

    applyPreviewHtml();
    schedulePassoLayoutMeasure(true);
    await flushPreviewRefresh();
  }

  function aplicarRelatorioApi(rel) {
    relatorioSalvoId = rel.id;
    relatorioStatus = rel.status || RELATORIO_STATUS.EM_ANALISE;
    formReadonly = relatorioStatus === RELATORIO_STATUS.FINALIZADO;

    if (rel.formData) {
      formData = normalizeFormData(rel.formData);
      projetistaUserDefaultApplied = true;
    }

    applyPreviewHtml();
    schedulePassoLayoutMeasure(true);
    formSavedViaSalvarButton = true;
    syncPersistedSnapshot();
  }

  async function bootstrapFormulario() {
    const mode = toolOpenOptions?.mode || 'edit';
    const abrindoRelatorio = Boolean(
      toolOpenOptions?.prefetchedRelatorio || toolOpenOptions?.relatorioId
    );

    if (abrindoRelatorio) {
      isTransitionLoading = true;
      loadingMessage = 'Carregando relatório…';
      await tick();
    }

    try {
      const usuario = (currentUser || '').trim();
      const origin = window.location.origin;

      const relatorioPromise = toolOpenOptions?.prefetchedRelatorio
        ? Promise.resolve(toolOpenOptions.prefetchedRelatorio)
        : toolOpenOptions?.relatorioId && usuario
          ? fetchRelatorioB2bById(usuario, toolOpenOptions.relatorioId, {
              payloadTipo: PAYLOAD_TIPO.PROJETOS
            })
          : Promise.resolve(null);

      const [rel, logo, ondas, assinatura] = await Promise.all([
        relatorioPromise,
        loadLogoDataUrl(origin),
        loadCapaOndasDataUrl(origin),
        loadAssinaturaSupervisorDataUrl(origin)
      ]);

      logoDataUrl = logo;
      capaOndasDataUrl = ondas;
      assinaturaSupervisorDataUrl = assinatura;
      assetsReady = true;

      if (rel) {
        aplicarRelatorioApi(rel);
      } else {
        formSavedViaSalvarButton = false;
        applyPreviewHtml();
        schedulePassoLayoutMeasure(true);
      }

      if (mode === 'print' && rel) {
        await tick();
        await flushPreviewRefresh();
        await handleGeneratePdf();
      }
    } catch (err) {
      pdfError = err?.message || 'Não foi possível carregar o relatório.';
    } finally {
      if (abrindoRelatorio) isTransitionLoading = false;
      await tick();
      syncPersistedSnapshot();
    }
  }

  async function carregarRelatorioSalvo(relatorioId, mode = 'edit') {
    const usuario = (currentUser || '').trim();
    if (!usuario || !relatorioId) return;

    try {
      const rel = await fetchRelatorioB2bById(usuario, relatorioId, {
        payloadTipo: PAYLOAD_TIPO.PROJETOS
      });
      aplicarRelatorioApi(rel);

      if (mode === 'print') {
        if (!assetsReady) {
          pdfError = 'Aguarde o carregamento dos recursos do PDF antes de imprimir.';
          return;
        }
        await tick();
        await flushPreviewRefresh();
        await handleGeneratePdf();
      }
    } catch (err) {
      pdfError = err?.message || 'Não foi possível carregar o relatório salvo.';
    }
  }

  async function persistRelatorio({ transferirImplantacao = false } = {}) {
    if (formReadonly) return;

    const usuario = (currentUser || '').trim();
    if (!usuario) {
      throw new Error('Usuário não identificado. Faça login novamente.');
    }

    const payload = normalizeFormData(formData);
    const saveOptions = {
      payload,
      payloadTipo: PAYLOAD_TIPO.PROJETOS,
      status: transferirImplantacao
        ? RELATORIO_STATUS.EM_IMPLANTACAO
        : relatorioStatus || RELATORIO_STATUS.EM_ANALISE,
      setorOrigem: transferirImplantacao ? SETOR_ORIGEM.IMPLANTACAO : SETOR_ORIGEM.PROJETOS
    };

    if (relatorioSalvoId) {
      const atualizado = await updateRelatorioB2b(currentUser, relatorioSalvoId, saveOptions);
      relatorioStatus = atualizado.status || saveOptions.status;
    } else {
      const criado = await createRelatorioB2b(currentUser, saveOptions);
      relatorioSalvoId = criado.id;
      relatorioStatus = criado.status || saveOptions.status;
    }

    notifyRelatoriosB2bAtualizados();
  }

  async function handleSalvarPdf() {
    if (savingPDF || formReadonly || syncingRelatorioData) return;

    savingPDF = true;
    pdfError = '';

    try {
      await sincronizarDadosRelatorio();
      if (formReadonly) {
        pdfError = 'Este relatório foi finalizado e não pode mais ser editado.';
        return;
      }
      await persistRelatorio();
      formSavedViaSalvarButton = true;
      syncPersistedSnapshot();
      saveSuccessDialogOpen = true;
    } catch (err) {
      pdfError = err?.message || 'Não foi possível salvar o relatório. Tente novamente.';
    } finally {
      savingPDF = false;
    }
  }

  async function solicitarGerarPdf() {
    if (!assetsReady) {
      pdfError = 'Aguarde o carregamento dos recursos do PDF antes de gerar.';
      return;
    }
    if (generatingPDF || savingPDF || syncingRelatorioData) return;

    pdfError = '';

    if (formReadonly || relatorioStatus === RELATORIO_STATUS.EM_IMPLANTACAO) {
      void executarGerarPdf({ transferirImplantacao: false });
      return;
    }

    syncingRelatorioData = true;
    try {
      await sincronizarDadosRelatorio();
      if (formReadonly) {
        pdfError = 'Este relatório foi finalizado e não pode mais ser editado.';
        return;
      }
      gerarPdfDialogOpen = true;
    } catch (err) {
      pdfError =
        err?.message || 'Não foi possível atualizar os dados do relatório. Tente novamente.';
    } finally {
      syncingRelatorioData = false;
    }
  }

  async function executarGerarPdf({ transferirImplantacao = false } = {}) {
    if (!assetsReady) {
      pdfError = 'Aguarde o carregamento dos recursos do PDF antes de gerar.';
      return;
    }
    if (generatingPDF || savingPDF || syncingRelatorioData) return;

    generatingPDF = true;
    pdfError = '';

    try {
      if (!formReadonly) {
        await sincronizarDadosRelatorio();
        if (formReadonly) {
          pdfError = 'Este relatório foi finalizado e não pode mais ser editado.';
          return;
        }
        await persistRelatorio({ transferirImplantacao });
        formSavedViaSalvarButton = true;
        syncPersistedSnapshot();
      }

      gerarPdfDialogOpen = false;
      await flushPreviewRefresh();
      const docTitle = getEngineeringPdfDocumentTitle(formData);
      const printHtml = buildFullPdfHtml(formData, {}, buildPreviewHtmlOptions());
      const result = await printPdfHtmlNamed(printHtml, { title: docTitle });
      if (!result.success) {
        pdfError =
          result.error === 'popup_blocked'
            ? 'Não foi possível abrir a impressão. Permita pop-ups para este site e tente de novo.'
            : 'Não foi possível abrir a impressão. Tente novamente.';
      }
    } catch (err) {
      pdfError = err?.message || 'Não foi possível salvar o relatório. Tente novamente.';
    } finally {
      generatingPDF = false;
    }
  }

  function confirmGerarPdfSemImplantacao() {
    void executarGerarPdf({ transferirImplantacao: false });
  }

  function confirmGerarPdfComImplantacao() {
    void executarGerarPdf({ transferirImplantacao: true });
  }

  /** Impressão direta (ex.: menu Imprimir do dashboard) — salva e abre PDF sem diálogo. */
  async function handleGeneratePdf() {
    await executarGerarPdf({ transferirImplantacao: false });
  }

  onMount(async () => {
    isTransitionLoading = false;
    exitWithoutSaveDialogOpen = false;

    if (onSettingsRequest && typeof onSettingsRequest === 'function') {
      onSettingsRequest(() => {});
    }
    if (onSettingsHover && typeof onSettingsHover === 'function') {
      onSettingsHover(() => {});
    }
    if (typeof onBackRequest === 'function') {
      onBackRequest(() => solicitarVoltarParaDashboardProjetos());
    }

    let removeWindowPaste = null;

    if (typeof window !== 'undefined') {
      loadFormColumnWidthPreference();
      await bootstrapFormulario();

      const onWindowPaste = async (e) => {
        if (!armedUploadTarget || imagePasteInFlight) return;
        e.preventDefault();
        e.stopPropagation();
        uploadTarget = armedUploadTarget;
        imagePasteInFlight = true;
        try {
          await processImagePaste(e);
        } finally {
          imagePasteInFlight = false;
        }
      };
      window.addEventListener('paste', onWindowPaste, true);
      removeWindowPaste = () => window.removeEventListener('paste', onWindowPaste, true);
    }

    return () => {
      if (typeof onBackRequest === 'function') {
        onBackRequest(null);
      }
      removeWindowPaste?.();
      disarmImagePaste();
      stopResizeFormColumn();
      clearTimeout(previewDebounceTimer);
      clearTimeout(measureDebounceTimer);
    };
  });

  onDestroy(() => {
    isTransitionLoading = false;
    if (typeof onBackRequest === 'function') {
      onBackRequest(null);
    }
  });
</script>

<div class="formulario-engenharia">
  <div class="workspace">
    <!-- Coluna esquerda: formulário -->
    <aside class="form-column" style="width: {formColumnWidthStyle}; flex: 0 0 auto;">
      <div
        class="form-scroll"
        class:form-readonly={formReadonly}
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
              {#each cabecalhoFieldsVisible as field (field.key)}
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
          multiple
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
                    on:focus={() => {
                      focusedDescricaoEditorKey = editorKey;
                    }}
                    on:input={(e) => handlePassoDescricaoInput(passoIndex, e)}
                    on:paste={handleDescricaoPaste}
                    on:blur={(e) => {
                      focusedDescricaoEditorKey = null;
                      syncDescricaoEditor(passoIndex, e.currentTarget);
                    }}
                  ></div>
                </label>
                <label class="field">
                  <span>Título da seção de Imagens</span>
                  <input
                    type="text"
                    value={passo.tituloImagem || 'Imagem'}
                    on:input={(e) => updatePasso(passoIndex, { tituloImagem: e.currentTarget.value })}
                    placeholder="Imagem"
                  />
                </label>
                <div class="field field-upload">
                  <div
                    class="upload-box"
                    class:armed={uploadTargetsMatch(armedUploadTarget, uploadCtx)}
                    tabindex="0"
                    role="group"
                    aria-label="Imagens do passo {passoIndex + 1}. Um clique para selecionar e colar com Ctrl+V. Dois cliques para escolher arquivos."
                    on:click={() => armImagePaste(uploadCtx)}
                    on:focus={() => armImagePaste(uploadCtx)}
                    on:blur={disarmImagePaste}
                    on:dblclick={(e) => {
                      setUploadTarget(uploadCtx);
                      handleUploadBoxDblClick(e);
                    }}
                  >
                    <div class="upload-trigger">
                      <span class="upload-trigger-text">1 clique: selecionar o box e colar (Ctrl+V)</span>
                      <span class="upload-trigger-hint"
                        >2 cliques: escolher imagens no computador — várias em sequência, até
                        {MAX_PASSO_IMAGE_MB} MB cada</span
                      >
                    </div>
                    {#if getPassoImagens(passo).length}
                      <div class="upload-previews-stack">
                        {#each getPassoImagens(passo) as img (img.id)}
                          <div class="upload-preview-wrap">
                            <img
                              class="upload-preview"
                              src={img.dataUrl}
                              alt="Prévia — {passo.tituloImagem || 'Imagem'} ({img.nome || 'sem nome'})"
                            />
                            {#if img.nome}
                              <p class="upload-filename">{img.nome}</p>
                            {/if}
                            <button
                              type="button"
                              class="btn-remove-image"
                              on:click|stopPropagation={() => removePassoImagem(passoIndex, img.id)}
                            >
                              Remover
                            </button>
                          </div>
                        {/each}
                        <button
                          type="button"
                          class="btn-remove-all-images"
                          on:click|stopPropagation={() => clearPassoImages(passoIndex)}
                        >
                          Remover todas
                        </button>
                      </div>
                    {/if}
                  </div>
                </div>
                {#each getPassoDescricoesAposImagem(passo) as block, blockIndex (block.id)}
                  {@const aposEditorKey = descricaoAposEditorKey(passoIndex, block.id)}
                  {@const blockUploadCtx = { type: 'passo', index: passoIndex, blockId: block.id }}
                  <div class="passo-bloco-apos">
                    <label class="field">
                      <span>Descrição</span>
                      <div
                        use:registerDescricaoEditor={{ key: aposEditorKey }}
                        class="rich-editor"
                        contenteditable="true"
                        role="textbox"
                        aria-multiline="true"
                        data-passo-index={passoIndex}
                        data-desc-apos-id={block.id}
                        data-placeholder="Descrição (suporta negrito e formatação ao colar)"
                        on:focus={() => {
                          focusedDescricaoEditorKey = aposEditorKey;
                        }}
                        on:input={(e) => handlePassoDescricaoAposInput(passoIndex, block.id, e)}
                        on:paste={handleDescricaoPaste}
                        on:blur={(e) => {
                          focusedDescricaoEditorKey = null;
                          syncDescricaoAposEditor(passoIndex, block.id, e.currentTarget);
                        }}
                      ></div>
                    </label>
                    <label class="field">
                      <span>Título da seção de Imagens</span>
                      <input
                        type="text"
                        value={block.tituloImagem || 'Imagem'}
                        on:input={(e) =>
                          updatePassoBlocoTituloImagem(passoIndex, block.id, e.currentTarget.value)}
                        placeholder="Imagem"
                      />
                    </label>
                    <div class="field field-upload">
                      <div
                        class="upload-box"
                        class:armed={uploadTargetsMatch(armedUploadTarget, blockUploadCtx)}
                        tabindex="0"
                        role="group"
                        aria-label="Imagens — {block.tituloImagem || 'Imagem'} do bloco {blockIndex + 1} do passo {passoIndex + 1}. Um clique para selecionar e colar com Ctrl+V. Dois cliques para escolher arquivos."
                        on:click={() => armImagePaste(blockUploadCtx)}
                        on:focus={() => armImagePaste(blockUploadCtx)}
                        on:blur={disarmImagePaste}
                        on:dblclick={(e) => {
                          setUploadTarget(blockUploadCtx);
                          handleUploadBoxDblClick(e);
                        }}
                      >
                        <div class="upload-trigger">
                          <span class="upload-trigger-text">1 clique: selecionar o box e colar (Ctrl+V)</span>
                          <span class="upload-trigger-hint"
                            >2 cliques: escolher imagens no computador — várias em sequência, até
                            {MAX_PASSO_IMAGE_MB} MB cada</span
                          >
                        </div>
                        {#if getPassoBlocoImagens(block).length}
                          <div class="upload-previews-stack">
                            {#each getPassoBlocoImagens(block) as img (img.id)}
                              <div class="upload-preview-wrap">
                                <img
                                  class="upload-preview"
                                  src={img.dataUrl}
                                  alt="Prévia — {block.tituloImagem || 'Imagem'} ({img.nome || 'sem nome'})"
                                />
                                {#if img.nome}
                                  <p class="upload-filename">{img.nome}</p>
                                {/if}
                                <button
                                  type="button"
                                  class="btn-remove-image"
                                  on:click|stopPropagation={() =>
                                    removePassoBlocoImagem(passoIndex, block.id, img.id)}
                                >
                                  Remover
                                </button>
                              </div>
                            {/each}
                            <button
                              type="button"
                              class="btn-remove-all-images"
                              on:click|stopPropagation={() => clearPassoBlocoImages(passoIndex, block.id)}
                            >
                              Remover todas
                            </button>
                          </div>
                        {/if}
                      </div>
                    </div>
                    <button
                      type="button"
                      class="btn-remove-desc-apos"
                      on:click={() => removeDescricaoAposImagem(passoIndex, block.id)}
                    >
                      Remover bloco (descrição e imagens)
                    </button>
                  </div>
                {/each}
                <button
                  type="button"
                  class="btn-add-desc-apos"
                  on:click={() => addDescricaoAposImagem(passoIndex)}
                >
                  + Adicionar descrição abaixo das imagens
                </button>
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
                  on:focus={() => {
                    focusedDescricaoEditorKey = 'material';
                  }}
                  on:input={handleMaterialDescricaoInput}
                  on:paste={handleDescricaoPaste}
                  on:blur={(e) => {
                    focusedDescricaoEditorKey = null;
                    syncMaterialDescricaoEditor(e.currentTarget);
                  }}
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
                Cada PDF anexado vira páginas na prévia e no PDF final, após a Lista de Material. Até
                {MAX_ANEXO_PDF_MB} MB por arquivo (o limite é o tamanho do arquivo, não a quantidade de páginas).
                Não é possível editar o conteúdo dos anexos.
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
        {#if formReadonly}
          <p class="readonly-banner" role="status">
            Este relatório não pode mais ser editado (finalizado).
          </p>
        {/if}
        <div class="form-actions-buttons">
          {#if !formReadonly}
            <button
              type="button"
              class="btn-generate-pdf"
              on:click={handleSalvarPdf}
              disabled={savingPDF || generatingPDF || syncingRelatorioData}
            >
              {savingPDF ? 'Salvando…' : 'Salvar PDF'}
            </button>
          {/if}
          <button
            type="button"
            class="btn-generate-pdf"
            on:click={solicitarGerarPdf}
            disabled={generatingPDF || savingPDF || syncingRelatorioData || !assetsReady}
          >
            {generatingPDF
              ? 'Abrindo impressão...'
              : syncingRelatorioData
                ? 'Atualizando…'
                : 'Gerar PDF'}
          </button>
        </div>
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

{#if isTransitionLoading}
  <div class="transition-loading-layer" role="status" aria-live="polite" aria-busy="true">
    <Loading currentMessage={loadingMessage} />
  </div>
{/if}

<InfoDialog
  open={gerarPdfDialogOpen}
  title="Gerar PDF"
  message="Deseja enviar o Relatório para Implantação?

Você pode Gerar o PDF sem enviar para implantação."
  secondaryLabel="Gerar PDF"
  primaryLabel="Enviar para Implantação"
  on:secondary={confirmGerarPdfSemImplantacao}
  on:primary={confirmGerarPdfComImplantacao}
/>

<InfoDialog
  open={saveSuccessDialogOpen}
  title="Relatório salvo"
  message="Relatório salvo com sucesso!"
  secondaryLabel="Voltar a Editar"
  primaryLabel="Voltar ao Dashboard"
  on:secondary={() => (saveSuccessDialogOpen = false)}
  on:primary={() => executarVoltarParaDashboardProjetos()}
/>

<ConfirmDialog
  open={exitWithoutSaveDialogOpen}
  title="Sair sem salvar?"
  message="Existem alterações que ainda não foram salvas no relatório.

Tem certeza que deseja sair sem salvar o arquivo?"
  confirmLabel="Sair sem salvar"
  cancelLabel="Continuar editando"
  on:confirm={confirmExitWithoutSave}
  on:cancel={closeExitWithoutSaveDialog}
/>

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

  .form-scroll.form-readonly {
    pointer-events: none;
    opacity: 0.92;
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

  .upload-previews-stack {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    width: 100%;
    margin-top: 0.5rem;
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

  .btn-remove-all-images {
    align-self: flex-start;
    margin-top: 0.25rem;
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    font-family: inherit;
    color: #7c2d12;
    background: #fff7ed;
    border: 1px solid #fed7aa;
    border-radius: 6px;
    cursor: pointer;
  }

  .btn-remove-all-images:hover {
    background: #ffedd5;
  }

  .passo-bloco-apos {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    min-width: 0;
    width: 100%;
  }

  .btn-add-desc-apos {
    display: block;
    width: 100%;
    padding: 0.65rem 1rem;
    font-size: 0.875rem;
    font-weight: 600;
    font-family: inherit;
    color: #5b21b6;
    background: #f5f3ff;
    border: 1px dashed rgba(123, 104, 238, 0.55);
    border-radius: 8px;
    cursor: pointer;
    text-align: center;
  }

  .btn-add-desc-apos:hover {
    background: #ede9fe;
    border-color: #7b68ee;
  }

  .btn-remove-desc-apos {
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

  .btn-remove-desc-apos:hover {
    background: #fee2e2;
  }

  .form-actions {
    padding: 1rem;
    border-top: 1px solid #e2e8f0;
    background: #f8fafc;
  }

  .form-actions-buttons {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .readonly-banner {
    margin: 0 0 0.65rem;
    padding: 0.55rem 0.75rem;
    font-size: 0.82rem;
    line-height: 1.4;
    color: #92400e;
    background: #fffbeb;
    border: 1px solid #fcd34d;
    border-radius: 6px;
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
    width: 210mm;
    height: 297mm;
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

  .transition-loading-layer {
    position: fixed;
    inset: 0;
    z-index: 10000;
  }

  .transition-loading-layer :global(.loading-container) {
    min-height: 100%;
  }
</style>
