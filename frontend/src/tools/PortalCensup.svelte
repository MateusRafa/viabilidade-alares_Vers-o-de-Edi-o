<script>
  import { onMount, onDestroy } from 'svelte';
  import Loading from '../Loading.svelte';
  import {
    clearToolShell,
    toolShellBackHandler,
    toolShellHeaderAction,
    toolShellHeaderShortcut,
    toolShellSearch,
    toolShellThemeToggle,
    toolShellTitle,
    toolShellViewToggle
  } from '../toolShellStore.js';
  import { theme } from '../themeStore.js';
  import {
    fetchPortalCensupChamados,
    fetchPortalCensupChamadoById
  } from './portalCensupApi.js';

  export let currentUser = '';
  export let userTipo = 'user'; // mantido para compatibilidade com o shell de ferramentas
  export let onBackToDashboard = () => {};
  export let onBackRequest = null;

  const VIABILIDADE_ALARES_TOOL_ID = 'viabilidade-alares';

  const REFRESH_INTERVAL_MS = 30000;
  const PAGE_SIZE_OPTIONS = [25, 50, 100];
  const COLUMNS_STORAGE_KEY = 'portalCensup.visibleColumns.v1';

  const TABLE_COLUMNS = [
    { id: 'uf', label: 'UF' },
    { id: 'cidade', label: 'Cidade' },
    { id: 'sistema', label: 'Sistema' },
    { id: 'pedido', label: 'Pedido' },
    { id: 'dataSituacao', label: 'Data Situação' },
    { id: 'horaAbertura', label: 'Hora da Abertura' },
    { id: 'horaFechamento', label: 'Hora do Fechamento' },
    { id: 'pdv', label: 'PDV' },
    { id: 'motivo', label: 'Motivo' },
    { id: 'situacao', label: 'Situação' }
  ];

  const DEFAULT_VISIBLE_COLUMN_IDS = TABLE_COLUMNS.map((c) => c.id);

  function loadVisibleColumnIds() {
    try {
      const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
      if (!raw) return [...DEFAULT_VISIBLE_COLUMN_IDS];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [...DEFAULT_VISIBLE_COLUMN_IDS];
      const allowed = new Set(DEFAULT_VISIBLE_COLUMN_IDS);
      const cleaned = parsed.map(String).filter((id) => allowed.has(id));
      return cleaned.length ? cleaned : [...DEFAULT_VISIBLE_COLUMN_IDS];
    } catch {
      return [...DEFAULT_VISIBLE_COLUMN_IDS];
    }
  }

  // Portal = arquivo de chamados finalizados (Salvar Relatório / Gerar PDF)
  let listView = 'resolvidos';
  let chamados = [];
  let total = 0;
  let totalPages = 1;
  let page = 1;
  let pageSize = 50;
  let pageInput = '1';
  let searchQuery = '';
  let searchTimer = null;
  let loadingList = false;
  let listError = '';
  let persistNotice = '';
  let persistOk = false;
  let refreshInterval = null;
  let isRefreshing = false;

  let selectedChamado = null;
  let loadingDetail = false;
  let detailError = '';
  let feedbackMessage = '';

  let visibleColumnIds = loadVisibleColumnIds();
  let openColumnMenuId = null;
  let showHiddenColumnsMenu = false;

  $: showingDetail = !!selectedChamado;
  $: isDark = $theme === 'dark';
  $: visibleColumns = TABLE_COLUMNS.filter((c) => visibleColumnIds.includes(c.id));
  $: hiddenColumns = TABLE_COLUMNS.filter((c) => !visibleColumnIds.includes(c.id));
  $: tableColSpan = visibleColumns.length + 1;

  function syncHeaderRefresh() {
    toolShellHeaderAction.set({
      label: 'Atualizar',
      spinning: isRefreshing,
      disabled: isRefreshing,
      onClick: handleAtualizar
    });
  }

  function syncHeaderSearch({ enabled = true } = {}) {
    if (!enabled) {
      toolShellSearch.set(null);
      return;
    }
    toolShellSearch.update((current) => ({
      enabled: true,
      open: current?.open || false,
      value: searchQuery,
      placeholder: 'Pedido, cidade, motivo, projetista…',
      onInput: (value) => {
        searchQuery = value;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          page = 1;
          pageInput = '1';
          carregarChamados();
        }, 280);
      }
    }));
  }

  $: isRefreshing, syncHeaderRefresh();

  function syncHeaderViewToggle() {
    // Portal agora é só arquivo de finalizados — sem toggle pendentes/resolvidos
    toolShellViewToggle.set(null);
  }

  function syncHeaderViabilidadeShortcut({ enabled = true } = {}) {
    if (!enabled) {
      toolShellHeaderShortcut.set(null);
      return;
    }

    toolShellHeaderShortcut.set({
      icon: 'viabilidade',
      label: 'Viabilidade Alares — busca avulsa',
      title: 'Viabilidade Alares — busca avulsa',
      onClick: abrirViabilidadeAvulsa
    });
  }

  function abrirViabilidadeAvulsa() {
    if (typeof window === 'undefined') return;
    const currentUrl = window.location.origin + window.location.pathname;
    const toolUrl = `${currentUrl}#/${VIABILIDADE_ALARES_TOOL_ID}`;
    window.open(toolUrl, '_blank', 'noopener,noreferrer');
  }

  async function carregarChamados({ silent = false } = {}) {
    if (!(currentUser || '').trim()) {
      chamados = [];
      return;
    }

    if (!silent) loadingList = true;
    listError = '';

    try {
      const data = await fetchPortalCensupChamados(currentUser, {
        q: searchQuery,
        page,
        limit: pageSize,
        view: listView
      });
      chamados = data.chamados || [];
      total = data.total || 0;
      totalPages = Math.max(1, data.totalPages || 1);
      if (page > totalPages) {
        page = totalPages;
        pageInput = String(page);
        await carregarChamados({ silent });
        return;
      }
      pageInput = String(page);

      if (data.source === 'supabase') {
        persistOk = true;
        persistNotice = '';
      } else {
        persistOk = false;
        persistNotice =
          data.warning ||
          'A tela ainda não está lendo a table chamados do Supabase.';
      }
    } catch (err) {
      if (!silent) {
        listError = err?.message || 'Não foi possível carregar os chamados.';
        chamados = [];
      }
    } finally {
      if (!silent) loadingList = false;
    }
  }

  async function handleAtualizar() {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
      await carregarChamados();
    } finally {
      isRefreshing = false;
    }
  }

  async function abrirChamado(item) {
    if (loadingDetail) return;
    loadingDetail = true;
    detailError = '';
    feedbackMessage = '';
    selectedChamado = {
      id: item.id,
      pedido: item.pedido,
      endereco: item.endereco || {},
      cidade: item.cidade
    };
    syncShellChrome();

    try {
      selectedChamado = await fetchPortalCensupChamadoById(currentUser, item.id);
      syncShellChrome();
      await carregarChamados({ silent: true });
    } catch (err) {
      detailError = err?.message || 'Não foi possível abrir o chamado.';
      selectedChamado = null;
      syncShellChrome();
    } finally {
      loadingDetail = false;
    }
  }

  function fecharDetalhe() {
    selectedChamado = null;
    detailError = '';
    feedbackMessage = '';
    syncShellChrome();
  }

  function syncShellChrome() {
    const inDetail = !!selectedChamado;
    const pedido = selectedChamado?.pedido;

    if (inDetail && pedido) {
      toolShellTitle.set(`ALA-${pedido}`);
      toolShellBackHandler.set(() => fecharDetalhe());
      syncHeaderSearch({ enabled: false });
      syncHeaderViabilidadeShortcut({ enabled: false });
      syncHeaderViewToggle();
      if (typeof document !== 'undefined') {
        document.title = `ALA-${pedido}`;
      }
    } else {
      toolShellTitle.set(null);
      toolShellBackHandler.set(null);
      syncHeaderSearch({ enabled: true });
      syncHeaderViabilidadeShortcut({ enabled: true });
      syncHeaderViewToggle();
      if (typeof document !== 'undefined') {
        document.title = 'Portal CENSUP';
      }
    }

    if (typeof onBackRequest === 'function') {
      onBackRequest(inDetail ? () => fecharDetalhe() : null);
    }
  }

  function goToPage(nextPage) {
    const target = Math.max(1, Math.min(totalPages, Math.trunc(Number(nextPage)) || 1));
    if (target === page) {
      pageInput = String(page);
      return;
    }
    page = target;
    pageInput = String(page);
    carregarChamados();
  }

  function commitPageInput() {
    goToPage(pageInput);
  }

  function onPageInputKeydown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitPageInput();
    } else if (event.key === 'Escape') {
      pageInput = String(page);
      event.currentTarget?.blur?.();
    }
  }

  function changePageSize(nextSize) {
    const size = Number(nextSize);
    if (!PAGE_SIZE_OPTIONS.includes(size) || size === pageSize) return;
    pageSize = size;
    page = 1;
    pageInput = '1';
    carregarChamados();
  }

  function formatCount(n) {
    return Number(n || 0).toLocaleString('pt-BR');
  }

  function statusLabel(status) {
    if (status === 'aprovada') return 'Aprovada';
    if (status === 'corrigida') return 'Corrigida';
    if (status === 'aguardando_analise') return 'Aguardando análise';
    return 'Finalizado';
  }

  function persistVisibleColumns() {
    try {
      localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(visibleColumnIds));
    } catch {
      /* ignore */
    }
  }

  function isColumnVisible(id) {
    return visibleColumnIds.includes(id);
  }

  function hideColumn(id) {
    if (!isColumnVisible(id)) return;
    if (visibleColumnIds.length <= 1) return;
    visibleColumnIds = visibleColumnIds.filter((c) => c !== id);
    openColumnMenuId = null;
    persistVisibleColumns();
  }

  function showColumn(id) {
    if (isColumnVisible(id)) return;
    const order = DEFAULT_VISIBLE_COLUMN_IDS;
    const next = [...visibleColumnIds, id].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b)
    );
    visibleColumnIds = next;
    showHiddenColumnsMenu = false;
    openColumnMenuId = null;
    persistVisibleColumns();
  }

  function showAllColumns() {
    visibleColumnIds = [...DEFAULT_VISIBLE_COLUMN_IDS];
    showHiddenColumnsMenu = false;
    openColumnMenuId = null;
    persistVisibleColumns();
  }

  function toggleColumnMenu(id, event) {
    event?.stopPropagation?.();
    showHiddenColumnsMenu = false;
    openColumnMenuId = openColumnMenuId === id ? null : id;
  }

  function toggleHiddenColumnsMenu(event) {
    event?.stopPropagation?.();
    openColumnMenuId = null;
    showHiddenColumnsMenu = !showHiddenColumnsMenu;
  }

  function closeColumnMenus() {
    openColumnMenuId = null;
    showHiddenColumnsMenu = false;
  }

  function columnCellValue(item, columnId) {
    switch (columnId) {
      case 'uf':
        return item.uf;
      case 'cidade':
        return item.cidade;
      case 'sistema':
        return item.sistema;
      case 'pedido':
        return item.pedido;
      case 'dataSituacao':
        return item.dataSituacaoLabel || item.dataSituacao;
      case 'horaAbertura':
        return item.horaAberturaLabel;
      case 'horaFechamento':
        return item.horaFechamentoLabel;
      case 'pdv':
        return item.pdv;
      case 'motivo':
        return item.motivo;
      case 'situacao':
        return item.situacaoLabel || item.situacao || 'Finalizado';
      default:
        return null;
    }
  }

  function cellText(value) {
    if (value == null) return '—';
    const s = String(value).trim();
    if (!s || /^null$/i.test(s) || /^undefined$/i.test(s)) return '—';
    return s;
  }

  function imprimirRelatorioSalvo() {
    const html = selectedChamado?.pdfHtml;
    if (!html) {
      feedbackMessage = 'Este chamado ainda não tem relatório salvo para imprimir.';
      return;
    }
    const win = window.open('', '_blank');
    if (!win) {
      feedbackMessage = 'Pop-up bloqueado. Permita pop-ups para imprimir o relatório.';
      return;
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

  function onDocumentClick() {
    closeColumnMenus();
  }

  onMount(async () => {
    syncHeaderRefresh();
    syncHeaderSearch({ enabled: true });
    syncHeaderViabilidadeShortcut({ enabled: true });
    syncHeaderViewToggle();
    toolShellThemeToggle.set(true);
    document.addEventListener('click', onDocumentClick);
    await carregarChamados();

    refreshInterval = setInterval(() => {
      carregarChamados({ silent: true });
    }, REFRESH_INTERVAL_MS);
  });

  onDestroy(() => {
    if (refreshInterval) clearInterval(refreshInterval);
    if (searchTimer) clearTimeout(searchTimer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('click', onDocumentClick);
    }
    clearToolShell();
    if (typeof onBackRequest === 'function') onBackRequest(null);
  });
</script>

<div class="portal-censup" class:theme-dark={isDark}>
  {#if showingDetail}
    <div class="detail-view">
      {#if loadingDetail}
        <div class="detail-loading"><Loading currentMessage="Abrindo relatório…" /></div>
      {:else if detailError}
        <p class="load-error" role="alert">{detailError}</p>
      {:else if selectedChamado}
        <div class="detail-arquivo">
          <aside class="detail-side">
            <div class="info-grid">
              <div class="info-item">
                <span class="label">Pedido</span>
                <span class="value">{selectedChamado.pedido}</span>
              </div>
              <div class="info-item">
                <span class="label">Cidade</span>
                <span class="value">{selectedChamado.endereco?.cidade || selectedChamado.cidade}</span>
              </div>
              <div class="info-item full">
                <span class="label">Endereço</span>
                <span class="value">{selectedChamado.endereco?.completo || '—'}</span>
              </div>
              {#if selectedChamado.endereco?.bairro || selectedChamado.endereco?.cep}
                <div class="info-item">
                  <span class="label">Bairro</span>
                  <span class="value">{selectedChamado.endereco?.bairro || '—'}</span>
                </div>
                <div class="info-item">
                  <span class="label">CEP</span>
                  <span class="value">{selectedChamado.endereco?.cep || '—'}</span>
                </div>
              {/if}
              <div class="info-item">
                <span class="label">Tabulação</span>
                <span class="value highlight">{selectedChamado.tabulacaoFinal || selectedChamado.relatorio?.tabulacaoFinal || '—'}</span>
              </div>
              <div class="info-item">
                <span class="label">Projetista</span>
                <span class="value">{selectedChamado.relatorio?.projetista || selectedChamado.viabilidadeResumo?.projetista || '—'}</span>
              </div>
              <div class="info-item">
                <span class="label">Status</span>
                <span class="value status-badge status-badge--{selectedChamado.tabulacaoStatus || 'aprovada'}">
                  {statusLabel(selectedChamado.tabulacaoStatus)}
                </span>
              </div>
              {#if selectedChamado.relatorioSalvoAt || selectedChamado.relatorio?.savedAt}
                <div class="info-item full">
                  <span class="label">Salvo em</span>
                  <span class="value">
                    {new Date(selectedChamado.relatorioSalvoAt || selectedChamado.relatorio.savedAt).toLocaleString('pt-BR')}
                  </span>
                </div>
              {/if}
            </div>

            <div class="feedback-actions">
              {#if selectedChamado.pdfHtml || selectedChamado.relatorioSalvo}
                <button type="button" class="btn-primary" on:click={imprimirRelatorioSalvo}>
                  Imprimir relatório
                </button>
              {/if}
            </div>

            {#if feedbackMessage}
              <p class="feedback-message" role="status">{feedbackMessage}</p>
            {/if}
          </aside>

          <div class="detail-preview">
            {#if selectedChamado.pdfHtml}
              <iframe
                class="report-preview-frame"
                title="Prévia do relatório ALA-{selectedChamado.pedido}"
                srcdoc={selectedChamado.pdfHtml}
              ></iframe>
            {:else if selectedChamado.mapPreviewImage || selectedChamado.relatorio?.mapPreviewImage}
              <div class="preview-map-only">
                <img
                  src={selectedChamado.mapPreviewImage || selectedChamado.relatorio.mapPreviewImage}
                  alt="Prévia do mapa do relatório"
                />
              </div>
            {:else}
              <div class="detail-loading">
                <p>Este chamado finalizado ainda não tem prévia de relatório salva.</p>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="queue-view">
      {#if persistNotice && !persistOk}
        <p class="persist-warning" role="status">{persistNotice}</p>
      {/if}
      {#if listError}
        <p class="load-error" role="alert">{listError}</p>
      {/if}

      {#if hiddenColumns.length > 0}
        <div class="columns-toolbar">
          <div class="col-menu-wrap">
            <button
              type="button"
              class="btn-hidden-columns"
              on:click={toggleHiddenColumnsMenu}
              aria-expanded={showHiddenColumnsMenu}
              aria-haspopup="menu"
            >
              Colunas ocultas ({hiddenColumns.length})
            </button>
            {#if showHiddenColumnsMenu}
              <div class="col-menu" role="menu" on:click|stopPropagation>
                {#each hiddenColumns as col (col.id)}
                  <button
                    type="button"
                    class="col-menu-item"
                    role="menuitem"
                    on:click={() => showColumn(col.id)}
                  >
                    Mostrar {col.label}
                  </button>
                {/each}
                <button
                  type="button"
                  class="col-menu-item col-menu-item-accent"
                  role="menuitem"
                  on:click={showAllColumns}
                >
                  Mostrar todas
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <div class="table-wrap">
        <table class="chamados-table">
          <thead>
            <tr>
              {#each visibleColumns as col (col.id)}
                <th>
                  <div class="th-inner">
                    <span>{col.label}</span>
                    <div class="col-menu-wrap">
                      <button
                        type="button"
                        class="btn-col-menu"
                        on:click={(e) => toggleColumnMenu(col.id, e)}
                        aria-label="Opções da coluna {col.label}"
                        aria-expanded={openColumnMenuId === col.id}
                        aria-haspopup="menu"
                        title="Opções da coluna"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <circle cx="12" cy="5" r="2" />
                          <circle cx="12" cy="12" r="2" />
                          <circle cx="12" cy="19" r="2" />
                        </svg>
                      </button>
                      {#if openColumnMenuId === col.id}
                        <div class="col-menu col-menu-th" role="menu" on:click|stopPropagation>
                          <button
                            type="button"
                            class="col-menu-item"
                            role="menuitem"
                            disabled={visibleColumns.length <= 1}
                            on:click={() => hideColumn(col.id)}
                          >
                            Ocultar coluna
                          </button>
                          {#if hiddenColumns.length > 0}
                            <div class="col-menu-sep"></div>
                            {#each hiddenColumns as hidden (hidden.id)}
                              <button
                                type="button"
                                class="col-menu-item"
                                role="menuitem"
                                on:click={() => showColumn(hidden.id)}
                              >
                                Mostrar {hidden.label}
                              </button>
                            {/each}
                            <button
                              type="button"
                              class="col-menu-item col-menu-item-accent"
                              role="menuitem"
                              on:click={showAllColumns}
                            >
                              Mostrar todas
                            </button>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  </div>
                </th>
              {/each}
              <th class="col-action" aria-label="Ações"></th>
            </tr>
          </thead>
          <tbody>
            {#if loadingList && chamados.length === 0}
              <tr>
                <td colspan={tableColSpan} class="empty-cell">Carregando chamados…</td>
              </tr>
            {:else if chamados.length === 0}
              <tr>
                <td colspan={tableColSpan} class="empty-cell">
                  Nenhum relatório finalizado ainda
                </td>
              </tr>
            {:else}
              {#each chamados as item (item.id)}
                <tr>
                  {#each visibleColumns as col (col.id)}
                    <td>{cellText(columnCellValue(item, col.id))}</td>
                  {/each}
                  <td class="col-action">
                    <div class="col-action-buttons">
                      <button
                        type="button"
                        class="btn-lupa"
                        on:click={() => abrirChamado(item)}
                        aria-label="Abrir relatório do pedido {item.pedido}"
                        title="Abrir relatório"
                      >
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2.5" />
                          <path d="M20 20L16.5 16.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>

      <footer class="table-footer" aria-label="Paginação da lista">
        <div class="pagination">
          <button
            type="button"
            class="btn-page btn-page-icon"
            on:click={() => goToPage(page - 1)}
            disabled={page <= 1 || loadingList}
            aria-label="Página anterior"
            title="Página anterior"
          >
            ‹
          </button>
          <label class="page-jump">
            <span>Página</span>
            <input
              type="number"
              class="page-input"
              min="1"
              max={totalPages}
              inputmode="numeric"
              bind:value={pageInput}
              on:keydown={onPageInputKeydown}
              on:blur={commitPageInput}
              disabled={loadingList}
              aria-label="Ir para página"
            />
            <span>de {formatCount(totalPages)}</span>
          </label>
          <button
            type="button"
            class="btn-page btn-page-icon"
            on:click={() => goToPage(page + 1)}
            disabled={page >= totalPages || loadingList}
            aria-label="Próxima página"
            title="Próxima página"
          >
            ›
          </button>
          <label class="page-size">
            <select
              value={pageSize}
              on:change={(e) => changePageSize(e.currentTarget.value)}
              disabled={loadingList}
              aria-label="Linhas por página"
            >
              {#each PAGE_SIZE_OPTIONS as size}
                <option value={size}>{size} linhas</option>
              {/each}
            </select>
          </label>
          <span class="page-total">{formatCount(total)} registros</span>
        </div>
      </footer>
    </div>
  {/if}
</div>

<style>
  .portal-censup {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #f0f2f8;
    box-sizing: border-box;
  }

  .queue-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 1.25rem 1.5rem;
    gap: 1rem;
  }

  .detail-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 0;
    gap: 0;
    overflow: hidden;
    position: relative;
  }

  .detail-viabilidade {
    flex: 1;
    min-height: 0;
    height: 100%;
    position: relative;
    overflow: hidden;
  }

  .detail-arquivo {
    flex: 1;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-columns: minmax(260px, 320px) 1fr;
    gap: 0;
    overflow: hidden;
    background: #fff;
  }

  .detail-side {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem;
    border-right: 1px solid #e5e7eb;
    overflow: auto;
    background: #f8fafc;
  }

  .detail-preview {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: #eef1f8;
  }

  .report-preview-frame {
    width: 100%;
    height: 100%;
    border: 0;
    background: #fff;
  }

  .preview-map-only {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    box-sizing: border-box;
  }

  .preview-map-only img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 4px 18px rgba(15, 23, 42, 0.12);
  }

  .censup-tabulacao {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .queue-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-shrink: 0;
  }

  .queue-header-actions {
    display: flex;
    align-items: center;
    gap: 0.65rem;
  }

  .extension-panel {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.05);
    flex-shrink: 0;
  }

  .extension-panel-main strong {
    display: block;
    color: #374151;
    margin-bottom: 0.15rem;
  }

  .extension-panel-main p {
    margin: 0;
    font-size: 0.88rem;
    color: #6b7280;
    line-height: 1.45;
  }

  .btn-link {
    background: none;
    border: none;
    padding: 0;
    color: #7b68ee;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    width: fit-content;
  }

  .btn-link:hover {
    text-decoration: underline;
  }

  .extension-help ol {
    margin: 0;
    padding-left: 1.2rem;
    font-size: 0.85rem;
    color: #4b5563;
    line-height: 1.55;
  }

  .extension-help code {
    font-size: 0.8rem;
    background: #f3f4f6;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
  }

  .api-hint {
    display: inline-block;
    margin-top: 0.2rem;
    word-break: break-all;
  }

  .queue-header-left {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .queue-header h2 {
    margin: 0;
    font-size: 1.35rem;
    color: #374151;
  }

  .last-update {
    font-size: 0.85rem;
    color: #6b7280;
  }

  .btn-primary,
  .btn-secondary,
  .btn-success,
  .btn-warning,
  .btn-page {
    border: none;
    border-radius: 8px;
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: filter 0.15s ease;
  }

  .btn-primary {
    padding: 0.65rem 1.1rem;
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    color: white;
    box-shadow: 0 4px 12px rgba(123, 104, 238, 0.3);
  }

  .btn-secondary {
    padding: 0.55rem 0.95rem;
    background: white;
    color: #7b68ee;
    border: 1px solid #c4b5fd;
  }

  .btn-success {
    padding: 0.65rem 1rem;
    background: #10b981;
    color: white;
  }

  .btn-warning {
    padding: 0.65rem 1rem;
    background: #f59e0b;
    color: white;
  }

  .btn-primary:hover,
  .btn-secondary:hover,
  .btn-success:hover,
  .btn-warning:hover,
  .btn-page:hover:not(:disabled) {
    filter: brightness(1.05);
  }

  .btn-primary:disabled,
  .btn-success:disabled,
  .btn-warning:disabled,
  .btn-page:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-refresh {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }

  .refresh-icon {
    display: inline-block;
    font-size: 1.1rem;
    line-height: 1;
  }

  .refresh-icon.spinning {
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .correction-form select {
    padding: 0.45rem 0.65rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.9rem;
    background: white;
  }

  .table-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
  }

  .chamados-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88rem;
  }

  .chamados-table thead {
    position: sticky;
    top: 0;
    z-index: 1;
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    color: white;
  }

  .chamados-table th,
  .chamados-table td {
    padding: 0.75rem 0.85rem;
    text-align: center;
    border-bottom: 1px solid #eef2f7;
    vertical-align: middle;
  }

  .chamados-table th {
    font-weight: 600;
    white-space: nowrap;
  }

  .th-inner {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
  }

  .col-menu-wrap {
    position: relative;
    display: inline-flex;
  }

  .btn-col-menu {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: rgba(255, 255, 255, 0.85);
    cursor: pointer;
    opacity: 0.75;
    transition: opacity 0.15s ease, background 0.15s ease;
  }

  .btn-col-menu:hover,
  .btn-col-menu[aria-expanded='true'] {
    opacity: 1;
    background: rgba(255, 255, 255, 0.18);
  }

  .columns-toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 0.5rem;
  }

  .btn-hidden-columns {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.7rem;
    border: 1px solid #c4b5fd;
    border-radius: 8px;
    background: #f5f3ff;
    color: #5b21b6;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }

  .btn-hidden-columns:hover {
    background: #ede9fe;
  }

  .col-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 20;
    min-width: 170px;
    padding: 0.35rem;
    border-radius: 8px;
    background: #fff;
    border: 1px solid #e5e7eb;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
  }

  .col-menu-th {
    right: 0;
    left: auto;
  }

  .col-menu-item {
    display: block;
    width: 100%;
    padding: 0.45rem 0.65rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #1f2937;
    font-family: inherit;
    font-size: 0.82rem;
    text-align: left;
    cursor: pointer;
  }

  .col-menu-item:hover:not(:disabled) {
    background: #f3f4f6;
  }

  .col-menu-item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .col-menu-item-accent {
    color: #5b21b6;
    font-weight: 600;
  }

  .col-menu-sep {
    height: 1px;
    margin: 0.25rem 0.35rem;
    background: #e5e7eb;
  }

  .chamados-table tbody tr:hover {
    background: #f8f7ff;
  }

  .col-action {
    width: 72px;
    text-align: center;
    vertical-align: middle;
  }

  .col-action-buttons {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
  }

  .report-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2rem;
    padding: 0.15rem 0.35rem;
    border-radius: 6px;
    background: #7b68ee;
    color: #fff;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .empty-cell {
    text-align: center;
    color: #6b7280;
    padding: 2.5rem 1rem !important;
  }

  .btn-lupa {
    width: 42px;
    height: 42px;
    border: none;
    border-radius: 8px;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 3px 10px rgba(123, 104, 238, 0.35);
  }

  .btn-lupa:hover {
    filter: brightness(1.06);
    transform: scale(1.03);
  }

  .table-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 1rem;
    flex-shrink: 0;
    font-size: 0.88rem;
    color: #6b7280;
  }

  .pagination {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.55rem;
  }

  .btn-page {
    padding: 0.45rem 0.85rem;
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    cursor: pointer;
  }

  .btn-page:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn-page-icon {
    width: 34px;
    height: 34px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.35rem;
    line-height: 1;
    font-weight: 600;
  }

  .page-jump,
  .page-size {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: inherit;
    white-space: nowrap;
  }

  .page-input {
    width: 3.4rem;
    height: 34px;
    padding: 0 0.4rem;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    text-align: center;
    font: inherit;
    font-weight: 600;
    color: #7b68ee;
    background: white;
    outline: none;
  }

  .page-input:focus {
    border-color: #7b68ee;
    box-shadow: 0 0 0 2px rgba(123, 104, 238, 0.2);
  }

  .page-input::-webkit-outer-spin-button,
  .page-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .page-input[type='number'] {
    -moz-appearance: textfield;
    appearance: textfield;
  }

  .page-size select {
    height: 34px;
    padding: 0 0.55rem;
    border: 1px solid #d1d5db;
    border-radius: 999px;
    background: white;
    color: #374151;
    font: inherit;
    cursor: pointer;
    outline: none;
  }

  .page-size select:focus {
    border-color: #7b68ee;
    box-shadow: 0 0 0 2px rgba(123, 104, 238, 0.2);
  }

  .page-total {
    font-weight: 600;
    color: #4b5563;
  }

  .detail-layout {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 0.85rem;
    overflow: hidden;
  }

  .search-panel {
    width: 320px;
    flex: 0 0 320px;
    background: white;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }

  .search-panel.minimized {
    width: 60px;
    flex-basis: 60px;
  }

  .panel-header {
    padding: 1rem 1.1rem 0.75rem;
    border-bottom: 1px solid #e5e7eb;
    background: #f9fafb;
  }

  .panel-header-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .panel-header h2 {
    margin: 0;
    font-size: 1.15rem;
    color: #7b68ee;
  }

  .panel-header p {
    margin: 0.35rem 0 0;
    font-size: 0.82rem;
    color: #6b7280;
  }

  .minimize-button {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 1rem;
    padding: 0.2rem 0.35rem;
    border-radius: 6px;
    line-height: 1;
  }

  .minimize-button:hover {
    background: rgba(123, 104, 238, 0.12);
  }

  .search-section {
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    overflow: auto;
  }

  .search-mode-selector {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.4rem;
  }

  .mode-button {
    border: 1px solid #d1d5db;
    background: white;
    border-radius: 8px;
    padding: 0.55rem 0.4rem;
    font-family: inherit;
    font-weight: 600;
    font-size: 0.85rem;
    color: #4b5563;
    cursor: pointer;
  }

  .mode-button.active {
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    color: white;
    border-color: transparent;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.85rem;
    color: #374151;
    font-weight: 600;
  }

  .form-group input {
    padding: 0.55rem 0.7rem;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 400;
  }

  .search-button {
    border: none;
    border-radius: 8px;
    padding: 0.75rem 1rem;
    font-family: inherit;
    font-weight: 700;
    font-size: 0.92rem;
    color: white;
    cursor: pointer;
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    box-shadow: 0 4px 12px rgba(123, 104, 238, 0.3);
  }

  .search-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .coverage-info-box {
    border-radius: 8px;
    padding: 0.75rem 0.85rem;
    font-size: 0.85rem;
  }

  .coverage-info-box strong {
    display: block;
  }

  .coverage-info-box p {
    margin: 0.35rem 0 0;
  }

  .coverage-info-box.success {
    background: #ecfdf5;
    color: #065f46;
    border: 1px solid #a7f3d0;
  }

  .coverage-info-box.warning {
    background: #fff7ed;
    color: #9a3412;
    border: 1px solid #fed7aa;
  }

  .detail-main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    overflow: auto;
  }

  .result-box.tabulacao-box {
    background: white;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex: 0 0 auto;
  }

  .tabulacao-box .box-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e5e7eb;
    background: #f9fafb;
  }

  .tabulacao-box .box-header h3 {
    margin: 0;
    color: #4c1d95;
    font-size: 1.1rem;
    font-weight: 600;
  }

  .tabulacao-body {
    padding: 1rem 1.25rem 1.25rem;
  }

  .info-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.85rem;
    margin-bottom: 1rem;
  }

  .info-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .info-item.full {
    grid-column: 1 / -1;
  }

  .label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #9ca3af;
  }

  .value {
    font-size: 0.92rem;
    color: #1f2937;
    font-weight: 600;
  }

  .value.highlight {
    color: #7b68ee;
  }

  .value.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem;
    word-break: break-all;
  }

  .status-badge {
    display: inline-flex;
    width: fit-content;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    font-size: 0.78rem;
  }

  .status-badge--pendente_revisao,
  .status-badge--pendente {
    background: #fef3c7;
    color: #92400e;
  }

  .status-badge--aguardando_analise {
    background: #dbeafe;
    color: #1d4ed8;
  }

  .status-badge--aprovada {
    background: #d1fae5;
    color: #065f46;
  }

  .status-badge--corrigida {
    background: #ede9fe;
    color: #5b21b6;
  }

  .ia-box {
    background: #f5f3ff;
    border: 1px solid #ddd6fe;
    border-radius: 8px;
    padding: 0.85rem;
    margin-bottom: 1rem;
  }

  .ia-box strong {
    display: block;
    margin-bottom: 0.35rem;
    color: #6d28d9;
  }

  .ia-box p {
    margin: 0;
    font-size: 0.88rem;
    color: #4b5563;
    line-height: 1.45;
  }

  .feedback-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
    margin-bottom: 0.75rem;
  }

  .correction-form {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    margin-top: 0.5rem;
  }

  .correction-form label {
    font-size: 0.85rem;
    color: #374151;
    font-weight: 600;
  }

  .feedback-message {
    margin: 0.75rem 0 0;
    font-size: 0.88rem;
    color: #059669;
  }

  .detail-loading {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .load-error {
    margin: 0;
    padding: 0.75rem 1rem;
    background: #fef2f2;
    color: #b91c1c;
    border: 1px solid #fecaca;
    border-radius: 8px;
  }

  .persist-warning {
    margin: 0 0 0.75rem;
    padding: 0.75rem 1rem;
    background: #fffbeb;
    color: #92400e;
    border: 1px solid #fcd34d;
    border-radius: 8px;
  }

  @media (max-width: 960px) {
    .detail-layout {
      flex-direction: column;
      overflow: auto;
    }

    .search-panel,
    .search-panel.minimized {
      width: 100%;
      flex-basis: auto;
    }
  }

  /* Dark alinhado à extensão (panel.css .censup-theme-dark) */
  .theme-dark .detail-arquivo {
    background: #0b1220;
  }

  .theme-dark .detail-side {
    background: #111827;
    border-right-color: #334155;
  }

  .theme-dark .detail-preview {
    background: #0b1220;
  }

  .portal-censup.theme-dark {
    --pc-bg: #0b1220;
    --pc-bg-panel: #111827;
    --pc-bg-elevated: #0f172a;
    --pc-bg-card: #1e293b;
    --pc-border: #334155;
    --pc-text: #e2e8f0;
    --pc-text-muted: #94a3b8;
    --pc-text-strong: #f8fafc;
    --pc-accent: #a78bfa;
    --pc-accent-soft: #c4b5fd;
    --pc-brand: #7b68ee;
    --pc-header: linear-gradient(135deg, #3b2f8a 0%, #3647a0 55%, #3a5bb8 100%);
    --pc-header-border: #5b4cdb;
    background: var(--pc-bg);
    color: var(--pc-text);
  }

  .theme-dark .table-wrap,
  .theme-dark .search-panel,
  .theme-dark .tabulacao-box,
  .theme-dark .extension-panel {
    background: var(--pc-bg-elevated);
    border-color: var(--pc-border);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  }

  .theme-dark .chamados-table thead {
    background: var(--pc-header);
    border-bottom: 2px solid var(--pc-header-border);
    color: #ffffff;
  }

  .theme-dark .panel-header,
  .theme-dark .tabulacao-box .box-header {
    background: var(--pc-bg-card);
    border-bottom-color: var(--pc-border);
  }

  .theme-dark .panel-header h2,
  .theme-dark .tabulacao-box .box-header h3 {
    color: var(--pc-accent);
  }

  .theme-dark .panel-header p,
  .theme-dark .form-group {
    color: var(--pc-text-muted);
  }

  .theme-dark .form-group input,
  .theme-dark .mode-button {
    background: var(--pc-bg-card);
    color: var(--pc-text);
    border-color: var(--pc-border);
  }

  .theme-dark .mode-button.active {
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    color: white;
    border-color: transparent;
  }

  .theme-dark .coverage-info-box.success {
    background: #064e3b;
    color: #6ee7b7;
    border-color: #065f46;
  }

  .theme-dark .coverage-info-box.warning {
    background: #422006;
    color: #fdba74;
    border-color: #9a3412;
  }

  .theme-dark .chamados-table tbody tr:hover {
    background: var(--pc-bg-card);
  }

  .theme-dark .btn-hidden-columns {
    border-color: rgba(123, 104, 238, 0.45);
    background: rgba(123, 104, 238, 0.18);
    color: #e9e5ff;
  }

  .theme-dark .btn-hidden-columns:hover {
    background: rgba(123, 104, 238, 0.28);
  }

  .theme-dark .col-menu {
    background: #1a1f2e;
    border-color: rgba(123, 104, 238, 0.35);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }

  .theme-dark .col-menu-item {
    color: #e5e7eb;
  }

  .theme-dark .col-menu-item:hover:not(:disabled) {
    background: rgba(123, 104, 238, 0.2);
  }

  .theme-dark .col-menu-item-accent {
    color: #c4b5fd;
  }

  .theme-dark .col-menu-sep {
    background: rgba(123, 104, 238, 0.25);
  }

  .theme-dark .chamados-table th,
  .theme-dark .chamados-table td {
    border-bottom-color: var(--pc-border);
    color: var(--pc-text);
  }

  .theme-dark .empty-cell,
  .theme-dark .table-footer,
  .theme-dark .last-update,
  .theme-dark .extension-panel-main p,
  .theme-dark .ia-box p,
  .theme-dark .label {
    color: var(--pc-text-muted);
  }

  .theme-dark .queue-header h2,
  .theme-dark .extension-panel-main strong,
  .theme-dark .value,
  .theme-dark .correction-form label {
    color: var(--pc-text-strong);
  }

  .theme-dark .value.highlight {
    color: var(--pc-accent-soft);
  }

  .theme-dark .btn-secondary,
  .theme-dark .btn-page {
    background: var(--pc-border);
    color: var(--pc-text);
    border-color: var(--pc-border);
  }

  .theme-dark .btn-secondary:hover,
  .theme-dark .btn-page:hover:not(:disabled) {
    background: #475569;
    color: #ffffff;
  }

  .theme-dark .correction-form select {
    background: var(--pc-bg-card);
    color: var(--pc-text);
    border-color: var(--pc-border);
  }

  .theme-dark .ia-box {
    background: #1e1b4b;
    border-color: var(--pc-brand);
  }

  .theme-dark .ia-box strong {
    color: var(--pc-accent-soft);
  }

  .theme-dark .status-badge--pendente_revisao,
  .theme-dark .status-badge--pendente {
    background: #422006;
    color: #fde68a;
  }

  .theme-dark .status-badge--aguardando_analise {
    background: #1e3a5f;
    color: #93c5fd;
  }

  .theme-dark .status-badge--aprovada {
    background: #064e3b;
    color: #6ee7b7;
  }

  .theme-dark .status-badge--corrigida {
    background: #2e1065;
    color: #ddd6fe;
  }

  .theme-dark .load-error {
    background: #3f1515;
    color: #fca5a5;
    border-color: #7f1d1d;
  }

  .theme-dark .persist-warning {
    background: #3f2e15;
    color: #fde68a;
    border-color: #92400e;
  }

  .theme-dark .feedback-message {
    color: #34d399;
  }

  .theme-dark .page-input {
    background: var(--pc-bg-card);
    border-color: var(--pc-border);
    color: var(--pc-accent);
  }

  .theme-dark .page-size select {
    background: var(--pc-bg-card);
    border-color: var(--pc-border);
    color: var(--pc-text);
  }

  .theme-dark .page-total {
    color: var(--pc-text);
  }

  .theme-dark .extension-help code {
    background: var(--pc-bg-card);
    color: var(--pc-accent-soft);
  }

  .theme-dark .btn-lupa {
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    box-shadow: 0 0 0 2px rgba(123, 104, 238, 0.2);
  }

  .theme-dark .queue-view {
    background: var(--pc-bg);
  }

  .theme-dark .info-grid .info-item {
    border-color: var(--pc-border);
  }

  .theme-dark .report-preview-frame {
    background: #ffffff;
  }

  .theme-dark .preview-map-only {
    background: var(--pc-bg);
  }
</style>
