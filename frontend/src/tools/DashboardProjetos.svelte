<script>
  import { onMount, tick } from 'svelte';
  import Loading from '../Loading.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import RelatoriosStatusQuadros from './RelatoriosStatusQuadros.svelte';
  import {
    fetchRelatoriosB2b,
    fetchRelatorioB2bById,
    updateRelatorioB2b,
    deleteRelatorioB2b,
    notifyRelatoriosB2bAtualizados,
    applyRelatorioListAction,
    SETOR_ORIGEM,
    RELATORIO_STATUS,
    PAYLOAD_TIPO,
    subscribeRelatoriosB2bAtualizados
  } from './relatoriosB2bApi.js';
  import { runDuringTransition } from './transitionLoading.js';

  export let currentUser = '';
  export let userTipo = 'user';
  export let onBackToDashboard = () => {};
  /** Abre outra ferramenta do portal (ex.: formulario-engenharia). */
  export let onOpenTool = null;
  export let onSettingsRequest = null;
  export let onSettingsHover = null;
  /** @type {{ refreshRelatorios?: boolean, refreshKey?: number, initialRelatorios?: object[] } | null} */
  export let toolOpenOptions = null;

  const FORMULARIO_TOOL_ID = 'formulario-engenharia';
  const RETURN_TOOL_ID = 'dashboard-projetos';
  const TRANSITION_LOADING_MS = 2000;

  let searchQuery = '';
  let recentRelatorios = [];
  let showSearch = false;
  let searchInputEl;
  let isTransitionLoading = false;
  let loadingMessage = '';
  let loadingRelatorios = false;
  let loadRelatoriosError = '';
  let confirmDialogOpen = false;
  let confirmDialogLoading = false;
  /** @type {{ type: 'transferir' | 'finalizar', item: object } | null} */
  let pendingConfirmAction = null;
  let appliedRefreshKey = 0;

  $: if (
    toolOpenOptions?.refreshKey != null &&
    toolOpenOptions.refreshKey !== appliedRefreshKey
  ) {
    appliedRefreshKey = toolOpenOptions.refreshKey;
    if (toolOpenOptions.initialRelatorios) {
      recentRelatorios = toolOpenOptions.initialRelatorios;
      loadingRelatorios = false;
      loadRelatoriosError = '';
    } else {
      carregarRelatorios();
    }
  }

  const CONFIRM_CONFIG = {
    transferir: {
      title: 'Transferir para Em Implantação',
      message:
        'Transferir este relatório para Em Implantação?\n\nAs seções de Projetos continuarão editáveis. A Resoluta do Projeto e a Lista de Material Implantado serão preenchidas pelo setor de Implantação.',
      confirmLabel: 'Transferir'
    },
    finalizar: {
      title: 'Finalizar projeto',
      message: 'Finalizar este projeto?\n\nApós a finalização, não será mais possível editá-lo.',
      confirmLabel: 'Finalizar'
    },
    excluir: {
      title: 'Excluir relatório',
      message:
        'Tem certeza que deseja excluir este relatório?\n\nEsta ação não pode ser desfeita.',
      confirmLabel: 'Excluir'
    }
  };

  $: confirmDialogConfig = pendingConfirmAction
    ? CONFIRM_CONFIG[pendingConfirmAction.type]
    : null;

  async function carregarRelatorios({ silent = false } = {}) {
    if (!(currentUser || '').trim()) {
      recentRelatorios = [];
      return;
    }

    if (!silent) {
      loadingRelatorios = true;
      loadRelatoriosError = '';
    }

    try {
      recentRelatorios = await fetchRelatoriosB2b(currentUser, {
        setorOrigem: SETOR_ORIGEM.PROJETOS,
        limit: 100
      });
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('Rota não encontrada') || msg.includes('404')) {
        if (!silent) {
          recentRelatorios = [];
          loadRelatoriosError = '';
        }
      } else if (!silent) {
        loadRelatoriosError = msg || 'Não foi possível carregar os relatórios.';
        recentRelatorios = [];
      }
    } finally {
      if (!silent) loadingRelatorios = false;
    }
  }

  async function abrirFormularioPdf() {
    if (isTransitionLoading) return;

    if (typeof onOpenTool !== 'function') {
      alert('Não foi possível abrir o formulário. Recarregue a página e tente novamente.');
      return;
    }

    isTransitionLoading = true;
    loadingMessage = 'Abrindo Relatório Técnico…';
    try {
      await tick();
      await new Promise((resolve) => setTimeout(resolve, TRANSITION_LOADING_MS));
      onOpenTool(FORMULARIO_TOOL_ID, { returnTo: RETURN_TOOL_ID });
    } finally {
      isTransitionLoading = false;
    }
  }

  async function abrirRelatorioComLoading(item, { mode = 'edit', loadingText = 'Abrindo relatório…' } = {}) {
    if (isTransitionLoading) return;

    if (typeof onOpenTool !== 'function') {
      alert('Não foi possível abrir o formulário. Recarregue a página e tente novamente.');
      return;
    }

    isTransitionLoading = true;
    loadingMessage = loadingText;
    await tick();

    try {
      const prefetchedRelatorio = await runDuringTransition(
        () =>
          fetchRelatorioB2bById(currentUser, item.id, {
            payloadTipo: PAYLOAD_TIPO.PROJETOS
          }),
        TRANSITION_LOADING_MS
      );

      onOpenTool(FORMULARIO_TOOL_ID, {
        returnTo: RETURN_TOOL_ID,
        relatorioId: item.id,
        mode,
        prefetchedRelatorio
      });
    } catch (err) {
      alert(err?.message || 'Não foi possível carregar o relatório.');
    } finally {
      isTransitionLoading = false;
    }
  }

  function handleEditarRelatorio(item) {
    abrirRelatorioComLoading(item, { mode: 'edit', loadingText: 'Abrindo relatório…' });
  }

  function handleImprimirRelatorio(item) {
    abrirRelatorioComLoading(item, { mode: 'print', loadingText: 'Preparando impressão…' });
  }

  function openConfirmDialog(type, item) {
    pendingConfirmAction = { type, item };
    confirmDialogOpen = true;
  }

  function closeConfirmDialog() {
    if (confirmDialogLoading) return;
    confirmDialogOpen = false;
    pendingConfirmAction = null;
  }

  async function handleConfirmDialogAction() {
    if (!pendingConfirmAction || confirmDialogLoading) return;

    const { type, item } = pendingConfirmAction;
    confirmDialogLoading = true;

    try {
      if (type === 'transferir') {
        await updateRelatorioB2b(currentUser, item.id, {
          status: RELATORIO_STATUS.EM_IMPLANTACAO,
          setorOrigem: SETOR_ORIGEM.IMPLANTACAO
        });
        notifyRelatoriosB2bAtualizados();
      } else if (type === 'finalizar') {
        await updateRelatorioB2b(currentUser, item.id, {
          status: RELATORIO_STATUS.FINALIZADO,
          setorOrigem:
            item.status === RELATORIO_STATUS.EM_IMPLANTACAO
              ? SETOR_ORIGEM.IMPLANTACAO
              : SETOR_ORIGEM.PROJETOS
        });
        notifyRelatoriosB2bAtualizados();
      } else if (type === 'excluir') {
        await deleteRelatorioB2b(currentUser, item.id);
        notifyRelatoriosB2bAtualizados();
      }

      recentRelatorios = applyRelatorioListAction(recentRelatorios, type, item);
      confirmDialogOpen = false;
      pendingConfirmAction = null;
      void carregarRelatorios({ silent: true });
    } catch (err) {
      alert(err?.message || 'Não foi possível concluir a ação.');
    } finally {
      confirmDialogLoading = false;
    }
  }

  function handleTransferirRelatorio(item) {
    openConfirmDialog('transferir', item);
  }

  function handleFinalizarRelatorio(item) {
    openConfirmDialog('finalizar', item);
  }

  function handleExcluirRelatorio(item) {
    openConfirmDialog('excluir', item);
  }

  async function toggleSearch() {
    showSearch = !showSearch;
    if (!showSearch) {
      searchQuery = '';
      return;
    }
    await tick();
    searchInputEl?.focus();
  }

  onMount(() => {
    if (onSettingsRequest && typeof onSettingsRequest === 'function') {
      onSettingsRequest(() => {});
    }
    if (onSettingsHover && typeof onSettingsHover === 'function') {
      onSettingsHover(() => {});
    }
    if (toolOpenOptions?.initialRelatorios) {
      recentRelatorios = toolOpenOptions.initialRelatorios;
    } else {
      carregarRelatorios();
    }

    const unsubscribe = subscribeRelatoriosB2bAtualizados(() => carregarRelatorios({ silent: true }));

    return () => {
      unsubscribe();
    };
  });
