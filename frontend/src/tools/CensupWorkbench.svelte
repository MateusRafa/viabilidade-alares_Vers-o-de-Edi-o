<script>
  import { onMount, onDestroy } from 'svelte';
  import {
    analisarPortalCensupChamado,
    fetchPortalCensupChamadoById,
    fetchTabulacoesList
  } from './portalCensupApi.js';
  import { getApiUrl } from '../config.js';

  // Import dinâmico — evita ciclo com registry/Config no bundle principal
  let ViabilidadeAlares = null;
  let viabilidadeRef = null;

  const MSG_SOURCE = 'censup-workbench';
  const PARENT_SOURCE = 'censup-extension';

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
  let formMinimized = false;
  /** Coords da casinha (mapa) — evita re-geocode por texto ao sync do form. */
  let pinCoords = null;
  let reanaliseTimer = null;
  let reanalyzing = false;

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

  $: mapAddress = form.enderecoCompleto || chamado?.endereco?.completo || '';
  $: originalMapAddress = chamado?.endereco?.completo || '';
  // Edição manual do texto (sem pin da casinha) → geocode por endereço
  $: addressWasEdited =
    pinCoords == null &&
    !!(form.enderecoCompleto || '').trim() &&
    (form.enderecoCompleto || '').trim() !== (originalMapAddress || '').trim();
  $: mapLat =
    pinCoords?.lat ??
    (addressWasEdited ? null : chamado?.localizacao?.lat ?? chamado?.mapaCoords?.lat ?? null);
  $: mapLng =
    pinCoords?.lng ??
    (addressWasEdited ? null : chamado?.localizacao?.lng ?? chamado?.mapaCoords?.lng ?? null);

  function formatCoords(lat, lng) {
    if (lat == null || lng == null || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) {
      return '';
    }
    return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
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
    form = {
      numeroALA: String(item?.pedido || '').replace(/\D/g, ''),
      cidade: end.cidade || item?.cidade || '',
      enderecoCompleto: end.completo || '',
      numeroEndereco: end.numero || '',
      cep: end.cep || '',
      coordenadas: coords ? formatCoords(coords.lat, coords.lng) : form.coordenadas || '',
      tabulacaoFinal: item?.tabulacaoFinal || '',
      projetista: usuario || item?.viabilidadeResumo?.projetista || ''
    };
    if (coords) pinCoords = coords;
    sugeridaOriginal = item?.tabulacaoFinal || item?.analiseIa?.tabulacaoSugerida || '';
  }

  /** Usuário digitou no endereço — solta o pin para o mapa poder geocodificar o texto. */
  function onEnderecoManualInput() {
    pinCoords = null;
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

    if (address.enderecoCompleto) {
      form.enderecoCompleto = address.enderecoCompleto;
    }
    if (address.cidade) {
      form.cidade = address.cidade;
    }
    if (address.numero) {
      form.numeroEndereco = address.numero;
    }
    // CEP do geocode do mapa (mais confiável que o da Agenda)
    if (address.cep) {
      form.cep = address.cep;
    }

    form = form; // reatividade
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

  async function loadChamado(id) {
    loading = true;
    error = '';
    pinCoords = null;
    statusMsg = 'Carregando chamado…';
    try {
      chamado = await fetchPortalCensupChamadoById(usuario, id);
      fillFormFromChamado(chamado);
      statusMsg = 'Analisando tabulação…';
      try {
        const analyzed = await analisarPortalCensupChamado(usuario, id, { force: false });
        if (analyzed?.chamado) {
          chamado = analyzed.chamado;
          fillFormFromChamado(chamado);
        }
      } catch (analyzeErr) {
        console.warn('[Workbench] Análise:', analyzeErr?.message || analyzeErr);
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
      statusMsg = 'Pronto para revisar';
      postToParent('READY', { chamadoId: chamado.id, pedido: chamado.pedido });
    } catch (err) {
      error = err?.message || String(err);
      statusMsg = '';
      postToParent('ERROR', { error });
    } finally {
      loading = false;
    }
  }

  async function applyInitPayload(payload = {}) {
    usuario = String(payload.usuario || '').trim();
    chamadoId = String(payload.chamadoId || payload.id || '').trim();

    if (payload.seed) {
      const seed = payload.seed;
      form = {
        numeroALA: String(seed.pedido || seed.numeroALA || '').replace(/\D/g, ''),
        cidade: seed.cidade || '',
        enderecoCompleto: seed.enderecoCompleto || seed.endereco?.completo || '',
        numeroEndereco: seed.numeroEndereco || seed.endereco?.numero || '',
        cep: seed.cep || seed.endereco?.cep || '',
        coordenadas: form.coordenadas || '',
        tabulacaoFinal: seed.tabulacaoFinal || '',
        projetista: usuario || seed.projetista || ''
      };
    }

    if (!usuario) {
      error = 'Informe o usuário no painel da extensão.';
      loading = false;
      statusMsg = 'Aguardando usuário…';
      return;
    }

    if (chamadoId) {
      await loadChamado(chamadoId);
      return;
    }

    loading = false;
    chamado = null;
    error = '';
    statusMsg = 'Aguardando sincronização de um chamado…';
  }

  function buildReportPayload() {
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
      projetista: form.projetista.trim(),
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
    if (!chamadoId) {
      error = 'Chamado não carregado.';
      return;
    }
    if (!viabilidadeRef || typeof viabilidadeRef.generateWorkbenchReport !== 'function') {
      error = 'Mapa ainda carregando. Aguarde a localização e tente de novo.';
      return;
    }
    generating = true;
    error = '';
    statusMsg = 'Capturando mapa e gerando PDF…';
    try {
      await viabilidadeRef.generateWorkbenchReport(buildReportPayload());
      statusMsg = 'PDF gerado (modelo Viabilidade Alares)';
      postToParent('REPORT_GENERATED', { chamadoId });
    } catch (err) {
      error = err?.message || String(err);
      statusMsg = '';
    } finally {
      generating = false;
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

  function onMessage(event) {
    const data = event?.data;
    if (!data || data.source !== PARENT_SOURCE) return;
    if (data.type === 'INIT' || data.type === 'LOAD') {
      applyInitPayload(data);
    }
  }

  onMount(async () => {
    window.addEventListener('message', onMessage);
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

    // Bootstrap via query (fallback sem postMessage)
    const params = new URLSearchParams(window.location.search);
    const qUser = params.get('usuario') || '';
    const qId = params.get('chamadoId') || params.get('id') || '';
    if (qUser || qId) {
      await applyInitPayload({ usuario: qUser, chamadoId: qId });
    } else {
      loading = false;
      statusMsg = 'Aguardando dados da extensão…';
      postToParent('HELLO');
    }
  });

  onDestroy(() => {
    window.removeEventListener('message', onMessage);
    if (reanaliseTimer) clearTimeout(reanaliseTimer);
  });
</script>

<div class="workbench">
  {#if error}
    <p class="wb-error" role="alert">{error}</p>
  {/if}

  <div class="wb-body">
    <aside class="wb-form-pane" class:minimized={formMinimized}>
      <div class="wb-form-toolbar">
        <span class="wb-form-toolbar-title">Informações</span>
        <button
          type="button"
          class="wb-pane-toggle"
          on:click={() => {
            formMinimized = !formMinimized;
            // Dá tempo ao layout redimensionar e pede resize do mapa embutido
            setTimeout(() => {
              try {
                window.dispatchEvent(new Event('resize'));
              } catch {
                // ignore
              }
            }, 120);
          }}
          title={formMinimized ? 'Expandir formulário' : 'Minimizar formulário'}
          aria-label={formMinimized ? 'Expandir formulário' : 'Minimizar formulário'}
        >
          {formMinimized ? '▾' : '▴'}
        </button>
      </div>
      {#if !formMinimized}
      <form class="wb-form" on:submit|preventDefault={salvarRelatorio}>
        <label>
          <span>1. Número do ALA</span>
          <input bind:value={form.numeroALA} inputmode="numeric" placeholder="Digite apenas números" />
        </label>
        <label>
          <span>2. Cidade</span>
          <input bind:value={form.cidade} />
        </label>
        <label>
          <span>3. Endereço Completo</span>
          <input bind:value={form.enderecoCompleto} on:input={onEnderecoManualInput} />
        </label>
        <label>
          <span>4. Número do Endereço</span>
          <input bind:value={form.numeroEndereco} />
        </label>
        <label>
          <span>5. CEP do Endereço</span>
          <input bind:value={form.cep} placeholder="Preenchido pelo mapa quando disponível" />
        </label>
        <label>
          <span>6. Coordenadas (Lat/Lon)</span>
          <input bind:value={form.coordenadas} readonly placeholder="Ajuste a casinha no mapa" />
        </label>
        <label>
          <span>7. Tabulação Final</span>
          <select bind:value={form.tabulacaoFinal}>
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
        </label>
        <label>
          <span>8. Projetista</span>
          <input bind:value={form.projetista} readonly />
        </label>

        <div class="wb-actions">
          <button type="button" class="btn-secondary" on:click={gerarRelatorio} disabled={generating || loading || !chamadoId}>
            {generating ? 'Gerando…' : 'Gerar Relatório'}
          </button>
          <button type="submit" class="btn-primary" disabled={saving || loading || !chamadoId}>
            {saving ? 'Salvando…' : 'Salvar Relatório'}
          </button>
        </div>
      </form>
      {/if}
    </aside>

    <section class="wb-map-pane">
      {#if loading}
        <div class="wb-map-placeholder">Carregando mapa…</div>
      {:else if mapAddress || (mapLat != null && mapLng != null)}
        {#key chamadoId || 'sem-chamado'}
          <div class="wb-map-host">
            {#if ViabilidadeAlares}
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
              />
            {:else}
              <div class="wb-map-placeholder">Carregando mapa…</div>
            {/if}
          </div>
        {/key}
      {:else}
        <div class="wb-map-placeholder">
          {usuario
            ? 'Sincronize um chamado na Agenda para carregar o mapa e a tabulação aqui.'
            : 'Informe o usuário no painel ao lado para iniciar.'}
        </div>
      {/if}
    </section>
  </div>
</div>

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

  .wb-form-pane {
    flex: 0 1 auto;
    align-self: stretch;
    width: auto;
    min-width: 0;
    max-width: 100%;
    max-height: 48%;
    overflow-x: hidden;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0;
    background: #ffffff;
    border: 1px solid #d1d5db;
    border-radius: 10px;
    box-shadow: none;
    box-sizing: border-box;
  }

  .wb-form-pane.minimized {
    flex: 0 0 auto;
    max-height: none;
    overflow: hidden;
    align-items: stretch;
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

  .wb-form-pane.minimized .wb-form-toolbar {
    flex-direction: row;
    justify-content: space-between;
    width: 100%;
    max-width: 100%;
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

  .wb-form-pane.minimized .wb-form-toolbar-title {
    writing-mode: horizontal-tb;
    transform: none;
    margin-top: 0;
    letter-spacing: normal;
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

  .wb-form {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0 0.55rem 0.65rem;
  }

  .wb-form label {
    display: flex;
    flex-direction: column;
    gap: 0.18rem;
    font-size: 0.68rem;
    font-weight: 600;
    color: #374151;
  }

  .wb-form input,
  .wb-form select {
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 0.32rem 0.45rem;
    font-size: 0.75rem;
    font-weight: 500;
    line-height: 1.25;
    color: #111827;
    background: #fff;
    min-height: 1.7rem;
  }

  .wb-form input[readonly] {
    background: #f3f4f6;
  }

  .hint {
    font-size: 0.62rem;
    font-weight: 500;
    color: #7b68ee;
  }

  .wb-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.25rem;
  }

  .btn-primary,
  .btn-secondary {
    border: none;
    border-radius: 6px;
    padding: 0.4rem 0.65rem;
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
  }

  .btn-primary {
    background: #6495ed;
    color: #fff;
  }

  .btn-primary:disabled,
  .btn-secondary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: #e5e7eb;
    color: #374151;
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
