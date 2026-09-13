<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import {
    analisarPortalCensupChamado,
    fetchPortalCensupChamadoById,
    fetchTabulacoesList
  } from './portalCensupApi.js';
  import { getApiUrl } from '../config.js';
  import { theme } from '../themeStore.js';

  // Import dinâmico — evita ciclo com registry/Config no bundle principal
  let ViabilidadeAlares = null;
  let viabilidadeRef = null;

  const MSG_SOURCE = 'censup-workbench';
  const PARENT_SOURCE = 'censup-extension';

  $: isDarkUi = $theme === 'dark';

  function applyUiTheme(next) {
    const value = next === 'dark' ? 'dark' : 'light';
    theme.set(value);
    try {
      document.documentElement.dataset.theme = value;
      document.documentElement.classList.toggle('wb-theme-dark', value === 'dark');
      document.body?.classList.toggle('wb-theme-dark', value === 'dark');
    } catch {
      /* ignore */
    }
  }

  let usuario = '';
  let chamadoId = '';
  let chamado = null;
  let loading = true;
  let error = '';
  let saving = false;
  let generating = false;
  let statusMsg = '';
  let tabulacoes = [];
  let sugeridaOriginal = '';
  let showInfoModal = false;
  let equipamentos = [];
  /** Box “Fora do Limite” (CTO > 250m) — espelho do oficial. */
  let foraLimiteInfo = null;
  let showInfoForaLimite = false;
  /** Altura do box Equipamentos (px) dentro do split; null = padrão ~32%. */
  let equipPaneHeightPx = null;
  let equipCollapsed = true;
  let mapCollapsed = false;
  let splitDragging = false;
  let splitEl = null;
  let equipPaneEl = null;
  let splitResizeRaf = 0;
  let splitStartY = 0;
  let splitStartEquipHeight = 0;
  let splitHandleEl = null;
  let splitPointerId = null;
  let splitShieldEl = null;
  /** Coords da casinha (mapa) — evita re-geocode por texto ao sync do form. */
  let pinCoords = null;
  let reanaliseTimer = null;
  let reanalyzing = false;
  let mapPreviewImage = '';
  let capturingMapPreview = false;
  let locating = false;
  let mapSearchError = '';

  /** Altura da barra Equipamentos colapsada (toolbar + padding ≈ Informações). */
  const EQUIP_HEADER_H = 42;
  const MAP_COLLAPSED_H = 8;
  const HANDLE_H = 12;
  const SNAP_PX = 28;
  const DEFAULT_EQUIP_RATIO = 0.32;

  function requestMapResize(delayMs = 120) {
    setTimeout(() => {
      try {
        window.dispatchEvent(new Event('resize'));
      } catch {
        // ignore
      }
    }, delayMs);
  }

  function onEquipamentosFromViabilidade(payload = {}) {
    const next = Array.isArray(payload.items) ? payload.items : [];
    const signature = (list) =>
      list
        .map((i) => `${i.ctoKey || i.nome}:${i.visible !== false ? 1 : 0}:${i.n}`)
        .join('|');
    const prevKey = signature(equipamentos);
    const nextKey = signature(next);
    if (prevKey === nextKey) return;
    const sameSet =
      equipamentos.map((i) => i.ctoKey || i.nome).join('|') ===
      next.map((i) => i.ctoKey || i.nome).join('|');
    equipamentos = next;
    if (!sameSet) clearEquipSelection();
  }

  function onForaLimiteFromViabilidade(payload = {}) {
    if (!payload?.active) {
      if (foraLimiteInfo !== null) foraLimiteInfo = null;
      showInfoForaLimite = false;
      return;
    }
    foraLimiteInfo = {
      nome: payload.nome || 'N/A',
      distancia: Number(payload.distancia) || 0
    };
  }

  function syncForaLimiteFromRef() {
    try {
      const info =
        typeof viabilidadeRef?.getWorkbenchForaLimiteInfo === 'function'
          ? viabilidadeRef.getWorkbenchForaLimiteInfo()
          : null;
      onForaLimiteFromViabilidade(info || { active: false });
    } catch (err) {
      console.warn('[Workbench] sync Fora do Limite:', err?.message || err);
    }
  }

  function formatForaLimiteDistancia(metros) {
    const d = Number(metros) || 0;
    if (d >= 1000) return `${(d / 1000).toFixed(2)} km`;
    return `${Math.round(d)} m`;
  }

  // ——— Seleção / cópia da tabela Equipamentos (igual ao oficial, só cols Nº…POP) ———
  // Colunas: 0=checkbox, 1=Nº, 2=CTO, 3=Status, 4=Cidade, 5=POP
  let equipSelectedCells = [];
  let equipSelectedRows = [];
  let equipSelectedColumns = [];
  let equipSelectionStart = null;
  $: equipAllVisible =
    equipamentos.length > 0 && equipamentos.every((item) => item.visible !== false);
  $: equipSomeVisible =
    equipamentos.some((item) => item.visible !== false) && !equipAllVisible;

  function equipCellKey(rowIndex, colIndex) {
    return `${rowIndex}-${colIndex}`;
  }

  function clearEquipSelection() {
    equipSelectedCells = [];
    equipSelectedRows = [];
    equipSelectedColumns = [];
    equipSelectionStart = null;
  }

  function selectEquipCell(rowIndex, colIndex) {
    equipSelectedCells = [equipCellKey(rowIndex, colIndex)];
    equipSelectedRows = [];
    equipSelectedColumns = [];
    equipSelectionStart = { row: rowIndex, col: colIndex };
  }

  function selectEquipRow(rowIndex, addToSelection = false) {
    if (!addToSelection) {
      equipSelectedCells = [];
      equipSelectedRows = [rowIndex];
      equipSelectedColumns = [];
    } else if (!equipSelectedRows.includes(rowIndex)) {
      equipSelectedRows = [...equipSelectedRows, rowIndex];
    }
    equipSelectionStart = { row: rowIndex, col: 1 };
  }

  function selectEquipColumn(colIndex, addToSelection = false) {
    if (!addToSelection) {
      equipSelectedCells = [];
      equipSelectedRows = [];
      equipSelectedColumns = [colIndex];
    } else if (!equipSelectedColumns.includes(colIndex)) {
      equipSelectedColumns = [...equipSelectedColumns, colIndex];
    }
    equipSelectionStart = null;
  }

  function selectEquipRange(startRow, startCol, endRow, endCol) {
    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);
    const minCol = Math.min(startCol, endCol);
    const maxCol = Math.max(startCol, endCol);
    const next = [];
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = Math.max(1, minCol); col <= maxCol; col++) {
        next.push(equipCellKey(row, col));
      }
    }
    equipSelectedCells = next;
    equipSelectedRows = [];
    equipSelectedColumns = [];
  }

  function getEquipCellValue(item, colIndex) {
    switch (colIndex) {
      case 1:
        return String(item?.n ?? '-');
      case 2:
        return String(item?.nome ?? '');
      case 3:
        return String(item?.status ?? '');
      case 4:
        return String(item?.cidade ?? '');
      case 5:
        return String(item?.pop ?? '');
      default:
        return '';
    }
  }

  function handleEquipCellClick(event, rowIndex, colIndex) {
    if (colIndex === 0) return;
    if (
      event.target?.tagName === 'INPUT' ||
      event.target?.type === 'checkbox' ||
      event.target?.closest?.('input[type="checkbox"]')
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    // Clique na coluna Nº seleciona a linha inteira (como “cabeçalho de linha”)
    if (colIndex === 1 && !event.shiftKey) {
      selectEquipRow(rowIndex, event.ctrlKey || event.metaKey);
      return;
    }

    if (event.shiftKey && equipSelectionStart) {
      selectEquipRange(
        equipSelectionStart.row,
        equipSelectionStart.col,
        rowIndex,
        colIndex
      );
    } else if (event.ctrlKey || event.metaKey) {
      const key = equipCellKey(rowIndex, colIndex);
      equipSelectedRows = [];
      equipSelectedColumns = [];
      equipSelectedCells = equipSelectedCells.includes(key)
        ? equipSelectedCells.filter((k) => k !== key)
        : [...equipSelectedCells, key];
      equipSelectionStart = { row: rowIndex, col: colIndex };
    } else {
      selectEquipCell(rowIndex, colIndex);
    }
  }

  function handleEquipColumnHeaderClick(event, colIndex) {
    if (colIndex === 0) return;
    if (
      event.target?.tagName === 'INPUT' ||
      event.target?.type === 'checkbox' ||
      event.target?.closest?.('input[type="checkbox"]')
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.ctrlKey || event.metaKey) {
      equipSelectedCells = [];
      equipSelectedRows = [];
      if (equipSelectedColumns.includes(colIndex)) {
        equipSelectedColumns = equipSelectedColumns.filter((c) => c !== colIndex);
      } else {
        equipSelectedColumns = [...equipSelectedColumns, colIndex];
      }
    } else {
      selectEquipColumn(colIndex, false);
    }
  }

  function preventEquipTextSelection(event) {
    if (
      event.target?.tagName === 'INPUT' ||
      event.target?.tagName === 'TEXTAREA' ||
      event.target?.closest?.('input') ||
      event.target?.closest?.('textarea')
    ) {
      return;
    }
    if (event.target?.closest?.('.wb-equip-table')) {
      event.preventDefault();
    }
  }

  function handleEquipDocumentClick(event) {
    if (!event.target?.closest?.('.wb-equip-table')) {
      clearEquipSelection();
    }
  }

  async function copyEquipSelectionToClipboard() {
    if (
      !equipSelectedCells.length &&
      !equipSelectedRows.length &&
      !equipSelectedColumns.length
    ) {
      return;
    }
    let textToCopy = '';
    if (equipSelectedColumns.length) {
      const cols = [...equipSelectedColumns].filter((c) => c >= 1).sort((a, b) => a - b);
      for (let r = 0; r < equipamentos.length; r++) {
        textToCopy += cols.map((c) => getEquipCellValue(equipamentos[r], c)).join('\t') + '\n';
      }
    } else if (equipSelectedRows.length) {
      const rows = [...equipSelectedRows].sort((a, b) => a - b);
      for (const r of rows) {
        const item = equipamentos[r];
        if (!item) continue;
        textToCopy += [1, 2, 3, 4, 5].map((c) => getEquipCellValue(item, c)).join('\t') + '\n';
      }
    } else {
      const cellsByRow = {};
      equipSelectedCells.forEach((cellKey) => {
        const [row, col] = String(cellKey).split('-').map(Number);
        if (!Number.isFinite(row) || !Number.isFinite(col) || col < 1) return;
        if (!cellsByRow[row]) cellsByRow[row] = {};
        if (equipamentos[row]) {
          cellsByRow[row][col] = getEquipCellValue(equipamentos[row], col);
        }
      });
      const sortedRows = Object.keys(cellsByRow)
        .map(Number)
        .sort((a, b) => a - b);
      const allColumns = new Set();
      sortedRows.forEach((row) => {
        Object.keys(cellsByRow[row]).forEach((col) => allColumns.add(Number(col)));
      });
      const sortedColumns = [...allColumns].sort((a, b) => a - b);
      sortedRows.forEach((rowIndex) => {
        textToCopy +=
          sortedColumns.map((colIndex) => cellsByRow[rowIndex][colIndex] || '').join('\t') +
          '\n';
      });
    }
    const text = textToCopy.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* ignore */
      }
      ta.remove();
    }
  }

  function onEquipCopyKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || (event.key !== 'c' && event.key !== 'C')) return;
    if (
      !equipSelectedCells.length &&
      !equipSelectedRows.length &&
      !equipSelectedColumns.length
    ) {
      return;
    }
    const active = document.activeElement;
    const isInput =
      active?.tagName === 'INPUT' ||
      active?.tagName === 'TEXTAREA' ||
      active?.contentEditable === 'true';
    if (isInput) return;
    event.preventDefault();
    event.stopPropagation();
    copyEquipSelectionToClipboard();
  }

  async function toggleEquipVisible(item, checked) {
    if (!item?.ctoKey || !viabilidadeRef) return;
    try {
      await viabilidadeRef.setWorkbenchCtoVisible?.(item.ctoKey, checked);
    } catch (err) {
      console.warn('[Workbench] toggle CTO:', err?.message || err);
    }
  }

  async function toggleAllEquipVisible(checked) {
    if (!viabilidadeRef) return;
    try {
      await viabilidadeRef.setAllWorkbenchCtosVisible?.(checked);
    } catch (err) {
      console.warn('[Workbench] toggle all CTO:', err?.message || err);
    }
  }

  function clampEquipHeight(height, splitHeight) {
    const maxEquip = Math.max(EQUIP_HEADER_H, splitHeight - HANDLE_H - MAP_COLLAPSED_H);
    let h = Math.max(EQUIP_HEADER_H, Math.min(maxEquip, height));
    if (h <= EQUIP_HEADER_H + SNAP_PX) {
      h = EQUIP_HEADER_H;
      equipCollapsed = true;
      mapCollapsed = false;
    } else if (h >= maxEquip - SNAP_PX) {
      h = maxEquip;
      equipCollapsed = false;
      mapCollapsed = true;
    } else {
      equipCollapsed = false;
      mapCollapsed = false;
    }
    return h;
  }

  function ensureSplitShield() {
    if (splitShieldEl) return splitShieldEl;
    splitShieldEl = document.createElement('div');
    splitShieldEl.className = 'wb-split-shield';
    splitShieldEl.setAttribute('aria-hidden', 'true');
    return splitShieldEl;
  }

  function beginSplitCapture(handle, pointerId) {
    const root = document.querySelector('.workbench') || document.body;
    const shield = ensureSplitShield();
    if (!shield.isConnected) root.appendChild(shield);
    document.body.classList.add('wb-split-interacting');
    try {
      if (handle && pointerId != null && typeof handle.setPointerCapture === 'function') {
        handle.setPointerCapture(pointerId);
      }
    } catch {
      // ignore
    }
    // Mapa Google / iframes internos não roubam o ponteiro
    root.querySelectorAll('iframe, .map, #censup-workbench-map').forEach((el) => {
      el.classList?.add?.('wb-pe-none');
      if (el.style) el.style.pointerEvents = 'none';
    });
  }

  function endSplitCapture() {
    document.body.classList.remove('wb-split-interacting');
    splitShieldEl?.remove();
    try {
      if (
        splitHandleEl &&
        splitPointerId != null &&
        typeof splitHandleEl.releasePointerCapture === 'function'
      ) {
        splitHandleEl.releasePointerCapture(splitPointerId);
      }
    } catch {
      // ignore
    }
    document.querySelectorAll('.wb-pe-none').forEach((el) => {
      el.classList.remove('wb-pe-none');
      if (el.style) el.style.pointerEvents = '';
    });
    splitHandleEl = null;
    splitPointerId = null;
  }

  function onSplitPointerMove(e) {
    if (!splitDragging) return;
    e.preventDefault();
    if (!splitEl) return;
    const splitRect = splitEl.getBoundingClientRect();
    if (splitRect.height < EQUIP_HEADER_H + HANDLE_H + MAP_COLLAPSED_H) return;
    const deltaY = e.clientY - splitStartY;
    const nextHeight = splitStartEquipHeight + deltaY;
    equipPaneHeightPx = clampEquipHeight(nextHeight, splitRect.height);
    if (splitResizeRaf) cancelAnimationFrame(splitResizeRaf);
    splitResizeRaf = requestAnimationFrame(() => {
      try {
        window.dispatchEvent(new Event('resize'));
      } catch {
        // ignore
      }
    });
  }

  function endSplitDrag() {
    if (!splitDragging) return;
    splitDragging = false;
    try {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    } catch {
      // ignore
    }
    endSplitCapture();
    window.removeEventListener('pointermove', onSplitPointerMove, true);
    window.removeEventListener('pointerup', endSplitDrag, true);
    window.removeEventListener('pointercancel', endSplitDrag, true);
    window.removeEventListener('blur', endSplitDrag);
    requestMapResize(60);
  }

  function startSplitDrag(e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    if (!splitEl || !equipPaneEl) return;
    const splitRect = splitEl.getBoundingClientRect();
    if (splitRect.height < EQUIP_HEADER_H + HANDLE_H + MAP_COLLAPSED_H) return;
    splitDragging = true;
    splitStartY = e.clientY;
    splitStartEquipHeight = equipPaneEl.getBoundingClientRect().height;
    splitHandleEl = e.currentTarget;
    splitPointerId = e.pointerId;
    try {
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    } catch {
      // ignore
    }
    beginSplitCapture(splitHandleEl, splitPointerId);
    window.addEventListener('pointermove', onSplitPointerMove, true);
    window.addEventListener('pointerup', endSplitDrag, true);
    window.addEventListener('pointercancel', endSplitDrag, true);
    window.addEventListener('blur', endSplitDrag);
  }

  function toggleEquipCollapsed() {
    const willCollapse = !equipCollapsed;
    if (willCollapse) {
      equipCollapsed = true;
      mapCollapsed = false;
      equipPaneHeightPx = EQUIP_HEADER_H;
      requestMapResize(60);
      return;
    }

    equipCollapsed = false;
    mapCollapsed = false;
    if (splitEl) {
      const h = splitEl.getBoundingClientRect().height;
      if (h >= EQUIP_HEADER_H + HANDLE_H + MAP_COLLAPSED_H) {
        const next = Math.round(Math.max(EQUIP_HEADER_H + 8, (h - HANDLE_H) * DEFAULT_EQUIP_RATIO));
        equipPaneHeightPx = clampEquipHeight(next, h);
      }
    } else {
      equipPaneHeightPx = null;
    }
    requestMapResize(60);
  }

  function equipPaneStyle() {
    if (equipCollapsed) {
      return 'height:auto';
    }
    if (equipPaneHeightPx == null) {
      return `height:${DEFAULT_EQUIP_RATIO * 100}%`;
    }
    return `height:${equipPaneHeightPx}px`;
  }

  let form = {
    numeroALA: '',
    cidade: '',
    enderecoCompleto: '',
    numeroEndereco: '',
    cep: '',
    coordenadas: '',
    tabulacaoFinal: '',
    projetista: ''
  };
  /** true após endereço/CEP vindos do pin do mapa — não sobrescrever com Agenda */
  let addressFromMap = false;

  $: mapAddress = form.enderecoCompleto || chamado?.endereco?.completo || '';
  // Digitar endereço NÃO altera coords do mapa — só Localizar / casinha / sync do chamado
  $: mapLat =
    pinCoords?.lat ?? chamado?.localizacao?.lat ?? chamado?.mapaCoords?.lat ?? null;
  $: mapLng =
    pinCoords?.lng ?? chamado?.localizacao?.lng ?? chamado?.mapaCoords?.lng ?? null;

  function formatCoords(lat, lng) {
    if (lat == null || lng == null || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) {
      return '';
    }
    return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
  }

  /** CEP da Agenda às vezes vem concatenado com o pedido; mantém só 8 dígitos. */
  function normalizeCep(cep) {
    const digits = String(cep || '').replace(/\D/g, '');
    if (!digits) return '';
    return digits.length > 8 ? digits.slice(0, 8) : digits;
  }

  function applyMapAddressToForm(address = {}) {
    if (!address || typeof address !== 'object') return;
    let changed = false;
    if (address.enderecoCompleto) {
      form.enderecoCompleto = address.enderecoCompleto;
      changed = true;
    }
    if (address.cidade) {
      form.cidade = address.cidade;
      changed = true;
    }
    if (address.numero) {
      form.numeroEndereco = address.numero;
      changed = true;
    }
    if (address.cep) {
      form.cep = normalizeCep(address.cep);
      changed = true;
    }
    if (changed) {
      addressFromMap = true;
      form = form;
    }
  }

  function coordsFromChamado(item) {
    const lat = item?.localizacao?.lat ?? item?.mapaCoords?.lat ?? null;
    const lng = item?.localizacao?.lng ?? item?.mapaCoords?.lng ?? null;
    if (lat == null || lng == null) return null;
    return { lat: Number(lat), lng: Number(lng) };
  }

  function postToParent(type, payload = {}) {
    try {
      window.parent?.postMessage({ source: MSG_SOURCE, type, ...payload }, '*');
    } catch {
      // ignore
    }
  }

  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-Usuario': usuario || ''
    };
  }

  function fillFormFromChamado(item) {
    const end = item?.endereco || {};
    const coords = coordsFromChamado(item);
    const next = {
      numeroALA: String(item?.pedido || '').replace(/\D/g, ''),
      cidade: end.cidade || item?.cidade || '',
      enderecoCompleto: end.completo || '',
      numeroEndereco: end.numero || '',
      cep: normalizeCep(end.cep),
      coordenadas: coords ? formatCoords(coords.lat, coords.lng) : form.coordenadas || '',
      tabulacaoFinal: item?.tabulacaoFinal || '',
      projetista: String(usuario || '').trim() || item?.viabilidadeResumo?.projetista || ''
    };
    // Se o mapa já resolveu o endereço do pin, não voltar para o texto da Agenda/busca
    if (addressFromMap) {
      next.enderecoCompleto = form.enderecoCompleto || next.enderecoCompleto;
      next.cidade = form.cidade || next.cidade;
      next.numeroEndereco = form.numeroEndereco || next.numeroEndereco;
      next.cep = form.cep || next.cep;
      next.coordenadas = form.coordenadas || next.coordenadas;
    }
    form = next;
    if (coords) pinCoords = coords;
    sugeridaOriginal = item?.tabulacaoFinal || item?.analiseIa?.tabulacaoSugerida || '';
    ensureProjetistaFromLogin();
  }

  /** Projetista = usuário do login da extensão (campo da tela de entrada). */
  function ensureProjetistaFromLogin() {
    const name = String(usuario || '').trim();
    if (!name) return;
    if (form.projetista !== name) {
      form.projetista = name;
      form = form;
    }
  }

  /** Digitar no overlay só altera o texto — pesquisa só no botão Localizar. */
  function onEnderecoManualInput() {
    if (mapSearchError) mapSearchError = '';
    // no-op intencional (mantém pin/coords até Localizar ou casinha)
  }

  async function localizarNoMapa() {
    const endereco = (form.enderecoCompleto || '').trim();
    mapSearchError = '';
    // Erro no box só quando clica Localizar com campo vazio
    if (!endereco) {
      mapSearchError = 'Informe um endereço para localizar.';
      return;
    }
    if (!viabilidadeRef || typeof viabilidadeRef.searchWorkbenchAddress !== 'function') {
      error = 'Mapa ainda carregando. Aguarde e tente de novo.';
      return;
    }
    locating = true;
    error = '';
    statusMsg = 'Localizando endereço no mapa…';
    // Libera pin antigo para a busca por texto valer
    pinCoords = null;
    mapPreviewImage = '';
    capturingMapPreview = false;
    try {
      const found = await viabilidadeRef.searchWorkbenchAddress(endereco);
      // Campo do overlay/relatório = endereço encontrado no pin, não o texto digitado na busca
      if (found) {
        applyMapAddressToForm(found);
      } else if (typeof viabilidadeRef.syncWorkbenchAddressFromMap === 'function') {
        applyMapAddressToForm(await viabilidadeRef.syncWorkbenchAddressFromMap());
      }
      await tick();
      syncForaLimiteFromRef();
      // Rotas podem atualizar a distância um pouco depois
      setTimeout(() => syncForaLimiteFromRef(), 800);
      setTimeout(() => syncForaLimiteFromRef(), 2000);
      statusMsg = 'Endereço localizado no mapa';
    } catch (err) {
      error = err?.message || String(err);
      statusMsg = '';
    } finally {
      locating = false;
    }
  }

  function openInfoModal() {
    error = '';
    ensureProjetistaFromLogin();
    showInfoModal = true;
  }

  function closeInfoModal() {
    showInfoModal = false;
  }

  /**
   * Recarrega tabulações da mesma fonte do oficial (API + lista da Viabilidade).
   * Evita dropdown desatualizado na extensão após novas tabulações no Config.
   */
  async function refreshTabulacoesForReport() {
    let list = [];

    if (viabilidadeRef && typeof viabilidadeRef.refreshTabulacoesList === 'function') {
      try {
        list = await viabilidadeRef.refreshTabulacoesList();
      } catch {
        /* fallback abaixo */
      }
    }

    if (!Array.isArray(list) || list.length === 0) {
      try {
        list = await fetchTabulacoesList();
      } catch {
        list = [];
      }
    }

    if (Array.isArray(list) && list.length > 0) {
      tabulacoes = list;
    }
  }

  /**
   * Igual openReportModal da Viabilidade: abre o formulário e captura a prévia do mapa.
   * Usado pelo botão "Gerar Relatório" do overlay.
   */
  async function abrirRelatorioComPrint() {
    if (!viabilidadeRef || typeof viabilidadeRef.refreshWorkbenchMapPreview !== 'function') {
      error = 'Mapa ainda carregando. Localize um endereço e tente de novo.';
      return;
    }

    error = '';
    mapPreviewImage = '';
    ensureProjetistaFromLogin();
    // Atualiza opções do select antes de mostrar o modal
    await refreshTabulacoesForReport();
    showInfoModal = true;
    capturingMapPreview = true;
    statusMsg = 'Capturando prévia do mapa…';
    await tick();
    // Deixa o box do relatório pintar antes do ajuste do mapa (atrás do modal)
    await new Promise((r) => setTimeout(r, 120));

    try {
      // Endereço Completo / CEP = encontrados no pin do mapa (igual Viabilidade oficial)
      if (typeof viabilidadeRef.syncWorkbenchAddressFromMap === 'function') {
        applyMapAddressToForm(await viabilidadeRef.syncWorkbenchAddressFromMap());
      }
      ensureProjetistaFromLogin();

      const preview = await viabilidadeRef.refreshWorkbenchMapPreview();
      if (!preview) {
        throw new Error(
          'Não foi possível capturar a prévia do mapa. Localize o endereço no mapa e tente de novo.'
        );
      }
      mapPreviewImage = preview;
      statusMsg = 'Prévia do mapa capturada';
    } catch (err) {
      error = err?.message || String(err);
      statusMsg = '';
      mapPreviewImage = '';
    } finally {
      capturingMapPreview = false;
      ensureProjetistaFromLogin();
    }
  }

  /**
   * Callback da Viabilidade (casinha): atualiza Informações + CEP do mapa + coords
   * e reanalisa tabulação com as novas coordenadas.
   */
  function onClientLocationFromMap(payload = {}) {
    const coords = payload.coords || {};
    const address = payload.address || {};
    const lat = Number(coords.lat);
    const lng = Number(coords.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    pinCoords = { lat, lng };
    form.coordenadas = formatCoords(lat, lng);
    applyMapAddressToForm(address);
    scheduleReanaliseTabulacao();
  }

  function scheduleReanaliseTabulacao() {
    if (!chamadoId || !usuario || !pinCoords) return;
    if (reanaliseTimer) clearTimeout(reanaliseTimer);
    reanaliseTimer = setTimeout(() => {
      void reanalisarTabulacaoAposCasinha();
    }, 900);
  }

  async function reanalisarTabulacaoAposCasinha() {
    if (!chamadoId || !usuario || !pinCoords) return;
    reanalyzing = true;
    statusMsg = 'Recalculando tabulação pela nova posição…';
    try {
      const analyzed = await analisarPortalCensupChamado(usuario, chamadoId, {
        force: true,
        lat: pinCoords.lat,
        lng: pinCoords.lng,
        endereco: {
          completo: form.enderecoCompleto || undefined,
          cidade: form.cidade || undefined,
          numero: form.numeroEndereco || undefined,
          cep: form.cep || undefined
        }
      });
      if (analyzed?.chamado) {
        chamado = analyzed.chamado;
        const tab =
          chamado.tabulacaoFinal ||
          chamado.analiseIa?.tabulacaoSugerida ||
          '';
        if (tab) {
          form.tabulacaoFinal = tab;
          sugeridaOriginal = chamado.analiseIa?.tabulacaoSugerida || tab;
        }
        // Mantém endereço/CEP/coords já vindos do mapa (não sobrescrever com Agenda)
        const end = chamado.endereco || {};
        if (!form.cep && end.cep) form.cep = end.cep;
        form = form;
      }
      statusMsg = 'Tabulação atualizada pela posição da casinha';
    } catch (err) {
      console.warn('[Workbench] Reanálise:', err?.message || err);
      statusMsg = 'Posição atualizada (falha ao recalcular tabulação)';
    } finally {
      reanalyzing = false;
    }
  }

  async function loadChamado(id, { preserveMap = false } = {}) {
    loading = true;
    error = '';
    if (!preserveMap) {
      pinCoords = null;
      addressFromMap = false;
      mapPreviewImage = '';
      capturingMapPreview = false;
    }
    equipamentos = [];
    statusMsg = 'Carregando chamado…';
    try {
      chamado = await fetchPortalCensupChamadoById(usuario, id);
      fillFormFromChamado(chamado);
      loading = false;
      statusMsg = form.coordenadas || pinCoords ? 'Posicionando mapa…' : 'Localizando endereço…';
      requestMapResize(30);

      // Posiciona na hora; tabulação em background (não bloqueia o mapa)
      if (!pinCoords && (form.enderecoCompleto || '').trim()) {
        void localizarNoMapa().catch((err) => {
          console.warn('[Workbench] Localizar:', err?.message || err);
        });
      } else if (pinCoords) {
        statusMsg = 'Endereço posicionado no mapa';
        setTimeout(() => syncForaLimiteFromRef(), 1200);
        setTimeout(() => syncForaLimiteFromRef(), 3000);
      }

      void (async () => {
        try {
          const analyzed = await analisarPortalCensupChamado(usuario, id, { force: false });
          if (analyzed?.chamado) {
            chamado = analyzed.chamado;
            fillFormFromChamado(chamado);
            requestMapResize(30);
          }
          if (!form.tabulacaoFinal && chamado?.tabulacaoFinal) {
            form.tabulacaoFinal = chamado.tabulacaoFinal;
          }
          sugeridaOriginal =
            chamado?.analiseIa?.tabulacaoSugerida ||
            chamado?.tabulacaoFinal ||
            sugeridaOriginal ||
            '';
          if (!form.tabulacaoFinal && sugeridaOriginal) {
            form.tabulacaoFinal = sugeridaOriginal;
          }
          if (!statusMsg || /Posicionando|Localizando|Carregando/i.test(statusMsg)) {
            statusMsg = 'Pronto para revisar';
          }
        } catch (analyzeErr) {
          console.warn('[Workbench] Análise:', analyzeErr?.message || analyzeErr);
          statusMsg = statusMsg || 'Pronto para revisar';
        }
      })();

      postToParent('READY', { chamadoId: chamado.id, pedido: chamado.pedido });
    } catch (err) {
      error = err?.message || String(err);
      statusMsg = '';
      postToParent('ERROR', { error });
    } finally {
      loading = false;
    }
  }

  function coordsFromSeed(seed) {
    if (!seed) return null;
    const c = seed.mapaCoords || seed.localizacao || null;
    const lat = c?.lat ?? seed.lat ?? null;
    const lng = c?.lng ?? seed.lng ?? null;
    if (lat == null || lng == null || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) {
      return null;
    }
    return { lat: Number(lat), lng: Number(lng) };
  }

  async function applyInitPayload(payload = {}) {
    usuario = String(payload.usuario || '').trim();
    chamadoId = String(payload.chamadoId || payload.id || '').trim();
    ensureProjetistaFromLogin();

    let positionedFromSeed = false;

    if (payload.seed) {
      const seed = payload.seed;
      form = {
        numeroALA: String(seed.pedido || seed.numeroALA || '').replace(/\D/g, ''),
        cidade: seed.cidade || seed.endereco?.cidade || '',
        enderecoCompleto: seed.enderecoCompleto || seed.endereco?.completo || '',
        numeroEndereco: seed.numeroEndereco || seed.endereco?.numero || '',
        cep: seed.cep || seed.endereco?.cep || '',
        coordenadas: form.coordenadas || '',
        tabulacaoFinal: seed.tabulacaoFinal || '',
        projetista: usuario || seed.projetista || ''
      };
      form.cep = normalizeCep(form.cep);
      ensureProjetistaFromLogin();

      // Prioridade: coords da Agenda → pin imediato (sem geocode)
      const seedCoords = coordsFromSeed(seed);
      if (seedCoords) {
        pinCoords = seedCoords;
        form.coordenadas = formatCoords(seedCoords.lat, seedCoords.lng);
        form = form;
        positionedFromSeed = true;
        statusMsg = 'Endereço posicionado no mapa';
        requestMapResize(30);
      } else if ((form.enderecoCompleto || '').trim()) {
        // Sem coords: pesquisa já, sem esperar a API do chamado
        statusMsg = 'Localizando endereço no mapa…';
        positionedFromSeed = true;
        void localizarNoMapa().catch((err) => {
          console.warn('[Workbench] Localizar (seed):', err?.message || err);
        });
      }
    }

    if (!usuario) {
      error = 'Informe o usuário no painel da extensão.';
      loading = false;
      statusMsg = 'Aguardando usuário…';
      return;
    }

    if (chamadoId) {
      // Formulário/tabulação em paralelo; mapa já pode estar posicionado pelo seed
      await loadChamado(chamadoId, { preserveMap: positionedFromSeed });
      return;
    }

    loading = false;
    if (!positionedFromSeed) {
      chamado = null;
      equipamentos = [];
      mapPreviewImage = '';
      capturingMapPreview = false;
      error = '';
      statusMsg = 'Mapa pronto — sincronize um chamado para preencher o formulário';
    }
    ensureProjetistaFromLogin();
  }

  function buildReportPayload() {
    ensureProjetistaFromLogin();
    return {
      numeroALA: form.numeroALA.trim(),
      cidade: form.cidade.trim(),
      enderecoCompleto: form.enderecoCompleto.trim(),
      numeroEndereco: form.numeroEndereco.trim(),
      cep: form.cep.trim(),
      coordenadas: (form.coordenadas || '').trim(),
      latitude: pinCoords?.lat ?? null,
      longitude: pinCoords?.lng ?? null,
      tabulacaoFinal: form.tabulacaoFinal.trim(),
      projetista: (form.projetista || usuario || '').trim(),
      tabulacaoSugeridaOriginal: sugeridaOriginal || null
    };
  }

  function openPdfHtml(html) {
    const win = window.open('', '_blank');
    if (!win) {
      throw new Error('Pop-up bloqueado. Permita pop-ups para gerar o PDF.');
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    setTimeout(() => {
      try {
        win.focus();
        win.print();
      } catch {
        // ignore
      }
    }, 400);
  }

  async function gerarRelatorio() {
    if (!viabilidadeRef || typeof viabilidadeRef.generateWorkbenchReport !== 'function') {
      error = 'Mapa ainda carregando. Localize um endereço e tente de novo.';
      return;
    }
    if (!showInfoModal) {
      openInfoModal();
      await tick();
    }

    generating = true;
    error = '';
    statusMsg = 'Gerando PDF…';

    try {
      // Reusa a prévia já capturada ao abrir o modal — só captura de novo se faltar
      if (!mapPreviewImage && typeof viabilidadeRef.refreshWorkbenchMapPreview === 'function') {
        capturingMapPreview = true;
        statusMsg = 'Capturando mapa…';
        const preview = await viabilidadeRef.refreshWorkbenchMapPreview();
        if (preview) {
          mapPreviewImage = preview;
        }
        capturingMapPreview = false;
        statusMsg = 'Gerando PDF…';
        await tick();
      }

      const result = await viabilidadeRef.generateWorkbenchReport({
        ...buildReportPayload(),
        previewImage: mapPreviewImage || undefined
      });
      if (result?.preview) {
        mapPreviewImage = result.preview;
      }
      statusMsg = result?.viAla
        ? `PDF gerado (${result.viAla})`
        : 'PDF gerado (modelo Viabilidade Alares)';
      showInfoModal = false;
      if (chamadoId) {
        postToParent('REPORT_GENERATED', { chamadoId, viAla: result?.viAla || null });
      }
    } catch (err) {
      error = err?.message || String(err);
      statusMsg = mapPreviewImage ? 'Prévia ok — corrija os campos e tente de novo' : '';
      showInfoModal = true;
    } finally {
      capturingMapPreview = false;
      generating = false;
    }
  }

  async function onSalvarRelatorioSubmit() {
    await salvarRelatorio();
    if (!error) {
      showInfoModal = false;
    }
  }

  async function salvarRelatorio() {
    if (!chamadoId) {
      error = 'Chamado não carregado.';
      return;
    }
    saving = true;
    error = '';
    statusMsg = 'Salvando relatório no Portal…';
    try {
      const response = await fetch(
        getApiUrl(`/api/portal-censup/chamados/${encodeURIComponent(chamadoId)}/relatorio`),
        {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ ...buildReportPayload(), persist: true })
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Falha ao salvar relatório (${response.status})`);
      }
      chamado = data.chamado || chamado;
      statusMsg = 'Relatório salvo no arquivo do Portal';
      postToParent('REPORT_SAVED', {
        chamadoId,
        pedido: chamado?.pedido,
        corrected: data.corrected === true
      });
    } catch (err) {
      error = err?.message || String(err);
      statusMsg = '';
    } finally {
      saving = false;
    }
  }

  function fecharWorkbench() {
    postToParent('CLOSE');
  }

  function resetWorkbenchUi() {
    chamado = null;
    chamadoId = '';
    equipamentos = [];
    clearEquipSelection();
    foraLimiteInfo = null;
    showInfoForaLimite = false;
    sugeridaOriginal = '';
    error = '';
    statusMsg = 'Aguardando chamado…';
    mapPreviewImage = '';
    capturingMapPreview = false;
    showInfoModal = false;
    pinCoords = null;
    form = {
      numeroALA: '',
      cidade: '',
      enderecoCompleto: '',
      numeroEndereco: '',
      cep: '',
      coordenadas: '',
      tabulacaoFinal: '',
      projetista: usuario || ''
    };
    try {
      viabilidadeRef?.clearWorkbenchMap?.();
    } catch {
      /* ignore */
    }
    requestMapResize(80);
  }

  function onMessage(event) {
    const data = event?.data;
    if (!data || data.source !== PARENT_SOURCE) return;
    if (data.type === 'THEME') {
      applyUiTheme(data.theme);
      return;
    }
    if (data.type === 'INIT' || data.type === 'LOAD') {
      if (data.theme === 'dark' || data.theme === 'light') {
        applyUiTheme(data.theme);
      }
      applyInitPayload(data);
    }
    if (data.type === 'CLEAR' || data.type === 'RESET') {
      resetWorkbenchUi();
    }
  }

  onMount(async () => {
    window.addEventListener('message', onMessage);
    document.addEventListener('keydown', onEquipCopyKeydown);
    document.addEventListener('click', handleEquipDocumentClick);
    // Equipamentos inicia minimizado — mapa ocupa o split desde o boot
    equipCollapsed = true;
    equipPaneHeightPx = EQUIP_HEADER_H;
    requestMapResize(80);
    try {
      const mod = await import('./ViabilidadeAlares.svelte');
      ViabilidadeAlares = mod.default;
    } catch (err) {
      console.warn('[Workbench] Falha ao carregar mapa:', err?.message || err);
    }
    try {
      tabulacoes = await fetchTabulacoesList();
    } catch {
      tabulacoes = [];
    }
    // Segunda chance após o mapa montar (mesma lista que a Viabilidade oficial usa)
    setTimeout(() => {
      void refreshTabulacoesForReport();
    }, 1500);

    // Bootstrap via query (fallback sem postMessage)
    const params = new URLSearchParams(window.location.search);
    const qTheme = params.get('theme');
    if (qTheme === 'dark' || qTheme === 'light') {
      applyUiTheme(qTheme);
    }
    const qUser = params.get('usuario') || '';
    const qId = params.get('chamadoId') || params.get('id') || '';
    if (qUser || qId) {
      await applyInitPayload({ usuario: qUser, chamadoId: qId });
    } else {
      loading = false;
      statusMsg = 'Aguardando dados da extensão…';
      postToParent('HELLO');
    }
    requestMapResize(200);
  });

  function onMapReadyFromViabilidade() {
    postToParent('MAP_READY');
    // Agenda → coords: a busca de CTOs roda no mapa; sincroniza o box depois
    setTimeout(() => syncForaLimiteFromRef(), 600);
    setTimeout(() => syncForaLimiteFromRef(), 1800);
    setTimeout(() => syncForaLimiteFromRef(), 4000);
  }

  function onMapPreviewFromViabilidade(payload = {}) {
    capturingMapPreview = !!payload.capturing;
    if (!payload.capturing) {
      mapPreviewImage = payload.image || '';
    }
  }

  onDestroy(() => {
    window.removeEventListener('message', onMessage);
    document.removeEventListener('keydown', onEquipCopyKeydown);
    document.removeEventListener('click', handleEquipDocumentClick);
    if (reanaliseTimer) clearTimeout(reanaliseTimer);
    endSplitDrag();
    if (splitResizeRaf) cancelAnimationFrame(splitResizeRaf);
  });
</script>

<div class="workbench" class:theme-dark={isDarkUi}>
  {#if error}
    <p class="wb-error" role="alert">{error}</p>
  {/if}

  <div class="wb-body">
    <div class="wb-split" bind:this={splitEl}>
      <aside
        class="wb-equip-pane"
        bind:this={equipPaneEl}
        class:collapsed={equipCollapsed}
        style={equipPaneStyle()}
      >
        <div class="wb-form-toolbar">
          <span class="wb-form-toolbar-title">Equipamentos</span>
          <button
            type="button"
            class="wb-pane-toggle"
            on:click={toggleEquipCollapsed}
            title={equipCollapsed ? 'Expandir equipamentos' : 'Minimizar equipamentos'}
            aria-label={equipCollapsed ? 'Expandir equipamentos' : 'Minimizar equipamentos'}
          >
            {equipCollapsed ? '▾' : '▴'}
          </button>
        </div>
        {#if !equipCollapsed}
          <div class="wb-equip-body">
            {#if equipamentos.length > 0}
              <div class="wb-equip-table-wrap" role="presentation">
                <table class="wb-equip-table" on:selectstart={preventEquipTextSelection}>
                  <thead>
                    <tr>
                      <th class="wb-equip-check-col" title="Mostrar/ocultar no mapa">
                        <input
                          type="checkbox"
                          checked={equipAllVisible}
                          indeterminate={equipSomeVisible}
                          aria-label="Marcar todos os equipamentos no mapa"
                          on:change={(e) => toggleAllEquipVisible(e.currentTarget.checked)}
                          on:click|stopPropagation
                        />
                      </th>
                      <th
                        class:selected={equipSelectedColumns.includes(1)}
                        on:click={(e) => handleEquipColumnHeaderClick(e, 1)}
                      >Nº</th>
                      <th
                        class:selected={equipSelectedColumns.includes(2)}
                        on:click={(e) => handleEquipColumnHeaderClick(e, 2)}
                      >CTO</th>
                      <th
                        class:selected={equipSelectedColumns.includes(3)}
                        on:click={(e) => handleEquipColumnHeaderClick(e, 3)}
                      >Status</th>
                      <th
                        class:selected={equipSelectedColumns.includes(4)}
                        on:click={(e) => handleEquipColumnHeaderClick(e, 4)}
                      >Cidade</th>
                      <th
                        class:selected={equipSelectedColumns.includes(5)}
                        on:click={(e) => handleEquipColumnHeaderClick(e, 5)}
                      >POP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each equipamentos as item, rowIndex (item.ctoKey || item.n + '-' + item.nome)}
                      {@const cellKey1 = `${rowIndex}-1`}
                      {@const cellKey2 = `${rowIndex}-2`}
                      {@const cellKey3 = `${rowIndex}-3`}
                      {@const cellKey4 = `${rowIndex}-4`}
                      {@const cellKey5 = `${rowIndex}-5`}
                      <tr class:row-selected={equipSelectedRows.includes(rowIndex)}>
                        <td class="wb-equip-check-col">
                          <input
                            type="checkbox"
                            checked={item.visible !== false}
                            aria-label={`Mostrar ${item.nome || 'equipamento'} no mapa`}
                            on:change={(e) => toggleEquipVisible(item, e.currentTarget.checked)}
                            on:click|stopPropagation
                          />
                        </td>
                        <td
                          class="wb-equip-num-col"
                          class:cell-selected={equipSelectedCells.includes(cellKey1) || equipSelectedRows.includes(rowIndex) || equipSelectedColumns.includes(1)}
                          title="Clique para selecionar a linha"
                          on:click={(e) => handleEquipCellClick(e, rowIndex, 1)}
                        >{item.n}</td>
                        <td
                          title={item.nome}
                          class:cell-selected={equipSelectedCells.includes(cellKey2) || equipSelectedRows.includes(rowIndex) || equipSelectedColumns.includes(2)}
                          on:click={(e) => handleEquipCellClick(e, rowIndex, 2)}
                        >{item.nome}</td>
                        <td
                          class:cell-selected={equipSelectedCells.includes(cellKey3) || equipSelectedRows.includes(rowIndex) || equipSelectedColumns.includes(3)}
                          on:click={(e) => handleEquipCellClick(e, rowIndex, 3)}
                        >
                          <span class="wb-status-badge" class:ativado={item.statusClass === 'ativado'} class:desativado={item.statusClass === 'desativado'}>
                            {item.status}
                          </span>
                        </td>
                        <td
                          class:cell-selected={equipSelectedCells.includes(cellKey4) || equipSelectedRows.includes(rowIndex) || equipSelectedColumns.includes(4)}
                          on:click={(e) => handleEquipCellClick(e, rowIndex, 4)}
                        >{item.cidade}</td>
                        <td
                          class:cell-selected={equipSelectedCells.includes(cellKey5) || equipSelectedRows.includes(rowIndex) || equipSelectedColumns.includes(5)}
                          on:click={(e) => handleEquipCellClick(e, rowIndex, 5)}
                        >{item.pop}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <p class="wb-equip-empty">
                {chamadoId
                  ? 'Nenhum equipamento encontrado para este chamado.'
                  : 'Sincronize um chamado na Agenda para carregar os equipamentos aqui.'}
              </p>
            {/if}
          </div>
        {/if}
      </aside>

      <div
        class="wb-split-handle"
        class:dragging={splitDragging}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Redimensionar equipamentos e mapa"
        title="Arraste para redimensionar"
        on:pointerdown={startSplitDrag}
      ></div>

      <section class="wb-map-pane" class:collapsed={mapCollapsed}>
        {#if ViabilidadeAlares}
          <div class="wb-map-host">
            <svelte:component
              this={ViabilidadeAlares}
              bind:this={viabilidadeRef}
              embedded={true}
              workbenchMode={true}
              mapDomId="censup-workbench-map"
              currentUser={usuario}
              initialAddress={mapAddress}
              initialLat={mapLat}
              initialLng={mapLng}
              onClientLocationChange={onClientLocationFromMap}
              onMapPreviewChange={onMapPreviewFromViabilidade}
              onEquipamentosChange={onEquipamentosFromViabilidade}
              onForaLimiteChange={onForaLimiteFromViabilidade}
              onMapReady={onMapReadyFromViabilidade}
            />
          </div>
        {:else}
          <div class="wb-map-placeholder">Carregando mapa…</div>
        {/if}

        {#if !mapCollapsed}
          <div class="wb-map-search-box">
            <label class="wb-map-search-label" for="wb-map-address">
              Endereço
            </label>
            <input
              id="wb-map-address"
              class="wb-map-search-input"
              type="text"
              bind:value={form.enderecoCompleto}
              on:input={onEnderecoManualInput}
              placeholder="Endereço para localizar no mapa"
            />
            <div class="wb-map-search-actions">
              <button
                type="button"
                class="wb-map-btn wb-map-btn-locate"
                on:click={localizarNoMapa}
                disabled={locating}
              >
                {locating ? 'Localizando…' : 'Localizar'}
              </button>
              <button
                type="button"
                class="wb-map-btn wb-map-btn-report"
                on:click={abrirRelatorioComPrint}
                disabled={loading || locating || capturingMapPreview || generating || !ViabilidadeAlares}
              >
                {capturingMapPreview ? 'Capturando…' : 'Gerar Relatório'}
              </button>
            </div>
            {#if mapSearchError}
              <p class="wb-map-search-error" role="alert">{mapSearchError}</p>
            {/if}
            {#if foraLimiteInfo}
              <div class="wb-fora-limite-box" role="status">
                <div class="wb-fora-limite-header">
                  <span class="wb-fora-limite-icon" aria-hidden="true">📍</span>
                  <span class="wb-fora-limite-title">Fora do Limite</span>
                  <button
                    type="button"
                    class="wb-fora-limite-info"
                    title="Informação"
                    aria-label="Informação sobre CTO fora do limite"
                    on:click={() => (showInfoForaLimite = !showInfoForaLimite)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" fill="#FF9800" stroke="#FF9800" stroke-width="1"/>
                      <path d="M12 16V12" stroke="white" stroke-width="2" stroke-linecap="round"/>
                      <circle cx="12" cy="8" r="1" fill="white"/>
                    </svg>
                  </button>
                </div>
                <p class="wb-fora-limite-text">
                  Equipamento mais próximo é <strong>{foraLimiteInfo.nome}</strong> a
                  <strong>{formatForaLimiteDistancia(foraLimiteInfo.distancia)}</strong>.
                </p>
              </div>
            {/if}
          </div>
        {/if}
      </section>
    </div>
  </div>
</div>

{#if showInfoForaLimite}
  <div
    class="wb-modal-overlay"
    role="button"
    tabindex="-1"
    aria-label="Fechar modal de informação"
    on:click={() => (showInfoForaLimite = false)}
    on:keydown={(e) => e.key === 'Escape' && (showInfoForaLimite = false)}
  >
    <div
      class="wb-modal-content wb-fora-limite-modal"
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="wb-fora-limite-modal-title"
      on:click|stopPropagation
      on:keydown={(e) => e.key === 'Enter' && e.stopPropagation()}
    >
      <div class="wb-modal-header">
        <h2 id="wb-fora-limite-modal-title">Informação</h2>
        <button type="button" class="wb-modal-close" on:click={() => (showInfoForaLimite = false)} aria-label="Fechar">×</button>
      </div>
      <div class="wb-modal-body">
        <p>
          Nenhuma CTO foi encontrada dentro do limite padrão de 250 metros do endereço pesquisado.
          O sistema realizou uma busca progressiva e encontrou a CTO mais próxima disponível,
          que está além da metragem limite padrão para atendimento. A distância informada representa
          a distância real calculada através de rotas.
        </p>
      </div>
    </div>
  </div>
{/if}

{#if showInfoModal}
  <div
    class="wb-modal-overlay"
    role="presentation"
  >
    <div
      class="wb-modal-content"
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="wb-info-modal-title"
      on:click|stopPropagation
      on:keydown={(e) => e.stopPropagation()}
    >
      <div class="wb-modal-header">
        <h2 id="wb-info-modal-title">Preencher Relatório</h2>
        <button type="button" class="wb-modal-close" on:click={closeInfoModal} aria-label="Fechar modal">×</button>
      </div>
      <div class="wb-modal-body">
        <form class="wb-modal-form" on:submit|preventDefault={onSalvarRelatorioSubmit}>
          <div class="wb-modal-field">
            <label for="wb-modal-ala">1. Número do ALA</label>
            <input id="wb-modal-ala" bind:value={form.numeroALA} inputmode="numeric" placeholder="Digite apenas números" />
          </div>
          <div class="wb-modal-field">
            <label for="wb-modal-cidade">2. Cidade</label>
            <input id="wb-modal-cidade" bind:value={form.cidade} />
          </div>
          <div class="wb-modal-field">
            <label for="wb-modal-end">3. Endereço Completo</label>
            <input id="wb-modal-end" bind:value={form.enderecoCompleto} on:input={onEnderecoManualInput} />
          </div>
          <div class="wb-modal-field">
            <label for="wb-modal-num">4. Número do Endereço</label>
            <input id="wb-modal-num" bind:value={form.numeroEndereco} />
          </div>
          <div class="wb-modal-field">
            <label for="wb-modal-cep">5. CEP do Endereço</label>
            <input id="wb-modal-cep" bind:value={form.cep} placeholder="Preenchido pelo mapa quando disponível" />
          </div>
          <div class="wb-modal-field">
            <label for="wb-modal-coords">6. Coordenadas</label>
            <input id="wb-modal-coords" bind:value={form.coordenadas} readonly placeholder="Ajuste a casinha no mapa" />
          </div>
          <div class="wb-modal-field">
            <label for="wb-modal-tab">7. Tabulação Final</label>
            <select id="wb-modal-tab" bind:value={form.tabulacaoFinal}>
              <option value="">Selecione uma opção</option>
              {#each tabulacoes as tab}
                <option value={tab}>{tab}</option>
              {/each}
              {#if form.tabulacaoFinal && !tabulacoes.includes(form.tabulacaoFinal)}
                <option value={form.tabulacaoFinal}>{form.tabulacaoFinal}</option>
              {/if}
            </select>
            {#if sugeridaOriginal}
              <small class="hint">
                Sugestão automática: {sugeridaOriginal}{reanalyzing ? ' (recalculando…)' : ''}
              </small>
            {:else if reanalyzing}
              <small class="hint">Recalculando tabulação…</small>
            {/if}
          </div>
          <div class="wb-modal-field">
            <label for="wb-modal-proj">8. Projetista</label>
            <input id="wb-modal-proj" bind:value={form.projetista} readonly />
          </div>

          <div class="wb-map-preview-block">
            <span class="wb-map-preview-label">9. Prévia do Mapa</span>
            <div class="wb-map-preview-container">
              {#if capturingMapPreview}
                <div class="wb-preview-loading">
                  <div class="wb-loading-spinner"></div>
                  <p>Capturando mapa...</p>
                </div>
              {:else if mapPreviewImage}
                <div class="wb-preview-image-wrapper">
                  <img src={mapPreviewImage} alt="Prévia do Mapa" class="wb-preview-image" />
                </div>
                <p class="wb-preview-hint">
                  O mapa foi capturado automaticamente com todas as CTOs encontradas e suas rotas visíveis.
                </p>
              {:else}
                <div class="wb-preview-loading">
                  <p>A prévia será capturada ao abrir por Gerar Relatório.</p>
                </div>
              {/if}
            </div>
          </div>

          <div class="wb-modal-actions">
            <button type="button" class="wb-modal-btn-cancel" on:click={closeInfoModal}>Cancelar</button>
            <button type="submit" class="wb-modal-btn-save" disabled={saving || loading || !chamadoId}>
              {saving ? 'Salvando…' : 'Salvar Relatório'}
            </button>
            <button
              type="button"
              class="wb-modal-btn-pdf"
              on:click={gerarRelatorio}
              disabled={generating || loading || capturingMapPreview}
            >
              {generating || capturingMapPreview ? 'Gerando…' : 'Gerar PDF'}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
{/if}

<style>
  .workbench {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    height: 100%;
    overflow: hidden;
    background: #eef1f8;
    color: #1f2937;
    box-sizing: border-box;
  }

  .workbench.theme-dark {
    background: #0b1220;
    color: #e2e8f0;
  }

  .workbench.theme-dark .wb-body,
  .workbench.theme-dark .wb-split,
  .workbench.theme-dark .wb-map-pane,
  .workbench.theme-dark .wb-map-host {
    background: #0b1220;
  }

  .workbench.theme-dark .wb-map-placeholder {
    background: #121826;
    border-color: #3f4b63;
    color: #94a3b8;
  }

  .workbench.theme-dark .wb-split-handle:hover::after,
  .workbench.theme-dark .wb-split-handle.dragging::after {
    background: rgba(123, 104, 238, 0.45);
  }

  .workbench.theme-dark .wb-equip-pane,
  .workbench.theme-dark .wb-form-toolbar {
    background: #111827;
    border-color: #334155;
  }

  .workbench.theme-dark .wb-form-toolbar-title {
    color: #a78bfa;
  }

  .workbench.theme-dark .wb-equip-table th {
    background: #1e293b;
    color: #cbd5e1;
  }

  .workbench.theme-dark .wb-equip-table td {
    border-bottom-color: #334155;
    border-right-color: #334155;
    color: #e2e8f0;
  }

  .workbench.theme-dark .wb-map-search-box {
    background: rgba(15, 23, 42, 0.96);
    border-color: #334155;
  }

  .workbench.theme-dark .wb-map-search-label {
    color: #a78bfa;
  }

  .workbench.theme-dark .wb-map-search-input {
    background: #0f172a;
    border-color: #475569;
    color: #f1f5f9;
  }

  .workbench.theme-dark .wb-equip-empty {
    color: #94a3b8;
  }

  .workbench.theme-dark .wb-modal-content {
    background: #1e293b;
    color: #e2e8f0;
  }

  .workbench.theme-dark .wb-map-host :global(.viabilidade-content.workbench-mode .map-container) {
    background: #121826 !important;
    border-color: #3f4b63 !important;
  }

  .wb-error {
    margin: 0;
    padding: 0.55rem 1rem;
    background: #fef2f2;
    color: #b91c1c;
    font-size: 0.85rem;
    flex-shrink: 0;
    box-sizing: border-box;
  }

  .wb-body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    padding: 0.45rem;
    overflow: hidden;
    background: #eef1f8;
    box-sizing: border-box;
  }

  .wb-split {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-sizing: border-box;
  }

  .wb-equip-pane {
    flex: 0 0 auto;
    align-self: stretch;
    width: auto;
    min-width: 0;
    max-width: 100%;
    height: 32%;
    max-height: none;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0;
    background: #ffffff;
    border: 1px solid #d1d5db;
    border-radius: 10px;
    box-shadow: none;
    box-sizing: border-box;
  }

  .wb-equip-pane.collapsed {
    height: auto !important;
    flex: 0 0 auto;
  }

  .wb-equip-pane.collapsed .wb-form-toolbar {
    width: 100%;
    max-width: 100%;
    align-items: center;
    justify-content: space-between;
  }

  .wb-split-handle {
    flex: 0 0 12px;
    width: 100%;
    margin: -2px 0;
    padding: 0;
    border: none;
    background: transparent;
    cursor: row-resize;
    touch-action: none;
    position: relative;
    z-index: 3;
    box-sizing: border-box;
  }

  .wb-split-handle::after {
    content: '';
    position: absolute;
    left: 18%;
    right: 18%;
    top: 50%;
    height: 2px;
    margin-top: -1px;
    border-radius: 2px;
    background: transparent;
  }

  .wb-split-handle:hover::after,
  .wb-split-handle.dragging::after {
    background: rgba(123, 104, 238, 0.35);
  }

  :global(.wb-split-shield) {
    position: fixed;
    inset: 0;
    z-index: 99999;
    background: transparent;
    cursor: row-resize;
    touch-action: none;
  }

  :global(body.wb-split-interacting),
  :global(body.wb-split-interacting *) {
    cursor: row-resize !important;
    user-select: none !important;
  }

  .wb-equip-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 0 0.45rem 0.45rem;
    box-sizing: border-box;
  }

  .wb-equip-empty {
    margin: 0;
    padding: 0.75rem 0.35rem;
    text-align: center;
    font-size: 0.72rem;
    font-weight: 500;
    color: #64748b;
    line-height: 1.35;
  }

  .wb-equip-table-wrap {
    width: 100%;
    overflow: auto;
  }

  .wb-equip-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.68rem;
    user-select: none;
    -webkit-user-select: none;
  }

  .wb-equip-table th,
  .wb-equip-table td {
    padding: 0.28rem 0.35rem;
    text-align: center;
    border-bottom: 1px solid #e5e7eb;
    border-right: 1px solid #e5e7eb;
    white-space: nowrap;
    max-width: 9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: cell;
    vertical-align: middle;
  }

  .wb-equip-table th:last-child,
  .wb-equip-table td:last-child {
    border-right: none;
  }

  .wb-equip-table th {
    position: sticky;
    top: 0;
    background: #f8fafc;
    color: #4b5563;
    font-weight: 700;
    z-index: 1;
    cursor: pointer;
    border-bottom: 2px solid #e5e7eb;
  }

  .wb-equip-table th.selected {
    background: rgba(100, 149, 237, 0.2) !important;
    color: #1e40af;
    border-bottom: 2px solid #6495ed !important;
  }

  .wb-equip-table td.cell-selected {
    background: rgba(100, 149, 237, 0.15) !important;
    outline: 2px solid #6495ed;
    outline-offset: -2px;
    position: relative;
  }

  .wb-equip-table tr.row-selected td {
    background: rgba(100, 149, 237, 0.1) !important;
  }

  .wb-equip-table tr.row-selected td.cell-selected {
    background: rgba(100, 149, 237, 0.18) !important;
  }

  .wb-equip-table .wb-equip-check-col {
    width: 1.75rem;
    max-width: 2rem;
    text-align: center;
    cursor: default;
    overflow: visible;
  }

  .wb-equip-table .wb-equip-check-col input[type='checkbox'] {
    width: 0.85rem;
    height: 0.85rem;
    margin: 0;
    cursor: pointer;
    accent-color: #7b68ee;
  }

  .wb-equip-table .wb-equip-num-col {
    width: 2rem;
    max-width: 2.5rem;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }

  .wb-equip-table td:nth-child(2),
  .wb-equip-table th:nth-child(2) {
    width: 2rem;
    max-width: 2.5rem;
  }

  .wb-status-badge {
    display: inline-block;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-size: 0.62rem;
    font-weight: 700;
    background: #e5e7eb;
    color: #374151;
  }

  .wb-status-badge.ativado {
    background: #dcfce7;
    color: #166534;
  }

  .wb-status-badge.desativado {
    background: #fee2e2;
    color: #991b1b;
  }

  .wb-form-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.35rem;
    flex-shrink: 0;
    min-width: 0;
    min-height: 28px;
    padding: 0.3rem 0.45rem;
    box-sizing: border-box;
  }

  .wb-form-toolbar-title {
    font-size: 0.72rem;
    font-weight: 700;
    color: #7b68ee;
    line-height: 1.2;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wb-pane-toggle {
    width: 28px;
    height: 28px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    background: #ffffff;
    color: #4b5563;
    font-size: 0.85rem;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-sizing: border-box;
  }

  .wb-pane-toggle:hover {
    border-color: #a78bfa;
    color: #7b68ee;
    background: #f5f3ff;
  }

  .hint {
    font-size: 0.72rem;
    font-weight: 500;
    color: #7b68ee;
  }

  .wb-map-preview-block {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-top: 0.35rem;
  }

  .wb-map-preview-label {
    font-size: 0.95rem;
    font-weight: 600;
    color: #333;
  }

  .wb-map-preview-container {
    width: 100%;
    margin-top: 0.25rem;
  }

  .wb-preview-image-wrapper {
    position: relative;
    display: block;
    width: 100%;
    max-width: 100%;
    border: 2px solid #ddd;
    border-radius: 6px;
    overflow: hidden;
    background: #fff;
    line-height: 0;
  }

  .wb-preview-image {
    display: block;
    width: 100%;
    height: auto;
    max-width: 100%;
    object-fit: contain;
    object-position: center;
    vertical-align: top;
  }

  .wb-preview-loading {
    padding: 2.5rem 1.5rem;
    text-align: center;
    background: #f5f5f5;
    border: 2px dashed #ddd;
    border-radius: 6px;
    min-height: 280px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
  }

  .wb-preview-loading p {
    margin: 0.75rem 0 0;
    font-size: 0.9rem;
    font-weight: 600;
    color: #7b68ee;
  }

  .wb-loading-spinner {
    border: 4px solid #f3f3f3;
    border-top: 4px solid #7b68ee;
    border-radius: 50%;
    width: 40px;
    height: 40px;
    animation: wb-spin 1s linear infinite;
    margin: 0 auto;
  }

  @keyframes wb-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .wb-preview-hint {
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
    color: #666;
    font-style: italic;
    text-align: center;
    line-height: 1.3;
  }

  .wb-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    z-index: 2147483646;
    padding: 16px;
    box-sizing: border-box;
    overflow-y: auto;
  }

  .wb-modal-content {
    background: #fff;
    border-radius: 12px;
    max-width: 600px;
    width: 100%;
    max-height: none;
    overflow: visible;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    box-sizing: border-box;
    margin: 0 auto 24px;
  }

  .wb-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.85rem 1.1rem;
    border-bottom: 2px solid #7b68ee;
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    color: #fff;
  }

  .wb-modal-header h2 {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 600;
  }

  .wb-modal-close {
    background: none;
    border: none;
    color: #fff;
    font-size: 1.75rem;
    cursor: pointer;
    padding: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    line-height: 1;
  }

  .wb-modal-close:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .wb-modal-body {
    padding: 1.25rem 1.35rem 1.35rem;
  }

  .wb-modal-form {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .wb-modal-field {
    margin-bottom: 1rem;
  }

  .wb-modal-field label {
    display: block;
    margin-bottom: 0.4rem;
    font-weight: 600;
    color: #333;
    font-size: 0.95rem;
  }

  .wb-modal-field input,
  .wb-modal-field select {
    width: 100%;
    border: 2px solid #ddd;
    border-radius: 6px;
    padding: 0.65rem 0.75rem;
    font-size: 0.95rem;
    color: #111827;
    background: #fff;
    box-sizing: border-box;
  }

  .wb-modal-field input[readonly] {
    background: #f3f4f6;
  }

  .wb-modal-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.55rem;
    padding-top: 0.7rem;
    border-top: 1px solid #e5e7eb;
  }

  .wb-modal-btn-cancel,
  .wb-modal-btn-save,
  .wb-modal-btn-pdf {
    border: none;
    border-radius: 6px;
    padding: 0.5rem 0.85rem;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
  }

  .wb-modal-btn-cancel {
    background: #e5e7eb;
    color: #374151;
  }

  .wb-modal-btn-save {
    background: #6495ed;
    color: #fff;
  }

  .wb-modal-btn-pdf {
    background: #7b68ee;
    color: #fff;
  }

  .wb-modal-btn-cancel:disabled,
  .wb-modal-btn-save:disabled,
  .wb-modal-btn-pdf:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .wb-map-pane {
    flex: 1 1 auto;
    align-self: stretch;
    min-width: 0;
    min-height: 0;
    width: auto;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    padding: 0;
    background: transparent;
    box-sizing: border-box;
    overflow: hidden;
    position: relative;
  }

  .wb-map-search-box {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 25;
    width: min(280px, calc(100% - 20px));
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.5rem 0.55rem;
    background: rgba(255, 255, 255, 0.96);
    border: 1px solid #d1d5db;
    border-radius: 10px;
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.12);
    box-sizing: border-box;
    pointer-events: auto;
    max-height: calc(100% - 20px);
    overflow-x: hidden;
    overflow-y: auto;
  }

  .wb-map-search-label {
    font-size: 0.68rem;
    font-weight: 700;
    color: #7b68ee;
    line-height: 1.2;
  }

  .wb-map-search-input {
    width: 100%;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 0.35rem 0.45rem;
    font-size: 0.74rem;
    font-weight: 500;
    color: #111827;
    background: #fff;
    box-sizing: border-box;
    min-height: 1.85rem;
  }

  .wb-map-search-input:focus {
    outline: none;
    border-color: #a78bfa;
    box-shadow: 0 0 0 2px rgba(123, 104, 238, 0.18);
  }

  .wb-map-search-actions {
    display: flex;
    gap: 0.35rem;
  }

  .wb-map-search-error {
    margin: 0;
    padding: 0.3rem 0.35rem;
    border-radius: 6px;
    background: #fef2f2;
    color: #b91c1c;
    font-size: 0.68rem;
    line-height: 1.3;
  }

  .wb-fora-limite-box {
    margin-top: 0.15rem;
    padding: 0.45rem 0.5rem;
    background: linear-gradient(135deg, #ffe0b2 0%, #ffcc80 100%);
    border: 1.5px solid #ff9800;
    border-radius: 8px;
    box-shadow: 0 2px 6px rgba(255, 152, 0, 0.18);
  }

  .wb-fora-limite-header {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-bottom: 0.2rem;
  }

  .wb-fora-limite-icon {
    font-size: 0.85rem;
    line-height: 1;
    flex-shrink: 0;
  }

  .wb-fora-limite-title {
    flex: 1;
    min-width: 0;
    font-size: 0.72rem;
    font-weight: 700;
    color: #e65100;
    line-height: 1.2;
  }

  .wb-fora-limite-info {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border-radius: 999px;
    flex-shrink: 0;
  }

  .wb-fora-limite-info:focus-visible {
    outline: 2px solid #ff9800;
    outline-offset: 1px;
  }

  .wb-fora-limite-text {
    margin: 0;
    font-size: 0.66rem;
    line-height: 1.35;
    color: #e65100;
  }

  .wb-fora-limite-text strong {
    color: #e65100;
    font-weight: 700;
  }

  .wb-fora-limite-modal {
    max-width: min(420px, calc(100vw - 2rem));
  }

  .wb-fora-limite-modal .wb-modal-body {
    padding: 0.85rem 1rem 1rem;
    font-size: 0.82rem;
    line-height: 1.45;
    color: #374151;
  }

  .wb-fora-limite-modal .wb-modal-body p {
    margin: 0;
  }

  .wb-map-btn {
    flex: 1 1 0;
    border: none;
    border-radius: 6px;
    padding: 0.4rem 0.45rem;
    font-size: 0.7rem;
    font-weight: 700;
    cursor: pointer;
    line-height: 1.2;
  }

  .wb-map-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .wb-map-btn-locate {
    background: #7b68ee;
    color: #fff;
  }

  .wb-map-btn-locate:hover:not(:disabled) {
    background: #6a58e0;
  }

  .wb-map-btn-report {
    background: #6495ed;
    color: #fff;
  }

  .wb-map-btn-report:hover:not(:disabled) {
    background: #4f7fd6;
  }

  .wb-map-pane.collapsed {
    flex: 0 0 8px;
    min-height: 8px;
    max-height: 8px;
  }

  .wb-map-pane.collapsed .wb-map-placeholder,
  .wb-map-pane.collapsed .wb-map-host {
    opacity: 0;
    pointer-events: none;
  }

  .wb-map-host {
    flex: 1;
    min-width: 0;
    min-height: 0;
    width: 100%;
    max-width: 100%;
    border-radius: 0;
    overflow: hidden;
    border: none;
    background: transparent;
    box-sizing: border-box;
  }

  .wb-map-host :global(.viabilidade-content.embedded) {
    height: 100%;
    min-height: 0;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    overflow: hidden;
  }

  .wb-map-host :global(.viabilidade-content.workbench-mode .main-layout) {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    height: 100%;
    padding: 0;
    box-sizing: border-box;
    overflow: hidden;
  }

  .wb-map-host :global(.viabilidade-content.workbench-mode .search-panel),
  .wb-map-host :global(.viabilidade-content.workbench-mode .resize-handle-vertical),
  .wb-map-host :global(.viabilidade-content.workbench-mode .resize-handle-horizontal) {
    display: none !important;
  }

  .wb-map-host :global(.viabilidade-content.workbench-mode .main-area) {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    box-sizing: border-box;
  }

  .wb-map-host :global(.viabilidade-content.workbench-mode .results-table-container),
  .wb-map-host :global(.viabilidade-content.workbench-mode .empty-state),
  .wb-map-host :global(.viabilidade-content.workbench-mode .map-container) {
    max-width: 100% !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
  }

  .wb-map-placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    border: 1px dashed #cbd5e1;
    color: #64748b;
    background: #fff;
    padding: 1rem;
    text-align: center;
    font-size: 0.8rem;
  }
</style>