</script>

<div class="relatorios-dashboard">
  <header class="dashboard-header">
    <div class="dashboard-actions">
      <button
        type="button"
        class="btn-primary"
        class:btn-primary--active={showSearch}
        on:click={toggleSearch}
        aria-expanded={showSearch}
        disabled={isTransitionLoading}
      >
        Pesquisar
      </button>
      <button
        type="button"
        class="btn-primary"
        on:click={abrirFormularioPdf}
        disabled={isTransitionLoading}
      >
        Gerar PDF
      </button>

      {#if showSearch}
        <section class="search-panel" aria-label="Pesquisar relatórios">
          <input
            bind:this={searchInputEl}
            id="search-relatorios-projetos"
            type="search"
            class="search-input"
            placeholder="Cliente, projeto, cidade, projetista…"
            bind:value={searchQuery}
            autocomplete="off"
          />
        </section>
      {/if}
    </div>
  </header>

  <div class="quadros-area">
  {#if loadRelatoriosError}
    <p class="load-error" role="alert">{loadRelatoriosError}</p>
  {:else if loadingRelatorios && recentRelatorios.length === 0}
    <p class="load-hint" role="status">Carregando relatórios…</p>
  {/if}

  <RelatoriosStatusQuadros
    relatorios={recentRelatorios}
    {searchQuery}
    onEditar={handleEditarRelatorio}
    onImprimir={handleImprimirRelatorio}
    onTransferir={handleTransferirRelatorio}
    onFinalizar={handleFinalizarRelatorio}
    onExcluir={handleExcluirRelatorio}
  />
  </div>
</div>

{#if isTransitionLoading}
  <div class="transition-loading-layer" role="status" aria-live="polite" aria-busy="true">
    <Loading currentMessage={loadingMessage} />
  </div>
{/if}

{#if confirmDialogOpen && confirmDialogConfig}
  <ConfirmDialog
    open={confirmDialogOpen}
    title={confirmDialogConfig.title}
    message={confirmDialogConfig.message}
    confirmLabel={confirmDialogConfig.confirmLabel}
    cancelLabel="Cancelar"
    loading={confirmDialogLoading}
    on:confirm={handleConfirmDialogAction}
    on:cancel={closeConfirmDialog}
  />
{/if}

<style>
  .relatorios-dashboard {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #f0f2f8;
    padding: 1.25rem 1.5rem;
    box-sizing: border-box;
    gap: 1.25rem;
  }

  .dashboard-header {
    display: flex;
    justify-content: flex-start;
    flex-shrink: 0;
  }

  .dashboard-actions {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: flex-start;
    gap: 0.65rem;
    width: 100%;
    min-width: 0;
  }

  .btn-primary {
    padding: 0.65rem 1.1rem;
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(123, 104, 238, 0.3);
    white-space: nowrap;
  }

  .btn-primary:hover {
    filter: brightness(1.06);
  }

  .btn-primary--active {
    box-shadow:
      0 4px 12px rgba(123, 104, 238, 0.35),
      inset 0 0 0 2px rgba(255, 255, 255, 0.45);
  }

  .search-panel {
    flex: 1 1 auto;
    min-width: 12rem;
    max-width: 24rem;
    display: flex;
    align-items: center;
  }

  .search-input {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 0.6rem 0.85rem;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-size: 0.95rem;
    font-family: inherit;
    background: white;
  }

  .search-input:focus {
    outline: none;
    border-color: #7b68ee;
    box-shadow: 0 0 0 3px rgba(123, 104, 238, 0.15);
  }

  .load-error {
    margin: 0;
    font-size: 0.85rem;
    color: #b91c1c;
    flex-shrink: 0;
  }

  .load-hint {
    margin: 0;
    font-size: 0.85rem;
    color: #6b7280;
    flex-shrink: 0;
  }

  .quadros-area {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    gap: 0.5rem;
  }

  .quadros-area :global(.status-quadros-grid) {
    flex: 1;
    min-height: 0;
  }

  .btn-primary:disabled {
    opacity: 0.7;
    cursor: wait;
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
