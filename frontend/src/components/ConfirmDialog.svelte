<script>
  import { createEventDispatcher } from 'svelte';

  export let open = false;
  export let title = 'Confirmar';
  export let message = '';
  export let confirmLabel = 'Confirmar';
  export let cancelLabel = 'Cancelar';
  export let loading = false;

  const dispatch = createEventDispatcher();

  function handleCancel() {
    if (loading) return;
    dispatch('cancel');
  }

  function handleConfirm() {
    if (loading) return;
    dispatch('confirm');
  }
</script>

{#if open}
  <div class="confirm-overlay" role="presentation">
    <div
      class="confirm-box"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
    >
      <header class="confirm-header">
        <h2 id="confirm-dialog-title">{title}</h2>
      </header>

      <div class="confirm-body">
        <p id="confirm-dialog-message">{message}</p>
      </div>

      <footer class="confirm-footer">
        <button
          type="button"
          class="btn-cancel"
          disabled={loading}
          on:click={handleCancel}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          class="btn-confirm"
          disabled={loading}
          on:click={handleConfirm}
        >
          {loading ? 'Aguarde…' : confirmLabel}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .confirm-overlay {
    position: fixed;
    inset: 0;
    z-index: 10001;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.25rem;
    background: rgba(15, 23, 42, 0.55);
    animation: confirmFadeIn 0.2s ease;
  }

  @keyframes confirmFadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .confirm-box {
    width: 100%;
    max-width: 580px;
    background: white;
    border-radius: 14px;
    overflow: hidden;
    box-shadow:
      0 20px 50px rgba(0, 0, 0, 0.25),
      0 0 0 1px rgba(123, 104, 238, 0.12);
    animation: confirmSlideUp 0.25s ease;
  }

  @keyframes confirmSlideUp {
    from {
      opacity: 0;
      transform: translateY(16px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .confirm-header {
    padding: 1.35rem 1.6rem;
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    color: white;
  }

  .confirm-header h2 {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 700;
    line-height: 1.35;
  }

  .confirm-body {
    padding: 1.65rem 1.6rem 0.85rem;
  }

  .confirm-body p {
    margin: 0;
    font-size: 1.05rem;
    line-height: 1.65;
    color: #374151;
    white-space: pre-line;
  }

  .confirm-footer {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.85rem;
    padding: 1.15rem 1.6rem 1.5rem;
  }

  .btn-cancel,
  .btn-confirm {
    padding: 0.8rem 1.4rem;
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: filter 0.15s ease, opacity 0.15s ease;
  }

  .btn-cancel {
    border: 1px solid #d1d5db;
    background: white;
    color: #4b5563;
  }

  .btn-cancel:hover:not(:disabled) {
    background: #f9fafb;
    border-color: #9ca3af;
  }

  .btn-confirm {
    border: none;
    background: linear-gradient(135deg, #7b68ee 0%, #6495ed 100%);
    color: white;
    box-shadow: 0 4px 12px rgba(123, 104, 238, 0.35);
  }

  .btn-confirm:hover:not(:disabled) {
    filter: brightness(1.06);
  }

  .btn-cancel:disabled,
  .btn-confirm:disabled {
    opacity: 0.7;
    cursor: wait;
  }
</style>
