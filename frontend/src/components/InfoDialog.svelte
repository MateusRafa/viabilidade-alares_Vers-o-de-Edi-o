<script>
  import { createEventDispatcher } from 'svelte';

  export let open = false;
  export let title = 'Informação';
  export let message = '';
  /** Botão único (modo legado). Ignorado se secondaryLabel e primaryLabel estiverem definidos. */
  export let okLabel = 'OK';
  export let secondaryLabel = '';
  export let primaryLabel = '';

  const dispatch = createEventDispatcher();

  $: dualActions = !!(secondaryLabel && primaryLabel);

  function handleOk() {
    dispatch('close');
  }

  function handleSecondary() {
    dispatch('secondary');
  }

  function handlePrimary() {
    dispatch('primary');
  }
</script>

{#if open}
  <div class="info-overlay" role="presentation">
    <div
      class="info-box"
      role="dialog"
      aria-modal="true"
      aria-labelledby="info-dialog-title"
      aria-describedby="info-dialog-message"
    >
      <header class="info-header">
        <h2 id="info-dialog-title">{title}</h2>
      </header>

      <div class="info-body">
        <p id="info-dialog-message">{message}</p>
      </div>

      <footer class="info-footer" class:info-footer--dual={dualActions}>
        {#if dualActions}
          <button type="button" class="btn-secondary" on:click={handleSecondary}>
            {secondaryLabel}
          </button>
          <button type="button" class="btn-primary" on:click={handlePrimary}>
            {primaryLabel}
          </button>
        {:else}
          <button type="button" class="btn-primary" on:click={handleOk}>
            {okLabel}
          </button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .info-overlay {
    position: fixed;
    inset: 0;
    z-index: 10001;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.25rem;
    background: rgba(15, 23, 42, 0.55);
    animation: infoFadeIn 0.2s ease;
  }

  @keyframes infoFadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .info-box {
    width: 100%;
    max-width: 580px;
    background: white;
    border-radius: 14px;
    overflow: hidden;
    box-shadow:
      0 20px 50px rgba(0, 0, 0, 0.25),
      0 0 0 1px rgba(123, 104, 238, 0.12);
    animation: infoSlideUp 0.25s ease;
  }

  @keyframes infoSlideUp {
    from {
      opacity: 0;
      transform: translateY(16px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .info-header {
    padding: 1.35rem 1.6rem;
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    color: white;
  }

  .info-header h2 {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 700;
    line-height: 1.35;
  }

  .info-body {
    padding: 1.65rem 1.6rem 0.85rem;
  }

  .info-body p {
    margin: 0;
    font-size: 1.05rem;
    line-height: 1.65;
    color: #374151;
    white-space: pre-line;
  }

  .info-footer {
    display: flex;
    justify-content: flex-end;
    padding: 1.15rem 1.6rem 1.5rem;
  }

  .info-footer--dual {
    flex-wrap: wrap;
    gap: 0.85rem;
  }

  .btn-secondary,
  .btn-primary {
    padding: 0.8rem 1.4rem;
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: filter 0.15s ease, background 0.15s ease, border-color 0.15s ease;
  }

  .btn-secondary {
    border: 1px solid #d1d5db;
    background: white;
    color: #4b5563;
  }

  .btn-secondary:hover {
    background: #f9fafb;
    border-color: #9ca3af;
  }

  .btn-primary {
    border: none;
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    color: white;
    box-shadow: 0 4px 12px rgba(123, 104, 238, 0.35);
  }

  .btn-primary:hover {
    filter: brightness(1.06);
  }
</style>
