<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { Loader } from '@googlemaps/js-api-loader';
  import Loading from '../Loading.svelte';
  import { getApiUrl } from '../config.js';

  // Props do componente
  export let currentUser = '';
  export let userTipo = 'user';
  export let onBackToDashboard = () => {};
  export let onSettingsRequest = null;
  export let onSettingsHover = null;

  // Estados da ferramenta
  let isLoading = false; // Loading inicial da ferramenta (tela completa)
  let loadingMessage = '';
  let showSettingsModal = false;
  let loadingCTOs = false; // Loading específico para busca de CTOs (inline)
  let loadingDots = '.'; // Pontos animados para "Buscando..."
  let loadingDotsInterval = null; // Intervalo para animação dos pontos
  let baseDataExists = true; // Indica se a base de dados foi carregada com sucesso
  
  // Google Maps
  let map;
  let mapElement; // Referência ao elemento DOM do mapa
  let googleMapsLoaded = false;
  let mapInitialized = false;
  let isDisplayingMarkers = false; // Flag para evitar múltiplas tentativas simultâneas
  const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  let markers = []; // Array para armazenar marcadores das CTOs
  let searchMarker = null; // Marcador do ponto de busca (endereço/coordenadas)
  let mapObserver = null; // Observer para detectar quando o mapa fica visível
  
  // Modo de busca
  let searchMode = 'nome'; // 'nome', 'endereco'
  
  // Campos de busca
  let nomeCTO = '';
  let enderecoInput = '';
  
  // Resultados
  let ctos = [];
  let error = null;
  let duplicatedCTOs = []; // Array para armazenar informações sobre CTOs duplicadas (mesmo nome, diferentes caminhos)
  
  // Mapa para controlar quais CTOs estão visíveis no mapa (key: identificador único da CTO)
  let ctoVisibility = new Map(); // Map<ctoKey, boolean>
  
  // Set para armazenar as chaves das CTOs pesquisadas pelo usuário (apenas na pesquisa por nome)
  let searchedCTOKeys = new Set(); // Set<ctoKey>
  
  // Função para gerar uma chave única para uma CTO (declarada aqui para uso nos reactive statements)
  function getCTOKey(cto) {
    // Usar ID + nome + coordenadas para criar chave única
    // O ID é essencial para diferenciar CTOs com mesmo nome mas caminhos diferentes
    const id = cto.id_cto || cto.id || 'NO_ID';
    const lat = parseFloat(cto.latitude || 0).toFixed(6);
    const lng = parseFloat(cto.longitude || 0).toFixed(6);
    return `${id}_${cto.nome || 'UNKNOWN'}_${lat}_${lng}`;
  }
  
  // Função para gerar chave do caminho de rede (CIDADE|POP|CHASSE|PLACA|OLT)
  function getCaminhoRedeKey(cto) {
    const cidade = (cto.cidade || 'N/A').trim();
    const pop = (cto.pop || 'N/A').trim();
    const chasse = (cto.olt || 'N/A').trim();
    const placa = (cto.slot || 'N/A').trim();
    const olt = (cto.pon || 'N/A').trim();
    return `${cidade}|${pop}|${chasse}|${placa}|${olt}`;
  }
  
  // Map para armazenar o total de portas por caminho de rede (busca da base de dados)
  let caminhoRedeTotals = new Map();
  // Map para armazenar o total de CTOs por caminho de rede
  let caminhoRedeCTOsTotals = new Map();
  let caminhoRedeLoading = new Set(); // Caminhos que estão sendo carregados
  let caminhosCarregando = false; // Flag para indicar se ainda está carregando totais
  let calculandoTotais = false; // Flag para evitar múltiplas execuções simultâneas
  let ultimosCaminhosCalculados = new Set(); // Rastrear quais caminhos já foram calculados
  
  // ========== SISTEMA DE SELEÇÃO DE TABELA ==========
  // Estados de seleção (usando Arrays para melhor reatividade no Svelte)
  let selectedCells = []; // Array de strings "row-col" (ex: "0-2" = linha 0, coluna 2)
  let selectedRows = []; // Array de índices de linha
  let selectedColumns = []; // Array de índices de coluna
  let selectionMode = 'cell'; // 'cell', 'row', 'column'
  let selectionStart = null; // {row, col} para range selection com Shift
  let isSelecting = false; // Flag para indicar se está em processo de seleção (drag)
  
  // Variável reativa para forçar atualização quando seleção mudar
  $: selectionKey = `${selectedCells.length}-${selectedRows.length}-${selectedColumns.length}-${selectedColumns.join(',')}-${selectedRows.join(',')}`;
  
  // Função para gerar chave de célula (row-col)
  function getCellKey(rowIndex, colIndex) {
    return `${rowIndex}-${colIndex}`;
  }
  
  // Função para verificar se uma célula está selecionada
  function isCellSelected(rowIndex, colIndex) {
    // Usar selectionKey para forçar reatividade
    const _ = selectionKey;
    
    const cellKey = getCellKey(rowIndex, colIndex);
    
    // Verificar seleção direta da célula
    if (selectedCells.includes(cellKey)) {
      return true;
    }
    // Verificar se a linha inteira está selecionada
    if (selectedRows.includes(rowIndex)) {
      return true;
    }
    // Verificar se a coluna inteira está selecionada
    if (selectedColumns.includes(colIndex)) {
      return true;
    }
    return false;
  }
  
  // Função para selecionar célula única
  function selectCell(rowIndex, colIndex, addToSelection = false) {
    const cellKey = getCellKey(rowIndex, colIndex);
    
    if (!addToSelection) {
      // Limpar seleções anteriores
      selectedCells = [cellKey];
      selectedRows = [];
      selectedColumns = [];
    } else {
      // Adicionar à seleção existente
      if (!selectedCells.includes(cellKey)) {
        selectedCells = [...selectedCells, cellKey];
      }
    }
    selectionMode = 'cell';
    selectionStart = { row: rowIndex, col: colIndex };
  }
  
  // Função para selecionar linha inteira
  function selectRow(rowIndex, addToSelection = false) {
    if (!addToSelection) {
      selectedCells = [];
      selectedRows = [rowIndex];
      selectedColumns = [];
    } else {
      // Adicionar à seleção existente
      if (!selectedRows.includes(rowIndex)) {
        selectedRows = [...selectedRows, rowIndex];
      }
    }
    selectionMode = 'row';
  }
  
  // Função para selecionar coluna inteira
  function selectColumn(colIndex, addToSelection = false) {
    if (!addToSelection) {
      selectedCells = [];
      selectedRows = [];
      selectedColumns = [colIndex];
    } else {
      // Adicionar à seleção existente
      if (!selectedColumns.includes(colIndex)) {
        selectedColumns = [...selectedColumns, colIndex];
      }
    }
    selectionMode = 'column';
  }
  
  // Função para limpar todas as seleções
  function clearSelection() {
    selectedCells = [];
    selectedRows = [];
    selectedColumns = [];
    selectionStart = null;
  }
  
  // Função para selecionar range de células (Shift + Click)
  function selectRange(startRow, startCol, endRow, endCol) {
    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);
    const minCol = Math.min(startCol, endCol);
    const maxCol = Math.max(startCol, endCol);
    
    // Limpar seleções de linha/coluna quando selecionar range
    selectedRows = [];
    selectedColumns = [];
    
    // Criar array com todas as células do range
    const newSelectedCells = [];
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        newSelectedCells.push(getCellKey(row, col));
      }
    }
    
    selectedCells = newSelectedCells;
  }
  
  // Handler para click em célula
  function handleCellClick(e, rowIndex, colIndex) {
    // Encontrar o elemento TD (pode ser que o click foi em um elemento filho)
    const tdElement = e.currentTarget || e.target.closest('td');
    
    // Não processar se clicou em checkbox, input ou elementos dentro deles
    if (e.target.tagName === 'INPUT' || 
        e.target.type === 'checkbox' ||
        e.target.closest('input[type="checkbox"]') ||
        e.target.closest('span.occupation-badge')) {
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    
    if (e.shiftKey && selectionStart) {
      // Seleção de range com Shift
      selectRange(selectionStart.row, selectionStart.col, rowIndex, colIndex);
    } else if (e.ctrlKey || e.metaKey) {
      // Adicionar/remover da seleção com Ctrl/Cmd
      const cellKey = getCellKey(rowIndex, colIndex);
      
      // Limpar seleções de linha/coluna quando selecionar células individuais
      selectedRows = [];
      selectedColumns = [];
      
      if (selectedCells.includes(cellKey)) {
        // Remover da seleção
        selectedCells = selectedCells.filter(key => key !== cellKey);
      } else {
        // Adicionar à seleção
        selectedCells = [...selectedCells, cellKey];
      }
      selectionStart = { row: rowIndex, col: colIndex };
    } else {
      // Seleção simples
      selectCell(rowIndex, colIndex, false);
    }
  }
  
  // Handler para click em header de linha (se implementarmos)
  function handleRowHeaderClick(e, rowIndex) {
    e.preventDefault();
    e.stopPropagation();
    
    if (e.ctrlKey || e.metaKey) {
      // Toggle linha com Ctrl
      if (selectedRows.includes(rowIndex)) {
        selectedRows = selectedRows.filter(idx => idx !== rowIndex);
      } else {
        selectedRows = [...selectedRows, rowIndex];
      }
    } else {
      selectRow(rowIndex, false);
    }
  }
  
  // Handler para click em header de coluna
  function handleColumnHeaderClick(e, colIndex) {
    // Desativar seleção de coluna na coluna 0 (checkbox "marcar todos")
    if (colIndex === 0) {
      return; // Não fazer nada se clicar na coluna do checkbox
    }
    
    // Não processar se clicou no checkbox do header
    if (e.target.tagName === 'INPUT' || 
        e.target.type === 'checkbox' ||
        e.target.closest('input[type="checkbox"]')) {
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    
    if (e.ctrlKey || e.metaKey) {
      // Toggle coluna com Ctrl
      // Limpar seleções de células e linhas quando selecionar coluna
      selectedCells = [];
      selectedRows = [];
      
      if (selectedColumns.includes(colIndex)) {
        selectedColumns = selectedColumns.filter(idx => idx !== colIndex);
      } else {
        selectedColumns = [...selectedColumns, colIndex];
      }
    } else {
      selectColumn(colIndex, false);
    }
  }
  
  // Limpar seleção ao clicar fora da tabela
  function handleClickOutside(e) {
    if (!e.target.closest('.results-table')) {
      clearSelection();
    }
  }
  
  // Prevenir seleção de texto nativa dentro da tabela
  function preventTextSelection(e) {
    // Só prevenir se não for um input, textarea ou elemento editável
    if (e.target.tagName !== 'INPUT' && 
        e.target.tagName !== 'TEXTAREA' &&
        !e.target.closest('input') &&
        !e.target.closest('textarea') &&
        e.target.closest('.results-table')) {
      e.preventDefault();
    }
  }
  
  // Prevenir seleção via mouse drag dentro da tabela
  function preventTextSelectionDrag(e) {
    if (e.target.closest('.results-table') &&
        e.target.tagName !== 'INPUT' &&
        e.target.tagName !== 'TEXTAREA' &&
        !e.target.closest('input') &&
        !e.target.closest('textarea')) {
      // Se o usuário está arrastando para selecionar texto, prevenir
      if (e.type === 'selectstart' || (e.type === 'mousedown' && e.shiftKey)) {
        e.preventDefault();
        return false;
      }
    }
  }
  
  // Função para obter o valor de uma célula baseado em rowIndex e colIndex
  function getCellValue(rowIndex, colIndex, cto) {
    switch(colIndex) {
      case 0: return ''; // Checkbox - vazio (não copiar)
      case 1: return (ctoNumbers.get(cto) || '-').toString(); // #
      case 2: return cto.nome || ''; // CTO
      case 3: return (cto.latitude || '').toString(); // Latitude
      case 4: return (cto.longitude || '').toString(); // Longitude
      case 5: return cto.cidade || 'N/A'; // Cidade
      case 6: return cto.pop || 'N/A'; // POP
      case 7: return cto.olt || 'N/A'; // CHASSE (usa campo olt)
      case 8: return cto.slot || 'N/A'; // PLACA (usa campo slot)
      case 9: return cto.pon || 'N/A'; // OLT (usa campo pon)
      case 10: return (cto.id_cto || cto.id || 'N/A').toString(); // ID CTO
      case 11: {
        // Data de Criação - formatar se existir (formato: MM/YYYY)
        const dataCriacao = cto.data_criacao || cto.data_cadastro || cto.created_at || '';
        if (!dataCriacao) return 'N/A';
        
        // Se for string, verificar se já está no formato MM/YYYY
        if (typeof dataCriacao === 'string') {
          // Verificar se já está no formato MM/YYYY (ex: "04/2023")
          const mmYYYYMatch = dataCriacao.match(/^(\d{1,2})\/(\d{4})$/);
          if (mmYYYYMatch) {
            const mes = mmYYYYMatch[1].padStart(2, '0');
            const ano = mmYYYYMatch[2];
            return `${mes}/${ano}`;
          }
          
          // Tentar formato YYYY-MM (ex: "2023-04")
          const yyyyMMMatch = dataCriacao.match(/^(\d{4})-(\d{1,2})/);
          if (yyyyMMMatch) {
            const ano = yyyyMMMatch[1];
            const mes = yyyyMMMatch[2].padStart(2, '0');
            return `${mes}/${ano}`;
          }
          
          // Tentar formato YYYY-MM-DD (ex: "2023-04-15")
          const yyyyMMDDMatch = dataCriacao.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
          if (yyyyMMDDMatch) {
            const ano = yyyyMMDDMatch[1];
            const mes = yyyyMMDDMatch[2].padStart(2, '0');
            return `${mes}/${ano}`;
          }
          
          // Tentar formato DD/MM/YYYY (ex: "15/04/2023")
          const ddMMYYYYMatch = dataCriacao.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (ddMMYYYYMatch) {
            const mes = ddMMYYYYMatch[2].padStart(2, '0');
            const ano = ddMMYYYYMatch[3];
            return `${mes}/${ano}`;
          }
        }
        
        // Tentar converter para Date se não for string ou se não bateu com nenhum padrão
        try {
          const data = new Date(dataCriacao);
          if (!isNaN(data.getTime())) {
            // Formato: MM/YYYY (apenas mês e ano)
            const mes = String(data.getMonth() + 1).padStart(2, '0');
            const ano = data.getFullYear();
            return `${mes}/${ano}`;
          }
        } catch (e) {
          // Ignorar erro
        }
        
        // Se não conseguiu formatar, retornar como está
        return String(dataCriacao);
      }
      case 12: return (cto.vagas_total || 0).toString(); // Portas Total
      case 13: return (cto.clientes_conectados || 0).toString(); // Ocupadas
      case 14: return ((cto.vagas_total || 0) - (cto.clientes_conectados || 0)).toString(); // Disponíveis
      case 15: return `${parseFloat(cto.pct_ocup || 0).toFixed(1)}%`; // Ocupação
      case 16: return cto.status_cto || 'N/A'; // Status
      case 17: {
        const caminhoKey = getCaminhoRedeKey(cto);
        const total = caminhoRedeTotalsVersion >= 0 && caminhoRedeTotals ? (caminhoRedeTotals.get(caminhoKey) || 0) : 0;
        return total.toString(); // Total de Portas no Caminho de Rede
      }
      case 18: return getCaminhoRedeCTOsTotal(cto).toString(); // Total de CTOs no Caminho de Rede
      default: return '';
    }
  }
  
  // Função para copiar seleção para clipboard
  async function copySelectionToClipboard() {
    if (selectedCells.length === 0 && selectedColumns.length === 0 && selectedRows.length === 0) {
      console.log('⚠️ Nada selecionado para copiar');
      return; // Nada selecionado
    }
    
    console.log('📋 Copiando seleção:', {
      cells: selectedCells.length,
      columns: selectedColumns.length,
      rows: selectedRows.length,
      selectedColumns: selectedColumns,
      selectedCells: selectedCells.slice(0, 5) // Primeiros 5 para debug
    });
    
    let textToCopy = '';
    
    // Se coluna(s) inteira(s) selecionada(s)
    if (selectedColumns.length > 0) {
      // Ordenar colunas
      const sortedColumns = [...selectedColumns].sort((a, b) => a - b);
      
      // Para cada linha
      ctos.forEach((cto, rowIndex) => {
        const rowValues = [];
        sortedColumns.forEach(colIndex => {
          rowValues.push(getCellValue(rowIndex, colIndex, cto));
        });
        textToCopy += rowValues.join('\t') + '\n'; // Tab separa colunas, \n separa linhas
      });
    }
    // Se linha(s) inteira(s) selecionada(s)
    else if (selectedRows.length > 0) {
      const sortedRows = [...selectedRows].sort((a, b) => a - b);
      
      sortedRows.forEach(rowIndex => {
        const cto = ctos[rowIndex];
        if (cto) {
          const rowValues = [];
          // Copiar todas as colunas (exceto checkbox)
          for (let colIndex = 1; colIndex <= 18; colIndex++) {
            rowValues.push(getCellValue(rowIndex, colIndex, cto));
          }
          textToCopy += rowValues.join('\t') + '\n';
        }
      });
    }
    // Se células individuais selecionadas
    else if (selectedCells.length > 0) {
      // Organizar células por linha e coluna
      const cellsByRow = {};
      selectedCells.forEach(cellKey => {
        const [row, col] = cellKey.split('-').map(Number);
        if (!cellsByRow[row]) cellsByRow[row] = {};
        if (ctos[row]) {
          cellsByRow[row][col] = getCellValue(row, col, ctos[row]);
        }
      });
      
      // Ordenar linhas e colunas
      const sortedRows = Object.keys(cellsByRow).map(Number).sort((a, b) => a - b);
      
      // Encontrar todas as colunas únicas para manter alinhamento
      const allColumns = new Set();
      sortedRows.forEach(row => {
        Object.keys(cellsByRow[row]).forEach(col => allColumns.add(Number(col)));
      });
      const sortedColumns = Array.from(allColumns).sort((a, b) => a - b);
      
      // Gerar texto formatado
      sortedRows.forEach(rowIndex => {
        const rowValues = [];
        sortedColumns.forEach(colIndex => {
          rowValues.push(cellsByRow[rowIndex][colIndex] || '');
        });
        textToCopy += rowValues.join('\t') + '\n';
      });
    }
    
    // Copiar para clipboard
    if (textToCopy && textToCopy.trim()) {
      const textToCopyTrimmed = textToCopy.trim();
      console.log('📋 Texto a copiar (primeiros 200 chars):', textToCopyTrimmed.substring(0, 200));
      
      try {
        // Método moderno (requer HTTPS ou localhost)
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(textToCopyTrimmed);
          console.log('✅ Dados copiados para clipboard (método moderno)');
        } else {
          throw new Error('Clipboard API não disponível');
        }
      } catch (err) {
        console.warn('⚠️ Método moderno falhou, tentando fallback:', err);
        // Fallback para método antigo (funciona em HTTP também)
        try {
          const textArea = document.createElement('textarea');
          textArea.value = textToCopyTrimmed;
          textArea.style.position = 'fixed';
          textArea.style.top = '0';
          textArea.style.left = '0';
          textArea.style.width = '2em';
          textArea.style.height = '2em';
          textArea.style.padding = '0';
          textArea.style.border = 'none';
          textArea.style.outline = 'none';
          textArea.style.boxShadow = 'none';
          textArea.style.background = 'transparent';
          textArea.style.opacity = '0';
          textArea.style.zIndex = '-9999';
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          
          const successful = document.execCommand('copy');
          document.body.removeChild(textArea);
          
          if (successful) {
            console.log('✅ Dados copiados para clipboard (método fallback)');
          } else {
            console.error('❌ Falha ao executar execCommand("copy")');
          }
        } catch (fallbackErr) {
          console.error('❌ Erro no método fallback:', fallbackErr);
          alert('Erro ao copiar. Tente selecionar o texto manualmente.');
        }
      }
    } else {
      console.warn('⚠️ Nenhum texto para copiar');
    }
  }
  
  // Handler para Ctrl+C
  function handleCopyKeydown(e) {
    // Verificar se é Ctrl+C (ou Cmd+C no Mac)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      // Verificar se há seleção na tabela
      if (selectedCells.length > 0 || selectedColumns.length > 0 || selectedRows.length > 0) {
        // Verificar se não está em um input ou textarea (onde queremos copiar texto normal)
        const activeElement = document.activeElement;
        const isInput = activeElement?.tagName === 'INPUT' || 
                       activeElement?.tagName === 'TEXTAREA' ||
                       activeElement?.contentEditable === 'true';
        
        // Se não é um input editável, copiar nossa seleção da tabela
        if (!isInput) {
          e.preventDefault();
          e.stopPropagation();
          copySelectionToClipboard();
          return false;
        }
      }
    }
  }
  
  // ========== FIM DO SISTEMA DE SELEÇÃO ==========
  
  // Função para buscar total de portas do caminho de rede da base de dados
  async function fetchCaminhoRedeTotal(olt, slot, pon) {
    const caminhoKey = `${olt}|${slot}|${pon}`;
    
    // Se já está carregando ou já tem o valor, retornar
    if (caminhoRedeLoading.has(caminhoKey) || caminhoRedeTotals.has(caminhoKey)) {
      return caminhoRedeTotals.get(caminhoKey) || 0;
    }
    
    // Se algum valor é N/A ou vazio, não buscar
    if (!olt || !slot || !pon || olt === 'N/A' || slot === 'N/A' || pon === 'N/A' || olt.trim() === '' || slot.trim() === '' || pon.trim() === '') {
      console.warn(`⚠️ Valores inválidos para caminho de rede: olt="${olt}", slot="${slot}", pon="${pon}"`);
      return 0;
    }
    
    // Marcar como carregando
    caminhoRedeLoading.add(caminhoKey);
    
    try {
      const url = getApiUrl(`/api/ctos/caminho-rede?olt=${encodeURIComponent(olt)}&slot=${encodeURIComponent(slot)}&pon=${encodeURIComponent(pon)}`);
      console.log(`🌐 Fazendo requisição para: ${url}`);
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error(`❌ Resposta HTTP não OK: ${response.status} ${response.statusText}`);
        const errorText = await response.text();
        console.error(`Erro: ${errorText}`);
        return 0;
      }
      
      const data = await response.json();
      console.log(`📥 Resposta da API para ${olt} / ${slot} / ${pon}:`, data);
      
      if (data.success && data.total_portas !== undefined) {
        // Atualizar o Map (criar novo para garantir reatividade)
        // IMPORTANTE: Usar o Map atual para não perder valores já carregados
        const currentTotals = caminhoRedeTotals || new Map();
        const newTotals = new Map(currentTotals);
        newTotals.set(caminhoKey, data.total_portas);
        caminhoRedeTotals = newTotals;
        
        console.log(`✅ Total de portas para ${olt} / ${slot} / ${pon}: ${data.total_portas} (${data.total_ctos} CTOs)`);
        console.log(`📊 Map atualizado. Tamanho: ${caminhoRedeTotals.size}, Chaves:`, Array.from(caminhoRedeTotals.keys()));
        return data.total_portas;
      } else {
        console.warn(`⚠️ Resposta da API não tem success=true ou total_portas:`, data);
        return 0;
      }
    } catch (err) {
      console.error(`❌ Erro ao buscar total de portas para ${olt} / ${slot} / ${pon}:`, err);
      return 0;
    } finally {
      caminhoRedeLoading.delete(caminhoKey);
    }
  }
  
  // Função OTIMIZADA para calcular e buscar totais de todos os caminhos de rede únicos
  // Usa uma única requisição batch em vez de múltiplas requisições individuais
  async function calculateCaminhoRedeTotals() {
    // Evitar execuções simultâneas
    if (calculandoTotais) {
      console.log('⏸️ Cálculo já em andamento, ignorando chamada duplicada');
      return;
    }
    
    // Coletar todos os caminhos de rede únicos das CTOs
    const caminhosUnicos = new Set();
    const caminhosPorCTO = new Map(); // Para debug: rastrear qual CTO tem qual caminho
    for (const cto of ctos) {
      const caminhoKey = getCaminhoRedeKey(cto);
      const ctoId = cto.id_cto || cto.id || 'NO_ID';
      // Verificar se o caminho é válido (não é N/A e não está vazio)
      // Formato da chave: CIDADE|POP|CHASSE|PLACA|OLT (5 partes separadas por |)
      if (caminhoKey && !caminhoKey.includes('N/A') && caminhoKey !== '||||' && caminhoKey.split('|').length === 5) {
        caminhosUnicos.add(caminhoKey);
        // Rastrear qual CTO tem qual caminho (para debug)
        if (!caminhosPorCTO.has(caminhoKey)) {
          caminhosPorCTO.set(caminhoKey, []);
        }
        caminhosPorCTO.get(caminhoKey).push({ id: ctoId, nome: cto.nome });
      } else {
        console.warn(`⚠️ Caminho inválido para CTO ${ctoId} (${cto.nome}): "${caminhoKey}"`);
      }
    }
    
    console.log(`📊 Caminhos únicos coletados: ${caminhosUnicos.size}`);
    for (const [caminho, ctosList] of caminhosPorCTO.entries()) {
      console.log(`   - ${caminho}: ${ctosList.length} CTO(s) - ${ctosList.map(c => `${c.nome} (${c.id})`).join(', ')}`);
    }
    
    // Verificar se os caminhos mudaram
    const caminhosString = Array.from(caminhosUnicos).sort().join(',');
    const ultimosCaminhosString = Array.from(ultimosCaminhosCalculados).sort().join(',');
    
    if (caminhosString === ultimosCaminhosString && caminhoRedeTotals.size > 0) {
      console.log('✅ Caminhos não mudaram e já temos os valores, pulando recálculo');
      return;
    }
    
    // Marcar como calculando
    calculandoTotais = true;
    caminhosCarregando = true;
    
    // Limpar apenas os caminhos que não estão mais presentes
    const novosCaminhos = new Set(caminhosUnicos);
    const caminhosParaRemover = [];
    for (const key of caminhoRedeTotals.keys()) {
      if (!novosCaminhos.has(key)) {
        caminhosParaRemover.push(key);
      }
    }
    for (const key of caminhosParaRemover) {
      caminhoRedeTotals.delete(key);
      caminhoRedeCTOsTotals.delete(key);
    }
    
    caminhoRedeLoading.clear();
    
    console.log(`🔍 Calculando totais para ${caminhosUnicos.size} caminhos de rede únicos:`, Array.from(caminhosUnicos));
    
    if (caminhosUnicos.size === 0) {
      console.warn('⚠️ Nenhum caminho de rede válido encontrado nas CTOs');
      calculandoTotais = false;
      caminhosCarregando = false;
      return;
    }
    
    // Filtrar apenas caminhos que ainda não foram calculados
    const todosCaminhos = Array.from(caminhosUnicos);
    const caminhosParaCalcular = todosCaminhos.filter(key => !caminhoRedeTotals.has(key));
    
    if (caminhosParaCalcular.length === 0) {
      console.log('✅ Todos os caminhos já foram calculados');
      ultimosCaminhosCalculados = novosCaminhos;
      calculandoTotais = false;
      caminhosCarregando = false;
      caminhoRedeTotalsVersion++;
      return;
    }
    
    console.log(`📦 Buscando ${caminhosParaCalcular.length} novos caminhos de ${todosCaminhos.length} totais em uma única requisição batch`);
    
    try {
      // Preparar array de caminhos para a requisição batch
      // IMPORTANTE: A chave é gerada como CIDADE|POP|CHASSE|PLACA|OLT
      // Onde CHASSE = cto.olt, PLACA = cto.slot, OLT = cto.pon
      // O backend espera: { cidade, pop, olt, slot, pon }
      // Onde: olt = CHASSE (cto.olt), slot = PLACA (cto.slot), pon = OLT (cto.pon)
      // E o backend gera a chave como: cidade|pop|olt|slot|pon
      const caminhosArray = caminhosParaCalcular.map(caminhoKey => {
        const [cidade, pop, chasse, placa, olt] = caminhoKey.split('|');
        // Mapear corretamente: chasse -> olt, placa -> slot, olt -> pon
        // O backend vai gerar a chave como: cidade|pop|olt|slot|pon
        // Mas precisamos garantir que a chave do frontend corresponda
        return { 
          cidade: cidade.trim(), 
          pop: pop.trim(), 
          olt: chasse.trim(),  // CHASSE vai para olt no backend
          slot: placa.trim(),  // PLACA vai para slot no backend
          pon: olt.trim()       // OLT vai para pon no backend
        };
      });
      
      console.log(`📤 Enviando ${caminhosArray.length} caminhos para o backend:`, caminhosArray.map(c => `${c.cidade}|${c.pop}|${c.olt}|${c.slot}|${c.pon}`));
      
      // Fazer uma única requisição POST com todos os caminhos
      const url = getApiUrl('/api/ctos/caminhos-rede-batch');
      console.log(`🚀 Fazendo requisição batch para ${caminhosArray.length} caminhos`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ caminhos: caminhosArray })
      });
      
      if (!response.ok) {
        console.error(`❌ Resposta HTTP não OK: ${response.status} ${response.statusText}`);
        const errorText = await response.text();
        console.error(`Erro: ${errorText}`);
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      
      const data = await response.json();
      
      if (data.success && data.resultados) {
        // Atualizar o Map com todos os resultados de uma vez (portas e CTOs)
        const newTotals = new Map(caminhoRedeTotals);
        const newCTOsTotals = new Map(caminhoRedeCTOsTotals);
        
        // Criar um mapa: chave do backend -> chave do frontend
        // O backend gera a chave como: cidade|pop|olt|slot|pon
        // O frontend usa: cidade|pop|chasse|placa|olt
        // Onde: olt (backend) = chasse (frontend), slot (backend) = placa (frontend), pon (backend) = olt (frontend)
        const chavesBackendParaFrontend = new Map();
        for (const caminhoKey of caminhosParaCalcular) {
          const [cidade, pop, chasse, placa, olt] = caminhoKey.split('|');
          // O backend gera: cidade|pop|olt|slot|pon
          // Onde olt=chasse, slot=placa, pon=olt
          const chaveBackend = `${cidade.trim()}|${pop.trim()}|${chasse.trim()}|${placa.trim()}|${olt.trim()}`;
          chavesBackendParaFrontend.set(chaveBackend, caminhoKey);
        }
        
        console.log(`📥 Chaves recebidas do backend:`, Object.keys(data.resultados));
        console.log(`📋 Mapeamento frontend->backend:`, Array.from(chavesBackendParaFrontend.entries()));
        
        for (const caminhoKey of caminhosParaCalcular) {
          // Primeiro tentar encontrar pela chave exata do frontend
          let resultado = data.resultados[caminhoKey];
          
          // Se não encontrou, tentar pela chave que o backend gera
          if (!resultado) {
            const [cidade, pop, chasse, placa, olt] = caminhoKey.split('|');
            // O backend gera: cidade|pop|olt|slot|pon (onde olt=chasse, slot=placa, pon=olt)
            const chaveBackend = `${cidade.trim()}|${pop.trim()}|${chasse.trim()}|${placa.trim()}|${olt.trim()}`;
            resultado = data.resultados[chaveBackend];
            
            if (resultado) {
              console.log(`🔄 Chave encontrada usando formato do backend: "${caminhoKey}" -> "${chaveBackend}"`);
            }
          }
          
          // Se ainda não encontrou, tentar por comparação de partes
          if (!resultado) {
            const chavesDisponiveis = Object.keys(data.resultados);
            const [cidade, pop, chasse, placa, olt] = caminhoKey.split('|');
            const chaveEncontrada = chavesDisponiveis.find(chave => {
              const partesChave = chave.split('|');
              // Comparar: cidade, pop, e depois verificar se olt=chasse, slot=placa, pon=olt
              if (partesChave.length !== 5) return false;
              return partesChave[0].trim() === cidade.trim() &&
                     partesChave[1].trim() === pop.trim() &&
                     partesChave[2].trim() === chasse.trim() &&
                     partesChave[3].trim() === placa.trim() &&
                     partesChave[4].trim() === olt.trim();
            });
            if (chaveEncontrada) {
              resultado = data.resultados[chaveEncontrada];
              console.log(`🔄 Chave encontrada por comparação de partes: "${caminhoKey}" -> "${chaveEncontrada}"`);
            }
          }
          
          if (resultado && resultado.total_portas !== undefined) {
            newTotals.set(caminhoKey, resultado.total_portas);
            // Armazenar também o total de CTOs
            newCTOsTotals.set(caminhoKey, resultado.total_ctos || 0);
            console.log(`✅ ${caminhoKey}: ${resultado.total_portas} portas (${resultado.total_ctos} CTOs)`);
          } else {
            console.warn(`⚠️ Sem resultado para ${caminhoKey}. Chaves disponíveis no backend:`, Object.keys(data.resultados));
            // Tentar buscar diretamente no backend usando os valores da CTO
            console.warn(`   Tentando buscar manualmente para: cidade=${caminhoKey.split('|')[0]}, pop=${caminhoKey.split('|')[1]}, chasse=${caminhoKey.split('|')[2]}, placa=${caminhoKey.split('|')[3]}, olt=${caminhoKey.split('|')[4]}`);
            newTotals.set(caminhoKey, 0);
            newCTOsTotals.set(caminhoKey, 0);
          }
        }
        
        caminhoRedeTotals = newTotals;
        caminhoRedeCTOsTotals = newCTOsTotals;
        ultimosCaminhosCalculados = novosCaminhos;
        
        console.log(`✅ Batch completo! ${Object.keys(data.resultados).length} caminhos processados`);
        console.log(`📊 Map atualizado. Tamanho: ${caminhoRedeTotals.size}, Chaves:`, Array.from(caminhoRedeTotals.keys()));
      } else {
        console.error('❌ Resposta da API não tem success=true ou resultados:', data);
        throw new Error('Resposta inválida da API');
      }
    } catch (err) {
      console.error('❌ Erro ao buscar totais em batch:', err);
      // Em caso de erro, marcar todos como 0 para não ficar travado
      const newTotals = new Map(caminhoRedeTotals);
      const newCTOsTotals = new Map(caminhoRedeCTOsTotals);
      for (const caminhoKey of caminhosParaCalcular) {
        newTotals.set(caminhoKey, 0);
        newCTOsTotals.set(caminhoKey, 0);
      }
      caminhoRedeTotals = newTotals;
      caminhoRedeCTOsTotals = newCTOsTotals;
    } finally {
      // Marcar como concluído
      calculandoTotais = false;
      caminhosCarregando = false;
      caminhoRedeTotalsVersion++;
      await tick(); // Garantir atualização do DOM
    }
    
    console.log(`✅ Totais calculados para ${todosCaminhos.length} caminhos de rede`);
    console.log(`🔄 Versão final: ${caminhoRedeTotalsVersion}. Map final tem ${caminhoRedeTotals.size} entradas`);
  }
  
  // Função para obter total de portas do caminho de rede de uma CTO
  function getCaminhoRedeTotal(cto) {
    if (!cto || !caminhoRedeTotals) {
      console.warn('⚠️ getCaminhoRedeTotal: CTO ou Map inválido', { cto: !!cto, map: !!caminhoRedeTotals });
      return 0;
    }
    const caminhoKey = getCaminhoRedeKey(cto);
    const total = caminhoRedeTotals.get(caminhoKey) || 0;
    if (total === 0 && caminhoKey && !caminhoKey.includes('N/A') && caminhoKey !== '||||') {
      // Verificar se a chave existe no Map
      const hasKey = caminhoRedeTotals.has(caminhoKey);
      console.warn(`⚠️ getCaminhoRedeTotal: Total 0 para caminho "${caminhoKey}" (CTO: ${cto.nome}). Chave existe no Map: ${hasKey}. Map tem ${caminhoRedeTotals.size} chaves:`, Array.from(caminhoRedeTotals.keys()));
      // Se a chave não existe, pode ser que o cálculo ainda não foi feito
      if (!hasKey && !caminhosCarregando) {
        console.log(`🔄 Chave não encontrada e não está carregando. CTO: ${cto.nome}, Caminho: ${caminhoKey}`);
      }
    }
    return total;
  }
  
  // Função para obter total de CTOs do caminho de rede
  function getCaminhoRedeCTOsTotal(cto) {
    if (!cto || !caminhoRedeCTOsTotals) {
      console.warn('⚠️ getCaminhoRedeCTOsTotal: CTO ou Map inválido', { cto: !!cto, map: !!caminhoRedeCTOsTotals });
      return 0;
    }
    const caminhoKey = getCaminhoRedeKey(cto);
    const total = caminhoRedeCTOsTotals.get(caminhoKey) || 0;
    return total;
  }
  
  // Função para calcular o número de uma CTO na sequência (mesma lógica do mapa)
  // Retorna um Map com CTO como chave e número como valor
  // Map para rastrear a ordem de marcação individual (usado quando nem todas as CTOs estão marcadas)
  let ctoMarkOrder = new Map(); // Map<ctoKey, number> - armazena a ordem em que cada CTO foi marcada
  let markOrderCounter = 0; // Contador para a ordem de marcação
  let useVisualOrder = false; // Flag: true = usar ordem visual (quando usa "marcar todos" no header), false = usar ordem de marcação
  
  function calculateCTONumbers() {
    const ctoToNumber = new Map();
    
    if (useVisualOrder) {
      // Lógica 1: Todas marcadas - usar ordem visual (ordem do array ctos)
      let markerNumber = 1;
      for (const cto of ctos) {
        const ctoKey = getCTOKey(cto);
        const isVisible = ctoVisibility.get(ctoKey) !== false;
        
        if (isVisible) {
          // Validar coordenadas
          if (cto.latitude && cto.longitude && !isNaN(cto.latitude) && !isNaN(cto.longitude)) {
            // Garantir que cada CTO (mesmo objeto) tenha um número único
            // Mesmo que haja CTOs com o mesmo nome, cada objeto é único
            if (!ctoToNumber.has(cto)) {
              ctoToNumber.set(cto, markerNumber);
              markerNumber++;
            }
          }
        }
      }
    } else {
      // Lógica 2: Não está usando ordem visual - verificar se deve usar ordem de marcação
      // A ordem de marcação só é usada se foi ativada (quando todas estavam desmarcadas)
      // Se não foi ativada, usar ordem visual como fallback
      
      if (ctoMarkOrder.size > 0) {
        // Usar ordem de marcação (foi ativada quando todas estavam desmarcadas)
        const markedCTOs = [];
    for (const cto of ctos) {
      const ctoKey = getCTOKey(cto);
          const isVisible = ctoVisibility.get(ctoKey) !== false;
      
      if (isVisible) {
        // Validar coordenadas
        if (cto.latitude && cto.longitude && !isNaN(cto.latitude) && !isNaN(cto.longitude)) {
              // Se a CTO está em ctoMarkOrder, usar a ordem de marcação
              // Caso contrário, usar um número muito alto para que fique por último
              const markOrder = ctoMarkOrder.has(ctoKey) ? ctoMarkOrder.get(ctoKey) : Number.MAX_SAFE_INTEGER;
              markedCTOs.push({
                cto,
                markOrder
              });
            }
          }
        }
        
        // Ordenar pela ordem de marcação
        markedCTOs.sort((a, b) => a.markOrder - b.markOrder);
        
        // Atribuir números sequenciais baseados na ordem de marcação
        let markerNumber = 1;
        for (const { cto } of markedCTOs) {
          // Garantir que cada CTO (mesmo objeto) tenha um número único
          if (!ctoToNumber.has(cto)) {
            ctoToNumber.set(cto, markerNumber);
            markerNumber++;
          }
        }
      } else {
        // Se não há ordem de marcação ativada, usar ordem visual como fallback
        let markerNumber = 1;
        for (const cto of ctos) {
          const ctoKey = getCTOKey(cto);
          const isVisible = ctoVisibility.get(ctoKey) !== false;
          
          if (isVisible) {
            // Validar coordenadas
            if (cto.latitude && cto.longitude && !isNaN(cto.latitude) && !isNaN(cto.longitude)) {
              // Garantir que cada CTO (mesmo objeto) tenha um número único
              if (!ctoToNumber.has(cto)) {
                ctoToNumber.set(cto, markerNumber);
                markerNumber++;
              }
            }
          }
        }
      }
    }
    
    return ctoToNumber;
  }
  
  // Map reativo para armazenar números das CTOs
  let ctoNumbers = new Map();
  let ctoNumbersVersion = 0; // Versão para forçar atualização
  
  // Recalcular números quando CTOs ou visibilidade mudarem
  // Duas lógicas de numeração:
  // 1. Se todas as CTOs estão marcadas: usa ordem visual (ordem do array ctos)
  // 2. Se nem todas estão marcadas: usa ordem de marcação (ctoMarkOrder)
  $: if (ctos && ctos.length > 0) {
    // Forçar recálculo - ctoNumbersVersion será incrementado quando visibilidade mudar
    const _ = ctoNumbersVersion;
    // Também forçar recálculo quando ctoVisibility, ctoMarkOrder ou useVisualOrder mudarem
    const _visibility = Array.from(ctoVisibility.entries());
    const _markOrder = Array.from(ctoMarkOrder.entries());
    const _useVisualOrder = useVisualOrder;
    ctoNumbers = calculateCTONumbers();
    
    // Não atualizar o mapa automaticamente aqui para evitar chamadas duplicadas
    // O mapa será atualizado explicitamente após a busca ou quando o usuário marcar/desmarcar
    // Isso evita múltiplas chamadas desnecessárias
  } else {
    ctoNumbers = new Map();
    // Se não há CTOs, limpar o mapa
    if (map && google?.maps) {
      displayResultsOnMap();
    }
  }
  
  // Variável reativa para forçar atualização quando os totais mudarem
  let caminhoRedeTotalsVersion = 0;
  
  // Recalcular quando a lista de CTOs mudar (com debounce para evitar loops)
  let timeoutId = null;
  $: if (ctos && ctos.length > 0) {
    // Cancelar timeout anterior se existir
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    
    // Aguardar um pouco antes de calcular para evitar múltiplas execuções
    timeoutId = setTimeout(async () => {
      try {
        // Verificar novamente se ainda há CTOs (pode ter mudado durante o timeout)
        if (ctos && ctos.length > 0 && !calculandoTotais) {
          console.log(`🔄 Iniciando cálculo de totais para ${ctos.length} CTOs`);
          await calculateCaminhoRedeTotals();
          console.log(`✅ Cálculo concluído. Versão: ${caminhoRedeTotalsVersion}, Map size: ${caminhoRedeTotals.size}`);
          await tick();
        }
      } catch (err) {
        console.error('❌ Erro ao calcular totais do caminho de rede:', err);
        calculandoTotais = false;
        caminhosCarregando = false;
      }
    }, 300); // Debounce de 300ms
  } else {
    // Limpar quando não há CTOs
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    caminhoRedeTotals = new Map();
    caminhoRedeCTOsTotals = new Map();
    caminhoRedeLoading.clear();
    caminhoRedeTotalsVersion = 0;
    caminhosCarregando = false;
    calculandoTotais = false;
    ultimosCaminhosCalculados = new Set();
  }
  
  // Estados reativos para checkbox "marcar todos"
  $: allCTOsVisible = ctos.length > 0 && ctos.every(cto => {
    const ctoKey = getCTOKey(cto);
    return ctoVisibility.get(ctoKey) !== false;
  });
  
  $: someCTOsVisible = ctos.length > 0 && ctos.some(cto => {
    const ctoKey = getCTOKey(cto);
    return ctoVisibility.get(ctoKey) === true;
  }) && !allCTOsVisible;
  
  // Redimensionamento de boxes - usar variáveis que o Svelte detecta como reativas
  let sidebarWidth = 400; // Largura inicial da sidebar em pixels (aumentada para melhor visibilidade)
  let mapHeightPixels = 400; // Altura inicial do mapa em pixels
  let isResizingSidebar = false;
  let isResizingMapTable = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartSidebarWidth = 0;
  let resizeStartMapHeight = 0;
  
  // Estados de minimização dos boxes
  let isSearchPanelMinimized = false;
  let isMapMinimized = false;
  let isTableMinimized = true; // Começar minimizada quando não há resultados
  
  // InfoWindow para o botão de menu da tabela
  let tableMenuInfoWindow = null;
  let tableMenuInfoWindowElement = null;
  
  // Reactive statements para calcular estilos automaticamente
  $: sidebarWidthStyle = `${sidebarWidth}px`;
  $: mapHeightStyle = `${mapHeightPixels}px`;
  
  // Função para abrir configurações
  function openSettings() {
    showSettingsModal = true;
  }
  
  // Função para verificar se todas as CTOs pesquisadas estão marcadas
  function areSearchedCTOsVisible() {
    if (searchedCTOKeys.size === 0) return false;
    for (const ctoKey of searchedCTOKeys) {
      if (!ctoVisibility.get(ctoKey)) {
        return false;
      }
    }
    return true;
  }
  
  // Função para marcar/desmarcar apenas as CTOs pesquisadas pelo usuário
  async function toggleSearchedCTOs() {
    const allVisible = areSearchedCTOsVisible();
    
    // Marcar ou desmarcar todas as CTOs pesquisadas
    for (const ctoKey of searchedCTOKeys) {
      ctoVisibility.set(ctoKey, !allVisible);
    }
    
    // Forçar reatividade
    ctoVisibility = ctoVisibility;
    ctoNumbersVersion++;
    
    // Atualizar mapa
    await tick();
    await displayResultsOnMap();
  }
  
  // Função para abrir InfoWindow do menu da tabela sobre a tabela
  function openTableMenuInfoWindow(event) {
    event.stopPropagation(); // Prevenir propagação do evento
    
    // Fechar InfoWindow anterior se existir
    if (tableMenuInfoWindowElement) {
      // Restaurar overflow original
      if (tableMenuInfoWindowElement._restoreOverflow) {
        tableMenuInfoWindowElement._restoreOverflow();
      }
      tableMenuInfoWindowElement.remove();
      tableMenuInfoWindowElement = null;
      return; // Se já estava aberto, apenas fecha
    }
    
    // Verificar se há CTOs pesquisadas (apenas funciona para pesquisa por nome)
    const hasSearchedCTOs = searchedCTOKeys.size > 0;
    const allSearchedVisible = areSearchedCTOsVisible();
    
    // Criar estrutura do box exatamente como o modal "Alterar Dados"
    const infoContent = document.createElement('div');
    infoContent.className = 'table-menu-content';
    
    // Criar header do box (igual ao modal)
    const header = document.createElement('div');
    header.className = 'table-menu-header';
    const headerTitle = document.createElement('h2');
    headerTitle.textContent = 'Ajuste na Tabela';
    header.appendChild(headerTitle);
    const closeButton = document.createElement('button');
    closeButton.className = 'table-menu-close';
    closeButton.innerHTML = '×';
    closeButton.setAttribute('aria-label', 'Fechar');
    closeButton.onclick = (e) => {
      e.stopPropagation();
      if (tableMenuInfoWindowElement) {
        tableMenuInfoWindowElement.remove();
        tableMenuInfoWindowElement = null;
      }
    };
    header.appendChild(closeButton);
    infoContent.appendChild(header);
    
    // Criar body do box (igual ao modal)
    const body = document.createElement('div');
    body.className = 'table-menu-body';
    
    if (hasSearchedCTOs) {
      // Criar seção de CTOs pesquisadas (estilo igual ao modal)
      const section = document.createElement('div');
      section.style.marginBottom = '2rem';
      section.style.paddingBottom = '2rem';
      section.style.borderBottom = '1px solid #e0e0e0';
      
      const sectionTitle = document.createElement('h3');
      sectionTitle.className = 'table-menu-section-title';
      sectionTitle.textContent = 'CTOs Pesquisadas';
      section.appendChild(sectionTitle);
      
      // Criar container para o botão (similar ao layout do modal)
      const buttonContainer = document.createElement('div');
      buttonContainer.className = 'table-menu-button-container';
      
      const button = document.createElement('button');
      button.className = 'table-menu-button-action';
      button.type = 'button';
      button.innerHTML = `
        <span class="button-text">${allSearchedVisible ? 'Desmarcar CTOs Pesquisadas' : 'Marcar CTOs Pesquisadas'}</span>
      `;
      button.onclick = async (e) => {
        e.stopPropagation();
        await toggleSearchedCTOs();
        // Atualizar texto do botão
        const newState = areSearchedCTOsVisible();
        button.querySelector('.button-text').textContent = newState ? 'Desmarcar CTOs Pesquisadas' : 'Marcar CTOs Pesquisadas';
      };
      buttonContainer.appendChild(button);
      section.appendChild(buttonContainer);
      
      body.appendChild(section);
    } else {
      // Se não há CTOs pesquisadas, mostrar mensagem
      const message = document.createElement('div');
      message.className = 'table-menu-message';
      message.innerHTML = `
        <span class="message-icon">ℹ️</span>
        <span class="message-text">Nenhuma CTO pesquisada por nome</span>
      `;
      body.appendChild(message);
    }
    
    infoContent.appendChild(body);
    
    // Criar container do InfoWindow
    const infoWindowContainer = document.createElement('div');
    infoWindowContainer.className = 'table-menu-infowindow';
    infoWindowContainer.appendChild(infoContent);
    
    // Encontrar o container da tabela
    const buttonElement = event.currentTarget;
    const tableHeader = buttonElement.closest('.table-header');
    const tableContainer = buttonElement.closest('.results-table-container, .empty-state');
    
    if (tableContainer && tableHeader) {
      // Garantir que o container tenha position relative e overflow visible
      if (getComputedStyle(tableContainer).position === 'static') {
        tableContainer.style.position = 'relative';
      }
      // Garantir que o overflow não corte o InfoWindow
      const originalOverflow = getComputedStyle(tableContainer).overflow;
      tableContainer.style.overflow = 'visible';
      
      // Adicionar o box ao container da tabela
      tableContainer.appendChild(infoWindowContainer);
      
      // Calcular posição relativa ao botão dos três pontos
      const buttonRect = buttonElement.getBoundingClientRect();
      const containerRect = tableContainer.getBoundingClientRect();
      const headerRect = tableHeader.getBoundingClientRect();
      
      // Posicionar o InfoWindow alinhado à direita, abaixo do header
      const padding = 10; // Espaçamento mínimo das bordas
      
      infoWindowContainer.style.position = 'absolute';
      infoWindowContainer.style.top = `${headerRect.bottom - containerRect.top + 5}px`;
      
      // Alinhar à direita do container (próximo ao botão dos três pontos)
      // Usar right para garantir alinhamento correto
      infoWindowContainer.style.right = `${padding}px`;
      infoWindowContainer.style.left = 'auto';
      infoWindowContainer.style.zIndex = '10000'; // Z-index muito alto para ficar acima de tudo
      
      tableMenuInfoWindowElement = infoWindowContainer;
      
      // Restaurar overflow original quando fechar
      const restoreOverflow = () => {
        if (tableContainer && originalOverflow) {
          tableContainer.style.overflow = originalOverflow;
        }
      };
      
      // Salvar função de restore para usar quando fechar
      infoWindowContainer._restoreOverflow = restoreOverflow;
      
      // Função para fechar o InfoWindow e restaurar overflow
      const closeInfoWindow = () => {
        if (infoWindowContainer && infoWindowContainer.parentNode) {
          // Restaurar overflow original
          if (infoWindowContainer._restoreOverflow) {
            infoWindowContainer._restoreOverflow();
          }
          infoWindowContainer.remove();
        }
        document.removeEventListener('click', closeOnClickOutside);
        tableMenuInfoWindowElement = null;
      };
      
      // Atualizar o botão fechar para usar a nova função
      closeButton.onclick = (e) => {
        e.stopPropagation();
        closeInfoWindow();
      };
      
      // Fechar ao clicar fora
      const closeOnClickOutside = (e) => {
        if (infoWindowContainer && !infoWindowContainer.contains(e.target) && e.target !== buttonElement) {
          closeInfoWindow();
        }
      };
      
      setTimeout(() => {
        document.addEventListener('click', closeOnClickOutside);
      }, 100);
    } else {
      console.error('Não foi possível encontrar o container da tabela');
    }
  }

  // Função para pré-carregar configurações no hover
  function preloadSettingsData() {
    // Pré-carregar dados se necessário
  }

  // Verificar se a base de dados está disponível
  async function checkBaseAvailable() {
    try {
      // Verificar se o Supabase está disponível fazendo uma busca simples
      const testLat = -23.5505; // Coordenada de teste (São Paulo)
      const testLng = -46.6333;
      const response = await fetch(getApiUrl(`/api/ctos/nearby?lat=${testLat}&lng=${testLng}&radius=1000&probe=1`));
      if (response.ok) {
        baseDataExists = true;
        return true;
      }
      baseDataExists = false;
      return false;
    } catch (err) {
      console.warn('Aviso: Não foi possível verificar base de dados:', err.message);
      baseDataExists = false;
      return false;
    }
  }

  // Carregar biblioteca do Google Maps
  async function loadGoogleMaps() {
    // Verificar se o Google Maps já está carregado globalmente
    if (typeof google !== 'undefined' && google.maps) {
      console.log('✅ Google Maps já está carregado globalmente');
      googleMapsLoaded = true;
      return;
    }
    
    if (googleMapsLoaded) return;
    
    try {
      if (!GOOGLE_MAPS_API_KEY) {
        throw new Error('Chave da API do Google Maps não configurada');
      }
      
      // Usar as mesmas bibliotecas que ViabilidadeAlares para evitar conflitos
      // Adicionar 'marker' para suportar AdvancedMarkerElement
      const loader = new Loader({
        apiKey: GOOGLE_MAPS_API_KEY,
        version: 'weekly',
        libraries: ['places', 'geometry', 'marker'] // Adicionar 'marker' para AdvancedMarkerElement
      });
      
      await loader.load();
      googleMapsLoaded = true;
      console.log('✅ Google Maps carregado');
    } catch (err) {
      // Se o erro for sobre Loader já chamado, verificar se está disponível globalmente
      if (err.message && err.message.includes('Loader must not be called again')) {
        console.warn('Google Maps Loader já foi chamado, verificando disponibilidade global...');
        if (typeof google !== 'undefined' && google.maps) {
          console.log('✅ Google Maps disponível globalmente');
          googleMapsLoaded = true;
          return;
        }
      }
      console.error('Erro ao carregar Google Maps:', err);
      throw err; // Re-throw para ser capturado por initializeTool
    }
  }

  // Inicializar o mapa (criar instância) - simplificado similar ao ViabilidadeAlares
  function initMap() {
    if (!googleMapsLoaded) return;

    const mapElement = document.getElementById('map');
    if (!mapElement) return;

    map = new google.maps.Map(mapElement, {
      center: { lat: -23.5505, lng: -46.6333 }, // São Paulo como padrão
      zoom: 13,
      mapId: 'DEMO_MAP_ID', // Necessário para AdvancedMarkerElement
      mapTypeControl: true,
      streetViewControl: true,
      fullscreenControl: true,
      scrollwheel: true,
      gestureHandling: 'greedy'
    });
    
    mapInitialized = true;
    console.log('✅ Mapa inicializado com sucesso');
  }

  // Função de inicialização da ferramenta (chamada quando o componente é montado)
  async function initializeTool() {
    // Mostrar loading enquanto carrega a ferramenta
    isLoading = true;
    
    try {
      // Etapa 1: Carregando Mapa
      loadingMessage = 'Carregando Mapa';
      await loadGoogleMaps();
      
      // Pequeno delay para visualização
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Etapa 2: Verificando Base de dados
      loadingMessage = 'Verificando Base de dados';
      baseDataExists = true; // Resetar estado
      try {
        await checkBaseAvailable();
      } catch (err) {
        console.warn('Aviso: Não foi possível verificar base de dados:', err.message);
        baseDataExists = false;
      }
      
      // Pequeno delay para visualização
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Etapa 3: Ajuste Finais
      loadingMessage = 'Ajuste Finais';
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Etapa 4: Abrindo Ferramenta
      loadingMessage = 'Abrindo Ferramenta';
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Tudo carregado
      isLoading = false;
      
      // Aguardar o DOM atualizar antes de inicializar o mapa
      await tick();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Agora inicializar o mapa após o elemento estar no DOM
      initMap();
    } catch (err) {
      console.error('Erro ao inicializar ferramenta:', err);
      error = 'Erro ao inicializar ferramenta: ' + err.message;
      isLoading = false;
      
      // Tentar inicializar o mapa mesmo com erro
      await tick();
      await new Promise(resolve => setTimeout(resolve, 100));
      initMap();
    }
  }

  // Função para determinar a cor do marcador baseada na porcentagem de ocupação
  function getCTOColor(pctOcup) {
    const porcentagem = parseFloat(pctOcup) || 0;
    
    if (porcentagem < 0 || porcentagem > 100) {
      return '#F44336'; // Vermelho
    }
    
    // 0% - 49,99% = Verde
    if (porcentagem >= 0 && porcentagem < 50) {
      return '#4CAF50'; // Verde
    }
    // 50,00% - 79,99% = Laranja
    else if (porcentagem >= 50 && porcentagem < 80) {
      return '#FF9800'; // Laranja
    }
    // 80,00% - 100% = Vermelho
    else {
      return '#F44336'; // Vermelho
    }
  }

  // Array para armazenar múltiplos marcadores de busca
  let searchMarkers = [];
  
  // Array para armazenar círculos de raio de 250m das CTOs pesquisadas
  let radiusCircles = [];
  // Array para armazenar polígonos fundidos quando há sobreposição
  let radiusPolygons = [];
  let showRadiusCircles = true; // Controla a visibilidade dos círculos de 250m

  // Limpar marcadores do mapa
  function clearMap() {
    // Limpar marcadores das CTOs
    markers.forEach(marker => {
      if (marker && marker.setMap) {
        marker.setMap(null);
      }
    });
    markers = [];
    
    // Limpar marcadores de busca (múltiplos)
    searchMarkers.forEach(marker => {
      if (marker && marker.setMap) {
        marker.setMap(null);
      }
    });
    searchMarkers = [];
    
    // Limpar círculos de raio de 250m
    radiusCircles.forEach(circle => {
      if (circle && circle.setMap) {
        circle.setMap(null);
      }
    });
    radiusCircles = [];
    
    // Limpar polígonos fundidos
    radiusPolygons.forEach(polygon => {
      if (polygon && polygon.setMap) {
        polygon.setMap(null);
      }
    });
    radiusPolygons = [];
    
    // Limpar marcador único anterior (compatibilidade)
    if (searchMarker) {
      searchMarker.setMap(null);
      searchMarker = null;
    }
  }

  // Função para geocodificar endereço
  function geocodeAddress(address) {
    return new Promise((resolve, reject) => {
      if (!google.maps || !google.maps.Geocoder) {
        reject(new Error('Google Maps Geocoder não está disponível'));
        return;
      }

      const geocoder = new google.maps.Geocoder();
      
      geocoder.geocode(
        { 
          address: address.trim(),
          region: 'br'
        },
        (results, status) => {
          if (status === 'OK' && results && results.length > 0) {
            resolve(results[0]);
          } else {
            reject(new Error(`Geocoding failed: ${status}`));
          }
        }
      );
    });
  }

  // Função para calcular distância geodésica (Haversine)
  function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Raio da Terra em metros
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distância em metros
  }
  
  // Função para verificar se dois círculos de 250m se intersectam
  // Dois círculos se intersectam se a distância entre os centros < 500m (2 * raio)
  function doCirclesIntersect(cto1, cto2) {
    const RADIUS = 250; // Raio em metros
    const INTERSECTION_THRESHOLD = RADIUS * 2; // 500m - se distância < 500m, círculos se tocam/fundem
    
    const lat1 = parseFloat(cto1.latitude);
    const lng1 = parseFloat(cto1.longitude);
    const lat2 = parseFloat(cto2.latitude);
    const lng2 = parseFloat(cto2.longitude);
    
    // Validar coordenadas
    if (isNaN(lat1) || isNaN(lng1) || isNaN(lat2) || isNaN(lng2)) {
      return false;
    }
    
    // Calcular distância entre os centros
    const distance = calculateDistance(lat1, lng1, lat2, lng2);
    
    // Se a distância for menor que 500m, os círculos se intersectam
    return distance < INTERSECTION_THRESHOLD;
  }
  
  // Função para agrupar CTOs que se intersectam (algoritmo de agrupamento)
  // Retorna array de grupos, onde cada grupo é um array de CTOs que se intersectam
  function groupCTOsByIntersection(ctos) {
    if (ctos.length === 0) return [];
    if (ctos.length === 1) return [[ctos[0]]]; // Grupo único
    
    const groups = [];
    const processed = new Set(); // Rastrear CTOs já processadas
    
    for (let i = 0; i < ctos.length; i++) {
      if (processed.has(i)) continue;
      
      // Criar novo grupo começando com esta CTO
      const currentGroup = [ctos[i]];
      processed.add(i);
      
      // Buscar todas as CTOs que se intersectam com qualquer CTO do grupo atual
      // Usar busca em largura (BFS) para encontrar todas as conexões transitivas
      let foundNew = true;
      while (foundNew) {
        foundNew = false;
        
        // Verificar todas as CTOs não processadas
        for (let j = 0; j < ctos.length; j++) {
          if (processed.has(j)) continue;
          
          // Verificar se esta CTO se intersecta com alguma CTO do grupo atual
          for (const groupCTO of currentGroup) {
            if (doCirclesIntersect(ctos[j], groupCTO)) {
              // Esta CTO se intersecta com o grupo, adicionar ao grupo
              currentGroup.push(ctos[j]);
              processed.add(j);
              foundNew = true;
              break; // Parar de verificar esta CTO, já foi adicionada
            }
          }
        }
      }
      
      // Adicionar grupo à lista de grupos
      groups.push(currentGroup);
    }
    
    return groups;
  }

  // Função para verificar se dois pontos (endereços) se intersectam (círculos de 250m)
  function doPointsIntersect(point1, point2) {
    const RADIUS = 250; // Raio em metros
    const INTERSECTION_THRESHOLD = RADIUS * 2; // 500m - se distância < 500m, círculos se tocam/fundem
    
    const lat1 = point1.lat;
    const lng1 = point1.lng;
    const lat2 = point2.lat;
    const lng2 = point2.lng;
    
    // Validar coordenadas
    if (isNaN(lat1) || isNaN(lng1) || isNaN(lat2) || isNaN(lng2)) {
      return false;
    }
    
    // Calcular distância entre os pontos
    const distance = calculateDistance(lat1, lng1, lat2, lng2);
    
    // Se a distância for menor que 500m, os círculos se intersectam
    return distance < INTERSECTION_THRESHOLD;
  }
  
  // Função para agrupar pontos (endereços) que se intersectam (algoritmo de agrupamento)
  // Retorna array de grupos, onde cada grupo é um array de pontos que se intersectam
  function groupPointsByIntersection(points) {
    if (points.length === 0) return [];
    if (points.length === 1) return [[points[0]]]; // Grupo único
    
    const groups = [];
    const processed = new Set(); // Rastrear pontos já processados
    
    for (let i = 0; i < points.length; i++) {
      if (processed.has(i)) continue;
      
      // Criar novo grupo começando com este ponto
      const currentGroup = [points[i]];
      processed.add(i);
      
      // Buscar todos os pontos que se intersectam com qualquer ponto do grupo atual
      // Usar busca em largura (BFS) para encontrar todas as conexões transitivas
      let foundNew = true;
      while (foundNew) {
        foundNew = false;
        
        // Verificar todos os pontos não processados
        for (let j = 0; j < points.length; j++) {
          if (processed.has(j)) continue;
          
          // Verificar se este ponto se intersecta com algum ponto do grupo atual
          for (const groupPoint of currentGroup) {
            if (doPointsIntersect(points[j], groupPoint)) {
              // Este ponto se intersecta com o grupo, adicionar ao grupo
              currentGroup.push(points[j]);
              processed.add(j);
              foundNew = true;
              break; // Parar de verificar este ponto, já foi adicionado
            }
          }
        }
      }
      
      // Adicionar grupo à lista de grupos
      groups.push(currentGroup);
    }
    
    return groups;
  }

  // Função para verificar se uma CTO já está na lista (evitar duplicatas)
  function isCTODuplicate(cto, existingList) {
    return existingList.some(existing => 
      existing.nome === cto.nome || 
      existing.id === cto.id ||
      (existing.latitude && existing.longitude && cto.latitude && cto.longitude &&
       Math.abs(parseFloat(existing.latitude) - parseFloat(cto.latitude)) < 0.0001 &&
       Math.abs(parseFloat(existing.longitude) - parseFloat(cto.longitude)) < 0.0001)
    );
  }

  // Função para buscar CTOs por nome (suporta múltiplas CTOs)
  async function searchByNome() {
    if (!nomeCTO.trim()) {
      error = 'Por favor, insira o nome da(s) CTO(s)';
      return;
    }

    loadingCTOs = true;
    error = null;
    ctos = [];
    // Limpar CTOs pesquisadas quando iniciar nova busca
    searchedCTOKeys.clear();
    // Minimizar tabela quando limpar resultados
    isTableMinimized = true;
    clearMap();

    try {
      // Verificar se o mapa está inicializado
      if (!map) {
        initMap();
        await tick();
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      // Separar múltiplas CTOs (aceita vírgula, ponto e vírgula, ou quebra de linha)
      const ctoNames = nomeCTO
        .split(/[,;\n]/)
        .map(name => name.trim())
        .filter(name => name.length > 0);

      if (ctoNames.length === 0) {
        error = 'Por favor, insira pelo menos um nome de CTO';
        loadingCTOs = false;
        return;
      }

      console.log(`🔍 Buscando ${ctoNames.length} CTO(s):`, ctoNames);

      const allCTOsMap = new Map(); // CTOs próximas - chave: coordenadas (para evitar duplicatas entre próximas)
      const searchedCTOsList = []; // Lista de TODAS as CTOs pesquisadas pelo usuário (incluindo duplicatas por coordenadas)

      // ETAPA 1: Buscar TODAS as CTOs pesquisadas pelo usuário
      const searchPromises = ctoNames.map(async (ctoName) => {
        try {
          const searchResponse = await fetch(getApiUrl(`/api/ctos/search?nome=${encodeURIComponent(ctoName)}`));
          const searchData = await searchResponse.json();
          return { ctoName, searchData };
        } catch (err) {
          console.error(`Erro ao buscar CTO "${ctoName}":`, err);
          return { ctoName, searchData: null };
        }
      });

      const searchResults = await Promise.all(searchPromises);

      // Coletar TODAS as CTOs pesquisadas (incluindo duplicadas por coordenadas)
      let foundCount = 0;
      let notFoundCount = 0;
      let skippedCoordinatesCount = 0;
      duplicatedCTOs = []; // Limpar duplicatas anteriores
      
      for (const { ctoName, searchData } of searchResults) {
        if (!searchData?.success || !searchData.ctos || searchData.ctos.length === 0) {
          console.warn(`⚠️ CTO "${ctoName}" não encontrada na base de dados`);
          notFoundCount++;
          continue;
        }

        console.log(`✅ CTO "${ctoName}" encontrada: ${searchData.ctos.length} resultado(s)`);

        // Detectar se há múltiplas CTOs com o mesmo nome (duplicatas)
        if (searchData.ctos.length > 1) {
          // Agrupar CTOs por caminho de rede para identificar duplicatas
          const caminhosMap = new Map();
          for (const foundCTO of searchData.ctos) {
            const caminhoKey = getCaminhoRedeKey(foundCTO);
            if (!caminhosMap.has(caminhoKey)) {
              caminhosMap.set(caminhoKey, []);
            }
            caminhosMap.get(caminhoKey).push(foundCTO);
          }
          
          // Se houver múltiplos caminhos diferentes, são duplicatas
          if (caminhosMap.size > 1) {
            const duplicatasInfo = {
              nome: ctoName,
              quantidade: searchData.ctos.length,
              caminhos: Array.from(caminhosMap.keys()).map(caminho => {
                const [cidade, pop, chasse, placa, olt] = caminho.split('|');
                return {
                  caminho: caminho,
                  cidade: cidade,
                  pop: pop,
                  chasse: chasse,
                  placa: placa,
                  olt: olt,
                  ctos: caminhosMap.get(caminho)
                };
              })
            };
            duplicatedCTOs.push(duplicatasInfo);
            console.log(`⚠️ CTOs duplicadas encontradas: "${ctoName}" com ${caminhosMap.size} caminhos diferentes`);
          }
        }

        // Para cada CTO encontrada com esse nome - adicionar TODAS, mesmo com coordenadas duplicadas
        for (const foundCTO of searchData.ctos) {
          if (!foundCTO.latitude || !foundCTO.longitude) {
            console.warn(`⚠️ CTO "${foundCTO.nome}" sem coordenadas válidas (lat: ${foundCTO.latitude}, lng: ${foundCTO.longitude})`);
            skippedCoordinatesCount++;
            continue;
          }

          const lat = parseFloat(foundCTO.latitude);
          const lng = parseFloat(foundCTO.longitude);

          // Adicionar TODAS as CTOs pesquisadas à lista (sem verificar duplicatas)
          searchedCTOsList.push({ cto: foundCTO, lat, lng });
          foundCount++;
        }
      }
      
      console.log(`📊 Resumo da busca:`);
      console.log(`   - CTOs pesquisadas pelo usuário: ${ctoNames.length}`);
      console.log(`   - CTOs encontradas e adicionadas: ${foundCount}`);
      console.log(`   - CTOs não encontradas: ${notFoundCount}`);
      console.log(`   - CTOs ignoradas (sem coordenadas): ${skippedCoordinatesCount}`);
      console.log(`   - CTOs com duplicatas: ${duplicatedCTOs.length}`);

      if (searchedCTOsList.length === 0) {
        error = 'Nenhuma CTO encontrada. Verifique os nomes digitados.';
        loadingCTOs = false;
        return;
      }

      // Se houver CTOs duplicadas, mostrar mensagem informativa
      if (duplicatedCTOs.length > 0) {
        // Construir mensagem detalhada sobre as duplicatas
        let duplicatasMessage = 'CTOs duplicadas na base de dados:\n\n';
        for (const dup of duplicatedCTOs) {
          duplicatasMessage += `• ${dup.nome} (${dup.quantidade} ocorrências):\n`;
          for (const caminho of dup.caminhos) {
            duplicatasMessage += `  - ${caminho.cidade} | ${caminho.pop} | ${caminho.chasse} | ${caminho.placa} | ${caminho.olt}\n`;
          }
        }
        error = duplicatasMessage.trim();
        console.log(`ℹ️ ${duplicatasMessage}`);
      } else {
        // Limpar erro se não houver duplicatas
        error = null;
      }

      console.log(`✅ ${searchedCTOsList.length} CTO(s) pesquisada(s) encontrada(s)`);

      // Armazenar as chaves das CTOs pesquisadas pelo usuário
      searchedCTOKeys.clear();
      for (const { cto } of searchedCTOsList) {
        const ctoKey = getCTOKey(cto);
        searchedCTOKeys.add(ctoKey);
      }

      // Criar marcadores azuis para TODAS as CTOs pesquisadas
      // Usando AdvancedMarkerElement (API moderna recomendada pelo Google)
      if (map) {
        for (const { cto, lat, lng } of searchedCTOsList) {
          // Criar ícone personalizado usando PinElement
          const pinElement = new google.maps.marker.PinElement({
            background: '#4285F4', // Azul do Google Maps
            borderColor: '#FFFFFF',
            glyphColor: '#FFFFFF',
            scale: 1.2
          });
          
          const marker = new google.maps.marker.AdvancedMarkerElement({
            map: map,
            position: { lat, lng },
            title: `CTO pesquisada: ${cto.nome}`,
            content: pinElement.element,
            zIndex: 999
          });
          searchMarkers.push(marker);
        }
        
        // Criar mancha usando APENAS as CTOs encontradas na pesquisa
        const foundCTOs = searchedCTOsList.map(({ cto }) => cto);
        
        // Agrupar CTOs que se intersectam
        const groups = groupCTOsByIntersection(foundCTOs);
        
        console.log(`🔍 Agrupamento: ${groups.length} grupo(s) de CTOs identificado(s)`);
        
        // Processar cada grupo
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
          const group = groups[groupIndex];
          
          if (group.length === 1) {
            // Grupo com 1 CTO: criar círculo individual (método antigo)
            const cto = group[0];
            // Encontrar a CTO correspondente em searchedCTOsList para obter lat/lng
            // Usar comparação de coordenadas para encontrar a correspondente
            const searchedCTO = searchedCTOsList.find(({ cto: c }) => {
              const ctoLat = parseFloat(cto.latitude);
              const ctoLng = parseFloat(cto.longitude);
              const cLat = parseFloat(c.latitude);
              const cLng = parseFloat(c.longitude);
              return Math.abs(ctoLat - cLat) < 0.0001 && Math.abs(ctoLng - cLng) < 0.0001;
            });
            
            if (searchedCTO) {
              const { lat, lng } = searchedCTO;
          const circle = new google.maps.Circle({
                strokeColor: '#7B68EE',
                strokeOpacity: 0.6,
            strokeWeight: 2,
                fillColor: '#6495ED',
                fillOpacity: 0.08,
                map: showRadiusCircles ? map : null,
            center: { lat, lng },
                radius: 250,
                zIndex: 1
          });
          radiusCircles.push(circle);
              console.log(`✅ Grupo ${groupIndex + 1} (1 CTO): Círculo individual criado (método antigo)`);
            } else {
              console.warn(`⚠️ Grupo ${groupIndex + 1}: CTO não encontrada em searchedCTOsList`);
            }
          } else {
            // Grupo com 2+ CTOs: usar função SQL do Supabase (polígono fundido)
            console.log(`🔍 Grupo ${groupIndex + 1} (${group.length} CTOs): Círculos se intersectam - usando função SQL do Supabase`);
            try {
              const polygonResponse = await fetch(getApiUrl('/api/coverage/calculate-polygon-for-ctos'), {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ ctos: group })
              });
              
              if (polygonResponse.ok) {
                const polygonData = await polygonResponse.json();
                
                if (polygonData.success && polygonData.geometry) {
                  // Converter GeoJSON para Google Maps Polygon
                  const coordinates = polygonData.geometry.coordinates[0].map(coord => ({
                    lat: coord[1],
                    lng: coord[0]
                  }));
                  
                  const polygon = new google.maps.Polygon({
                    paths: coordinates,
                    strokeColor: '#7B68EE',
                    strokeOpacity: 0.6,
                    strokeWeight: 2,
                    fillColor: '#6495ED',
                    fillOpacity: 0.08,
                    map: showRadiusCircles ? map : null,
                    zIndex: 1,
                    geodesic: true
                  });
                  
                  radiusPolygons.push(polygon);
                  console.log(`✅ Grupo ${groupIndex + 1} (${group.length} CTOs): Polígono fundido criado no backend`);
                } else {
                  console.warn(`⚠️ Grupo ${groupIndex + 1}: Resposta do backend não contém polígono válido`);
                }
              } else {
                console.error(`❌ Grupo ${groupIndex + 1}: Erro ao calcular polígono no backend:`, polygonResponse.status);
              }
            } catch (polygonErr) {
              console.error(`❌ Grupo ${groupIndex + 1}: Erro ao chamar endpoint de cálculo de polígono:`, polygonErr);
            }
          }
        }
        
        console.log(`✅ Processamento completo: ${radiusPolygons.length} polígono(s) fundido(s) + ${radiusCircles.length} círculo(s) individual(is)`);
      }

      // ETAPA 2: Para CADA CTO pesquisada, buscar todas as próximas dentro de 250m
      const nearbyPromises = searchedCTOsList.map(({ cto, lat, lng }) =>
        fetch(getApiUrl(`/api/ctos/nearby?lat=${lat}&lng=${lng}&radius=250`))
          .then(response => response.json())
          .then(nearbyData => ({ cto, nearbyData, lat, lng }))
          .catch(err => {
            console.error(`Erro ao buscar CTOs próximas de "${cto.nome}":`, err);
            return { cto, nearbyData: null, lat, lng };
          })
      );

      const nearbyResults = await Promise.all(nearbyPromises);

      // ETAPA 3: Processar resultados e adicionar CTOs próximas (evitando duplicatas com pesquisadas e entre si)
      // Criar Set de chaves das CTOs pesquisadas para evitar duplicatas
      const searchedKeysSetForNearby = new Set();
      searchedCTOsList.forEach(({ cto }) => {
        const key = `${parseFloat(cto.latitude).toFixed(6)},${parseFloat(cto.longitude).toFixed(6)}`;
        searchedKeysSetForNearby.add(key);
      });
      
      let totalNearbyFound = 0;
      let totalAddedToMap = 0;
      let totalSkippedDuplicates = 0;
      
      for (const { nearbyData, lat, lng, cto: searchedCto } of nearbyResults) {
        if (nearbyData?.success && nearbyData.ctos) {
          // Filtrar apenas CTOs dentro de 250m (garantir precisão)
          const nearbyCTOs = nearbyData.ctos.filter(cto => {
            if (!cto.latitude || !cto.longitude) return false;
            const distance = calculateDistance(lat, lng, parseFloat(cto.latitude), parseFloat(cto.longitude));
            return distance <= 250;
          });

          totalNearbyFound += nearbyCTOs.length;
          console.log(`📍 Para CTO "${searchedCto?.nome || 'N/A'}": ${nearbyCTOs.length} CTOs próximas encontradas na API`);

          // Adicionar CTOs próximas (evitando duplicatas com as pesquisadas e entre si)
          let addedThisRound = 0;
          let skippedThisRound = 0;
          for (const cto of nearbyCTOs) {
            const ctoNearbyKey = `${parseFloat(cto.latitude).toFixed(6)},${parseFloat(cto.longitude).toFixed(6)}`;
            // Não adicionar se já está nas pesquisadas ou já foi adicionada como próxima
            if (!searchedKeysSetForNearby.has(ctoNearbyKey) && !allCTOsMap.has(ctoNearbyKey)) {
              allCTOsMap.set(ctoNearbyKey, cto);
              totalAddedToMap++;
              addedThisRound++;
            } else {
              skippedThisRound++;
              totalSkippedDuplicates++;
            }
          }
          console.log(`   → Adicionadas: ${addedThisRound}, Ignoradas (duplicatas): ${skippedThisRound}`);
        } else {
          console.warn(`⚠️ Erro ao buscar CTOs próximas para "${searchedCto?.nome || 'N/A'}":`, nearbyData);
        }
      }
      
      console.log(`📊 Resumo da consolidação:`);
      console.log(`   - Total de CTOs próximas encontradas (com duplicatas): ${totalNearbyFound}`);
      console.log(`   - CTOs únicas adicionadas ao Map: ${totalAddedToMap}`);
      console.log(`   - CTOs ignoradas (duplicatas): ${totalSkippedDuplicates}`);
      console.log(`   - Tamanho do Map (apenas próximas): ${allCTOsMap.size}`);

      // ETAPA 4: Organizar resultado final - TODAS as CTOs pesquisadas primeiro, depois próximas
      // Criar Set de chaves das CTOs pesquisadas para evitar duplicatas nas próximas
      const searchedKeysSet = new Set();
      searchedCTOsList.forEach(({ cto }) => {
        const key = `${parseFloat(cto.latitude).toFixed(6)},${parseFloat(cto.longitude).toFixed(6)}`;
        searchedKeysSet.add(key);
      });

      // Separar CTOs pesquisadas (TODAS, incluindo com coordenadas duplicadas) e próximas
      // IMPORTANTE: Manter TODAS as CTOs pesquisadas, mesmo que tenham o mesmo nome
      // - Se têm mesmas coordenadas: serão agrupadas no mapa (comportamento normal)
      // - Se têm coordenadas diferentes: serão plotadas separadamente em suas respectivas coordenadas
      const searchedCTOs = searchedCTOsList.map(({ cto }) => cto); // TODAS as pesquisadas, na ordem que foram pesquisadas
      const nearbyCTOs = [];
      
      // Processar todas as CTOs próximas do Map (já filtradas para evitar duplicatas com pesquisadas)
      for (const cto of allCTOsMap.values()) {
        nearbyCTOs.push(cto);
      }

      // Resultado final: TODAS as CTOs pesquisadas primeiro (na ordem pesquisada), depois próximas
      // IMPORTANTE: Todas as CTOs pesquisadas aparecem, mesmo com coordenadas duplicadas ou mesmo nome
      // O mapa agrupa apenas por coordenadas, então CTOs com mesmo nome mas coordenadas diferentes
      // serão plotadas separadamente em suas respectivas posições
      ctos = [...searchedCTOs, ...nearbyCTOs];
      
      // Expandir tabela automaticamente quando houver resultados
      if (ctos.length > 0) {
        isTableMinimized = false;
      }
      
      // Inicializar visibilidade de todas as CTOs como verdadeira (todas visíveis por padrão)
      ctoVisibility.clear();
      for (const cto of ctos) {
        const ctoKey = getCTOKey(cto);
        if (!ctoVisibility.has(ctoKey)) {
          ctoVisibility.set(ctoKey, true); // Todas visíveis por padrão
        }
      }
      // Quando CTOs são encontradas, usar ordem visual e limpar ordem de marcação
      useVisualOrder = true;
      ctoMarkOrder = new Map();
      markOrderCounter = 0;
      ctoVisibility = ctoVisibility; // Forçar reatividade
      ctoNumbersVersion++; // Forçar atualização da numeração
      
      // Aguardar a reatividade do Svelte recalcular ctoNumbers antes de atualizar o mapa
      await tick();
      // Aguardar múltiplos ticks para garantir que a reatividade processou tudo
      for (let i = 0; i < 3; i++) {
        await tick();
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Verificar se ctoNumbers foi populado antes de atualizar o mapa
      if (ctoNumbers.size > 0) {
        await displayResultsOnMap();
      } else {
        console.warn('ctoNumbers ainda está vazio após busca, tentando novamente...');
        await new Promise(resolve => setTimeout(resolve, 300));
        if (ctoNumbers.size > 0) {
          await displayResultsOnMap();
        } else {
          console.error('Erro: ctoNumbers não foi populado após busca. Forçando recálculo...');
          // Forçar recálculo manual
          ctoNumbers = calculateCTONumbers();
          if (ctoNumbers.size > 0) {
            await displayResultsOnMap();
          }
        }
      }

      console.log(`✅ Total final: ${searchedCTOs.length} CTO(s) pesquisada(s) + ${nearbyCTOs.length} CTO(s) próxima(s) = ${ctos.length} CTO(s) no total`);
      console.log(`📋 CTOs pesquisadas na lista: ${searchedCTOsList.length}, CTOs pesquisadas no resultado: ${searchedCTOs.length}, CTOs próximas: ${nearbyCTOs.length}`);
      console.log(`📝 Nomes das CTOs pesquisadas:`, searchedCTOs.map(cto => cto.nome).join(', '));
      console.log(`🔍 Verificação: Array ctos tem ${ctos.length} elementos`);
      
      // Forçar recálculo dos totais após adicionar todas as CTOs
      // Isso garante que os totais sejam calculados para todas as CTOs, incluindo duplicatas
      await calculateCaminhoRedeTotals();
      
      // Verificar se há duplicatas
      const uniqueKeys = new Set();
      let duplicates = 0;
      for (const cto of ctos) {
        const key = `${parseFloat(cto.latitude).toFixed(6)},${parseFloat(cto.longitude).toFixed(6)}`;
        if (uniqueKeys.has(key)) {
          duplicates++;
        } else {
          uniqueKeys.add(key);
        }
      }
      if (duplicates > 0) {
        console.warn(`⚠️ Encontradas ${duplicates} CTOs duplicadas no resultado final`);
      }

      if (ctos.length === 0) {
        error = 'Nenhuma CTO encontrada. Verifique os nomes digitados.';
        loadingCTOs = false;
        return;
      }

      // Os marcadores e círculos já foram criados acima
      // Limpar marcador único anterior se existir (compatibilidade)
      if (searchMarker) {
        searchMarker.setMap(null);
        searchMarker = null;
      }
      
      // Aguardar um pouco para garantir que o DOM está atualizado
      await tick();
      // Não chamar clearMap() aqui, pois já criamos os marcadores e círculos das CTOs pesquisadas
      // displayResultsOnMap() vai criar os marcadores das CTOs próximas, mas não deve limpar os círculos
      await displayResultsOnMap();
    } catch (err) {
      console.error('Erro ao buscar CTOs:', err);
      error = 'Erro ao buscar CTOs. Tente novamente.';
    } finally {
      loadingCTOs = false;
    }
  }

  // Função para detectar se o input é coordenadas (lat, lng) ou endereço
  function parseCoordinatesOrAddress(input) {
    const trimmed = input.trim();
    
    // Tentar detectar formato de coordenadas com múltiplos separadores:
    // - "lat, lng" ou "lat,lng" (vírgula)
    // - "lat; lng" ou "lat;lng" (ponto e vírgula)
    // - "lat lng" (espaço) - NOVO!
    // Suporta números decimais com ponto ou vírgula
    // Padrão: número opcionalmente com decimais, separador (vírgula/ponto e vírgula/espaço), número opcionalmente com decimais
    const coordPatternWithComma = /^-?\d+([.,]\d+)?\s*[,;]\s*-?\d+([.,]\d+)?$/;
    const coordPatternWithSpace = /^-?\d+([.,]\d+)?\s+-?\d+([.,]\d+)?$/;
    
    // Tentar primeiro com vírgula ou ponto e vírgula
    if (coordPatternWithComma.test(trimmed)) {
      // Dividir pela primeira vírgula ou ponto e vírgula encontrada (separador entre lat e lng)
      const separatorIndex = trimmed.search(/[,;]/);
      if (separatorIndex > 0) {
        const latStr = trimmed.substring(0, separatorIndex).trim().replace(',', '.');
        const lngStr = trimmed.substring(separatorIndex + 1).trim().replace(',', '.');
        
        const lat = parseFloat(latStr);
        const lng = parseFloat(lngStr);
        
        // Validar se são coordenadas válidas
        if (!isNaN(lat) && !isNaN(lng) && 
            lat >= -90 && lat <= 90 && 
            lng >= -180 && lng <= 180) {
          console.log(`✅ Coordenadas parseadas (com vírgula): "${trimmed}" → lat: ${lat}, lng: ${lng}`);
          return { isCoordinates: true, lat, lng };
        } else {
          console.warn(`⚠️ Coordenadas inválidas: "${trimmed}" → lat: ${lat}, lng: ${lng}`);
        }
      }
    }
    // Tentar com espaço como separador
    else if (coordPatternWithSpace.test(trimmed)) {
      // Dividir por espaço (um ou mais espaços)
      const parts = trimmed.split(/\s+/).filter(p => p.length > 0);
      if (parts.length >= 2) {
        // Pegar os dois primeiros números (lat e lng)
        const latStr = parts[0].replace(',', '.');
        const lngStr = parts[1].replace(',', '.');
        
        const lat = parseFloat(latStr);
        const lng = parseFloat(lngStr);
        
        // Validar se são coordenadas válidas
        if (!isNaN(lat) && !isNaN(lng) && 
            lat >= -90 && lat <= 90 && 
            lng >= -180 && lng <= 180) {
          console.log(`✅ Coordenadas parseadas (com espaço): "${trimmed}" → lat: ${lat}, lng: ${lng}`);
          return { isCoordinates: true, lat, lng };
        } else {
          console.warn(`⚠️ Coordenadas inválidas (espaço): "${trimmed}" → lat: ${lat}, lng: ${lng}`);
        }
      }
    }
    
    // Se não for coordenadas, tratar como endereço
    return { isCoordinates: false, address: trimmed };
  }

  // Função para buscar CTOs por endereço ou coordenadas
  async function searchByEndereco() {
    if (!enderecoInput.trim()) {
      error = 'Por favor, insira um endereço ou coordenadas (lat, lng)';
      return;
    }

    loadingCTOs = true;
    error = null;
    ctos = [];
    // Limpar CTOs pesquisadas quando iniciar nova busca
    searchedCTOKeys.clear();
    // Minimizar tabela quando limpar resultados
    isTableMinimized = true;
    clearMap();

    try {
      // Verificar se o mapa está inicializado
      if (!map) {
        initMap();
        await tick();
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Separar múltiplos endereços/coordenadas de forma inteligente
      // Estratégia: primeiro dividir por separadores seguros (quebra de linha, ponto e vírgula)
      // Depois, para cada linha, verificar se é uma coordenada completa
      let addressesInputs = [];
      
      // Dividir por quebra de linha ou ponto e vírgula primeiro (separadores seguros)
      const lines = enderecoInput.split(/[;\n]/).map(line => line.trim()).filter(line => line.length > 0);
      
      // Se não encontrou separadores seguros, tratar o input inteiro como uma única entrada
      if (lines.length === 0) {
        lines.push(enderecoInput.trim());
      }
      
      for (const line of lines) {
        // Verificar se a linha inteira é uma coordenada válida
        const parsed = parseCoordinatesOrAddress(line);
        if (parsed.isCoordinates) {
          // É uma coordenada completa, adicionar como está
          addressesInputs.push(line);
          console.log(`✅ Linha identificada como coordenada: "${line}"`);
        } else {
          // Não é coordenada completa, pode ser:
          // 1. Um endereço textual
          // 2. Múltiplas coordenadas na mesma linha separadas por vírgula ou espaço
          // Tentar detectar se são múltiplas coordenadas (padrão: números, vírgulas, pontos, espaços, hífens)
          if (/^[\d\s,.-]+$/.test(line)) {
            let parts = [];
            let hasComma = line.includes(',');
            
            if (hasComma) {
              // Dividir por vírgula
              parts = line.split(',').map(p => p.trim()).filter(p => p.length > 0);
            } else {
              // Dividir por espaço (um ou mais espaços)
              parts = line.split(/\s+/).filter(p => p.length > 0);
            }
            
            if (parts.length >= 2 && parts.length % 2 === 0) {
              // Número par de partes, agrupar em pares (lat, lng)
              let allValid = true;
              const validPairs = [];
              
              for (let i = 0; i < parts.length; i += 2) {
                // Criar par usando o separador original (vírgula ou espaço)
                const coordPair = hasComma 
                  ? `${parts[i]},${parts[i + 1]}`
                  : `${parts[i]} ${parts[i + 1]}`;
                
                // Verificar se o par é uma coordenada válida
                const pairParsed = parseCoordinatesOrAddress(coordPair);
                if (pairParsed.isCoordinates) {
                  validPairs.push(coordPair);
                  console.log(`✅ Par de coordenadas identificado: "${coordPair}"`);
                } else {
                  // Par inválido
                  allValid = false;
                  console.log(`⚠️ Par inválido: "${coordPair}"`);
                  break; // Parar de processar pares
                }
              }
              
              if (allValid && validPairs.length > 0) {
                // Todos os pares são válidos, adicionar todos
                addressesInputs.push(...validPairs);
                console.log(`✅ ${validPairs.length} par(es) de coordenadas identificado(s)`);
              } else {
                // Algum par inválido, tratar como endereço
                addressesInputs.push(line);
                console.log(`⚠️ Algum par inválido, tratando linha inteira como endereço: "${line}"`);
              }
            } else {
              // Número ímpar de partes ou formato inválido, tratar como endereço único
              addressesInputs.push(line);
              console.log(`ℹ️ Linha tratada como endereço (número ímpar de partes): "${line}"`);
            }
          } else {
            // Parece ser um endereço textual, adicionar como está
            addressesInputs.push(line);
            console.log(`ℹ️ Linha tratada como endereço textual: "${line}"`);
          }
        }
      }

      if (addressesInputs.length === 0) {
        error = 'Por favor, insira pelo menos um endereço ou coordenadas';
        loadingCTOs = false;
        return;
      }
      
      console.log(`📋 Total de entradas processadas: ${addressesInputs.length}`, addressesInputs);

      console.log(`🔍 Buscando ${addressesInputs.length} endereço(s)/coordenada(s):`, addressesInputs);

      // Processar cada endereço/coordenada em paralelo
      const searchPromises = addressesInputs.map(async (input) => {
        try {
          const parsed = parseCoordinatesOrAddress(input);
          let lat, lng;
          let title;

          if (parsed.isCoordinates) {
            // É coordenadas - usar diretamente
            lat = parsed.lat;
            lng = parsed.lng;
            title = `Coordenadas: ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
            console.log(`✅ Coordenadas detectadas: ${lat}, ${lng}`);
          } else {
            // É endereço - geocodificar (precisa do Google Maps carregado)
            if (!googleMapsLoaded || !google.maps || !google.maps.Geocoder) {
              throw new Error('Google Maps não está carregado. Aguarde alguns instantes e tente novamente.');
            }
            const result = await geocodeAddress(parsed.address);
            const location = result.geometry.location;
            lat = location.lat();
            lng = location.lng();
            title = `Endereço: ${parsed.address}`;
            console.log(`✅ Endereço geocodificado: ${parsed.address} → ${lat}, ${lng}`);
          }

          return { lat, lng, title, input };
        } catch (err) {
          console.error(`❌ Erro ao processar "${input}":`, err);
          return null;
        }
      });

      const searchResults = await Promise.all(searchPromises);
      const validPoints = searchResults.filter(result => result !== null);

      if (validPoints.length === 0) {
        error = 'Nenhum endereço ou coordenada válida encontrada. Verifique os valores digitados.';
        loadingCTOs = false;
        return;
      }

      console.log(`✅ ${validPoints.length} ponto(s) válido(s) encontrado(s)`);

      // Criar marcadores e círculos para cada ponto pesquisado
      // Usando AdvancedMarkerElement (API moderna recomendada pelo Google)
      if (map) {
        for (const { lat, lng, title } of validPoints) {
          // Marcador azul para o ponto pesquisado
          // Criar ícone personalizado usando PinElement
          const pinElement = new google.maps.marker.PinElement({
            background: '#4285F4', // Azul do Google Maps
            borderColor: '#FFFFFF',
            glyphColor: '#FFFFFF',
            scale: 1.2
          });
          
          const marker = new google.maps.marker.AdvancedMarkerElement({
            map: map,
            position: { lat, lng },
            title: title,
            content: pinElement.element,
            zIndex: 999
          });
          searchMarkers.push(marker);
        }
      }

      // Buscar CTOs próximas de cada ponto (em paralelo)
      // Estratégia: primeiro tentar 250m, se não encontrar, expandir para 500m, depois 700m
      const searchRadii = [250, 500, 700]; // Raios progressivos
      
      const nearbyPromises = validPoints.map(async ({ lat, lng }) => {
        let lastData = null;
        let lastRadius = 250;
        
        // Tentar cada raio progressivamente até encontrar CTOs
        for (const radius of searchRadii) {
          try {
            const response = await fetch(getApiUrl(`/api/ctos/nearby?lat=${lat}&lng=${lng}&radius=${radius}`));
            if (!response.ok) continue;
            
            const data = await response.json();
            if (data?.success && data.ctos) {
              // Se encontrou CTOs (mesmo que sejam poucas), usar este resultado
              // Não verificar length > 0 aqui, pois pode ter CTOs que serão filtradas depois
              // O importante é ter um resultado válido da API
              return { data, lat, lng, searchRadius: radius };
            }
            // Guardar último resultado válido
            if (data?.success) {
              lastData = data;
              lastRadius = radius;
            }
          } catch (err) {
            console.error(`Erro ao buscar CTOs próximas de ${lat}, ${lng} com raio ${radius}m:`, err);
            continue;
          }
        }
        
        // Se não encontrou resultado válido em nenhum raio, retornar último resultado (pode estar vazio)
        return { data: lastData, lat, lng, searchRadius: lastRadius };
      });

      const nearbyResults = await Promise.all(nearbyPromises);

      // Mapear cada endereço para suas CTOs encontradas
      const pointToCTOsMap = new Map(); // Map<pointKey, CTO[]>
      const allCTOsMap = new Map(); // Chave: coordenadas para evitar duplicatas (para a tabela)
      
      for (let i = 0; i < validPoints.length; i++) {
        const point = validPoints[i];
        const { data, lat, lng, searchRadius = 250 } = nearbyResults[i];
        const pointKey = `${lat.toFixed(6)},${lng.toFixed(6)}`;
        
        if (data?.success && data.ctos) {
          // Filtrar CTOs usando o raio real da busca (pode ser 250m, 500m ou 700m)
          const nearbyCTOs = data.ctos.filter(cto => {
            if (!cto.latitude || !cto.longitude) return false;
            const distance = calculateDistance(lat, lng, parseFloat(cto.latitude), parseFloat(cto.longitude));
            // Aceitar CTOs dentro do raio da busca (pode ser 250m, 500m, 700m, etc.)
            return distance <= searchRadius;
          });

          // Armazenar CTOs deste ponto
          pointToCTOsMap.set(pointKey, nearbyCTOs);

          // Adicionar CTOs ao Map global (evitando duplicatas para a tabela)
          for (const cto of nearbyCTOs) {
            const ctoKey = `${parseFloat(cto.latitude).toFixed(6)},${parseFloat(cto.longitude).toFixed(6)}`;
            if (!allCTOsMap.has(ctoKey)) {
              allCTOsMap.set(ctoKey, cto);
            }
          }
        } else {
          // Nenhuma CTO encontrada para este ponto
          pointToCTOsMap.set(pointKey, []);
        }
      }

      // Converter Map para array (para a tabela)
      const foundCTOs = Array.from(allCTOsMap.values());
      
      // Criar mancha usando a mesma lógica da pesquisa por nome: baseada nos ENDEREÇOS pesquisados
      // A mancha é o círculo de 250m do endereço pesquisado, não das CTOs encontradas
      if (validPoints.length > 0 && map) {
        // Se 1 endereço: criar círculo de 250m centrado no endereço (método antigo)
        if (validPoints.length === 1) {
          const point = validPoints[0];
          const circle = new google.maps.Circle({
            strokeColor: '#7B68EE',
            strokeOpacity: 0.6,
            strokeWeight: 2,
            fillColor: '#6495ED',
            fillOpacity: 0.08,
            map: showRadiusCircles ? map : null,
            center: { lat: point.lat, lng: point.lng },
            radius: 250,
            zIndex: 1
          });
          radiusCircles.push(circle);
          console.log(`✅ 1 endereço pesquisado: 1 círculo de 250m criado (método antigo)`);
        } else {
          // Múltiplos endereços: agrupar por interseção
          const groups = groupPointsByIntersection(validPoints);
          
          console.log(`🔍 Agrupamento: ${groups.length} grupo(s) de endereços identificado(s)`);
          
          // Processar cada grupo
          for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            const group = groups[groupIndex];
            
            if (group.length === 1) {
              // Grupo com 1 endereço: criar círculo de 250m centrado no endereço (método antigo)
              const point = group[0];
              const circle = new google.maps.Circle({
                strokeColor: '#7B68EE',
                strokeOpacity: 0.6,
                strokeWeight: 2,
                fillColor: '#6495ED',
                fillOpacity: 0.08,
                map: showRadiusCircles ? map : null,
                center: { lat: point.lat, lng: point.lng },
                radius: 250,
                zIndex: 1
              });
              radiusCircles.push(circle);
              console.log(`✅ Grupo ${groupIndex + 1} (1 endereço): 1 círculo de 250m criado (método antigo)`);
            } else {
              // Grupo com 2+ endereços: usar função SQL do Supabase (polígono fundido)
              // Criar objetos "falsos" de CTO com apenas lat/lng dos endereços para usar a função SQL
              const fakeCTOs = group.map((point, index) => ({
                latitude: point.lat.toString(),
                longitude: point.lng.toString(),
                nome: `Endereço ${index + 1}` // Nome fictício, não usado no cálculo
              }));
              
              console.log(`🔍 Grupo ${groupIndex + 1} (${group.length} endereços): Círculos se intersectam - usando função SQL do Supabase`);
              try {
                const polygonResponse = await fetch(getApiUrl('/api/coverage/calculate-polygon-for-ctos'), {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ ctos: fakeCTOs })
                });
                
                if (polygonResponse.ok) {
                  const polygonData = await polygonResponse.json();
                  
                  if (polygonData.success && polygonData.geometry) {
                    // Converter GeoJSON para Google Maps Polygon
                    const coordinates = polygonData.geometry.coordinates[0].map(coord => ({
                      lat: coord[1],
                      lng: coord[0]
                    }));
                    
                    const polygon = new google.maps.Polygon({
                      paths: coordinates,
                      strokeColor: '#7B68EE',
                      strokeOpacity: 0.6,
                      strokeWeight: 2,
                      fillColor: '#6495ED',
                      fillOpacity: 0.08,
                      map: showRadiusCircles ? map : null,
                      zIndex: 1,
                      geodesic: true
                    });
                    
                    radiusPolygons.push(polygon);
                    console.log(`✅ Grupo ${groupIndex + 1}: Polígono fundido criado no backend para ${group.length} endereço(s)`);
                  } else {
                    console.warn(`⚠️ Grupo ${groupIndex + 1}: Resposta do backend não contém polígono válido`);
                  }
                } else {
                  console.error(`❌ Grupo ${groupIndex + 1}: Erro ao calcular polígono no backend:`, polygonResponse.status);
                }
              } catch (polygonErr) {
                console.error(`❌ Grupo ${groupIndex + 1}: Erro ao chamar endpoint de cálculo de polígono:`, polygonErr);
              }
            }
          }
        }
      }
      
      // Usar as CTOs encontradas para a tabela
      ctos = foundCTOs;

      // Calcular raio máximo usado na busca para a mensagem de log
      const maxRadiusUsed = nearbyResults.reduce((max, result) => {
        return Math.max(max, result.searchRadius || 250);
      }, 250);

      console.log(`📍 Busca por endereço/coordenadas: ${ctos.length} CTOs únicas encontradas (raio máximo usado: ${maxRadiusUsed}m)`);

      // Inicializar visibilidade de todas as CTOs como verdadeira (todas visíveis por padrão)
      ctoVisibility.clear();
      for (const cto of ctos) {
        const ctoKey = getCTOKey(cto);
        if (!ctoVisibility.has(ctoKey)) {
          ctoVisibility.set(ctoKey, true); // Todas visíveis por padrão
        }
      }
      // Quando CTOs são encontradas, usar ordem visual e limpar ordem de marcação
      useVisualOrder = true;
      ctoMarkOrder = new Map();
      markOrderCounter = 0;
      ctoVisibility = ctoVisibility; // Forçar reatividade
      ctoNumbersVersion++; // Forçar atualização da numeração
      
      // Aguardar a reatividade do Svelte recalcular ctoNumbers antes de atualizar o mapa
      await tick();
      // Aguardar múltiplos ticks para garantir que a reatividade processou tudo
      for (let i = 0; i < 3; i++) {
        await tick();
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Verificar se ctoNumbers foi populado antes de atualizar o mapa
      if (ctoNumbers.size > 0) {
        await displayResultsOnMap();
      } else {
        console.warn('ctoNumbers ainda está vazio após busca, tentando novamente...');
        await new Promise(resolve => setTimeout(resolve, 300));
        if (ctoNumbers.size > 0) {
          await displayResultsOnMap();
        } else {
          console.error('Erro: ctoNumbers não foi populado após busca. Forçando recálculo...');
          // Forçar recálculo manual
          ctoNumbers = calculateCTONumbers();
          if (ctoNumbers.size > 0) {
            await displayResultsOnMap();
          }
        }
      }

      if (ctos.length === 0) {
        // Calcular raio máximo usado para a mensagem de erro
        const maxRadiusUsed = nearbyResults.reduce((max, result) => {
          return Math.max(max, result.searchRadius || 250);
        }, 250);
        error = `Nenhuma CTO encontrada dentro de ${maxRadiusUsed}m dos pontos pesquisados.`;
        loadingCTOs = false;
        return;
      }

      // Limpar marcador único anterior se existir (compatibilidade)
      if (searchMarker) {
        searchMarker.setMap(null);
        searchMarker = null;
      }
      
      // Aguardar um pouco para garantir que o DOM está atualizado
      await tick();
      // Exibir CTOs no mapa (isso vai ajustar o zoom automaticamente)
      await displayResultsOnMap();
      
      // Se não houver CTOs, centralizar no primeiro ponto pesquisado
      if (ctos.length === 0 && map && validPoints.length > 0) {
        const firstPoint = validPoints[0];
        map.setCenter({ lat: firstPoint.lat, lng: firstPoint.lng });
        map.setZoom(15);
      }
    } catch (err) {
      console.error('Erro ao buscar por endereço/coordenadas:', err);
      error = err.message || 'Erro ao processar endereço ou coordenadas. Verifique se os dados estão corretos.';
    } finally {
      loadingCTOs = false;
    }
  }

  // Função principal de busca
  async function handleSearch() {
    if (searchMode === 'nome') {
      await searchByNome();
    } else if (searchMode === 'endereco') {
      await searchByEndereco();
    }
  }

  // Função para mostrar/ocultar círculos de 250m
  function toggleRadiusCircles() {
    showRadiusCircles = !showRadiusCircles;
    radiusCircles.forEach(circle => {
      if (circle && circle.setMap) {
        if (showRadiusCircles) {
          circle.setMap(map);
        } else {
          circle.setMap(null);
        }
      }
    });
    
    // Mostrar/ocultar polígonos fundidos também
    radiusPolygons.forEach(polygon => {
      if (polygon && polygon.setMap) {
        if (showRadiusCircles) {
          polygon.setMap(map);
        } else {
          polygon.setMap(null);
        }
      }
    });
  }
  
  // Funções de cálculo de polígonos removidas - agora são calculadas no backend
  // via endpoint /api/coverage/calculate-polygon-for-ctos (igual ao MapaConsulta.svelte)

  // Função para exibir resultados no mapa (estilo ViabilidadeAlares)
  async function displayResultsOnMap() {
    if (!map || !google.maps) {
      console.error('Mapa não disponível', { map: !!map, googleMaps: !!google.maps });
      return;
    }
    
    if (ctos.length === 0) {
      console.warn('Nenhuma CTO para exibir');
      return;
    }
    
    console.log(`🗺️ Exibindo ${ctos.length} CTOs no mapa (sem limite)`);
    console.log('📊 ctoNumbers size:', ctoNumbers.size);
    console.log('📊 useVisualOrder:', useVisualOrder);

    // Limpar apenas marcadores das CTOs (mantendo círculos e marcadores de busca)
    // Os círculos e marcadores de busca das CTOs pesquisadas devem ser preservados
    markers.forEach(marker => {
      if (marker && marker.setMap) {
        marker.setMap(null);
      }
    });
    markers = [];

    // Evitar múltiplas tentativas simultâneas
    if (isDisplayingMarkers) {
      console.warn('Já está exibindo marcadores, ignorando chamada duplicada');
      return;
    }
    
    // Verificar se ctoNumbers está vazio antes de começar
    // Se estiver vazio, aguardar um pouco e tentar novamente (mas apenas uma vez)
    if (ctoNumbers.size === 0 && ctos.length > 0) {
      console.warn('ctoNumbers está vazio, aguardando recálculo...');
      // Aguardar um pouco e tentar novamente apenas uma vez
      isDisplayingMarkers = true; // Marcar como processando para evitar múltiplas tentativas
      setTimeout(async () => {
        isDisplayingMarkers = false;
        if (ctoNumbers.size > 0) {
          await displayResultsOnMap();
        } else {
          console.warn('ctoNumbers ainda está vazio após aguardar, pulando atualização do mapa.');
        }
      }, 200);
      return;
    }
    
    isDisplayingMarkers = true;

    const bounds = new google.maps.LatLngBounds();
    let markersCreated = 0;
    let markersSkipped = 0;

    // ETAPA 1: Agrupar CTOs por coordenadas (lat/lng idênticas) e filtrar apenas as visíveis
    // Usar a mesma numeração da tabela (ctoNumbers) para garantir sincronização
    const ctosByPosition = new Map(); // Chave: "lat,lng", Valor: Array de CTOs + números
    const ctoToNumber = new Map(); // Mapear CTO para seu número no array
    
    for (let i = 0; i < ctos.length; i++) {
      const cto = ctos[i];
      
      // Verificar se a CTO está marcada como visível
      const ctoKey = getCTOKey(cto);
      const isVisible = ctoVisibility.get(ctoKey) !== false; // Padrão: true (visível)
      
      if (!isVisible) {
        // CTO não está marcada como visível, pular
        markersSkipped++;
        continue;
      }
      
      // Validar coordenadas
      if (!cto.latitude || !cto.longitude || isNaN(cto.latitude) || isNaN(cto.longitude)) {
        console.warn(`⚠️ CTO ${cto.nome} tem coordenadas inválidas:`, cto.latitude, cto.longitude);
        markersSkipped++;
        continue;
      }
      
      // Usar o número da tabela (sincronizado com a lógica de numeração da tabela)
      // A CTO só aparece no mapa se tiver um número na tabela (está numerada)
      const tableNumber = ctoNumbers.get(cto);
      
      // Debug: verificar se o número existe
      if (tableNumber === undefined || tableNumber === null) {
        console.warn(`⚠️ CTO ${cto.nome || ctoKey} não tem número na tabela`, { 
          ctoKey, 
          isVisible, 
          tableNumber,
          ctoNumbersSize: ctoNumbers.size,
          useVisualOrder 
        });
        markersSkipped++;
        continue;
      }
      
      // Converter para número se necessário (caso seja string)
      const numberForMap = typeof tableNumber === 'number' ? tableNumber : parseInt(tableNumber);
      if (isNaN(numberForMap) || numberForMap <= 0) {
        console.warn(`⚠️ CTO ${cto.nome || ctoKey} tem número inválido:`, tableNumber, '->', numberForMap);
        markersSkipped++;
        continue;
      }
      
      const lat = parseFloat(cto.latitude).toFixed(6);
      const lng = parseFloat(cto.longitude).toFixed(6);
      const positionKey = `${lat},${lng}`;
      
      // IMPORTANTE: Agrupar CTOs APENAS por coordenadas (lat/lng), NÃO por nome
      // - CTOs com mesmo nome e mesmas coordenadas: serão agrupadas em um marcador (comportamento normal)
      // - CTOs com mesmo nome mas coordenadas diferentes: serão plotadas separadamente em suas respectivas coordenadas
      // Isso garante que CTOs duplicadas (mesmo nome, diferentes caminhos de rede) sejam visualizadas corretamente
      if (!ctosByPosition.has(positionKey)) {
        ctosByPosition.set(positionKey, { position: { lat: parseFloat(lat), lng: parseFloat(lng) }, ctos: [], numbers: [] });
      }
      
      const group = ctosByPosition.get(positionKey);
      group.ctos.push(cto);
      // Usar o número convertido para o mapa
      group.numbers.push(numberForMap);
      ctoToNumber.set(cto, numberForMap);
    }
    
    console.log(`📊 Agrupamento: ${ctosByPosition.size} posições únicas, ${ctos.length - markersSkipped} CTOs totais`);

    // ETAPA 2: Criar marcadores (um por grupo de coordenadas)
    for (const [positionKey, group] of ctosByPosition) {
      const { position, ctos: groupCTOs, numbers } = group;
      
      bounds.extend(position);
      
      // Determinar cor baseada na primeira CTO do grupo (ou média, pode ajustar depois)
      const firstCTO = groupCTOs[0];
      const ctoColor = getCTOColor(firstCTO.pct_ocup || 0);
      
      // Criar label com todos os números (ex: "1/9" ou "1/9/15")
      const labelText = numbers.join('/');

      try {
        // Criar marcador único para este grupo usando AdvancedMarkerElement
        // Criar elemento HTML customizado para replicar o círculo colorido com label
        const markerElement = document.createElement('div');
        markerElement.style.width = '36px';
        markerElement.style.height = '36px';
        markerElement.style.borderRadius = '50%';
        markerElement.style.backgroundColor = ctoColor;
        markerElement.style.border = '3px solid #000000';
        markerElement.style.display = 'flex';
        markerElement.style.alignItems = 'center';
        markerElement.style.justifyContent = 'center';
        markerElement.style.color = '#FFFFFF';
        markerElement.style.fontSize = '14px';
        markerElement.style.fontWeight = 'bold';
        markerElement.style.fontFamily = 'Arial, sans-serif';
        markerElement.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
        markerElement.style.cursor = 'pointer';
        markerElement.textContent = labelText;
        markerElement.title = `${groupCTOs.length} CTO(s) neste ponto: ${groupCTOs.map(cto => cto.nome).join(', ')}`;
        
        const marker = new google.maps.marker.AdvancedMarkerElement({
          map: map,
          position: position,
          title: `${groupCTOs.length} CTO(s) neste ponto: ${groupCTOs.map(cto => cto.nome).join(', ')}`,
          content: markerElement,
          zIndex: 1000 + numbers[0]
        });
        
        console.log(`Marcador ${labelText} criado para ${groupCTOs.length} CTO(s) em`, position);

        // InfoWindow com informações de TODAS as CTOs do grupo
        let infoWindowContent = '<div style="padding: 8px; font-family: \'Inter\', sans-serif; line-height: 1.6; max-width: 400px;">';
        
        for (let i = 0; i < groupCTOs.length; i++) {
          const cto = groupCTOs[i];
          const pctOcup = parseFloat(cto.pct_ocup) || 0;
          const statusCto = cto.status_cto || '';
          const isAtiva = statusCto && statusCto.toUpperCase().trim() === 'ATIVADO';
          
          // Separador entre múltiplas CTOs
          if (i > 0) {
            infoWindowContent += '<hr style="margin: 16px 0; border: none; border-top: 2px solid #e5e7eb;">';
          }
          
          // Alerta se não está ativa
          if (!isAtiva) {
            infoWindowContent += `
              <div style="background-color: #DC3545; color: white; padding: 12px; margin-bottom: 12px; border-radius: 4px; font-weight: bold; text-align: center;">
                ⚠️ CTO NÃO ATIVA
              </div>
            `;
          }
          
          // Informações da CTO
          infoWindowContent += `
            <div style="margin-bottom: ${i < groupCTOs.length - 1 ? '16px' : '0'};">
              <h4 style="margin: 0 0 8px 0; color: #1e40af; font-size: 16px;">CTO #${numbers[i]}: ${String(cto.nome || 'N/A')}</h4>
              <strong>Cidade:</strong> ${String(cto.cidade || 'N/A')}<br>
              <strong>POP:</strong> ${String(cto.pop || 'N/A')}<br>
              <strong>CHASSE:</strong> ${String(cto.olt || 'N/A')}<br>
              <strong>PLACA:</strong> ${String(cto.slot || 'N/A')}<br>
              <strong>OLT:</strong> ${String(cto.pon || 'N/A')}<br>
              <strong>ID CTO:</strong> ${String(cto.id_cto || cto.id || 'N/A')}<br>
              <strong>Status:</strong> <span style="color: ${isAtiva ? '#28A745' : '#DC3545'}; font-weight: bold;">${String(statusCto || 'N/A')}</span><br>
              <strong>Total de Portas:</strong> ${Number(cto.vagas_total || 0)}<br>
              <strong>Portas Conectadas:</strong> ${Number(cto.clientes_conectados || 0)}<br>
              <strong>Portas Disponíveis:</strong> ${Number((cto.vagas_total || 0) - (cto.clientes_conectados || 0))}<br>
              <strong>Ocupação:</strong> ${pctOcup.toFixed(1)}%<br>
              <strong>Total de Portas no Caminho de Rede:</strong> ${getCaminhoRedeTotal(cto)} (${String(cto.olt || 'N/A')} / ${String(cto.slot || 'N/A')} / ${String(cto.pon || 'N/A')})
            </div>
          `;
        }
        
        infoWindowContent += '</div>';

        const infoWindow = new google.maps.InfoWindow({
          content: infoWindowContent
        });

        // Event listener para AdvancedMarkerElement
        // AdvancedMarkerElement usa addEventListener diretamente no elemento DOM
        markerElement.addEventListener('click', () => {
          infoWindow.open({
            anchor: marker,
            map: map
          });
        });

        markers.push(marker);
        markersCreated++;
      } catch (markerErr) {
        console.error(`❌ Erro ao criar marcador para posição ${positionKey}:`, markerErr);
        markersSkipped++;
      }
    }
    
    console.log(`📊 Resumo: ${markersCreated} marcadores criados, ${markersSkipped} ignorados de ${ctos.length} CTOs totais`);

    // Ajustar zoom para mostrar todos os marcadores
    if (markers.length === 0) {
      console.warn('Nenhum marcador foi criado');
      isDisplayingMarkers = false;
      return;
    }
    
    console.log(`✅ ${markers.length} marcadores criados com sucesso`);
    
    // Aguardar um pouco para garantir que os marcadores foram renderizados
    await tick();
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Ajustar zoom para mostrar todos os marcadores
    try {
      // Forçar redimensionamento do mapa antes de ajustar zoom
      google.maps.event.trigger(map, 'resize');
      await new Promise(resolve => setTimeout(resolve, 200));
      
      if (markers.length > 1) {
        // Usar fitBounds com padding para múltiplos marcadores
        map.fitBounds(bounds, {
          top: 50,
          right: 50,
          bottom: 50,
          left: 50
        });
        console.log('Ajustando zoom para múltiplos marcadores');
      } else if (markers.length === 1) {
        // Centralizar em CTO única
        const singleCto = ctos[0];
        map.setCenter({ lat: parseFloat(singleCto.latitude), lng: parseFloat(singleCto.longitude) });
        map.setZoom(16);
        console.log('Centralizando em CTO única:', singleCto.nome);
      }
    } catch (err) {
      console.warn('Erro ao ajustar zoom:', err);
      // Se falhar, centralizar no primeiro marcador
      if (ctos.length > 0) {
        map.setCenter({ lat: parseFloat(ctos[0].latitude), lng: parseFloat(ctos[0].longitude) });
        map.setZoom(14);
      }
    }
    
    console.log('✅ Marcadores exibidos no mapa com sucesso');
    isDisplayingMarkers = false;
  }

  // Função para formatar porcentagem
  // Função para formatar data de criação (formato: MM/YYYY)
  function formatDataCriacao(cto) {
    const dataCriacao = cto.data_criacao || cto.data_cadastro || cto.created_at || '';
    
    // Log temporário para debug (apenas primeiras 3 CTOs)
    if (ctos.indexOf(cto) < 3) {
      console.log(`🔍 [Frontend] CTO ${ctos.indexOf(cto) + 1} - ID: ${cto.id_cto}, data_criacao:`, dataCriacao, 'tipo:', typeof dataCriacao);
    }
    
    // Verificar se está vazio, null ou undefined
    if (!dataCriacao || dataCriacao === 'null' || dataCriacao === 'undefined' || String(dataCriacao).trim() === '') {
      return 'N/A';
    }
    
    // Se for string, verificar se já está no formato MM/YYYY
    if (typeof dataCriacao === 'string') {
      const dataStr = dataCriacao.trim();
      
      // Verificar se já está no formato MM/YYYY (ex: "04/2023")
      const mmYYYYMatch = dataStr.match(/^(\d{1,2})\/(\d{4})$/);
      if (mmYYYYMatch) {
        const mes = mmYYYYMatch[1].padStart(2, '0');
        const ano = mmYYYYMatch[2];
        return `${mes}/${ano}`;
      }
      
      // Tentar formato YYYY-MM (ex: "2023-04")
      const yyyyMMMatch = dataStr.match(/^(\d{4})-(\d{1,2})$/);
      if (yyyyMMMatch) {
        const ano = yyyyMMMatch[1];
        const mes = yyyyMMMatch[2].padStart(2, '0');
        return `${mes}/${ano}`;
      }
      
      // Tentar formato YYYY-MM-DD (ex: "2023-04-15")
      const yyyyMMDDMatch = dataStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (yyyyMMDDMatch) {
        const ano = yyyyMMDDMatch[1];
        const mes = yyyyMMDDMatch[2].padStart(2, '0');
        return `${mes}/${ano}`;
      }
      
      // Tentar formato DD/MM/YYYY (ex: "15/04/2023")
      const ddMMYYYYMatch = dataStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (ddMMYYYYMatch) {
        const mes = ddMMYYYYMatch[2].padStart(2, '0');
        const ano = ddMMYYYYMatch[3];
        return `${mes}/${ano}`;
      }
      
      // Se não bateu com nenhum padrão conhecido e não é uma string vazia, retornar como está
      if (dataStr.length > 0) {
        return dataStr;
      }
    }
    
    // Tentar converter para Date apenas se não for string ou se não bateu com nenhum padrão
    try {
      const data = new Date(dataCriacao);
      if (!isNaN(data.getTime()) && data.getTime() > 0) {
        // Verificar se a data não é uma data inválida padrão (1970-01-01)
        const ano = data.getFullYear();
        if (ano >= 2000 && ano <= 2100) {
          // Formato: MM/YYYY (apenas mês e ano)
          const mes = String(data.getMonth() + 1).padStart(2, '0');
          return `${mes}/${ano}`;
        }
      }
    } catch (e) {
      // Ignorar erro
    }
    
    // Se não conseguiu formatar, retornar N/A
    return 'N/A';
  }

  function formatPercentage(value) {
    const num = parseFloat(value) || 0;
    return num.toFixed(1) + '%';
  }

  // Funções de redimensionamento
  function startResizeSidebar(e) {
    console.log('🖱️ Iniciando redimensionamento da sidebar', e);
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    isResizingSidebar = true;
    resizeStartX = e.clientX || e.touches?.[0]?.clientX || 0;
    resizeStartSidebarWidth = sidebarWidth;
    document.addEventListener('mousemove', handleResizeSidebar, { passive: false, capture: true });
    document.addEventListener('mouseup', stopResizeSidebar, { passive: false, capture: true });
    document.addEventListener('touchmove', handleResizeSidebar, { passive: false, capture: true });
    document.addEventListener('touchend', stopResizeSidebar, { passive: false, capture: true });
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return false;
  }

  function handleResizeSidebar(e) {
    if (!isResizingSidebar) return;
    e.preventDefault();
    e.stopPropagation();
    
    // Se o painel estiver minimizado, não permitir redimensionamento manual
    if (isSearchPanelMinimized) return;
    
    const clientX = e.clientX || e.touches?.[0]?.clientX || resizeStartX;
    const deltaX = clientX - resizeStartX;
    const newWidth = resizeStartSidebarWidth + deltaX;
    // Limites: mínimo 300px, máximo 700px (ajustado para corresponder ao CSS)
    const clampedWidth = Math.max(300, Math.min(700, newWidth));
    
    // Atualizar diretamente - Svelte detecta automaticamente
    sidebarWidth = clampedWidth;
    
    // Forçar atualização do DOM diretamente também
    const sidebarElement = document.querySelector('.search-panel');
    if (sidebarElement) {
      sidebarElement.style.width = `${clampedWidth}px`;
      sidebarElement.style.flex = '0 0 auto';
    }
    
    console.log(`📏 Arrastando sidebar: ${clampedWidth}px`);
    
    // Salvar no localStorage (sem await para não bloquear)
    try {
      localStorage.setItem('analiseCobertura_sidebarWidth', clampedWidth.toString());
    } catch (err) {
      console.warn('Erro ao salvar largura da sidebar:', err);
    }
  }

  function stopResizeSidebar() {
    console.log('✅ Parando redimensionamento da sidebar');
    isResizingSidebar = false;
    document.removeEventListener('mousemove', handleResizeSidebar, { capture: true });
    document.removeEventListener('mouseup', stopResizeSidebar, { capture: true });
    document.removeEventListener('touchmove', handleResizeSidebar, { capture: true });
    document.removeEventListener('touchend', stopResizeSidebar, { capture: true });
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  function startResizeMapTable(e) {
    console.log('🖱️ Iniciando redimensionamento mapa/tabela', e);
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    isResizingMapTable = true;
    resizeStartY = e.clientY || e.touches?.[0]?.clientY || 0;
    resizeStartMapHeight = mapHeightPixels; // Usar pixels ao invés de percent
    document.addEventListener('mousemove', handleResizeMapTable, { passive: false, capture: true });
    document.addEventListener('mouseup', stopResizeMapTable, { passive: false, capture: true });
    document.addEventListener('touchmove', handleResizeMapTable, { passive: false, capture: true });
    document.addEventListener('touchend', stopResizeMapTable, { passive: false, capture: true });
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    return false;
  }

  function handleResizeMapTable(e) {
    if (!isResizingMapTable) return;
    e.preventDefault();
    e.stopPropagation();
    
    const clientY = e.clientY || e.touches?.[0]?.clientY || resizeStartY;
    const deltaY = clientY - resizeStartY;
    const newHeight = resizeStartMapHeight + deltaY; // Usar pixels diretamente
    
    // Limites: mínimo 300px, máximo baseado no container
    const container = document.querySelector('.main-area');
    const containerHeight = container ? container.getBoundingClientRect().height : 800;
    
    // Se a tabela estiver minimizada, permitir que o mapa ocupe quase todo o espaço
    // Deixar apenas espaço para a tabela minimizada (~70px) + handle (~20px) + pequena margem
    const minSpaceForTable = isTableMinimized ? 90 : 200; // 90px quando minimizada, 200px quando expandida
    const maxHeight = Math.max(containerHeight - minSpaceForTable, 300);
    const clampedHeight = Math.max(300, Math.min(maxHeight, newHeight));
    
    // Atualizar diretamente - Svelte detecta automaticamente
    mapHeightPixels = clampedHeight;
    
    // Forçar atualização do DOM diretamente também
    const mapElement = document.querySelector('.map-container');
    const tableElement = document.querySelector('.results-table-container, .empty-state');
    if (mapElement) {
      // Respeitar o estado minimizado do mapa ao redimensionar
      if (isMapMinimized) {
        // Se o mapa está minimizado, manter altura minimizada
        mapElement.style.height = '60px';
        mapElement.style.flex = '0 0 auto';
        mapElement.style.minHeight = '60px';
      } else {
        // Se o mapa está expandido, aplicar altura calculada
        mapElement.style.height = `${clampedHeight}px`;
        mapElement.style.flex = '0 0 auto';
        mapElement.style.minHeight = `${clampedHeight}px`;
      }
    }
    if (tableElement) {
      // Respeitar o estado minimizado da tabela ao redimensionar
      if (isTableMinimized) {
        // Se a tabela está minimizada, manter estilos minimizados
        tableElement.style.flex = '0 0 auto';
        tableElement.style.minHeight = '60px';
      } else {
        // Se a tabela está expandida, ocupar o resto do espaço
        tableElement.style.flex = '1 1 auto';
        tableElement.style.minHeight = '200px';
      }
    }
    
    console.log(`📏 Arrastando mapa/tabela: Mapa ${clampedHeight}px`);
    
    // Salvar no localStorage (sem await para não bloquear)
    try {
      localStorage.setItem('analiseCobertura_mapHeightPixels', clampedHeight.toString());
    } catch (err) {
      console.warn('Erro ao salvar altura do mapa:', err);
    }
  }

  function stopResizeMapTable() {
    console.log('✅ Parando redimensionamento mapa/tabela');
    isResizingMapTable = false;
    document.removeEventListener('mousemove', handleResizeMapTable, { capture: true });
    document.removeEventListener('mouseup', stopResizeMapTable, { capture: true });
    document.removeEventListener('touchmove', handleResizeMapTable, { capture: true });
    document.removeEventListener('touchend', stopResizeMapTable, { capture: true });
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    
    // Redimensionar o mapa após ajuste
    if (map) {
      setTimeout(() => {
        google.maps.event.trigger(map, 'resize');
      }, 100);
    }
  }

  // Carregar preferências salvas
  function loadResizePreferences() {
    try {
      const savedSidebarWidth = localStorage.getItem('analiseCobertura_sidebarWidth');
      if (savedSidebarWidth) {
        sidebarWidth = parseInt(savedSidebarWidth, 10);
        if (isNaN(sidebarWidth) || sidebarWidth < 250 || sidebarWidth > 600) {
          sidebarWidth = 350;
        }
      }
      
      const savedMapHeight = localStorage.getItem('analiseCobertura_mapHeightPixels');
      if (savedMapHeight) {
        mapHeightPixels = parseInt(savedMapHeight, 10);
        if (isNaN(mapHeightPixels) || mapHeightPixels < 300 || mapHeightPixels > 1000) {
          mapHeightPixels = 400; // Valor padrão em pixels
        }
      }
    } catch (err) {
      console.warn('Erro ao carregar preferências de redimensionamento:', err);
    }
  }


  // Animação dos pontos em "Buscando..."
  $: if (loadingCTOs) {
    // Iniciar animação dos pontos
    if (loadingDotsInterval) {
      clearInterval(loadingDotsInterval);
    }
    loadingDotsInterval = setInterval(() => {
      if (loadingDots === '.') {
        loadingDots = '..';
      } else if (loadingDots === '..') {
        loadingDots = '...';
      } else {
        loadingDots = '.';
      }
    }, 500); // Muda a cada 500ms
  } else {
    // Parar animação quando não está carregando
    if (loadingDotsInterval) {
      clearInterval(loadingDotsInterval);
      loadingDotsInterval = null;
      loadingDots = '.'; // Resetar para o estado inicial
    }
  }

  // Inicializar ferramenta
  onMount(async () => {
    try {
      // Garantir que mapa esteja visível ao carregar
      // Tabela começa minimizada e será expandida quando houver resultados
      isMapMinimized = false;
      isTableMinimized = true; // Começar minimizada quando não há resultados
      
      // Carregar preferências de redimensionamento
      loadResizePreferences();
      
      // Registrar função de configurações com o parent
      if (onSettingsRequest && typeof onSettingsRequest === 'function') {
        onSettingsRequest(openSettings);
      }
      
      
      // Registrar função de pré-carregamento no hover
      if (onSettingsHover && typeof onSettingsHover === 'function') {
        onSettingsHover(preloadSettingsData);
      }
      
      // Inicializar a ferramenta (carrega Google Maps, verifica base, inicializa mapa)
      await initializeTool();
      
      // Adicionar listener para limpar seleção ao clicar fora da tabela
      document.addEventListener('click', handleClickOutside);
      
      // Prevenir seleção de texto nativa dentro da tabela
      document.addEventListener('selectstart', preventTextSelectionDrag, { passive: false });
      document.addEventListener('dragstart', preventTextSelection, { passive: false });
      
      // Adicionar handler para Ctrl+C
      document.addEventListener('keydown', handleCopyKeydown);
    } catch (err) {
      console.error('Erro ao inicializar ferramenta:', err);
      error = 'Erro ao inicializar ferramenta: ' + err.message;
      isLoading = false;
    }
  });

  // Cleanup ao desmontar
  onDestroy(() => {
    // Limpar intervalo de animação dos pontos
    if (loadingDotsInterval) {
      clearInterval(loadingDotsInterval);
      loadingDotsInterval = null;
    }
    
    // Limpar observer do mapa se existir
    if (mapObserver) {
      mapObserver.disconnect();
      mapObserver = null;
    }
    
    // Remover listeners de seleção
    document.removeEventListener('click', handleClickOutside);
    document.removeEventListener('selectstart', preventTextSelectionDrag);
    document.removeEventListener('dragstart', preventTextSelection);
    document.removeEventListener('keydown', handleCopyKeydown);
  });
</script>

<!-- Conteúdo da Ferramenta de Consulta de Alívio de Rede -->
<div class="analise-cobertura-content">
  {#if isLoading}
    <Loading message={loadingMessage} />
  {:else}
    <div class="main-layout">
      <!-- Painel de Busca -->
      <aside class="search-panel" class:minimized={isSearchPanelMinimized} style="width: {isSearchPanelMinimized ? '60px' : sidebarWidthStyle} !important; flex: 0 0 auto;">
        <div class="panel-header">
          <div class="panel-header-content">
            {#if !isSearchPanelMinimized}
              <h2>Consulta de Alívio de Rede</h2>
            {:else}
              <h2 class="vertical-title"></h2>
            {/if}
            <button 
              class="minimize-button" 
              disabled={isResizingSidebar || isResizingMapTable}
              on:click={() => isSearchPanelMinimized = !isSearchPanelMinimized}
              aria-label={isSearchPanelMinimized ? 'Expandir painel de busca' : 'Minimizar painel de busca'}
              title={isSearchPanelMinimized ? 'Expandir' : 'Minimizar'}
            >
              {isSearchPanelMinimized ? '➡️' : '⬅️'}
            </button>
          </div>
          {#if !isSearchPanelMinimized}
            <p>Busque CTOs na base de dados</p>
          {/if}
        </div>

        {#if !isSearchPanelMinimized}
        <div class="search-mode-selector">
          <button 
            class="mode-button" 
            class:active={searchMode === 'nome'}
            on:click={() => searchMode = 'nome'}
          >
            Nome CTO
          </button>
          <button 
            class="mode-button" 
            class:active={searchMode === 'endereco'}
            on:click={() => searchMode = 'endereco'}
          >
            Endereço
          </button>
        </div>

        <div class="search-form">
          {#if searchMode === 'nome'}
            <div class="form-group">
              <label for="nome-cto">Nome da(s) CTO(s)</label>
              <textarea 
                id="nome-cto"
                bind:value={nomeCTO}
                placeholder="Insira uma ou mais CTOs"
                rows="3"
                on:keydown={(e) => e.key === 'Enter' && !e.shiftKey && handleSearch()}
              ></textarea>
            </div>
          {:else if searchMode === 'endereco'}
            <div class="form-group">
              <label for="endereco">Endereço ou Coordenadas</label>
              <textarea 
                id="endereco"
                bind:value={enderecoInput}
                placeholder="Insira um ou mais endereços"
                rows="3"
                on:keydown={(e) => e.key === 'Enter' && !e.shiftKey && handleSearch()}
              ></textarea>
            </div>
          {/if}

          <button class="search-button" on:click={handleSearch} disabled={loadingCTOs}>
            {#if loadingCTOs}
              <span class="hourglass-icon">⏳</span> Buscando{loadingDots}
            {:else}
              Buscar
            {/if}
          </button>

          {#if error}
            <div class="error-message" class:duplicated-ctos={duplicatedCTOs.length > 0}>
              {#if duplicatedCTOs.length > 0}
                <div style="font-weight: bold; margin-bottom: 0.5rem;">
                  ⚠️ CTOs duplicadas na base de dados:
                </div>
                {#each duplicatedCTOs as dup}
                  <div style="margin-bottom: 1rem; padding-left: 1rem; border-left: 2px solid #ff9800;">
                    <div style="font-weight: 600; margin-bottom: 0.25rem;">
                      • {dup.nome} ({dup.quantidade} ocorrências)
                    </div>
                    {#each dup.caminhos as caminho}
                      <div style="font-size: 0.9em; color: #666; margin-left: 0.5rem; margin-bottom: 0.15rem;">
                        - {caminho.cidade} | {caminho.pop} | {caminho.chasse} | {caminho.placa} | {caminho.olt}
                      </div>
                    {/each}
                  </div>
                {/each}
              {:else}
                ⚠️ {error}
              {/if}
            </div>
          {/if}

          {#if ctos.length > 0}
            <div class="results-summary">
              ✅ {ctos.length} {ctos.length === 1 ? 'CTO encontrada' : 'CTOs encontradas'}
            </div>
          {/if}
        </div>
        {/if}
      </aside>

      <!-- Handle de redimensionamento vertical (sidebar) -->
      <div 
        class="resize-handle resize-handle-vertical"
        on:mousedown|stopPropagation={startResizeSidebar}
        on:touchstart|stopPropagation={startResizeSidebar}
        class:resizing={isResizingSidebar}
        role="separator"
        aria-label="Ajustar largura da barra lateral"
        tabindex="0"
      >
      </div>

      <!-- Área Principal (Mapa e Tabela) -->
      <main class="main-area">
        <!-- Mapa -->
        <div class="map-container" class:minimized={isMapMinimized} style="height: {isMapMinimized ? '60px' : mapHeightStyle}; flex: 0 0 auto; min-height: {isMapMinimized ? '60px' : mapHeightStyle};">
          <div class="map-header">
            <h3>Mapa</h3>
            <div style="display: flex; gap: 0.5rem;">
            <button 
              class="minimize-button" 
              disabled={isResizingSidebar || isResizingMapTable}
              on:click={async () => {
                isMapMinimized = !isMapMinimized;
                if (!isMapMinimized && map && google?.maps) {
                  // Quando expandir, aguardar renderização e fazer resize do mapa
                  await tick();
                  setTimeout(() => {
                    if (map && google.maps) {
                      google.maps.event.trigger(map, 'resize');
                    }
                  }, 100);
                }
              }}
              aria-label={isMapMinimized ? 'Expandir mapa' : 'Minimizar mapa'}
              title={isMapMinimized ? 'Expandir' : 'Minimizar'}
            >
              {isMapMinimized ? '⬆️' : '⬇️'}
            </button>
              <button 
                class="minimize-button toggle-circles-button" 
                disabled={isResizingSidebar || isResizingMapTable}
                on:click={() => {
                  toggleRadiusCircles();
                }}
                aria-label={showRadiusCircles ? 'Ocultar círculos de 250m' : 'Mostrar círculos de 250m'}
                title={showRadiusCircles ? 'Ocultar círculos' : 'Mostrar círculos'}
              >
                {#if showRadiusCircles}
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {:else}
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
            </button>
            </div>
          </div>
          <div id="map" class="map" class:hidden={isMapMinimized} bind:this={mapElement}></div>
        </div>

        <!-- Handle de redimensionamento horizontal (mapa/tabela) -->
        <div 
          class="resize-handle resize-handle-horizontal"
          on:mousedown|stopPropagation={startResizeMapTable}
          on:touchstart|stopPropagation={startResizeMapTable}
          class:resizing={isResizingMapTable}
          role="separator"
          aria-label="Ajustar altura do mapa e tabela"
          tabindex="0"
        >
        </div>

        <!-- Tabela de Resultados -->
        {#if ctos.length > 0}
          <div class="results-table-container" class:minimized={isTableMinimized} style="flex: {isTableMinimized ? '0 0 auto' : '1 1 auto'}; min-height: {isTableMinimized ? '60px' : '200px'};">
            <div class="table-header">
              <h3>Tabela de Equipamentos Encontrados - {ctos.length} Equipamentos Encontrados</h3>
              <div class="table-header-buttons">
                <button 
                  class="minimize-button table-menu-button" 
                  on:click={openTableMenuInfoWindow}
                  aria-label="Menu da tabela"
                  title="Menu"
                >
                  <span class="vertical-dots"></span>
                </button>
              <button 
                class="minimize-button" 
                disabled={isResizingSidebar || isResizingMapTable}
                on:click={() => isTableMinimized = !isTableMinimized}
                aria-label={isTableMinimized ? 'Expandir tabela' : 'Minimizar tabela'}
                title={isTableMinimized ? 'Expandir' : 'Minimizar'}
              >
                {isTableMinimized ? '⬆️' : '⬇️'}
              </button>
              </div>
            </div>
            {#if !isTableMinimized}
            <div class="table-wrapper">
              <table class="results-table">
                <thead>
                  <tr>
                    <th class:selected={selectedColumns.includes(0)} on:click={(e) => handleColumnHeaderClick(e, 0)}>
                      <input 
                        type="checkbox" 
                        checked={allCTOsVisible}
                        indeterminate={someCTOsVisible}
                        on:change={async (e) => {
                          const isChecked = e.target.checked;
                          const newVisibility = new Map();
                          for (const cto of ctos) {
                            const ctoKey = getCTOKey(cto);
                            newVisibility.set(ctoKey, isChecked);
                          }
                          ctoVisibility = newVisibility;
                          
                          // Quando usa o checkbox "marcar todos" no header, ativar ordem visual
                          // e limpar a ordem de marcação individual
                          useVisualOrder = true;
                          ctoMarkOrder = new Map();
                          markOrderCounter = 0;
                          
                          ctoNumbersVersion++; // Forçar atualização da numeração
                          // Aguardar um tick para garantir que ctoNumbers foi recalculado
                          await new Promise(resolve => setTimeout(resolve, 0));
                          await displayResultsOnMap();
                        }}
                      />
                    </th>
                    <th class:selected={selectedColumns.includes(1)} on:click={(e) => handleColumnHeaderClick(e, 1)}>N°</th>
                    <th class:selected={selectedColumns.includes(2)} on:click={(e) => handleColumnHeaderClick(e, 2)}>CTO</th>
                    <th class:selected={selectedColumns.includes(3)} on:click={(e) => handleColumnHeaderClick(e, 3)}>Latitude</th>
                    <th class:selected={selectedColumns.includes(4)} on:click={(e) => handleColumnHeaderClick(e, 4)}>Longitude</th>
                    <th class:selected={selectedColumns.includes(5)} on:click={(e) => handleColumnHeaderClick(e, 5)}>Cidade</th>
                    <th class:selected={selectedColumns.includes(6)} on:click={(e) => handleColumnHeaderClick(e, 6)}>POP</th>
                    <th class:selected={selectedColumns.includes(7)} on:click={(e) => handleColumnHeaderClick(e, 7)}>CHASSE</th>
                    <th class:selected={selectedColumns.includes(8)} on:click={(e) => handleColumnHeaderClick(e, 8)}>PLACA</th>
                    <th class:selected={selectedColumns.includes(9)} on:click={(e) => handleColumnHeaderClick(e, 9)}>OLT</th>
                    <th class:selected={selectedColumns.includes(10)} on:click={(e) => handleColumnHeaderClick(e, 10)}>ID CTO</th>
                    <th class:selected={selectedColumns.includes(11)} on:click={(e) => handleColumnHeaderClick(e, 11)}>Data de Criação</th>
                    <th class:selected={selectedColumns.includes(12)} on:click={(e) => handleColumnHeaderClick(e, 12)}>Portas Total</th>
                    <th class:selected={selectedColumns.includes(13)} on:click={(e) => handleColumnHeaderClick(e, 13)}>Ocupadas</th>
                    <th class:selected={selectedColumns.includes(14)} on:click={(e) => handleColumnHeaderClick(e, 14)}>Disponíveis</th>
                    <th class:selected={selectedColumns.includes(15)} on:click={(e) => handleColumnHeaderClick(e, 15)}>Ocupação</th>
                    <th class:selected={selectedColumns.includes(16)} on:click={(e) => handleColumnHeaderClick(e, 16)}>Status</th>
                    <th class:selected={selectedColumns.includes(17)} on:click={(e) => handleColumnHeaderClick(e, 17)}>Total de Portas no Caminho de Rede</th>
                    <th class:selected={selectedColumns.includes(18)} on:click={(e) => handleColumnHeaderClick(e, 18)}>Total de CTOs no Caminho de Rede</th>
                  </tr>
                </thead>
                <tbody>
                  {#each ctos as cto, rowIndex (getCTOKey(cto))}
                    {@const ctoKey = getCTOKey(cto)}
                    {@const isVisible = ctoVisibility.get(ctoKey) !== false}
                    {@const caminhoKey = getCaminhoRedeKey(cto)}
                    {@const total = caminhoRedeTotalsVersion >= 0 && caminhoRedeTotals ? (caminhoRedeTotals.get(caminhoKey) || 0) : 0}
                    {@const estaCarregando = caminhosCarregando && total === 0 && caminhoKey && !caminhoKey.includes('N/A') && caminhoKey !== '||||' && caminhoKey.split('|').length === 5}
                    {@const pctOcup = parseFloat(cto.pct_ocup || 0)}
                    {@const occupationClass = pctOcup < 50 ? 'low' : pctOcup >= 50 && pctOcup < 80 ? 'medium' : 'high'}
                    {@const cellKey0 = getCellKey(rowIndex, 0)}
                    {@const cellKey1 = getCellKey(rowIndex, 1)}
                    {@const cellKey2 = getCellKey(rowIndex, 2)}
                    {@const cellKey3 = getCellKey(rowIndex, 3)}
                    {@const cellKey4 = getCellKey(rowIndex, 4)}
                    {@const cellKey5 = getCellKey(rowIndex, 5)}
                    {@const cellKey6 = getCellKey(rowIndex, 6)}
                    {@const cellKey7 = getCellKey(rowIndex, 7)}
                    {@const cellKey8 = getCellKey(rowIndex, 8)}
                    {@const cellKey9 = getCellKey(rowIndex, 9)}
                    {@const cellKey10 = getCellKey(rowIndex, 10)}
                    {@const cellKey11 = getCellKey(rowIndex, 11)}
                    {@const cellKey12 = getCellKey(rowIndex, 12)}
                    {@const cellKey13 = getCellKey(rowIndex, 13)}
                    {@const cellKey14 = getCellKey(rowIndex, 14)}
                    {@const cellKey15 = getCellKey(rowIndex, 15)}
                    {@const cellKey16 = getCellKey(rowIndex, 16)}
                    {@const cellKey17 = getCellKey(rowIndex, 17)}
                    {@const cellKey18 = getCellKey(rowIndex, 18)}
                    <tr class:row-selected={selectedRows.includes(rowIndex)}>
                      <td class="checkbox-cell" class:cell-selected={selectedCells.includes(cellKey0) || selectedRows.includes(rowIndex) || selectedColumns.includes(0)}>
                        <input 
                          type="checkbox" 
                          checked={isVisible}
                          on:click|stopPropagation={(e) => {
                            // Não permitir que o clique no checkbox dispare handleCellClick
                            e.stopPropagation();
                          }}
                          on:change={async (e) => {
                            // Alterar apenas a visibilidade desta CTO específica
                            const isChecked = e.target.checked;
                            
                            // Verificar se todas as CTOs estão desmarcadas ANTES de fazer a mudança
                            // (verificando o estado atual, não o estado que será)
                            const allUnmarkedBefore = ctos.every(cto => {
                              const key = getCTOKey(cto);
                              return ctoVisibility.get(key) === false;
                            });
                            
                            ctoVisibility.set(ctoKey, isChecked);
                            ctoVisibility = ctoVisibility;
                            
                            // A ordem de marcação só é ativada se TODAS as CTOs estiverem desmarcadas
                            // E o usuário está MARCANDO (não desmarcando) individualmente
                            if (allUnmarkedBefore && isChecked) {
                              // Ativar ordem de marcação quando começa a marcar a partir de todas desmarcadas
                              useVisualOrder = false;
                              // Limpar ordem de marcação anterior
                              ctoMarkOrder = new Map();
                              markOrderCounter = 0;
                            }
                            
                            // Se desmarcou todas, limpar a ordem de marcação
                            const allUnmarkedAfter = ctos.every(cto => {
                              const key = getCTOKey(cto);
                              return ctoVisibility.get(key) === false;
                            });
                            if (allUnmarkedAfter) {
                              ctoMarkOrder = new Map();
                              markOrderCounter = 0;
                            }
                            
                            // Rastrear ordem de marcação individual apenas se não estiver usando ordem visual
                            if (!useVisualOrder) {
                              if (isChecked) {
                                // Marcar: adicionar à ordem de marcação
                                markOrderCounter++;
                                ctoMarkOrder.set(ctoKey, markOrderCounter);
                                ctoMarkOrder = ctoMarkOrder; // Forçar reatividade
                              } else {
                                // Desmarcar: remover da ordem de marcação
                                ctoMarkOrder.delete(ctoKey);
                                ctoMarkOrder = ctoMarkOrder; // Forçar reatividade
                              }
                            }
                            
                            ctoNumbersVersion++; // Forçar atualização da numeração
                            // Aguardar um tick para garantir que ctoNumbers foi recalculado
                            await new Promise(resolve => setTimeout(resolve, 0));
                            await displayResultsOnMap();
                          }}
                        />
                      </td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey1) || selectedRows.includes(rowIndex) || selectedColumns.includes(1)} on:click={(e) => handleCellClick(e, rowIndex, 1)}>{ctoNumbers.get(cto) || '-'}</td>
                      <td class="cto-name-cell" class:cell-selected={selectedCells.includes(cellKey2) || selectedRows.includes(rowIndex) || selectedColumns.includes(2)} on:click={(e) => handleCellClick(e, rowIndex, 2)}><strong>{cto.nome || ''}</strong></td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey3) || selectedRows.includes(rowIndex) || selectedColumns.includes(3)} on:click={(e) => handleCellClick(e, rowIndex, 3)}>{cto.latitude || ''}</td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey4) || selectedRows.includes(rowIndex) || selectedColumns.includes(4)} on:click={(e) => handleCellClick(e, rowIndex, 4)}>{cto.longitude || ''}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey5) || selectedRows.includes(rowIndex) || selectedColumns.includes(5)} on:click={(e) => handleCellClick(e, rowIndex, 5)}>{cto.cidade || 'N/A'}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey6) || selectedRows.includes(rowIndex) || selectedColumns.includes(6)} on:click={(e) => handleCellClick(e, rowIndex, 6)}>{cto.pop || 'N/A'}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey7) || selectedRows.includes(rowIndex) || selectedColumns.includes(7)} on:click={(e) => handleCellClick(e, rowIndex, 7)}>{cto.olt || 'N/A'}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey8) || selectedRows.includes(rowIndex) || selectedColumns.includes(8)} on:click={(e) => handleCellClick(e, rowIndex, 8)}>{cto.slot || 'N/A'}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey9) || selectedRows.includes(rowIndex) || selectedColumns.includes(9)} on:click={(e) => handleCellClick(e, rowIndex, 9)}>{cto.pon || 'N/A'}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey10) || selectedRows.includes(rowIndex) || selectedColumns.includes(10)} on:click={(e) => handleCellClick(e, rowIndex, 10)}>{cto.id_cto || cto.id || 'N/A'}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey11) || selectedRows.includes(rowIndex) || selectedColumns.includes(11)} on:click={(e) => handleCellClick(e, rowIndex, 11)}>{formatDataCriacao(cto)}</td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey12) || selectedRows.includes(rowIndex) || selectedColumns.includes(12)} on:click={(e) => handleCellClick(e, rowIndex, 12)}>{cto.vagas_total || 0}</td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey13) || selectedRows.includes(rowIndex) || selectedColumns.includes(13)} on:click={(e) => handleCellClick(e, rowIndex, 13)}>{cto.clientes_conectados || 0}</td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey14) || selectedRows.includes(rowIndex) || selectedColumns.includes(14)} on:click={(e) => handleCellClick(e, rowIndex, 14)}>{(cto.vagas_total || 0) - (cto.clientes_conectados || 0)}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey15) || selectedRows.includes(rowIndex) || selectedColumns.includes(15)} on:click={(e) => handleCellClick(e, rowIndex, 15)}>
                        <span class="occupation-badge {occupationClass}">{pctOcup.toFixed(1)}%</span>
                      </td>
                      <td class:cell-selected={selectedCells.includes(cellKey16) || selectedRows.includes(rowIndex) || selectedColumns.includes(16)} on:click={(e) => handleCellClick(e, rowIndex, 16)}>{cto.status_cto || 'N/A'}</td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey17) || selectedRows.includes(rowIndex) || selectedColumns.includes(17)} on:click={(e) => handleCellClick(e, rowIndex, 17)}>
                        {#if estaCarregando}
                          <span class="loading-text">Carregando...</span>
                        {:else}
                          <strong>{total}</strong>
                        {/if}
                      </td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey18) || selectedRows.includes(rowIndex) || selectedColumns.includes(18)} on:click={(e) => handleCellClick(e, rowIndex, 18)}>
                        {#if estaCarregando}
                          <span class="loading-text">Carregando...</span>
                        {:else}
                          <strong>{getCaminhoRedeCTOsTotal(cto)}</strong>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {/if}
          </div>
        {:else if !isLoading && !error}
          <div class="empty-state" class:minimized={isTableMinimized} style="flex: {isTableMinimized ? '0 0 auto' : '1 1 auto'}; min-height: {isTableMinimized ? '60px' : '200px'};">
            <div class="table-header">
              <h3>Tabela de Equipamentos Encontrados - Nenhum Equipamento Pesquisado</h3>
              <div class="table-header-buttons">
                <button 
                  class="minimize-button table-menu-button" 
                  on:click={openTableMenuInfoWindow}
                  aria-label="Menu da tabela"
                  title="Menu"
                >
                  <span class="vertical-dots"></span>
                </button>
              <button 
                class="minimize-button" 
                disabled={isResizingSidebar || isResizingMapTable}
                on:click={() => isTableMinimized = !isTableMinimized}
                aria-label={isTableMinimized ? 'Expandir tabela' : 'Minimizar tabela'}
                title={isTableMinimized ? 'Expandir' : 'Minimizar'}
              >
                {isTableMinimized ? '⬆️' : '⬇️'}
              </button>
              </div>
            </div>
            {#if !isTableMinimized}
              <p>🔍 Realize uma busca para ver os resultados aqui</p>
            {/if}
          </div>
        {/if}
      </main>
    </div>
  {/if}
</div>

<style>
  .analise-cobertura-content {
    width: 100%;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #f5f7fa;
  }

  .main-layout {
    display: flex;
    flex: 1;
    height: 100%;
    gap: 0.75rem; /* Espaçamento entre sidebar e área principal */
    padding: 1rem;
    padding-bottom: 1.75rem; /* Espaço na parte inferior: borda do box + pequena distância até o final */
    overflow: hidden;
    align-items: flex-start; /* Alinhar no topo, não esticar */
    position: relative;
    box-sizing: border-box;
  }

  .search-panel {
    min-width: 300px !important;
    max-width: 700px !important;
    width: 400px;
    background: white;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    overflow-y: auto;
    overflow-x: hidden;
    flex: 0 0 auto; /* Largura fixa, não cresce/encolhe */
    height: calc(100% - 2.75rem); /* Altura = 100% do pai - padding top (1rem) - padding bottom (1.75rem) */
    box-sizing: border-box;
    /* Bordas sempre visíveis + pequena distância até o final da página */
  }

  .panel-header {
    position: relative;
  }

  .panel-header-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  .panel-header h2 {
    margin: 0 0 0.5rem 0;
    color: #4c1d95;
    font-size: 1.5rem;
    font-weight: 600;
  }

  .panel-header p {
    margin: 0;
    color: #666;
    font-size: 0.875rem;
  }

  .toggle-circles-button {
    color: #7B68EE;
    transition: all 0.25s ease;
  }

  .toggle-circles-button:hover {
    background-color: rgba(123, 104, 238, 0.1);
    color: #7B68EE;
  }

  .toggle-circles-button:active {
    background-color: rgba(123, 104, 238, 0.2);
  }

  .toggle-circles-button svg {
    width: 18px;
    height: 18px;
  }

  .minimize-button {
    background: transparent;
    border: 1px solid rgba(123, 104, 238, 0.3);
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    color: #7B68EE;
    font-weight: 400;
    transition: all 0.2s;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 24px;
    box-shadow: none;
    opacity: 0.7;
  }

  .minimize-button:hover {
    opacity: 1;
    background: rgba(100, 149, 237, 0.1);
    border-color: #7B68EE;
    color: #4c1d95;
  }

  .minimize-button:active {
    background: rgba(123, 104, 238, 0.15);
    border-color: #7B68EE;
    color: #4c1d95;
    transform: scale(0.95);
  }

  .minimize-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }

  .vertical-title {
    margin: 0;
    color: #4c1d95;
    font-size: 1.5rem;
    font-weight: 600;
  }

  .search-panel.minimized {
    padding: 1rem 0.75rem;
    overflow: hidden;
    min-width: 60px !important;
    max-width: 60px !important;
    align-items: center;
  }

  .search-panel.minimized .panel-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
  }

  .search-panel.minimized .panel-header-content {
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
  }

  .search-panel.minimized .panel-header-content h2,
  .search-panel.minimized .vertical-title {
    margin: 0;
    font-size: 1.5rem;
    writing-mode: vertical-rl;
    text-orientation: mixed;
    transform: rotate(180deg);
  }

  .search-panel.minimized .panel-header p {
    display: none;
  }

  .search-panel.minimized .minimize-button {
    width: 100%;
    min-width: auto;
  }

  .search-mode-selector {
    display: flex;
    gap: 0.5rem;
    border-bottom: 2px solid #e5e7eb;
    padding-bottom: 0.75rem;
  }

  .mode-button {
    flex: 1;
    padding: 0.5rem;
    border: none;
    background: transparent;
    color: #666;
    cursor: pointer;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.2s;
  }

  .mode-button:hover {
    background: #f3f4f6;
  }

  .mode-button.active {
    background: linear-gradient(135deg, #6495ED 0%, #7B68EE 100%);
    color: white;
  }

  .search-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .form-group label {
    font-weight: 500;
    color: #374151;
    font-size: 0.875rem;
  }

  .form-group input,
  .form-group textarea {
    padding: 0.75rem;
    border: 2px solid #e5e7eb;
    border-radius: 8px;
    font-size: 0.9375rem;
    transition: border-color 0.2s;
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
  }

  .form-group textarea {
    resize: vertical;
    min-height: 80px;
    line-height: 1.5;
  }

  .form-group input:focus,
  .form-group textarea:focus {
    outline: none;
    border-color: #6495ED;
  }

  .search-button {
    padding: 0.875rem 1.5rem;
    background: linear-gradient(135deg, #6495ED 0%, #7B68EE 100%);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .search-button:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(100, 149, 237, 0.3);
  }

  .search-button:active {
    transform: translateY(0);
  }

  .search-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    transform: none;
  }

  .hourglass-icon {
    display: inline-block;
    animation: hourglass-rotate 1.5s linear infinite;
  }

  @keyframes hourglass-rotate {
    0% {
      transform: rotate(0deg);
    }
    25% {
      transform: rotate(90deg);
    }
    50% {
      transform: rotate(180deg);
    }
    75% {
      transform: rotate(270deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }

  .loading-inline {
    padding: 0.75rem;
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-radius: 8px;
    color: #1e40af;
    font-size: 0.875rem;
    text-align: center;
  }

  .loading-inline p {
    margin: 0;
  }

  .error-message {
    padding: 0.75rem;
    background: #fee2e2;
    border: 1px solid #fecaca;
    border-radius: 8px;
    color: #991b1b;
    font-size: 0.875rem;
  }

  .results-summary {
    padding: 0.75rem;
    background: #dcfce7;
    border: 1px solid #bbf7d0;
    border-radius: 8px;
    color: #166534;
    font-size: 0.875rem;
    font-weight: 500;
    text-align: center;
  }

  .main-area {
    flex: 1 1 auto; /* Cresce para preencher espaço disponível */
    display: flex;
    flex-direction: column;
    gap: 0.75rem; /* Espaçamento entre mapa e tabela */
    overflow: hidden;
    width: 100%;
    position: relative;
    min-height: 0;
    box-sizing: border-box;
    height: calc(100% - 2.75rem); /* Altura = 100% do pai - padding top (1rem) - padding bottom (1.75rem) */
    /* Bordas sempre visíveis + pequena distância até o final da página */
  }

  /* Garantir que a tabela possa crescer e rolar corretamente */
  .main-area > .results-table-container {
    flex: 0 1 auto; /* Não forçar crescimento, permitir tamanho natural */
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-self: stretch; /* Esticar na largura mas permitir altura natural */
  }

  .map-container {
    min-height: 300px;
    position: relative;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    background: white;
    display: flex;
    flex-direction: column;
    flex: 0 0 auto; /* Não crescer nem encolher automaticamente */
    width: 100%;
  }

  .map-container.minimized {
    background: white;
    min-height: 60px;
  }

  .map-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e5e7eb;
    background: white;
    flex-shrink: 0;
  }

  .map-header h3 {
    margin: 0;
    color: #4c1d95;
    font-size: 1.125rem;
    font-weight: 600;
  }

  .map-container.minimized .map-header {
    border-bottom: none;
  }

  .map {
    width: 100%;
    height: 100%;
    min-height: 0;
    flex: 1 1 auto;
    display: block;
    background: #e5e7eb;
    position: relative;
  }

  .map.hidden {
    display: none;
  }
  

  .results-table-container {
    background: white;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    min-height: 200px;
    overflow: visible; /* Remove scroll do container externo */
    flex: 1 1 auto; /* Ocupar o espaço restante */
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    /* Scroll apenas no .table-wrapper interno */
  }

  /* Handles de redimensionamento - estilo discreto */
  .resize-handle {
    background: transparent;
    cursor: col-resize;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    flex-shrink: 0;
    position: relative;
    z-index: 10000 !important;
    pointer-events: auto !important;
    touch-action: none;
  }

  .resize-handle::before {
    content: '';
    position: absolute;
    background: transparent;
    transition: background 0.2s;
    pointer-events: none; /* Não bloquear eventos no pseudo-elemento */
  }

  .resize-handle:hover {
    background: rgba(100, 149, 237, 0.05);
  }

  .resize-handle:hover::before {
    background: rgba(100, 149, 237, 0.15);
  }

  .resize-handle.resizing {
    background: rgba(123, 104, 238, 0.1);
  }

  .resize-handle.resizing::before {
    background: rgba(123, 104, 238, 0.2);
  }

  .resize-handle-vertical {
    width: 20px; /* Área clicável maior para facilitar o arraste */
    cursor: col-resize !important;
    z-index: 10000 !important; /* Z-index muito alto para ficar acima de tudo */
    pointer-events: auto !important;
    margin: 0 -8px; /* Expandir área de hover sem mudar layout */
    background: transparent; /* Mais discreto */
    position: relative;
    flex-shrink: 0;
    flex-grow: 0;
    align-self: stretch; /* Esticar na altura para funcionar com flexbox */
  }

  .resize-handle-vertical::before {
    width: 2px;
    height: 100%;
    left: 50%;
    transform: translateX(-50%);
    pointer-events: none; /* Não bloquear eventos no pseudo-elemento */
    background: rgba(100, 149, 237, 0.08); /* Mais discreto */
  }

  .resize-handle-horizontal {
    height: 20px; /* Área clicável maior para facilitar o arraste */
    cursor: row-resize !important;
    width: 100%;
    z-index: 10000 !important; /* Z-index muito alto para ficar acima de tudo */
    pointer-events: auto !important;
    position: relative;
    margin: -4px 0; /* Expandir área de hover sem mudar layout */
    background: transparent; /* Mais discreto */
    flex-shrink: 0;
    flex-grow: 0;
    align-self: stretch; /* Esticar na largura para funcionar com flexbox */
  }

  .resize-handle-horizontal::before {
    height: 2px;
    width: 100%;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none; /* Não bloquear eventos no pseudo-elemento */
    background: rgba(100, 149, 237, 0.08); /* Mais discreto */
  }

  .table-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-shrink: 0;
    position: relative;
  }

  .table-header h3 {
    margin: 0;
    color: #4c1d95;
    font-size: 1.125rem;
    font-weight: 600;
  }

  .table-header-buttons {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }


  .vertical-dots {
    font-size: 0.875rem;
    line-height: 0.5;
    color: #7B68EE;
    font-weight: bold;
    display: inline-block;
    letter-spacing: 0;
    opacity: 0.7;
  }

  .table-menu-button:hover .vertical-dots {
    opacity: 1;
  }

  .vertical-dots::before {
    content: '•';
    display: block;
  }

  .vertical-dots::after {
    content: '•\A•';
    white-space: pre;
    display: block;
  }

  :global(.table-menu-infowindow) {
    background: white;
    border-radius: 12px;
    width: 420px;
    max-width: 90vw;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    animation: fadeIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    overflow: hidden;
    border: 1px solid rgba(123, 104, 238, 0.2);
  }

  :global(.table-menu-content) {
    display: flex;
    flex-direction: column;
  }

  :global(.table-menu-header) {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.5rem;
    border-bottom: 2px solid #7B68EE;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  :global(.table-menu-header h2) {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }

  :global(.table-menu-close) {
    background: none;
    border: none;
    color: white;
    font-size: 2rem;
    cursor: pointer;
    padding: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: background 0.3s;
    line-height: 1;
  }

  :global(.table-menu-close:hover) {
    background: rgba(255, 255, 255, 0.2);
  }

  :global(.table-menu-body) {
    padding: 1.5rem;
    background: white;
  }

  :global(.table-menu-section-title) {
    color: #7B68EE;
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0 0 1.5rem 0;
    padding-bottom: 0.75rem;
    border-bottom: 2px solid #7B68EE;
  }

  :global(.table-menu-button-container) {
    display: flex;
    justify-content: flex-start;
    margin-top: 1rem;
  }

  :global(.table-menu-button-action) {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.75rem 1.5rem;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s ease;
    font-family: 'Inter', sans-serif;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    box-shadow: 0 4px 12px rgba(123, 104, 238, 0.3);
  }

  :global(.table-menu-button-action:hover) {
    background: linear-gradient(135deg, #8B7AE8 0%, #7499F0 100%);
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(123, 104, 238, 0.4);
  }

  :global(.table-menu-button-action:active) {
    transform: translateY(0);
    box-shadow: 0 2px 8px rgba(123, 104, 238, 0.2);
  }

  :global(.button-text) {
    display: block;
  }

  :global(.table-menu-message) {
    padding: 1rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: #4c1d95;
    font-size: 0.9375rem;
    background: linear-gradient(135deg, rgba(123, 104, 238, 0.05) 0%, rgba(100, 149, 237, 0.05) 100%);
    border: 1px solid rgba(123, 104, 238, 0.2);
    border-radius: 8px;
    font-weight: 500;
  }

  :global(.message-icon) {
    font-size: 1.2rem;
    line-height: 1;
  }

  :global(.message-text) {
    flex: 1;
    color: #4c1d95;
    font-weight: 500;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-5px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .results-table-container.minimized {
    padding: 1rem 1.5rem;
    overflow: hidden;
  }

  .results-table-container.minimized .table-header {
    margin-bottom: 0;
  }

  .table-wrapper {
    overflow-y: auto;
    overflow-x: auto;
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    -webkit-overflow-scrolling: touch;
  }

  /* Estilizar scrollbar para melhor visualização */
  .table-wrapper::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .table-wrapper::-webkit-scrollbar-track {
    background: #f1f1f1;
    border-radius: 4px;
  }

  .table-wrapper::-webkit-scrollbar-thumb {
    background: #888;
    border-radius: 4px;
  }

  .table-wrapper::-webkit-scrollbar-thumb:hover {
    background: #555;
  }

  /* Estilos CSS da tabela HTML */

  .occupation-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-weight: 600;
    font-size: 0.8125rem;
  }

  .occupation-badge.low {
    background: #dcfce7;
    color: #166534;
  }

  .occupation-badge.medium {
    background: #fef3c7;
    color: #92400e;
  }

  .occupation-badge.high {
    background: #fee2e2;
    color: #991b1b;
  }

  .empty-state {
    background: white;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    padding: 1.5rem;
    color: #6b7280;
    flex: 1 1 auto; /* Ocupar o espaço restante */
    min-height: 200px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    width: 100%;
    max-height: 100%;
    box-sizing: border-box;
    margin-bottom: 0;
  }

  .empty-state.minimized {
    padding: 1rem 1.5rem;
    min-height: 60px;
  }

  .empty-state.minimized .table-header {
    margin-bottom: 0;
  }

  .empty-state .table-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-shrink: 0;
    position: relative;
  }

  .empty-state .table-header h3 {
    margin: 0;
    color: #4c1d95;
    font-size: 1.125rem;
    font-weight: 600;
  }

  .empty-state p {
    margin: 0;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
  }

  /* Responsividade */
  @media (max-width: 1024px) {
    .main-layout {
      flex-direction: column;
    }

    .search-panel {
      width: 100%;
      max-height: 400px;
    }

    .main-area {
      min-height: 500px;
    }
  }

  /* ============================================
     ESTILOS TABELA HTML
     ============================================ */
  
  .results-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  
  .results-table thead {
    background-color: #f9fafb;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  
  .results-table th {
    padding: 0.75rem;
    text-align: center;
    font-weight: 600;
    color: #374151;
    border-bottom: 2px solid #e5e7eb;
    white-space: nowrap;
    user-select: none; /* Desabilitar seleção de texto nativa nos headers */
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
  }
  
  .results-table th:first-child {
    text-align: center;
    width: 50px;
  }
  
  .results-table th:nth-child(2) {
    text-align: center;
    width: 50px;
  }
  
  .results-table td {
    padding: 0.75rem;
    border-bottom: 1px solid #e5e7eb;
    color: #4b5563;
    text-align: center;
    user-select: none; /* Desabilitar seleção de texto nativa */
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    cursor: cell; /* Cursor de célula em vez de texto */
  }
  
  .results-table .cto-name-cell {
    white-space: nowrap;
    min-width: 150px;
    text-align: center;
    user-select: none; /* Desabilitar seleção de texto nativa */
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    cursor: cell; /* Cursor de célula em vez de texto */
  }
  
  .results-table tbody tr:hover {
    background-color: #f9fafb;
  }
  
  .results-table tbody tr:nth-child(even) {
    background-color: #ffffff;
  }
  
  .results-table tbody tr:nth-child(even):hover {
    background-color: #f9fafb;
  }
  
  .results-table .checkbox-cell {
    text-align: center;
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    cursor: default;
  }
  
  .results-table .checkbox-cell input[type="checkbox"] {
    cursor: pointer;
    width: 18px;
    height: 18px;
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
  }
  
  .results-table .numeric {
    text-align: center;
  }
  
  .results-table .loading-text {
    color: #666;
    font-style: italic;
    font-size: 0.9em;
  }

  /* ============================================
     ESTILOS DE SELEÇÃO DE TABELA
     ============================================ */
  
  /* Célula selecionada */
  .results-table td.cell-selected {
    background-color: rgba(100, 149, 237, 0.15) !important;
    border: 2px solid #6495ED !important;
    position: relative;
  }
  
  .results-table td.cell-selected::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    border: 1px solid #7B68EE;
    pointer-events: none;
  }
  
  /* Header de coluna selecionada */
  .results-table th.selected {
    background-color: rgba(100, 149, 237, 0.2) !important;
    border-bottom: 3px solid #6495ED !important;
    color: #4c1d95;
    font-weight: 700;
    cursor: pointer;
    position: relative;
    z-index: 1;
  }
  
  /* Garantir que todos os headers sejam clicáveis */
  .results-table th {
    position: relative;
    z-index: 1;
  }
  
  .results-table th.selected::after {
    content: '';
    position: absolute;
    bottom: -3px;
    left: 0;
    right: 0;
    height: 3px;
    background: linear-gradient(90deg, #6495ED 0%, #7B68EE 100%);
  }
  
  /* Linha inteira selecionada */
  .results-table tbody tr.row-selected {
    background-color: rgba(100, 149, 237, 0.1) !important;
  }
  
  .results-table tbody tr.row-selected td {
    border-left: 3px solid #6495ED;
    border-right: 3px solid #6495ED;
  }
  
  .results-table tbody tr.row-selected:first-child td {
    border-top: 3px solid #6495ED;
  }
  
  .results-table tbody tr.row-selected:last-child td {
    border-bottom: 3px solid #6495ED;
  }
  
  /* Coluna inteira selecionada - aplicar estilo em todas as células da coluna */
  .results-table tbody tr td.cell-selected {
    border-left: 2px solid #7B68EE;
    border-right: 2px solid #7B68EE;
  }
  
  /* Cursor pointer para células clicáveis */
  .results-table td:not(.checkbox-cell) {
    cursor: cell;
    position: relative;
  }
  
  .results-table th:not(:first-child) {
    cursor: pointer;
    transition: background-color 0.2s ease;
    position: relative;
  }
  
  .results-table th:not(:first-child):hover {
    background-color: rgba(100, 149, 237, 0.1);
  }
  
  /* Melhorar feedback visual ao passar o mouse sobre células */
  .results-table td:not(.checkbox-cell):hover {
    background-color: rgba(100, 149, 237, 0.05);
  }
  
  /* Evitar seleção de texto durante seleção de células */
  .results-table td.cell-selected,
  .results-table th.selected {
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
  }
  
  /* Garantir que cliques funcionem mesmo em elementos filhos */
  .results-table td:not(.checkbox-cell) {
    position: relative;
  }
  
  /* Quando célula está selecionada, desabilitar seleção de texto nos filhos */
  .results-table td.cell-selected * {
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
  }

  @media (max-width: 768px) {
    .main-layout {
      padding: 0.75rem;
    }

    .search-panel {
      padding: 1rem;
    }

    .results-table {
      font-size: 0.75rem;
    }
    
    .results-table th,
    .results-table td {
      padding: 0.5rem;
    }
  }
</style>
