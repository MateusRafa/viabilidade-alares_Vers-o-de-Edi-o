<script>
  /** @type {Array<{ id: string, titulo?: string, clienteProjeto?: string, cidade?: string, status: string, statusLabel?: string }>} */
  export let relatorios = [];
  export let searchQuery = '';
  /** @type {(item: object) => void} */
  export let onEditar = null;
  /** @type {(item: object) => void} */
  export let onImprimir = null;
  /** @type {(item: object) => void} */
  export let onTransferir = null;
  /** @type {(item: object) => void} */
  export let onFinalizar = null;
  /** @type {(item: object) => void} */
  export let onExcluir = null;

  const STATUS_SECTIONS = [
    {
      status: 'em_analise',
      title: 'Em Análise',
      emptyText: 'Nenhum relatório em análise no momento.'
    },
    {
      status: 'em_implantacao',
      title: 'Em Implantação',
      emptyText: 'Nenhum relatório em implantação no momento.'
    },
    {
      status: 'finalizado',
      title: 'Projetos Finalizados',
      emptyText: 'Nenhum projeto finalizado ainda.'
    }
  ];

  let openMenuId = null;
  let transferSubmenuOpen = false;

  function filterRelatorios(items, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const haystack = [item.titulo, item.clienteProjeto, item.cidade, item.projetista, item.statusLabel]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  function podeEditar(item) {
    return item.status === 'em_analise';
  }

  function podeTransferirOuFinalizar(item) {
    return item.status === 'em_analise';
  }

  function podeFinalizarDireto(item) {
    return item.status === 'em_implantacao';
  }

  function toggleMenu(itemId, event) {
    event?.stopPropagation();
    if (openMenuId === itemId) {
      closeMenu();
      return;
    }
    openMenuId = itemId;
    transferSubmenuOpen = false;
  }

  function closeMenu() {
    openMenuId = null;
    transferSubmenuOpen = false;
  }

  function toggleTransferSubmenu(event) {
    event?.stopPropagation();
    transferSubmenuOpen = !transferSubmenuOpen;
  }

  function handleEditar(item, event) {
    event?.stopPropagation();
    closeMenu();
    onEditar?.(item);
  }

  function handleImprimir(item, event) {
    event?.stopPropagation();
    closeMenu();
    onImprimir?.(item);
  }

  function handleTransferir(item, event) {
    event?.stopPropagation();
    closeMenu();
    onTransferir?.(item);
  }

  function handleFinalizar(item, event) {
    event?.stopPropagation();
    closeMenu();
    onFinalizar?.(item);
  }

  function handleExcluir(item, event) {
    event?.stopPropagation();
    closeMenu();
    onExcluir?.(item);
  }

  $: filteredRelatorios = filterRelatorios(relatorios, searchQuery);
  $: sectionsWithItems = STATUS_SECTIONS.map((section) => ({
    ...section,
    items: filteredRelatorios.filter((item) => item.status === section.status)
  }));
  $: hasSearch = !!(searchQuery || '').trim();
</script>

<svelte:window on:click={closeMenu} />

<div class="status-quadros-grid" role="region" aria-label="Relatórios por status">
  {#each sectionsWithItems as section (section.status)}
    <section
      class="status-quadro"
      class:status-quadro--analise={section.status === 'em_analise'}
      class:status-quadro--implantacao={section.status === 'em_implantacao'}
      class:status-quadro--finalizado={section.status === 'finalizado'}
      aria-labelledby="quadro-heading-{section.status}"
    >
      <header class="status-quadro-header">
        <h2 id="quadro-heading-{section.status}">{section.title}</h2>
        <span class="status-quadro-count" aria-label="{section.items.length} relatório(s)">
          {section.items.length}
        </span>
      </header>

      <div class="status-quadro-body">
        {#if section.items.length === 0}
          <div class="empty-state" role="status">
            {#if hasSearch}
              <p>Nenhum resultado em &ldquo;{searchQuery.trim()}&rdquo;.</p>
            {:else}
              <p>{section.emptyText}</p>
            {/if}
          </div>
        {:else}
          <ul class="relatorio-list">
            {#each section.items as item (item.id)}
              <li class="relatorio-card">
                <div class="relatorio-card-main">
                  <span class="relatorio-titulo">{item.clienteProjeto || 'Sem cliente / projeto'}</span>
                  <span class="relatorio-meta">{item.cidade || '—'}</span>
                </div>

                <div class="relatorio-card-actions">
                  <button
                    type="button"
                    class="btn-card-menu"
                    aria-label="Ações do relatório"
                    aria-haspopup="menu"
                    aria-expanded={openMenuId === item.id}
                    on:click={(e) => toggleMenu(item.id, e)}
                  >
                    <span class="btn-card-menu-icon" aria-hidden="true">⋮</span>
                  </button>

                  {#if openMenuId === item.id}
                    <div class="card-menu" role="menu" on:click|stopPropagation>
                        {#if podeEditar(item)}
                          <button
                            type="button"
                            class="card-menu-item"
                            role="menuitem"
                            on:click={(e) => handleEditar(item, e)}
                          >
                            Editar
                          </button>
                        {/if}

                        {#if podeTransferirOuFinalizar(item)}
                          <div class="card-menu-group">
                            <button
                              type="button"
                              class="card-menu-item card-menu-item--has-sub"
                              role="menuitem"
                              aria-expanded={transferSubmenuOpen}
                              on:click={toggleTransferSubmenu}
                            >
                              Transferir
                              <span class="sub-chevron" aria-hidden="true">›</span>
                            </button>
                            {#if transferSubmenuOpen}
                              <div class="card-submenu" role="menu">
                                <button
                                  type="button"
                                  class="card-menu-item card-menu-item--sub"
                                  role="menuitem"
                                  on:click={(e) => handleTransferir(item, e)}
                                >
                                  Transferir
                                </button>
                                <button
                                  type="button"
                                  class="card-menu-item card-menu-item--sub"
                                  role="menuitem"
                                  on:click={(e) => handleFinalizar(item, e)}
                                >
                                  Finalizar
                                </button>
                              </div>
                            {/if}
                          </div>
                        {:else if podeFinalizarDireto(item)}
                          <button
                            type="button"
                            class="card-menu-item"
                            role="menuitem"
                            on:click={(e) => handleFinalizar(item, e)}
                          >
                            Finalizar
                          </button>
                        {/if}

                        <button
                          type="button"
                          class="card-menu-item"
                          role="menuitem"
                          on:click={(e) => handleImprimir(item, e)}
                        >
                          Imprimir
                        </button>

                        <button
                          type="button"
                          class="card-menu-item card-menu-item--danger"
                          role="menuitem"
                          on:click={(e) => handleExcluir(item, e)}
                        >
                          Excluir
                        </button>
                    </div>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
  {/each}
</div>

<style>
  .status-quadros-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem;
    overflow: hidden;
  }

  .status-quadro {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: white;
    border-radius: 12px;
    border: 1px solid rgba(123, 104, 238, 0.2);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.04);
    overflow: hidden;
  }

  .status-quadro-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid #e5e7eb;
    flex-shrink: 0;
    background: linear-gradient(135deg, #fafbff 0%, #f5f3ff 100%);
  }

  .status-quadro--analise .status-quadro-header {
    border-bottom-color: #fcd34d;
    background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
  }

  .status-quadro--implantacao .status-quadro-header {
    border-bottom-color: #93c5fd;
    background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
  }

  .status-quadro--finalizado .status-quadro-header {
    border-bottom-color: #6ee7b7;
    background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%);
  }

  .status-quadro-header h2 {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 700;
    color: #4c1d95;
    line-height: 1.3;
  }

  .status-quadro--analise .status-quadro-header h2 {
    color: #92400e;
  }

  .status-quadro--implantacao .status-quadro-header h2 {
    color: #1d4ed8;
  }

  .status-quadro--finalizado .status-quadro-header h2 {
    color: #047857;
  }

  .status-quadro-count {
    flex-shrink: 0;
    min-width: 1.5rem;
    padding: 0.15rem 0.45rem;
    font-size: 0.75rem;
    font-weight: 700;
    text-align: center;
    border-radius: 999px;
    background: rgba(123, 104, 238, 0.12);
    color: #5b21b6;
  }

  .status-quadro--analise .status-quadro-count {
    background: rgba(146, 64, 14, 0.12);
    color: #92400e;
  }

  .status-quadro--implantacao .status-quadro-count {
    background: rgba(29, 78, 216, 0.12);
    color: #1d4ed8;
  }

  .status-quadro--finalizado .status-quadro-count {
    background: rgba(4, 120, 87, 0.12);
    color: #047857;
  }

  .status-quadro-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.25rem 1rem;
    text-align: center;
    color: #6b7280;
  }

  .empty-state p {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.45;
  }

  .relatorio-list {
    list-style: none;
    margin: 0;
    padding: 0.5rem;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .relatorio-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.55rem;
    padding: 0.65rem 0.75rem;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
    background: #fafbff;
    margin-bottom: 0.45rem;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .relatorio-card:last-child {
    margin-bottom: 0;
  }

  .relatorio-card:hover {
    border-color: rgba(123, 104, 238, 0.35);
    box-shadow: 0 2px 8px rgba(123, 104, 238, 0.08);
  }

  .relatorio-card-actions {
    position: relative;
    grid-column: 2;
    grid-row: 1;
    flex-shrink: 0;
    justify-self: end;
  }

  .btn-card-menu {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    color: #6b7280;
    cursor: pointer;
    line-height: 1;
    transition: color 0.15s ease;
  }

  .btn-card-menu:hover,
  .btn-card-menu[aria-expanded='true'] {
    background: transparent;
    color: #5b21b6;
  }

  .btn-card-menu-icon {
    font-size: 1.25rem;
    font-weight: 700;
    line-height: 1;
    transform: translateY(-1px);
  }

  .card-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    left: auto;
    z-index: 50;
    min-width: 13rem;
    padding: 0.5rem 0;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
  }

  .card-menu-group {
    position: relative;
  }

  .card-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.7rem 1.15rem;
    border: none;
    background: transparent;
    color: #1f2937;
    font-size: 0.95rem;
    font-weight: 500;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .card-menu-item:hover {
    background: #f5f3ff;
    color: #5b21b6;
  }

  .card-menu-item--has-sub .sub-chevron {
    margin-left: 0.85rem;
    color: #9ca3af;
    font-size: 1.05rem;
  }

  .card-submenu {
    padding: 0.35rem 0 0.45rem;
    border-top: 1px solid #f3f4f6;
    background: #fafbff;
  }

  .card-menu-item--sub {
    padding: 0.65rem 1.15rem 0.65rem 1.5rem;
    font-size: 0.9rem;
  }

  .card-menu-item--danger {
    color: #b91c1c;
    border-top: 1px solid #f3f4f6;
    margin-top: 0.15rem;
    padding-top: 0.75rem;
  }

  .card-menu-item--danger:hover {
    background: #fef2f2;
    color: #991b1b;
  }

  .relatorio-card-main {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
    grid-column: 1;
    grid-row: 1;
  }

  .relatorio-titulo {
    font-weight: 600;
    color: #1f2937;
    font-size: 0.85rem;
    word-break: break-word;
  }

  .relatorio-meta {
    font-size: 0.75rem;
    color: #6b7280;
    word-break: break-word;
  }

  @media (max-width: 1100px) {
    .status-quadros-grid {
      grid-template-columns: 1fr;
      overflow-y: auto;
    }

    .status-quadro {
      min-height: 200px;
      max-height: 280px;
    }
  }
</style>
