<script>
  import {
    toolShellHeaderAction,
    toolShellHeaderShortcut,
    toolShellSearch,
    toolShellThemeToggle,
    toolShellAddAction,
    toolShellViewToggle
  } from '../toolShellStore.js';
  import { theme } from '../themeStore.js';

  export let toolTitle = 'Ferramenta';
  export let onBackToDashboard = () => {};
  export let onOpenSettings = () => {};
  export let onSettingsHover = () => {};
  export let showSettingsButton = true;

  let searchInputEl;

  $: headerAction = $toolShellHeaderAction;
  $: searchConfig = $toolShellSearch;
  $: headerShortcut = $toolShellHeaderShortcut;
  $: viewToggle = $toolShellViewToggle;
  $: showThemeToggle = $toolShellThemeToggle;
  $: addAction = $toolShellAddAction;
  $: isDark = $theme === 'dark';

  function toggleSearch() {
    if (!searchConfig?.enabled) return;
    const nextOpen = !searchConfig.open;
    toolShellSearch.update((current) => ({
      ...(current || {}),
      open: nextOpen
    }));
    if (nextOpen) {
      queueMicrotask(() => searchInputEl?.focus());
    }
  }

  function onSearchInput(event) {
    const value = event.currentTarget.value;
    toolShellSearch.update((current) => ({
      ...(current || {}),
      value
    }));
    if (typeof searchConfig?.onInput === 'function') {
      searchConfig.onInput(value);
    }
  }

  function onSearchKeydown(event) {
    if (event.key === 'Escape') {
      toolShellSearch.update((current) => ({
        ...(current || {}),
        open: false
      }));
    }
  }
</script>

