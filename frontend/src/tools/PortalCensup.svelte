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
  const pageSize = 50;

  // Portal = arquivo de chamados finalizados (Salvar Relatório / Gerar PDF)
  let listView = 'resolvidos';
  let chamados = [];
  let total = 0;
  let totalPages = 1;
  let page = 1;
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

  $: showingDetail = !!selectedChamado;
  $: isDark = $theme === 'dark';

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
      totalPages = data.totalPages || 1;

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
    if (nextPage < 1 || nextPage > totalPages) return;
    page = nextPage;
    carregarChamados();
  }

  function statusLabel(status) {
    if (status === 'aprovada') return 'Aprovada';
    if (status === 'corrigida') return 'Corrigida';
    if (status === 'aguardando_analise') return 'Aguardando análise';
    return 'Finalizado';
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

  onMount(async () => {
    syncHeaderRefresh();
    syncHeaderSearch({ enabled: true });
    syncHeaderViabilidadeShortcut({ enabled: true });
    syncHeaderViewToggle();
    toolShellThemeToggle.set(true);
    await carregarChamados();

    refreshInterval = setInterval(() => {
      carregarChamados({ silent: true });
    }, REFRESH_INTERVAL_MS);
  });

  onDestroy(() => {
    if (refreshInterval) clearInterval(refreshInterval);
    if (searchTimer) clearTimeout(searchTimer);
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

      <div class="table-wrap">
        <table class="chamados-table">
          <thead>
            <tr>
              <th>UF</th>
              <th>Cidade</th>
              <th>Sistema</th>
              <th>Pedido</th>
              <th>Data Situação</th>
              <th>PDV</th>
              <th>Motivo</th>
              <th>Situação</th>
              <th class="col-action" aria-label="Ações"></th>
            </tr>
          </thead>
          <tbody>
            {#if loadingList && chamados.length === 0}
              <tr>
                <td colspan="9" class="empty-cell">Carregando chamados…</td>
              </tr>
            {:else if chamados.length === 0}
              <tr>
                <td colspan="9" class="empty-cell">
                  Nenhum relatório finalizado ainda
                </td>
              </tr>
            {:else}
              {#each chamados as item (item.id)}
                <tr>
                  <td>{cellText(item.uf)}</td>
                  <td>{cellText(item.cidade)}</td>
                  <td>{cellText(item.sistema)}</td>
                  <td>{cellText(item.pedido)}</td>
                  <td>{cellText(item.dataSituacaoLabel || item.dataSituacao)}</td>
                  <td>{cellText(item.pdv)}</td>
                  <td>{cellText(item.motivo)}</td>
                  <td>{cellText(item.situacaoLabel || item.situacao || 'Finalizado')}</td>
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

      <footer class="table-footer">
        <div class="pagination">
          <button type="button" class="btn-page" on:click={() => goToPage(page - 1)} disabled={page <= 1}>
            Anterior
          </button>
          <span class="page-indicator">{page}</span>
          <button
            type="button"
            class="btn-page"
            on:click={() => goToPage(page + 1)}
            disabled={page >= totalPages}
          >
            Próximo
          </button>
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
    gap: 0.5rem;
  }

  .btn-page {
    padding: 0.45rem 0.85rem;
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
  }

  .page-indicator {
    min-width: 2rem;
    text-align: center;
    font-weight: 600;
    color: #7b68ee;
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

  .theme-dark .detail-arquivo {
    background: #0b1220;
  }

  .theme-dark .detail-side {
    background: #111827;
    border-right-color: #1f2937;
  }

  .theme-dark .detail-preview {
    background: #0b1220;
  }

  .portal-censup.theme-dark {
    background: #0f1220;
    color: #e5e7eb;
  }

  .theme-dark .table-wrap,
  .theme-dark .search-panel,
  .theme-dark .tabulacao-box,
  .theme-dark .extension-panel {
    background: #1a1f33;
    border-color: #2d3550;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  }

  .theme-dark .panel-header,
  .theme-dark .tabulacao-box .box-header {
    background: #232a42;
    border-bottom-color: #2d3550;
  }

  .theme-dark .panel-header h2,
  .theme-dark .tabulacao-box .box-header h3 {
    color: #c4b5fd;
  }

  .theme-dark .panel-header p,
  .theme-dark .form-group {
    color: #9ca3af;
  }

  .theme-dark .form-group input,
  .theme-dark .mode-button {
    background: #232a42;
    color: #e5e7eb;
    border-color: #3b4566;
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
    background: #232a42;
  }

  .theme-dark .chamados-table th,
  .theme-dark .chamados-table td {
    border-bottom-color: #2d3550;
    color: #e5e7eb;
  }

  .theme-dark .empty-cell,
  .theme-dark .table-footer,
  .theme-dark .last-update,
  .theme-dark .extension-panel-main p,
  .theme-dark .ia-box p {
    color: #9ca3af;
  }

  .theme-dark .queue-header h2,
  .theme-dark .extension-panel-main strong,
  .theme-dark .value,
  .theme-dark .correction-form label {
    color: #f3f4f6;
  }

  .theme-dark .btn-secondary,
  .theme-dark .btn-page {
    background: #232a42;
    color: #c4b5fd;
    border-color: #4c3d99;
  }

  .theme-dark .correction-form select {
    background: #232a42;
    color: #e5e7eb;
    border-color: #3b4566;
  }

  .theme-dark .ia-box {
    background: #221d3d;
    border-color: #4c3d99;
  }

  .theme-dark .ia-box strong {
    color: #c4b5fd;
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

  .theme-dark .page-indicator {
    color: #a78bfa;
  }

  .theme-dark .extension-help code {
    background: #232a42;
  }
</style>