<div class="app-container" class:theme-dark={isDark}>
  <header>
    <div class="header-left">
      <button
        class="back-button"
        on:click={onBackToDashboard}
        aria-label="Voltar ao Dashboard"
        title="Voltar ao Dashboard"
        type="button"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <h1>{toolTitle}</h1>
    </div>

    <div class="header-right">
      {#if searchConfig?.enabled}
        <div class="header-search" class:open={searchConfig.open}>
          {#if searchConfig.open}
            <input
              bind:this={searchInputEl}
              class="header-search-input"
              type="search"
              value={searchConfig.value || ''}
              on:input={onSearchInput}
              on:keydown={onSearchKeydown}
              placeholder={searchConfig.placeholder || 'Pedido, cidade, motivo, projetista…'}
              aria-label="Procurar"
            />
          {/if}
          <button
            class="header-action-button"
            class:active={searchConfig.open || !!(searchConfig.value || '').trim()}
            on:click|stopPropagation={toggleSearch}
            aria-label="Procurar"
            title="Procurar"
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2.4" />
              <path d="M20 20L16.5 16.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      {/if}

      {#if headerShortcut?.onClick}
        <button
          class="header-action-button header-shortcut"
          class:active={headerShortcut.active}
          on:click|stopPropagation={headerShortcut.onClick}
          aria-label={headerShortcut.label || 'Atalho'}
          title={headerShortcut.title || headerShortcut.label || 'Atalho'}
          type="button"
          disabled={headerShortcut.disabled}
        >
          {#if headerShortcut.icon === 'viabilidade'}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10Z"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linejoin="round"
              />
              <circle cx="12" cy="11" r="2.2" fill="currentColor" />
            </svg>
          {/if}
        </button>
      {/if}

      {#if viewToggle?.onClick}
        <button
          class="header-action-button header-view-toggle"
          class:active={viewToggle.active}
          on:click|stopPropagation={viewToggle.onClick}
          aria-label={viewToggle.label || 'Alternar visualização'}
          title={viewToggle.title || viewToggle.label || 'Alternar visualização'}
          type="button"
        >
          <svg class="view-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="censup-table-icon-header" x1="4" y1="4" x2="20" y2="10" gradientUnits="userSpaceOnUse">
                <stop stop-color="#7B68EE" />
                <stop offset="1" stop-color="#6495ED" />
              </linearGradient>
            </defs>
            <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="2.2" />
            <rect x="4.2" y="4.2" width="15.6" height="5.4" rx="1.2" class="view-toggle-header" />
            <path d="M3 10.2h18" stroke="currentColor" stroke-width="2.2" />
            <path d="M8.2 10.2v10.6" stroke="currentColor" stroke-width="2.2" />
            <path d="M3 14.6h5.2" stroke="currentColor" stroke-width="2.2" />
            <path d="M8.2 14.6h12.8" stroke="currentColor" stroke-width="2.2" />
            <path d="M3 19h5.2" stroke="currentColor" stroke-width="2.2" />
            <path d="M8.2 19h12.8" stroke="currentColor" stroke-width="2.2" />
          </svg>
        </button>
      {/if}

      {#if showThemeToggle}
        <button
          class="header-action-button theme-toggle"
          on:click|stopPropagation={() => theme.toggle()}
          aria-label={isDark ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
          title={isDark ? 'Tema claro' : 'Tema escuro'}
          type="button"
        >
          {#if isDark}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2.2" />
              <path
                d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.05 5.05l1.55 1.55M17.4 17.4l1.55 1.55M5.05 18.95l1.55-1.55M17.4 6.6l1.55-1.55"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
              />
            </svg>
          {:else}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M20.2 14.2A7.8 7.8 0 0 1 9.8 3.8 7.9 7.9 0 1 0 20.2 14.2Z"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linejoin="round"
              />
            </svg>
          {/if}
        </button>
      {/if}

      {#if addAction?.onClick}
        <button
          class="header-action-button header-add"
          class:active={addAction.active}
          on:click|stopPropagation={addAction.onClick}
          aria-label={addAction.label || 'Adicionar'}
          title={addAction.title || addAction.label || 'Adicionar'}
          type="button"
          disabled={addAction.disabled}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r="8.2"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-dasharray="46 6"
              stroke-dashoffset="2"
              stroke-linecap="round"
            />
            <path d="M12 8.2v7.6M8.2 12h7.6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </button>
      {/if}

      {#if headerAction?.onClick}
        <button
          class="header-action-button"
          on:click|stopPropagation={headerAction.onClick}
          disabled={headerAction.disabled || headerAction.spinning}
          aria-label={headerAction.label || 'Atualizar'}
          title={headerAction.label || 'Atualizar'}
          type="button"
        >
          <span class="header-refresh-icon" class:spinning={headerAction.spinning}>↻</span>
        </button>
      {:else if showSettingsButton}
        <button
          class="settings-button"
          on:click|stopPropagation={onOpenSettings}
          on:mouseenter={onSettingsHover}
          aria-label="Configurações"
          title="Configurações"
          type="button"
        >
          ⚙️
        </button>
      {/if}
    </div>
  </header>

  <div class="main-content">
    <slot />
  </div>
</div>

<style>
  .app-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100%;
    overflow: hidden;
  }

  header {
    background: linear-gradient(135deg, #7B68EE 0%, #6B5BEE 100%);
    color: white;
    padding: 1rem 1.5rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    z-index: 100;
    position: relative;
    gap: 1rem;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-width: 0;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .back-button {
    background: rgba(255, 255, 255, 0.2);
    border: none;
    border-radius: 8px;
    padding: 0.5rem;
    cursor: pointer;
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  }

  .back-button:hover {
    background: rgba(255, 255, 255, 0.3);
    transform: translateX(-2px);
  }

  .back-button:active {
    transform: translateX(0);
  }

  header h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
    color: white;
  }

  .header-search {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .header-search-input {
    width: min(280px, 42vw);
    height: 36px;
    border: none;
    border-radius: 8px;
    padding: 0 0.75rem;
    font-size: 0.9rem;
    color: #1f2937;
    background: rgba(255, 255, 255, 0.95);
    outline: none;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.12);
  }

  .header-search-input::placeholder {
    color: #9ca3af;
  }

  .settings-button,
  .header-action-button {
    background: none;
    border: none;
    color: white;
    font-size: 1.5rem;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.3s ease, background 0.2s ease;
    position: relative;
    z-index: 1001;
  }

  .header-action-button {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.2);
    font-size: 1.25rem;
  }

  .header-action-button.active {
    background: rgba(255, 255, 255, 0.35);
  }

  .header-view-toggle .view-toggle-header {
    fill: url(#censup-table-icon-header);
  }

  .header-view-toggle.active .view-toggle-header {
    fill: #ffffff;
  }

  .header-action-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.3);
  }

  .header-action-button:disabled {
    opacity: 0.65;
    cursor: default;
  }

  .header-refresh-icon {
    display: inline-block;
    line-height: 1;
  }

  .header-refresh-icon.spinning {
    animation: headerSpin 0.8s linear infinite;
  }

  @keyframes headerSpin {
    to {
      transform: rotate(360deg);
    }
  }

  .settings-button:hover,
  .settings-button:active {
    animation: rotateOnce 0.5s ease-in-out;
  }

  @keyframes rotateOnce {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(45deg);
    }
  }

  .main-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    position: relative;
    background: transparent;
  }

  .app-container.theme-dark .main-content {
    background: #0b1220;
  }

  /* Header dark — mesma paleta da extensão (.censup-theme-dark .censup-panel-header) */
  .app-container.theme-dark header {
    background: linear-gradient(135deg, #3b2f8a 0%, #3647a0 55%, #3a5bb8 100%);
    border-bottom: 2px solid #5b4cdb;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    color: #ffffff;
  }

  .app-container.theme-dark .back-button {
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.22);
  }

  .app-container.theme-dark .back-button:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .app-container.theme-dark .header-action-button,
  .app-container.theme-dark .settings-button {
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.22);
    color: #ffffff;
  }

  .app-container.theme-dark .header-action-button.active {
    background: rgba(255, 255, 255, 0.22);
  }

  .app-container.theme-dark .header-action-button:hover:not(:disabled),
  .app-container.theme-dark .settings-button:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .app-container.theme-dark .header-search-input {
    background: #1e293b;
    color: #e2e8f0;
    border: 1px solid #334155;
    box-shadow: none;
  }

  .app-container.theme-dark .header-search-input::placeholder {
    color: #94a3b8;
  }

  @media (max-width: 768px) {
    header {
      padding: 0.75rem 1rem;
    }

    header h1 {
      font-size: 1.25rem;
    }

    .back-button,
    .settings-button {
      padding: 0.4rem;
    }

    .header-search-input {
      width: min(180px, 40vw);
    }
  }
</style>
