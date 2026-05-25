<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { Loader } from '@googlemaps/js-api-loader';
  import * as XLSX from 'xlsx';
  import html2canvas from 'html2canvas';
  import Config from '../Config.svelte';
  import Loading from '../Loading.svelte';
  import { getApiUrl } from '../config.js';

  // Props do componente
  export let currentUser = '';
  export let userTipo = 'user';
  export let onBackToDashboard = () => {};
  export let onSettingsRequest = null; // Callback para quando configurações são solicitadas

  // Helper para URL da API - usando função do config.js
  // (getApiUrl já foi importado acima)

  // ========== CONSTANTES ==========
  // Raios de busca de CTOs (em metros)
  const SEARCH_RADIUS_INITIAL = 250; // Raio inicial de busca
  const SEARCH_RADIUS_PROGRESSIVE = [500, 700, 900, 1200]; // Raios progressivos
  const SEARCH_RADIUS_MAX = 5000; // Raio máximo para busca
  const MAX_CTOS_TO_DISPLAY = 5; // Máximo de CTOs normais a exibir
  const MAX_CTOS_TO_CHECK = 15; // Máximo de CTOs para calcular rotas
  
  // Cores para marcadores e rotas
  const COLOR_CTO_GREEN = '#4CAF50'; // Verde (0-49.99%)
  const COLOR_CTO_ORANGE = '#FF9800'; // Laranja (50-79.99%)
  const COLOR_CTO_RED = '#F44336'; // Vermelho (80-100% ou fora do limite)
  const COLOR_CTO_OUT_OF_LIMIT = '#FF9800'; // Laranja para CTO fora do limite
  
  // Configurações de rota
  const ROUTE_STROKE_WEIGHT = 4;
  const ROUTE_STROKE_OPACITY_NORMAL = 0.6;
  const ROUTE_STROKE_OPACITY_OUT_OF_LIMIT = 0.5;
  
  // Opacidades para rotas tracejadas quando CTO está fora do limite (acima de 250m)
  // Você pode ajustar essas opacidades independentemente
  const ROUTE_ORANGE_OPACITY_OUT_OF_LIMIT = 1.0; // Opacidade dos traços laranja (0.0 a 1.0)
  const ROUTE_GRAY_OPACITY_OUT_OF_LIMIT = 1.0; // Opacidade dos traços cinza (0.0 a 1.0)
  
  // Configurações de cobertura
  const COVERAGE_OPACITY_DEFAULT = 0.4;
  
  // Configurações de heartbeat
  const HEARTBEAT_INTERVAL_MS = 120000; // 2 minutos
  
  // Limites de ocupação para cores
  const OCCUPATION_THRESHOLD_LOW = 0;
  const OCCUPATION_THRESHOLD_MEDIUM = 50;
  const OCCUPATION_THRESHOLD_HIGH = 80;
  const OCCUPATION_THRESHOLD_MAX = 100;

  let map;
  let googleMapsLoaded = false;
  let searchMode = 'address'; // 'address' ou 'coordinates'
  let addressInput = '';
  let coordinatesInput = '';
  let loading = false;
  let loadingDots = '.'; // Pontos animados para "Localizando..."
  let loadingDotsInterval = null; // Intervalo para animação dos pontos
  let error = null;
  let showPopupInstructions = false; // Controla exibição de instruções de pop-up
  let markers = [];
  let clientMarker = null; // Marcador do cliente
  let clientInfoWindow = null; // InfoWindow do cliente
  let clientCoords = null; // Coordenadas do cliente
  let ctos = []; // CTOs encontradas
  
  // Variáveis para status de cobertura do endereço do cliente
  let isClientCovered = null; // null = não verificado, true = dentro, false = fora
  let distanceToCoverage = null; // Distância em metros até a área de cobertura (se estiver fora)
  
  // Variável para CTO mais próxima fora do limite de 250m
  let nearestCTOOutsideLimit = null; // Armazena a CTO mais próxima quando não há CTOs dentro de 250m
  
  // Variáveis para mancha de cobertura (similar ao MapaConsulta.svelte)
  let coveragePolygons = []; // Array para armazenar polígonos de cobertura
  let coverageData = null; // Dados do polígono de cobertura (metadados)
  let coveragePolygonGeoJSON = null; // GeoJSON do polígono de cobertura
  let coverageOpacity = 0.4; // Opacidade das manchas (0-1)
  
  // Filtrar apenas CTOs de rua (não prédios) para exibição nos boxes e lista
  $: ctosRua = ctos.filter(cto => !cto.is_condominio || cto.is_condominio === false);
  let routes = []; // Rotas desenhadas no mapa
  let routeData = []; // Dados das rotas (para edição) - armazena CTO associada e path original
  let editingRoutes = false; // Modo de edição de rotas (DEPRECADO - usar editingRouteIndex)
  let editingRouteIndex = null; // Índice da rota que está sendo editada (null = nenhuma)
  let routeEditInterval = null; // Intervalo para monitorar mudanças nas rotas editáveis
  let lastRoutePaths = new Map(); // Armazena os últimos paths conhecidos de cada rota
  let selectedRouteIndex = null; // Índice da rota selecionada (para mostrar popup)
  let routePopupPosition = { x: 0, y: 0 }; // Posição do popup de rota
  let isDraggingRoutePopup = false; // Controla se o popup está sendo arrastado
  let dragOffset = { x: 0, y: 0 }; // Offset do mouse ao iniciar o arrasto
  let loadingCTOs = false; // Loading específico para busca de CTOs
  // REMOVIDO: ctosData não é mais necessário - buscamos CTOs sob demanda via API
  let baseDataExists = true; // Indica se a base de dados foi carregada com sucesso

  // Dados do endereço do cliente (para pré-preencher formulário)
  let clientAddressData = {
    cidade: '',
    enderecoCompleto: '',
    numero: '',
    cep: ''
  };

  // Modal e formulário de relatório
  let showReportModal = false;
  let generatingPDF = false; // Estado para controlar geração do PDF
  let mapPreviewImage = '';
  let capturingMap = false; // Estado para mostrar loading durante captura
  let reportForm = {
    numeroALA: '',
    cidade: '',
    enderecoCompleto: '',
    numeroEndereco: '',
    cep: '',
    tabulacaoFinal: '',
    projetista: ''
  };
  let reportFormErrors = {};
  let currentVIALA = ''; // VI ALA atual do PDF sendo gerado

  // Lista de projetistas salvos
  let projetistasList = [];
  let showAddProjetistaModal = false;
  let newProjetistaName = '';
  let showSettingsModal = false;
  
  // Lista de tabulações finais
  let tabulacoesList = [
    'Aprovado Com Portas',
    'Aprovado Com Alívio de Rede/Cleanup',
    'Aprovado Prédio Não Cabeado',
    'Aprovado - Endereço não Localizado',
    'Fora da Área de Cobertura'
  ];
  let showAddTabulacaoModal = false;
  let newTabulacaoName = '';

  // Estado para tooltips de informação
  let showInfoEquipamentos = false;
  let showInfoPortas = false;
  let showInfoForaCobertura = false;
  let showInfoForaLimite = false;

  // Estado de loading (apenas para esta ferramenta)
  let isLoading = false;
  let loadingMessage = '';
  let heartbeatInterval = null;
  let dotsInterval = null; // Intervalo para animação dos três pontinhos
  
  // Estados para modal de trocar senha
  let showChangePasswordModal = false;
  let newPassword = '';
  let confirmPassword = '';
  let showChangePassword = false;
  let showConfirmPassword = false;
  let changePasswordError = '';
  let changePasswordSuccess = false;
  let newUserName = '';
  let changeUserNameError = '';
  let changeUserNameSuccess = false;

  // Estados para redimensionamento e minimização
  let sidebarWidth = 400; // Largura inicial da sidebar em pixels
  let mapHeightPixels = 400; // Altura inicial do mapa em pixels
  let isResizingSidebar = false;
  let isResizingMapTable = false;
  let isSearchPanelMinimized = false;
  let isMapMinimized = false;
  let isListMinimized = false; // Para a lista de CTOs
  let resizeStartSidebarWidth = 0;
  let resizeStartMapHeight = 0;
  let resizeStartX = 0;
  let resizeStartY = 0;

  // ========== SISTEMA DE TABELA (igual ao AnaliseCobertura) ==========
  // Mapa para controlar quais CTOs estão visíveis no mapa (key: identificador único da CTO)
  let ctoVisibility = new Map(); // Map<ctoKey, boolean>
  
  // Função para gerar uma chave única para uma CTO
  function getCTOKey(cto) {
    const id = cto.id_cto || cto.id || 'NO_ID';
    const lat = isNaN(parseFloat(cto.latitude)) ? '0.000000' : parseFloat(cto.latitude || 0).toFixed(6);
    const lng = isNaN(parseFloat(cto.longitude)) ? '0.000000' : parseFloat(cto.longitude || 0).toFixed(6);
    return `${id}_${cto.nome || 'UNKNOWN'}_${lat}_${lng}`;
  }

  // Sistema de seleção de tabela
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
    const _ = selectionKey; // Forçar reatividade
    
    const cellKey = getCellKey(rowIndex, colIndex);
    
    if (selectedCells.includes(cellKey)) return true;
    if (selectedRows.includes(rowIndex)) return true;
    if (selectedColumns.includes(colIndex)) return true;
    return false;
  }
  
  // Função para selecionar célula única
  function selectCell(rowIndex, colIndex, addToSelection = false) {
    const cellKey = getCellKey(rowIndex, colIndex);
    
    if (!addToSelection) {
      selectedCells = [cellKey];
      selectedRows = [];
      selectedColumns = [];
    } else {
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
    
    selectedRows = [];
    selectedColumns = [];
    
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
    const tdElement = e.currentTarget || e.target.closest('td');
    
    if (e.target.tagName === 'INPUT' || 
        e.target.type === 'checkbox' ||
        e.target.closest('input[type="checkbox"]') ||
        e.target.closest('span.occupation-badge')) {
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    
    if (e.shiftKey && selectionStart) {
      selectRange(selectionStart.row, selectionStart.col, rowIndex, colIndex);
    } else if (e.ctrlKey || e.metaKey) {
      const cellKey = getCellKey(rowIndex, colIndex);
      selectedRows = [];
      selectedColumns = [];
      
      if (selectedCells.includes(cellKey)) {
        selectedCells = selectedCells.filter(key => key !== cellKey);
      } else {
        selectedCells = [...selectedCells, cellKey];
      }
      selectionStart = { row: rowIndex, col: colIndex };
    } else {
      selectCell(rowIndex, colIndex, false);
    }
  }
  
  // Handler para click em header de coluna
  function handleColumnHeaderClick(e, colIndex) {
    if (colIndex === 0) return; // Não fazer nada se clicar na coluna do checkbox
    
    if (e.target.tagName === 'INPUT' || 
        e.target.type === 'checkbox' ||
        e.target.closest('input[type="checkbox"]')) {
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    
    if (e.ctrlKey || e.metaKey) {
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
  
  // Handler para detectar cliques fora da tabela e limpar seleção
  function handleDocumentClick(e) {
    // Verificar se o clique foi fora da tabela
    const tableElement = e.target.closest('.results-table');
    if (!tableElement) {
      // Clique foi fora da tabela, limpar seleção
      clearSelection();
    }
  }
  
  // Prevenir seleção de texto nativa dentro da tabela
  function preventTextSelection(e) {
    if (e.target.tagName !== 'INPUT' && 
        e.target.tagName !== 'TEXTAREA' &&
        !e.target.closest('input') &&
        !e.target.closest('textarea') &&
        e.target.closest('.results-table')) {
      e.preventDefault();
    }
  }
  
  // Números das CTOs (para exibição na tabela)
  let ctoNumbers = new Map();
  let ctoNumbersVersion = 0;
  
  // Calcular números das CTOs baseado na visibilidade
  $: {
    const _ = ctoNumbersVersion;
    const _visibility = Array.from(ctoVisibility.entries());
    
    if (ctosRua.length > 0) {
      ctoNumbers = calculateCTONumbers();
    } else {
      ctoNumbers = new Map();
    }
  }
  
  // Fechar popup se a rota selecionada não existir mais
  $: {
    if (selectedRouteIndex !== null && (selectedRouteIndex >= routes.length || !routes[selectedRouteIndex])) {
      selectedRouteIndex = null;
    }
  }
  
  function calculateCTONumbers() {
    const numbers = new Map();
    let counter = 1;
    
    for (const cto of ctosRua) {
      const ctoKey = getCTOKey(cto);
      if (ctoVisibility.get(ctoKey) !== false) {
        numbers.set(cto, counter);
        counter++;
      }
    }
    
    return numbers;
  }
  
  // Computed para verificar se todas as CTOs estão visíveis
  $: allCTOsVisible = ctosRua.length > 0 && ctosRua.every(cto => {
    const ctoKey = getCTOKey(cto);
    return ctoVisibility.get(ctoKey) !== false;
  });
  
  // Computed para verificar se algumas CTOs estão visíveis (para estado indeterminado do checkbox)
  $: someCTOsVisible = ctosRua.length > 0 && ctosRua.some(cto => {
    const ctoKey = getCTOKey(cto);
    return ctoVisibility.get(ctoKey) === true;
  }) && !allCTOsVisible;
  
  // Função para obter o status da CTO de forma robusta
  // Verifica múltiplos campos possíveis para garantir que pegue o valor correto da base de dados
  function getStatusCTO(cto) {
    // Tentar múltiplos campos possíveis na ordem de prioridade
    const status = cto.status_cto || 
                   cto.status || 
                   cto.status_cto_condominio || 
                   cto.condominio_data?.status_cto ||
                   cto.cto_data?.status_cto ||
                   '';
    
    // Se encontrou um valor válido (não vazio, não null, não undefined), retornar
    if (status && typeof status === 'string' && status.trim() !== '') {
      return status.trim();
    }
    
    // Se não encontrou nenhum valor, retornar N/A
    return 'N/A';
  }
  
  // Função utilitária para formatar data para MM/YYYY (reutilizável)
  function formatDateToMMYYYY(dataCriacao) {
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

  // Função para formatar data de criação (formato: MM/YYYY)
  function formatDataCriacao(cto) {
    const dataCriacao = cto.data_criacao || cto.data_cadastro || cto.created_at || '';
    return formatDateToMMYYYY(dataCriacao);
  }
  
  // Função para obter o valor de uma célula baseado em rowIndex e colIndex
  // Nova ordem: 0=Checkbox, 1=N°, 2=CTO, 3=Status, 4=Cidade, 5=POP, 6=CHASSE, 7=PLACA, 8=OLT, 9=ID CTO, 10=Data Criação, 11=Portas Total, 12=Ocupadas, 13=Disponíveis, 14=Ocupação, 15=Latitude, 16=Longitude
  function getCellValue(rowIndex, colIndex, cto) {
    switch(colIndex) {
      case 0: return ''; // Checkbox - vazio (não copiar)
      case 1: return (ctoNumbers.get(cto) || '-').toString(); // N°
      case 2: return cto.nome || ''; // CTO
      case 3: return getStatusCTO(cto); // Status
      case 4: return cto.cidade || 'N/A'; // Cidade
      case 5: return cto.pop || 'N/A'; // POP
      case 6: return cto.olt || 'N/A'; // CHASSE (usa campo olt)
      case 7: return cto.slot || 'N/A'; // PLACA (usa campo slot)
      case 8: return cto.pon || 'N/A'; // OLT (usa campo pon)
      case 9: return (cto.id_cto || cto.id || 'N/A').toString(); // ID CTO
      case 10: {
        // Data de Criação - usar função utilitária para formatação
        const dataCriacao = cto.data_criacao || cto.data_cadastro || cto.created_at || '';
        return formatDateToMMYYYY(dataCriacao);
      }
      case 11: return (cto.vagas_total || 0).toString(); // Portas Total
      case 12: return (cto.clientes_conectados || 0).toString(); // Ocupadas
      case 13: return ((cto.vagas_total || 0) - (cto.clientes_conectados || 0)).toString(); // Disponíveis
      case 14: return `${parseFloat(cto.pct_ocup || 0).toFixed(1)}%`; // Ocupação
      case 15: return (cto.latitude || '').toString(); // Latitude
      case 16: return (cto.longitude || '').toString(); // Longitude
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
      ctosRua.forEach((cto, rowIndex) => {
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
        const cto = ctosRua[rowIndex];
        if (cto) {
          const rowValues = [];
          // Copiar todas as colunas (exceto checkbox)
          for (let colIndex = 1; colIndex <= 16; colIndex++) {
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
        if (ctosRua[row]) {
          cellsByRow[row][col] = getCellValue(row, col, ctosRua[row]);
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

  // Reactive statements para estilos
  $: sidebarWidthStyle = `${sidebarWidth}px`;
  $: mapHeightStyle = `${mapHeightPixels}px`;
  $: mapContainerStyle = isMapMinimized 
    ? 'flex: 0 0 auto;'
    : `height: ${mapHeightPixels}px; flex: 0 0 auto; min-height: ${mapHeightPixels}px;`;

  // Substitua pela sua chave do Google Maps
  const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || 'SUA_CHAVE_AQUI';

  // Função para calcular distância geodésica (linha reta) em metros
  // Função para calcular distância mínima de um ponto até um polígono GeoJSON
  // Calcula a distância até o ponto mais próximo do polígono (vértice ou aresta)
  function calculateDistanceToPolygon(pointLat, pointLng, polygonGeoJSON) {
    if (!polygonGeoJSON || !pointLat || !pointLng) {
      return null;
    }

    let minDistance = Infinity;

    try {
      // Processar Polygon ou MultiPolygon
      let rings = [];
      
      if (polygonGeoJSON.type === 'Polygon') {
        // Polygon tem um array de rings (primeiro é o exterior, outros são buracos)
        rings = polygonGeoJSON.coordinates;
      } else if (polygonGeoJSON.type === 'MultiPolygon') {
        // MultiPolygon tem múltiplos polígonos, cada um com seus rings
        rings = polygonGeoJSON.coordinates.flat();
      } else {
        console.warn(`⚠️ [Cobertura] Tipo GeoJSON não suportado para cálculo de distância: ${polygonGeoJSON.type}`);
        return null;
      }

      // Para cada ring (anel) do polígono
      for (const ring of rings) {
        // Ring é um array de coordenadas [lng, lat]
        // Calcular distância até cada vértice e cada aresta
        for (let i = 0; i < ring.length; i++) {
          const [lng1, lat1] = ring[i];
          
          // Distância até o vértice
          const distToVertex = calculateGeodesicDistance(pointLat, pointLng, lat1, lng1);
          if (distToVertex < minDistance) {
            minDistance = distToVertex;
          }
          
          // Distância até a aresta (segmento entre vértices consecutivos)
          if (i < ring.length - 1) {
            const [lng2, lat2] = ring[i + 1];
            const distToEdge = calculateDistanceToSegment(pointLat, pointLng, lat1, lng1, lat2, lng2);
            if (distToEdge < minDistance) {
              minDistance = distToEdge;
            }
          }
        }
      }

      return minDistance === Infinity ? null : minDistance;
    } catch (err) {
      console.error('❌ [Cobertura] Erro ao calcular distância até polígono:', err);
      return null;
    }
  }

  // Função auxiliar para calcular distância de um ponto até um segmento de linha (aresta do polígono)
  function calculateDistanceToSegment(pointLat, pointLng, segLat1, segLng1, segLat2, segLng2) {
    // Calcular distâncias até os pontos finais do segmento
    const distToPoint1 = calculateGeodesicDistance(pointLat, pointLng, segLat1, segLng1);
    const distToPoint2 = calculateGeodesicDistance(pointLat, pointLng, segLat2, segLng2);
    const distSegment = calculateGeodesicDistance(segLat1, segLng1, segLat2, segLng2);

    // Se o segmento tem comprimento zero, retornar distância até o ponto
    if (distSegment < 0.1) { // Tolerância de 0.1m
      return distToPoint1;
    }

    // Usar fórmula de distância de ponto a linha em coordenadas esféricas
    // Aproximação: calcular usando produto escalar em coordenadas cartesianas locais
    const toRad = (deg) => deg * Math.PI / 180;
    const R = 6371000; // Raio da Terra em metros

    const lat1Rad = toRad(segLat1);
    const lng1Rad = toRad(segLng1);
    const lat2Rad = toRad(segLat2);
    const lng2Rad = toRad(segLng2);
    const pointLatRad = toRad(pointLat);
    const pointLngRad = toRad(pointLng);

    // Coordenadas cartesianas (aproximação local)
    const x1 = Math.cos(lat1Rad) * Math.cos(lng1Rad);
    const y1 = Math.cos(lat1Rad) * Math.sin(lng1Rad);
    const z1 = Math.sin(lat1Rad);

    const x2 = Math.cos(lat2Rad) * Math.cos(lng2Rad);
    const y2 = Math.cos(lat2Rad) * Math.sin(lng2Rad);
    const z2 = Math.sin(lat2Rad);

    const xp = Math.cos(pointLatRad) * Math.cos(pointLngRad);
    const yp = Math.cos(pointLatRad) * Math.sin(pointLngRad);
    const zp = Math.sin(pointLatRad);

    // Vetor do segmento
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;

    // Vetor do ponto1 ao ponto
    const px = xp - x1;
    const py = yp - y1;
    const pz = zp - z1;

    // Produto escalar para encontrar projeção
    const dot = px * dx + py * dy + pz * dz;
    const lenSq = dx * dx + dy * dy + dz * dz;
    
    if (lenSq === 0) {
      return distToPoint1;
    }

    const t = Math.max(0, Math.min(1, dot / lenSq));

    // Ponto projetado no segmento
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    const projZ = z1 + t * dz;

    // Normalizar para obter coordenadas esféricas
    const projLen = Math.sqrt(projX * projX + projY * projY + projZ * projZ);
    if (projLen === 0) {
      return distToPoint1;
    }

    const projLat = Math.asin(projZ / projLen) * 180 / Math.PI;
    const projLng = Math.atan2(projY, projX) * 180 / Math.PI;

    // Calcular distância do ponto até o ponto projetado
    return calculateGeodesicDistance(pointLat, pointLng, projLat, projLng);
  }

  // Usa a fórmula de Haversine
  function calculateGeodesicDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Raio da Terra em metros
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c; // Distância em metros
    return distance;
  }

  // Função para aplicar offset lateral a uma rota para evitar sobreposição
  // Desloca a rota perpendicularmente à direção média, baseado no índice
  // IMPORTANTE: O primeiro ponto (centro da CTO) e o último ponto (cliente) NÃO são deslocados
  function applyRouteOffset(path, routeIndex) {
    if (path.length < 2) return path;
    
    // Guardar o primeiro ponto (centro exato da CTO) e o último ponto (cliente) - não serão deslocados
    const ctoCenter = path[0];
    const clientCenter = path[path.length - 1];
    
    // Se houver apenas 2 pontos (CTO e cliente), não aplicar offset
    if (path.length === 2) {
      return path;
    }
    
    // Calcular direção média da rota (usando primeiro e último ponto)
    const startPoint = path[0];
    const endPoint = path[path.length - 1];
    
    // Calcular azimute (direção) em radianos usando fórmula de Haversine
    const lat1 = startPoint.lat * Math.PI / 180;
    const lat2 = endPoint.lat * Math.PI / 180;
    const dLon = (endPoint.lng - startPoint.lng) * Math.PI / 180;
    
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const bearing = Math.atan2(y, x);
    
    // Calcular direção perpendicular (90 graus à direita)
    const perpendicularBearing = bearing + (Math.PI / 2);
    
    // Offset em metros: -4, -2, 0, 2, 4 (para rotas 0, 1, 2, 3, 4)
    // Isso cria uma distribuição simétrica: 2 rotas de cada lado, 1 no centro
    const offsetMeters = (routeIndex - 2) * 2;
    
    // Converter offset de metros para graus
    // Raio da Terra em metros
    const earthRadiusMeters = 6371000;
    const offsetRadians = offsetMeters / earthRadiusMeters;
    
    // Calcular offset em latitude e longitude
    const offsetLat = offsetRadians * Math.cos(perpendicularBearing) * (180 / Math.PI);
    const offsetLng = offsetRadians * Math.sin(perpendicularBearing) * (180 / Math.PI) / Math.cos(lat1);
    
    // Aplicar offset APENAS aos pontos intermediários (não ao primeiro nem ao último)
    return path.map((point, index) => {
      if (index === 0) {
        // Manter o primeiro ponto exatamente no centro da CTO
        return { lat: ctoCenter.lat, lng: ctoCenter.lng };
      }
      if (index === path.length - 1) {
        // Manter o último ponto exatamente no cliente
        return { lat: clientCenter.lat, lng: clientCenter.lng };
      }
      // Aplicar offset apenas aos pontos intermediários
      return {
        lat: point.lat + offsetLat,
        lng: point.lng + offsetLng
      };
    });
  }

  // Função para filtrar segmentos muito longos da rota (indicam ruas não mapeadas)
  // Quando detecta segmentos muito longos, mantém apenas os pontos principais
  // Isso evita que a rota siga pontos que cortam terrenos quando a rua não está mapeada
  // IMPORTANTE: Sempre preserva o primeiro ponto (CTO) e o último ponto (cliente)
  function filterLongSegments(path, maxSegmentLength = 100) {
    if (path.length < 2) return path;
    
    // Sempre manter o primeiro ponto (CTO) e o último ponto (cliente)
    const firstPoint = path[0];
    const lastPoint = path[path.length - 1];
    
    // Se houver apenas 2 pontos, retornar como está
    if (path.length === 2) {
      return path;
    }
    
    const filteredPath = [firstPoint]; // Sempre manter o primeiro ponto (CTO)
    
    // Processar apenas os pontos intermediários (não o primeiro nem o último)
    for (let i = 1; i < path.length - 1; i++) {
      const prevPoint = filteredPath[filteredPath.length - 1];
      const currentPoint = path[i];
      
      // Calcular distância entre o último ponto filtrado e o ponto atual
      const segmentDistance = calculateGeodesicDistance(
        prevPoint.lat,
        prevPoint.lng,
        currentPoint.lat,
        currentPoint.lng
      );
      
      // Se o segmento é muito longo (mais de maxSegmentLength metros), indica possível rua não mapeada
      // Nesse caso, manter apenas o ponto atual (pular pontos intermediários que cortam terreno)
      if (segmentDistance > maxSegmentLength) {
        // Adicionar o ponto atual (ponto após o segmento longo)
        filteredPath.push(currentPoint);
      } else {
        // Segmento normal (rua mapeada), manter todos os pontos
        filteredPath.push(currentPoint);
      }
    }
    
    // Sempre adicionar o último ponto (cliente) no final
    filteredPath.push(lastPoint);
    
    return filteredPath;
  }

  // Função para calcular distância REAL usando Directions API (ruas)
  function calculateRealRouteDistance(originLat, originLng, destLat, destLng) {
    return new Promise((resolve, reject) => {
      const directionsService = new google.maps.DirectionsService();

      // Calcular distância linear aproximada para decidir o modo de transporte
      const linearDistance = calculateGeodesicDistance(originLat, originLng, destLat, destLng);
      
      // Para distâncias muito longas (> 5000m), usar DRIVING em vez de WALKING
      // WALKING pode falhar ou retornar rotas muito longas para distâncias grandes
      const travelMode = linearDistance > 5000 
        ? google.maps.TravelMode.DRIVING 
        : google.maps.TravelMode.WALKING;
      
      console.log(`🚗 [Frontend] Calculando rota com modo ${travelMode === google.maps.TravelMode.DRIVING ? 'DRIVING' : 'WALKING'} (distância linear: ${linearDistance.toFixed(2)}m)`);

      directionsService.route(
        {
          origin: { lat: originLat, lng: originLng },
          destination: { lat: destLat, lng: destLng },
          travelMode: travelMode, // Usar DRIVING para longas distâncias, WALKING para curtas
          unitSystem: google.maps.UnitSystem.METRIC,
          region: 'BR', // Melhorar resultados para o Brasil
          provideRouteAlternatives: false, // Não calcular rotas alternativas (otimização)
          avoidHighways: travelMode === google.maps.TravelMode.WALKING // Evitar rodovias apenas no modo caminhada
        },
        (result, status) => {
          if (status === 'OK' && result.routes && result.routes.length > 0) {
            const route = result.routes[0];
            let totalDistance = 0;

            // Priorizar cálculo usando overview_path (geometria completa da rota) para maior precisão
            if (route.overview_path && route.overview_path.length > 1) {
              // Calcular distância somando segmentos entre pontos consecutivos do overview_path
              // Isso fornece maior precisão porque usa a geometria exata da rota
              for (let i = 0; i < route.overview_path.length - 1; i++) {
                const point1 = route.overview_path[i];
                const point2 = route.overview_path[i + 1];
                totalDistance += calculateGeodesicDistance(
                  point1.lat(),
                  point1.lng(),
                  point2.lat(),
                  point2.lng()
                );
              }
              
              // Adicionar distância do ponto inicial até o primeiro ponto do overview_path
              totalDistance += calculateGeodesicDistance(
                originLat,
                originLng,
                route.overview_path[0].lat(),
                route.overview_path[0].lng()
              );
              
              // Adicionar distância do último ponto do overview_path até o destino
              const lastPoint = route.overview_path[route.overview_path.length - 1];
              totalDistance += calculateGeodesicDistance(
                lastPoint.lat(),
                lastPoint.lng(),
                destLat,
                destLng
              );
            } else {
              // Fallback: usar distância dos legs se overview_path não estiver disponível
              route.legs.forEach(leg => {
                totalDistance += leg.distance.value; // value está em metros
              });
            }

            resolve(totalDistance);
          } else {
            // Se não conseguir calcular rota, usar distância linear como fallback
            let errorMessage = 'Não foi possível calcular rota real, usando distância linear.';
            switch (status) {
              case 'ZERO_RESULTS':
                errorMessage = 'Nenhuma rota encontrada, usando distância linear.';
                break;
              case 'NOT_FOUND':
                errorMessage = 'Origem ou destino não encontrados, usando distância linear.';
                break;
              case 'OVER_QUERY_LIMIT':
                errorMessage = 'Limite de requisições excedido, usando distância linear.';
                break;
              case 'REQUEST_DENIED':
                errorMessage = 'Requisição negada, usando distância linear.';
                break;
              case 'INVALID_REQUEST':
                errorMessage = 'Requisição inválida, usando distância linear.';
                break;
              default:
                errorMessage = `Erro ao calcular rota (Status: ${status}), usando distância linear.`;
            }
            console.warn(`⚠️ ${errorMessage}`);
            const linearDistance = calculateGeodesicDistance(originLat, originLng, destLat, destLng);
            resolve(linearDistance);
          }
        }
      );
    });
  }

  // Função para verificar/criar base_VI_ALA.xlsx
  async function ensureVIALABase() {
    try {
      const response = await fetch(getApiUrl('/api/vi-ala/ensure-base'));
      if (!response.ok) {
        console.warn('Aviso: Não foi possível verificar/criar base VI ALA');
        return false;
      }
      const result = await response.json();
      if (result.success) {
        console.log('✅ Base VI ALA verificada/criada com sucesso');
        return true;
      }
      return false;
    } catch (err) {
      console.warn('Aviso: Erro ao verificar/criar base VI ALA:', err);
      return false;
    }
  }

  // Função para verificar se a base de dados está disponível (nova abordagem - não carrega tudo)
  async function checkBaseAvailable() {
    try {
      // Verificar se o Supabase está disponível fazendo uma busca simples
      const testLat = -23.5505; // Coordenada de teste (São Paulo)
      const testLng = -46.6333;
      const response = await fetch(getApiUrl(`/api/ctos/nearby?lat=${testLat}&lng=${testLng}&radius=1000`));
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

  // Função para extrair componentes do endereço
  function extractAddressComponents(geocodeResult) {
    const components = geocodeResult.address_components || [];
    const formattedAddress = geocodeResult.formatted_address || '';

    const cityComponent = components.find(c => 
      c.types.includes('locality') || c.types.includes('administrative_area_level_2')
    );
    const postalCodeComponent = components.find(c => c.types.includes('postal_code'));
    const streetNumberComponent = components.find(c => c.types.includes('street_number'));

    clientAddressData = {
      cidade: cityComponent?.long_name || '',
      enderecoCompleto: formattedAddress,
      numero: streetNumberComponent?.long_name || '',
      cep: postalCodeComponent?.long_name || ''
    };

    if (showReportModal) {
      reportForm.cidade = clientAddressData.cidade;
      reportForm.enderecoCompleto = clientAddressData.enderecoCompleto;
      reportForm.numeroEndereco = clientAddressData.numero;
      reportForm.cep = clientAddressData.cep;
    }
  }

  // Função para determinar a cor do marcador baseada na porcentagem de ocupação (pct_ocup)
  function getCTOColor(pctOcup) {
    // Converter para número e tratar valores inválidos
    const porcentagem = parseFloat(pctOcup) || 0;

    // Se for abaixo de 0% ou acima de 100%, retorna vermelho
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

  // Função para iniciar heartbeat (manter usuário online)
  function startHeartbeat() {
    // Limpar intervalo anterior se existir
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    
    // Enviar heartbeat a cada 2 minutos
    heartbeatInterval = setInterval(async () => {
      if (currentUser) {
        try {
          await fetch(getApiUrl('/api/users/heartbeat'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ usuario: currentUser })
          });
        } catch (err) {
          console.error('Erro ao enviar heartbeat:', err);
        }
      }
    }, 2 * 60 * 1000); // 2 minutos
  }
  
  // Função para parar heartbeat
  function stopHeartbeat() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  // Funções de redimensionamento
  function startResizeSidebar(e) {
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
    
    if (isSearchPanelMinimized) return;
    
    const clientX = e.clientX || e.touches?.[0]?.clientX || resizeStartX;
    const deltaX = clientX - resizeStartX;
    const newWidth = resizeStartSidebarWidth + deltaX;
    const clampedWidth = Math.max(300, Math.min(700, newWidth));
    
    sidebarWidth = clampedWidth;
    
    const sidebarElement = document.querySelector('.search-panel');
    if (sidebarElement) {
      sidebarElement.style.width = `${clampedWidth}px`;
      sidebarElement.style.flex = '0 0 auto';
    }
    
    try {
      localStorage.setItem('viabilidadeAlares_sidebarWidth', clampedWidth.toString());
    } catch (err) {
      console.warn('Erro ao salvar largura da sidebar:', err);
    }
  }

  function stopResizeSidebar() {
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
    
    // Se a lista estiver minimizada, permitir que o mapa ocupe quase todo o espaço
    // Deixar apenas espaço para a lista minimizada (~70px) + handle (~20px) + pequena margem
    const minSpaceForList = isListMinimized ? 90 : 200; // 90px quando minimizada, 200px quando expandida
    const maxHeight = Math.max(containerHeight - minSpaceForList, 300);
    const clampedHeight = Math.max(300, Math.min(maxHeight, newHeight));
    
    // Atualizar diretamente - Svelte detecta automaticamente
    mapHeightPixels = clampedHeight;
    
    // Forçar atualização do DOM diretamente também
    const mapElement = document.querySelector('.map-container');
    const listElement = document.querySelector('.results-table-container, .empty-state');
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
    if (listElement) {
      // Respeitar o estado minimizado da lista ao redimensionar
      if (isListMinimized) {
        // Se a lista está minimizada, manter estilos minimizados
        listElement.style.flex = '0 0 auto';
        listElement.style.minHeight = '60px';
      } else {
        // Se a lista está expandida, ocupar o resto do espaço
        listElement.style.flex = '1 1 auto';
        listElement.style.minHeight = '200px';
      }
    }
    
    console.log(`📏 Arrastando mapa/tabela: Mapa ${clampedHeight}px`);
    
    // Salvar no localStorage (sem await para não bloquear)
    try {
      localStorage.setItem('viabilidadeAlares_mapHeight', clampedHeight.toString());
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
      const savedSidebarWidth = localStorage.getItem('viabilidadeAlares_sidebarWidth');
      if (savedSidebarWidth) {
        sidebarWidth = parseInt(savedSidebarWidth, 10);
        if (isNaN(sidebarWidth) || sidebarWidth < 250 || sidebarWidth > 700) {
          sidebarWidth = 400;
        }
      }
      
      const savedMapHeight = localStorage.getItem('viabilidadeAlares_mapHeight');
      if (savedMapHeight) {
        mapHeightPixels = parseInt(savedMapHeight, 10);
        if (isNaN(mapHeightPixels) || mapHeightPixels < 300) {
          mapHeightPixels = 400;
        }
      }
    } catch (err) {
      console.warn('Erro ao carregar preferências de redimensionamento:', err);
    }
  }

  // Função auxiliar para animar três pontinhos
  function animateDots(baseMessage, callback) {
    let dotCount = 0;
    const interval = setInterval(() => {
      dotCount = (dotCount % 3) + 1;
      const dots = '.'.repeat(dotCount);
      callback(baseMessage + dots);
    }, 500); // Alterna a cada 500ms
    
    return interval;
  }

  // Função de inicialização da ferramenta (chamada quando o componente é montado)
  async function initializeTool() {
      // Carregar a ferramenta de Viabilidade
      // Mostrar loading enquanto carrega a ferramenta
      isLoading = true;
      
      try {
      // Etapa 1: Carregando Mapa
      // Limpar intervalo anterior se existir
      if (dotsInterval) {
        clearInterval(dotsInterval);
        dotsInterval = null;
      }
      dotsInterval = animateDots('Carregando Mapa', (message) => {
        loadingMessage = message;
      });
    await loadGoogleMaps();
    
    // Aguardar mais tempo para o usuário conseguir ler a mensagem
    await new Promise(resolve => setTimeout(resolve, 2500));
    
    // Limpar intervalo anterior
    if (dotsInterval) {
      clearInterval(dotsInterval);
      dotsInterval = null;
    }
    
    // Etapa 2: Verificando Base de dados
    dotsInterval = animateDots('Verificando Base de dados', (message) => {
      loadingMessage = message;
    });
    baseDataExists = true; // Resetar estado
    try {
      await checkBaseAvailable();
    } catch (err) {
      console.warn('Aviso: Não foi possível verificar base de dados:', err.message);
      baseDataExists = false;
    }
    
    // Aguardar mais tempo para o usuário conseguir ler a mensagem
    await new Promise(resolve => setTimeout(resolve, 2500));
    
    // Limpar intervalo anterior
    if (dotsInterval) {
      clearInterval(dotsInterval);
      dotsInterval = null;
    }
    
    // Etapa 3: Carregando ambiente Virtual
    dotsInterval = animateDots('Carregando ambiente Virtual', (message) => {
      loadingMessage = message;
    });
    loadProjetistas();
    await loadTabulacoes();
    
    // Aguardar mais tempo para o usuário conseguir ler a mensagem
    await new Promise(resolve => setTimeout(resolve, 2500));
    
    // Limpar intervalo anterior
    if (dotsInterval) {
      clearInterval(dotsInterval);
      dotsInterval = null;
    }
    
    // Etapa 4: Ajuste Finais
    dotsInterval = animateDots('Ajuste Finais', (message) => {
      loadingMessage = message;
    });
    await new Promise(resolve => setTimeout(resolve, 2500));
    
    // Limpar intervalo anterior
    if (dotsInterval) {
      clearInterval(dotsInterval);
      dotsInterval = null;
    }
    
    // Etapa 5: Abrindo Ferramenta Virtual
    dotsInterval = animateDots('Abrindo Ferramenta Virtual', (message) => {
      loadingMessage = message;
    });
    await new Promise(resolve => setTimeout(resolve, 2500));
    
    // Limpar intervalo antes de ocultar loading
    if (dotsInterval) {
      clearInterval(dotsInterval);
      dotsInterval = null;
    }
    
    // Tudo carregado
    isLoading = false;
    
    // Aguardar o DOM atualizar antes de inicializar o mapa
    await tick();
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Agora inicializar o mapa após o elemento estar no DOM
    initMap();
    
    // A mancha de cobertura será carregada automaticamente dentro de initMap()
    // após o mapa estar inicializado
    
    // Iniciar heartbeat em background
    startHeartbeat();
      } catch (err) {
        console.error('Erro ao inicializar ferramenta:', err);
        error = 'Erro ao inicializar ferramenta: ' + err.message;
        isLoading = false;
        
        // Limpar intervalo em caso de erro
        if (dotsInterval) {
          clearInterval(dotsInterval);
          dotsInterval = null;
        }
        
        // Tentar inicializar o mapa mesmo com erro
        await tick();
        await new Promise(resolve => setTimeout(resolve, 100));
        initMap();
      }
  }

  // Função para limpar estado da ferramenta
  function cleanup() {
    // Limpar intervalo de animação dos pontinhos
    if (dotsInterval) {
      clearInterval(dotsInterval);
      dotsInterval = null;
    }
    
    if (map) {
      // Limpar mapa e marcadores
      markers.forEach(marker => marker.setMap(null));
      markers = [];
      if (clientMarker) {
        clientMarker.setMap(null);
        clientMarker = null;
      }
      if (clientInfoWindow) {
        clientInfoWindow.close();
        clientInfoWindow = null;
      }
      routes.forEach(route => route.setMap(null));
      routes = [];
      
      // Limpar polígonos de cobertura ao destruir componente
      clearCoveragePolygons();
      routeData = [];
      ctos = [];
      clientCoords = null;
    }
    // Parar heartbeat
    stopHeartbeat();
  }

  // Função para abrir modal de trocar senha
  function openChangePasswordModal() {
    showChangePasswordModal = true;
    newPassword = '';
    confirmPassword = '';
    changePasswordError = '';
    changePasswordSuccess = false;
    showChangePassword = false;
    showConfirmPassword = false;
    newUserName = currentUser || '';
    changeUserNameError = '';
    changeUserNameSuccess = false;
  }

  // Função para fechar modal de trocar senha
  function closeChangePasswordModal() {
    showChangePasswordModal = false;
    newPassword = '';
    confirmPassword = '';
    changePasswordError = '';
    changePasswordSuccess = false;
    showChangePassword = false;
    showConfirmPassword = false;
    newUserName = '';
    changeUserNameError = '';
    changeUserNameSuccess = false;
  }

  // Função para trocar senha do usuário atual
  async function changeUserPassword() {
    changePasswordError = '';
    changePasswordSuccess = false;
    
    if (!newPassword || !newPassword.trim()) {
      changePasswordError = 'Nova senha é obrigatória';
      return;
    }
    
    if (newPassword.trim().length < 4) {
      changePasswordError = 'A senha deve ter pelo menos 4 caracteres';
      return;
    }
    
    if (newPassword !== confirmPassword) {
      changePasswordError = 'As senhas não coincidem';
      return;
    }
    
    try {
      const response = await fetch(getApiUrl(`/api/projetistas/${encodeURIComponent(currentUser)}/password`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          senha: newPassword.trim()
        }),
      });

      const data = await response.json();

      if (data.success) {
        changePasswordSuccess = true;
        changePasswordError = '';
        // Fechar modal após sucesso
        setTimeout(() => {
          closeChangePasswordModal();
        }, 2000);
      } else {
        changePasswordError = data.error || 'Erro ao alterar senha';
      }
    } catch (err) {
      console.error('Erro ao alterar senha:', err);
      changePasswordError = 'Erro ao conectar com o servidor. Tente novamente.';
    }
  }

  // Função para alterar nome do usuário atual
  async function changeUserName() {
    changeUserNameError = '';
    changeUserNameSuccess = false;
    
    if (!newUserName || !newUserName.trim()) {
      changeUserNameError = 'Novo nome é obrigatório';
      return;
    }
    
    if (newUserName.trim().length < 2) {
      changeUserNameError = 'O nome deve ter pelo menos 2 caracteres';
      return;
    }
    
    if (newUserName.trim().toLowerCase() === currentUser.toLowerCase()) {
      changeUserNameError = 'O novo nome deve ser diferente do nome atual';
      return;
    }
    
    try {
      const response = await fetch(getApiUrl(`/api/projetistas/${encodeURIComponent(currentUser)}/name`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          novoNome: newUserName.trim()
        }),
      });

      const data = await response.json();

      if (data.success) {
        changeUserNameSuccess = true;
        changeUserNameError = '';
        
        // Atualizar currentUser e localStorage
        const oldUser = currentUser;
        currentUser = data.novoNome;
        
        // Atualizar localStorage
        const storedUser = localStorage.getItem('currentUser');
        if (storedUser) {
          localStorage.setItem('currentUser', data.novoNome);
        }
        
        // Atualizar também o 'usuario' no localStorage se existir
        const storedUsuario = localStorage.getItem('usuario');
        if (storedUsuario) {
          localStorage.setItem('usuario', data.novoNome);
        }
        
        
        // Fechar modal após sucesso
        setTimeout(() => {
          closeChangePasswordModal();
        }, 2000);
      } else {
        changeUserNameError = data.error || 'Erro ao alterar nome';
      }
    } catch (err) {
      console.error('Erro ao alterar nome:', err);
      changeUserNameError = 'Erro ao conectar com o servidor. Tente novamente.';
    }
  }

  // Inicializar ferramenta quando o componente é montado
  onMount(async () => {
    try {
      // Carregar preferências de redimensionamento
      loadResizePreferences();
      
      // Adicionar handler para Ctrl+C
      document.addEventListener('keydown', handleCopyKeydown);
      
      // Adicionar handler para detectar cliques fora da tabela
      document.addEventListener('click', handleDocumentClick);
      
      // Registrar função de configurações com o parent
      if (onSettingsRequest && typeof onSettingsRequest === 'function') {
        onSettingsRequest(openSettings);
      }
      
      // Registrar função de pré-carregamento no hover
      if (onSettingsHover && typeof onSettingsHover === 'function') {
        onSettingsHover(preloadSettingsData);
      }
      await initializeTool();
    } catch (err) {
      console.error('Erro ao inicializar ferramenta:', err);
      error = 'Erro ao inicializar ferramenta: ' + err.message;
    }
  });

  // Limpar recursos quando o componente é desmontado
  onDestroy(() => {
    // Remover handler de Ctrl+C
    document.removeEventListener('keydown', handleCopyKeydown);
    // Remover handler de cliques fora da tabela
    document.removeEventListener('click', handleDocumentClick);
    // Limpar intervalo de animação dos pontos
    if (loadingDotsInterval) {
      clearInterval(loadingDotsInterval);
      loadingDotsInterval = null;
    }
    cleanup();
  });

  // Função para carregar projetistas da API ou localStorage
  async function loadProjetistas() {
    try {
      const response = await fetch(getApiUrl('/api/projetistas'));
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          projetistasList = data.projetistas || [];
          // Sincronizar com localStorage
          try {
            localStorage.setItem('projetistasList', JSON.stringify(projetistasList));
          } catch (err) {
            console.error('Erro ao sincronizar localStorage:', err);
          }
          return;
        }
      }
    } catch (err) {
    }
    
    // Fallback para localStorage se a API não estiver disponível
    try {
      const saved = localStorage.getItem('projetistasList');
      if (saved) {
        projetistasList = JSON.parse(saved);
      }
    } catch (localErr) {
      console.error('Erro ao carregar do localStorage:', localErr);
      projetistasList = [];
    }
  }

  // Função para adicionar novo projetista via API ou localmente
  async function addProjetista() {
    if (!newProjetistaName.trim()) {
      return;
    }
    
    const nome = newProjetistaName.trim();
    
    // Verificar se já existe
    if (projetistasList.includes(nome)) {
      reportForm.projetista = nome;
      newProjetistaName = '';
      showAddProjetistaModal = false;
      return;
    }
    
    let apiSuccess = false;
    
    try {
      // Tentar usar a API primeiro
      const response = await fetch(getApiUrl('/api/projetistas'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nome }),
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          projetistasList = data.projetistas || [];
          apiSuccess = true;
        }
      }
    } catch (err) {
    }
    
    // Se a API não funcionou, adicionar localmente
    if (!apiSuccess) {
      projetistasList = [...projetistasList, nome];
      projetistasList.sort(); // Ordenar alfabeticamente
      
      // Salvar no localStorage como fallback
      try {
        localStorage.setItem('projetistasList', JSON.stringify(projetistasList));
      } catch (localErr) {
        console.error('Erro ao salvar no localStorage:', localErr);
      }
    }
    
    reportForm.projetista = nome;
    newProjetistaName = '';
    showAddProjetistaModal = false;
  }

  // Função para carregar tabulações da API ou localStorage
  async function loadTabulacoes() {
    try {
      const response = await fetch(getApiUrl('/api/tabulacoes'));
      if (response.ok) {
        const text = await response.text();
        if (text && text.trim() !== '') {
          const data = JSON.parse(text);
          if (data.success) {
            tabulacoesList = data.tabulacoes || tabulacoesList;
            // Sincronizar com localStorage
            try {
              localStorage.setItem('tabulacoesList', JSON.stringify(tabulacoesList));
            } catch (err) {
              console.error('Erro ao sincronizar localStorage:', err);
            }
            return;
          }
        }
      }
    } catch (err) {
    }

    // Fallback para localStorage se a API não estiver disponível
    try {
      const saved = localStorage.getItem('tabulacoesList');
      if (saved) {
        tabulacoesList = JSON.parse(saved);
      }
    } catch (localErr) {
      console.error('Erro ao carregar do localStorage:', localErr);
    }
  }

  // Função para abrir modal de adicionar tabulação
  function openAddTabulacaoModal() {
    showAddTabulacaoModal = true;
    newTabulacaoName = '';
  }

  // Função para fechar modal de adicionar tabulação
  function closeAddTabulacaoModal() {
    showAddTabulacaoModal = false;
    newTabulacaoName = '';
  }

  // Função para adicionar nova tabulação
  async function addTabulacao() {
    if (!newTabulacaoName.trim()) {
      return;
    }
    
    const nome = newTabulacaoName.trim();
    
    // Verificar se já existe
    if (tabulacoesList.includes(nome)) {
      reportForm.tabulacaoFinal = nome;
      newTabulacaoName = '';
      showAddTabulacaoModal = false;
      return;
    }
    
    let apiSuccess = false;
    
    try {
      // Tentar usar a API primeiro
      const response = await fetch(getApiUrl('/api/tabulacoes'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nome }),
      });
      
      if (response.ok) {
        const text = await response.text();
        if (text && text.trim() !== '') {
          const data = JSON.parse(text);
          if (data.success) {
            tabulacoesList = data.tabulacoes || tabulacoesList;
            apiSuccess = true;
          }
        }
      }
    } catch (err) {
    }
    
    // Se a API não funcionou, adicionar localmente
    if (!apiSuccess) {
      tabulacoesList = [...tabulacoesList, nome];
      tabulacoesList.sort(); // Ordenar alfabeticamente
      
      // Salvar no localStorage como fallback
      try {
        localStorage.setItem('tabulacoesList', JSON.stringify(tabulacoesList));
      } catch (localErr) {
        console.error('Erro ao salvar no localStorage:', localErr);
      }
    }

    reportForm.tabulacaoFinal = nome;
    newTabulacaoName = '';
    showAddTabulacaoModal = false;
  }

  // Função para abrir modal de adicionar projetista
  function openAddProjetistaModal() {
    showAddProjetistaModal = true;
    newProjetistaName = '';
  }

  // Função para fechar modal de adicionar projetista
  function closeAddProjetistaModal() {
    showAddProjetistaModal = false;
    newProjetistaName = '';
  }

  // Pré-carregar dados de configurações quando o usuário passa o mouse sobre a engrenagem
  let settingsDataPreloaded = false;
  
  async function preloadSettingsData() {
    if (settingsDataPreloaded) return;
    
    try {
      // Pré-carregar dados em paralelo sem bloquear a UI
      Promise.all([
        fetch(getApiUrl('/api/projetistas')).then(r => r.text()).then(text => {
          if (text && text.trim() !== '') {
            try {
              const data = JSON.parse(text);
              if (data.success && data.projetistas) {
                localStorage.setItem('projetistasList', JSON.stringify(data.projetistas));
              }
            } catch (e) {}
          }
        }),
        fetch(getApiUrl('/api/tabulacoes')).then(r => r.text()).then(text => {
          if (text && text.trim() !== '') {
            try {
              const data = JSON.parse(text);
              if (data.success && data.tabulacoes) {
                localStorage.setItem('tabulacoesList', JSON.stringify(data.tabulacoes));
              }
            } catch (e) {}
          }
        }),
        fetch(getApiUrl('/api/base-last-modified')).then(r => r.text()).then(text => {
          if (text && text.trim() !== '') {
            try {
              const data = JSON.parse(text);
              if (data.success && data.lastModified) {
                localStorage.setItem('baseLastModified', data.lastModified);
              }
            } catch (e) {}
          }
        })
      ]).catch(() => {}); // Ignorar erros silenciosamente na pré-carga
      
      settingsDataPreloaded = true;
    } catch (err) {
      // Ignorar erros na pré-carga
    }
  }

  // Função para abrir tela de configurações
  function openSettingsModal(event) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    showSettingsModal = true;
  }

  // Wrapper para chamar openSettingsModal sem parâmetros (para ToolWrapper)
  function openSettings() {
    // Pré-carregar dados antes de abrir (se ainda não foi carregado)
    preloadSettingsData();
    showSettingsModal = true;
  }

  // Expor função de pré-carregamento para o parent (ToolWrapper via App.svelte)
  export let onSettingsHover = null; // Callback para quando o mouse passa sobre a engrenagem

  // Função para fechar tela de configurações
  function closeSettingsModal() {
    showSettingsModal = false;
  }

  // Função para recarregar/verificar base após upload
  async function reloadCTOsData() {
    try {
      await checkBaseAvailable();
    } catch (err) {
      console.error('Erro ao verificar base:', err);
    }
  }

  async function loadGoogleMaps() {
    try {
      const loader = new Loader({
        apiKey: GOOGLE_MAPS_API_KEY,
        version: 'weekly',
        libraries: ['places', 'geometry']
      });

      await loader.load();
      googleMapsLoaded = true;
    } catch (err) {
      error = 'Erro ao carregar Google Maps: ' + err.message;
      console.error(err);
    }
  }

  function initMap() {
    if (!googleMapsLoaded) return;

    const mapElement = document.getElementById('map');
    if (!mapElement) return;

    map = new google.maps.Map(mapElement, {
      center: { lat: -23.5505, lng: -46.6333 }, // São Paulo como padrão
      zoom: 13,
      mapTypeControl: true,
      streetViewControl: true,
      fullscreenControl: true,
      scrollwheel: true, // Permite zoom com scroll do mouse
      gestureHandling: 'greedy' // Permite zoom direto com scroll, sem precisar Ctrl
    });
    
    // Carregar mancha de cobertura após inicializar o mapa
    if (map) {
      loadCoveragePolygon().then(loaded => {
        if (loaded && coveragePolygonGeoJSON) {
          drawCoverageArea();
        }
      }).catch(err => {
        console.warn('⚠️ Erro ao carregar mancha de cobertura:', err);
      });
    }
  }

  // ========== FUNÇÕES PARA VERIFICAÇÃO DE COBERTURA DO CLIENTE ==========
  
  // Função para verificar se o endereço do cliente está dentro da área de cobertura
  async function checkClientCoverage(lat, lng) {
    // Se não há coordenadas, não verificar
    if (!lat || !lng) {
      isClientCovered = null;
      distanceToCoverage = null;
      return;
    }
    
    try {
      const coverageCheckResponse = await fetch(getApiUrl(`/api/coverage/check-point?lat=${lat}&lng=${lng}`));
      if (coverageCheckResponse.ok) {
        const coverageCheckData = await coverageCheckResponse.json();
        if (coverageCheckData.success) {
          isClientCovered = coverageCheckData.is_covered;
          // Garantir que distanceToCoverage seja um número válido
          const rawDistance = coverageCheckData.distance_to_coverage_meters;
          console.log(`🔍 [Cobertura] Dados recebidos da API:`, {
            is_covered: coverageCheckData.is_covered,
            distance_to_coverage_meters: rawDistance,
            tipo: typeof rawDistance
          });
          
          if (rawDistance !== null && rawDistance !== undefined && !isNaN(rawDistance) && rawDistance >= 0) {
            distanceToCoverage = parseFloat(rawDistance);
            if (isClientCovered === false && distanceToCoverage === 0) {
              console.warn(`⚠️ [Cobertura] Cliente está FORA da área, mas distância retornada é 0m. Isso pode indicar um problema na API.`);
            }
          } else {
            // Se a distância não for válida, calcular no frontend usando o polígono de cobertura
            if (isClientCovered === false) {
              console.warn(`⚠️ [Cobertura] Cliente está FORA da área, mas distância não foi fornecida pela API (valor: ${rawDistance}). Calculando no frontend...`);
              
              // Tentar calcular distância usando o polígono de cobertura
              if (coveragePolygonGeoJSON) {
                const calculatedDistance = calculateDistanceToPolygon(lat, lng, coveragePolygonGeoJSON);
                if (calculatedDistance !== null && calculatedDistance >= 0) {
                  distanceToCoverage = calculatedDistance;
                  console.log(`✅ [Cobertura] Distância calculada no frontend: ${calculatedDistance.toFixed(2)}m`);
                } else {
                  distanceToCoverage = null;
                  console.warn(`⚠️ [Cobertura] Não foi possível calcular distância no frontend`);
                }
              } else {
                distanceToCoverage = null;
                console.warn(`⚠️ [Cobertura] Polígono de cobertura não está carregado, não é possível calcular distância`);
              }
            } else {
              distanceToCoverage = null;
            }
          }
          console.log(`✅ [Cobertura] Cliente ${isClientCovered ? 'DENTRO' : 'FORA'} da área de cobertura${!isClientCovered && distanceToCoverage !== null && distanceToCoverage > 0 ? ` (${(distanceToCoverage / 1000).toFixed(2)} km)` : !isClientCovered && distanceToCoverage === 0 ? ' (distância: 0m - possível erro na API)' : ''}`);
        } else {
          // Se não há mancha de cobertura calculada, considerar como não verificado
          isClientCovered = null;
          distanceToCoverage = null;
        }
      } else {
        // Se a API não respondeu, considerar como não verificado
        isClientCovered = null;
        distanceToCoverage = null;
      }
    } catch (coverageErr) {
      console.warn('⚠️ [Cobertura] Erro ao verificar cobertura:', coverageErr);
      // Em caso de erro, considerar como não verificado (usar vermelho como padrão)
      isClientCovered = null;
      distanceToCoverage = null;
    }
    
    // Atualizar cor do marcador baseado no status de cobertura
    updateClientMarkerColor();
  }
  
  // Função para atualizar a cor do marcador do cliente baseado no status de cobertura
  function updateClientMarkerColor() {
    if (!clientMarker) return;
    
    // Path de uma casa: triângulo (telhado) + retângulo (base)
    const housePath = 'M12 2L2 7v13h6v-6h8v6h6V7L12 2z';
    
    // Determinar cor baseado no status de cobertura
    // Apenas duas cores: verde (dentro) ou vermelho (fora/não verificado)
    let fillColor;
    if (isClientCovered === true) {
      fillColor = '#28A745'; // Verde - dentro da cobertura
    } else {
      // Vermelho para: fora da cobertura (false) ou não verificado (null)
      fillColor = '#DC3545'; // Vermelho - fora da cobertura ou não verificado
    }
    
    const houseIcon = {
      path: housePath,
      fillColor: fillColor,
      fillOpacity: 1,
      strokeColor: '#FFFFFF',
      strokeWeight: 2.5,
      scale: 1.8,
      anchor: new google.maps.Point(12, 22)
    };
    
    // Atualizar ícone do marcador
    clientMarker.setIcon(houseIcon);
    
    // Atualizar título do marcador
    let title = 'Localização do Cliente (Arraste para ajustar)';
    if (isClientCovered === true) {
      title += ' - DENTRO da área de cobertura';
    } else if (isClientCovered === false) {
      const distanceKm = distanceToCoverage ? (distanceToCoverage / 1000).toFixed(2) : 'desconhecida';
      title += ` - FORA da área de cobertura (${distanceKm} km)`;
    }
    clientMarker.setTitle(title);
  }
  
  // ========== FIM FUNÇÕES PARA VERIFICAÇÃO DE COBERTURA DO CLIENTE ==========

  // ========== FUNÇÕES PARA MANCHA DE COBERTURA ==========
  
  // Função para carregar polígono de cobertura do backend
  async function loadCoveragePolygon() {
    try {
      console.log('📥 [ViabilidadeAlares] Carregando polígono de cobertura do backend...');
      
      const response = await fetch(getApiUrl('/api/coverage/polygon?simplified=true'));
      
      if (!response.ok) {
        console.warn('⚠️ [ViabilidadeAlares] Não foi possível carregar polígonos de cobertura:', response.status);
        return false; // Não lançar erro, apenas retornar false
      }
      
      const data = await response.json();
      
      if (!data.success) {
        console.warn('⚠️ [ViabilidadeAlares] Nenhum polígono de cobertura encontrado. Execute o cálculo primeiro.');
        return false; // Não lançar erro, apenas retornar false
      }
      
      coverageData = data;
      coveragePolygonGeoJSON = data.geometry;
      
      console.log(`✅ [ViabilidadeAlares] Polígono de cobertura carregado: ${data.total_ctos} CTOs, ${data.area_km2?.toFixed(2)} km²`);
      
      return true;
    } catch (err) {
      console.warn('⚠️ [ViabilidadeAlares] Erro ao carregar polígono de cobertura:', err);
      return false; // Não lançar erro, apenas retornar false
    }
  }
  
  // Função para desenhar área de cobertura no mapa
  async function drawCoverageArea() {
    // Verificar se tudo está pronto
    if (!map) {
      console.error('❌ [ViabilidadeAlares] Mapa não está inicializado');
      return;
    }
    
    if (!googleMapsLoaded || !google || !google.maps) {
      console.error('❌ [ViabilidadeAlares] Google Maps não está carregado');
      return;
    }
    
    if (!coveragePolygonGeoJSON) {
      console.warn('⚠️ [ViabilidadeAlares] Nenhum polígono de cobertura carregado');
      return;
    }

    // Verificar se o mapa está realmente visível no DOM
    const mapElement = document.getElementById('map');
    if (!mapElement) {
      console.error('❌ [ViabilidadeAlares] Elemento do mapa não encontrado no DOM');
      return;
    }
    
    // Verificar se o mapa tem dimensões válidas
    const mapRect = mapElement.getBoundingClientRect();
    if (mapRect.width === 0 || mapRect.height === 0) {
      console.warn('⚠️ [ViabilidadeAlares] Mapa não tem dimensões válidas, aguardando...');
      await new Promise(resolve => setTimeout(resolve, 500));
      google.maps.event.trigger(map, 'resize');
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`🗺️ [ViabilidadeAlares] Desenhando polígono de cobertura (${coverageData?.total_ctos || 0} CTOs)...`);
    console.log(`📐 [ViabilidadeAlares] Dimensões do mapa: ${mapRect.width}x${mapRect.height}`);

    // Aguardar um pouco para garantir que o mapa está totalmente renderizado
    await new Promise(resolve => setTimeout(resolve, 200));

    const bounds = new google.maps.LatLngBounds();

    // Converter GeoJSON para formato do Google Maps
    try {
      // GeoJSON pode ter múltiplos polígonos (MultiPolygon) ou um único Polygon
      let polygonsToRender = [];
      
      if (coveragePolygonGeoJSON.type === 'Polygon') {
        // Polígono simples
        polygonsToRender = [coveragePolygonGeoJSON];
      } else if (coveragePolygonGeoJSON.type === 'MultiPolygon') {
        // Múltiplos polígonos - converter para array de polígonos
        polygonsToRender = coveragePolygonGeoJSON.coordinates.map(coords => ({
          type: 'Polygon',
          coordinates: coords
        }));
      } else {
        console.error('❌ [ViabilidadeAlares] Formato GeoJSON não suportado:', coveragePolygonGeoJSON.type);
        return;
      }
      
      console.log(`🎨 [ViabilidadeAlares] Renderizando ${polygonsToRender.length} polígono(s) de cobertura...`);
      
      // Limpar polígonos anteriores se existirem
      clearCoveragePolygons();
      
      // Renderizar cada polígono
      for (const geoJsonPolygon of polygonsToRender) {
        // Converter coordenadas GeoJSON para formato do Google Maps
        const paths = geoJsonPolygon.coordinates[0].map(coord => ({
          lat: coord[1], // GeoJSON usa [lng, lat], Google Maps usa {lat, lng}
          lng: coord[0]
        }));
        
        // Criar polígono no Google Maps
        const polygon = new google.maps.Polygon({
          paths: paths,
          strokeColor: '#8B7AE8',
          strokeOpacity: 0.8,
          strokeWeight: 1.2,
          fillColor: '#6B8DD6',
          fillOpacity: coverageOpacity,
          map: map,
          zIndex: 1, // Colocar atrás dos marcadores (zIndex padrão de marcadores é maior)
          geodesic: true
        });
        
        coveragePolygons.push(polygon);
        
        // Adicionar ao bounds para ajustar zoom (opcional - não vamos ajustar automaticamente)
        // para não interferir com a visualização do usuário
        for (const path of paths) {
          bounds.extend(path);
        }
      }
      
      console.log(`✅ [ViabilidadeAlares] ${coveragePolygons.length} polígono(s) renderizado(s) com sucesso!`);
      
    } catch (err) {
      console.error('❌ [ViabilidadeAlares] Erro ao renderizar polígono:', err);
      return;
    }
  }
  
  // Função para atualizar opacidade das manchas
  function updateCoverageOpacity() {
    // Garantir que coverageOpacity está definido
    if (coverageOpacity === undefined || coverageOpacity === null) {
      coverageOpacity = 0.4;
    }
    
    // Atualizar opacidade de todos os polígonos
    coveragePolygons.forEach(polygon => {
      if (polygon && polygon.setOptions) {
        polygon.setOptions({ fillOpacity: coverageOpacity });
      }
    });
  }
  
  // Função para limpar polígonos de cobertura
  function clearCoveragePolygons() {
    coveragePolygons.forEach(polygon => {
      if (polygon && polygon.setMap) {
        polygon.setMap(null);
      }
    });
    coveragePolygons = [];
  }
  
  // Reactive statement para opacidade percentual (para exibição)
  $: coverageOpacityPercent = Math.round(coverageOpacity * 100);
  
  // ========== FIM FUNÇÕES PARA MANCHA DE COBERTURA ==========

  // Função auxiliar para converter geocoder callback em Promise
  function geocodeAddress(address) {
    return new Promise((resolve, reject) => {
      if (!google.maps || !google.maps.Geocoder) {
        reject(new Error('Google Maps Geocoder não está disponível'));
        return;
      }

      const geocoder = new google.maps.Geocoder();
      
      // Verificar se o geocoder foi criado corretamente
      if (!geocoder) {
        reject(new Error('Não foi possível criar o Geocoder'));
        return;
      }

      geocoder.geocode(
        { 
          address: address.trim(),
          region: 'br' // Priorizar resultados do Brasil
        },
        (results, status) => {
          
          if (status === 'OK' && results && results.length > 0) {
            // Retornar objeto com results e status para compatibilidade
            resolve({ results, status });
          } else if (status === 'ZERO_RESULTS') {
            reject(new Error('ZERO_RESULTS'));
          } else if (status === 'OVER_QUERY_LIMIT') {
            reject(new Error('Geocoding failed: OVER_QUERY_LIMIT'));
          } else if (status === 'REQUEST_DENIED') {
            reject(new Error('Geocoding failed: REQUEST_DENIED'));
          } else if (status === 'INVALID_REQUEST') {
            reject(new Error('Geocoding failed: INVALID_REQUEST'));
          } else {
            reject(new Error(`Geocoding failed: ${status}`));
          }
        }
      );
    });
  }

  // Função auxiliar para reverse geocoding (coordenadas -> endereço)
  function reverseGeocode(lat, lng) {
    return new Promise((resolve, reject) => {
      if (!google.maps || !google.maps.Geocoder) {
        reject(new Error('Google Maps Geocoder não está disponível'));
        return;
      }

      const geocoder = new google.maps.Geocoder();
      
      geocoder.geocode(
        { location: { lat, lng } },
        (results, status) => {
          if (status === 'OK' && results && results.length > 0) {
            // Retornar objeto com results e status para compatibilidade
            resolve({ results, status });
          } else {
            reject(new Error(`Reverse geocoding failed: ${status}`));
          }
        }
      );
    });
  }

  async function searchClientLocation() {
    loading = true;
    error = null;

    // Limpar boxes informativos ao pesquisar novo endereço
    isClientCovered = null;
    distanceToCoverage = null;
    nearestCTOOutsideLimit = null;

    // Limpar marcadores anteriores
    if (map) {
      clearMap();
    }

    try {
      if (searchMode === 'address') {
        if (!addressInput || !addressInput.trim()) {
          error = 'Por favor, insira um endereço';
          loading = false;
          return;
        }

        // Verificar se o Google Maps está carregado
        if (!googleMapsLoaded || !google.maps || !google.maps.Geocoder) {
          error = 'Google Maps não está carregado. Aguarde alguns instantes e tente novamente.';
          loading = false;
          return;
        }

        const addressToSearch = addressInput.trim();

        // Usar Google Maps Geocoding para obter coordenadas
        let result;
        try {
          result = await geocodeAddress(addressToSearch);
        } catch (geocodeError) {
          console.error('Erro no geocoding:', geocodeError);
          throw geocodeError; // Re-throw para ser capturado pelo catch externo
        }

        // Verificar status da resposta
        if (!result || !result.results || result.results.length === 0) {
          error = 'Endereço não encontrado. Tente ser mais específico ou verifique se o endereço está correto.';
          loading = false;
          return;
        }

        // Procurar o resultado mais preciso (ROOFTOP ou RANGE_INTERPOLATED)
        let bestResult = result.results[0];
        for (const res of result.results) {
          if (res.geometry && res.geometry.location_type === 'ROOFTOP') {
            bestResult = res;
            break;
          } else if (res.geometry && res.geometry.location_type === 'RANGE_INTERPOLATED' && bestResult.geometry.location_type !== 'ROOFTOP') {
            bestResult = res;
          }
        }

        // Verificar se o resultado tem geometria válida
        if (!bestResult.geometry || !bestResult.geometry.location) {
          error = 'Endereço encontrado mas sem coordenadas válidas. Tente outro endereço.';
          loading = false;
          return;
        }

        const location = bestResult.geometry.location;
        clientCoords = {
          lat: location.lat(),
          lng: location.lng()
        };

        // Extrair componentes do endereço
        extractAddressComponents(bestResult);
      } else {
        // Parse coordenadas do formato "lat, lng"
        if (!coordinatesInput.trim()) {
          error = 'Por favor, insira as coordenadas';
          loading = false;
          return;
        }

        const coords = coordinatesInput.split(',').map(c => c.trim());

        if (coords.length !== 2) {
          error = 'Formato inválido. Use: latitude, longitude (ex: -22.5728462249402, -47.40101216301998)';
          loading = false;
          return;
        }

        const lat = parseFloat(coords[0]);
        const lng = parseFloat(coords[1]);

        if (isNaN(lat) || isNaN(lng)) {
          error = 'Por favor, insira coordenadas válidas';
          loading = false;
          return;
        }

        clientCoords = { lat, lng };
      }

      if (!clientCoords) {
        error = 'Não foi possível obter coordenadas';
        loading = false;
        return;
      }

      // Mover mapa para a localização exata com zoom maior
      map.setCenter(clientCoords);
      map.setZoom(18); // Zoom maior para mostrar localização exata

      // Verificar cobertura ANTES de criar o marcador
      await checkClientCoverage(clientCoords.lat, clientCoords.lng);

      // Criar ícone de casinha usando path SVG
      // Path de uma casa: triângulo (telhado) + retângulo (base)
      const housePath = 'M12 2L2 7v13h6v-6h8v6h6V7L12 2z';

      // Determinar cor baseado no status de cobertura
      // Apenas duas cores: verde (dentro) ou vermelho (fora/não verificado)
      let fillColor;
      if (isClientCovered === true) {
        fillColor = '#28A745'; // Verde - dentro da cobertura
      } else {
        // Vermelho para: fora da cobertura (false) ou não verificado (null)
        fillColor = '#DC3545'; // Vermelho - fora da cobertura ou não verificado
      }

      const houseIcon = {
        path: housePath,
        fillColor: fillColor,
        fillOpacity: 1,
        strokeColor: '#FFFFFF',
        strokeWeight: 2.5,
        scale: 1.8,
        anchor: new google.maps.Point(12, 22)
      };

      // Criar título do marcador baseado no status
      let markerTitle = 'Localização do Cliente (Arraste para ajustar)';
      if (isClientCovered === true) {
        markerTitle += ' - DENTRO da área de cobertura';
      } else if (isClientCovered === false) {
        const distanceKm = distanceToCoverage ? (distanceToCoverage / 1000).toFixed(2) : 'desconhecida';
        markerTitle += ` - FORA da área de cobertura (${distanceKm} km)`;
      }

      // Adicionar marcador (ícone de casinha) - ARRASTÁVEL
      const marker = new google.maps.Marker({
        position: clientCoords,
        map: map,
        title: markerTitle,
        icon: houseIcon,
        animation: google.maps.Animation.DROP,
        zIndex: 1000,
        optimized: false,
        draggable: true, // Permite arrastar o marcador
        cursor: 'move' // Cursor muda para "move" ao passar sobre o marcador
      });

      clientMarker = marker;
      markers.push(marker);

      async function getAddressFromCoords(lat, lng) {
        try {
          const result = await reverseGeocode(lat, lng);
          if (result.results && result.results.length > 0) {
            const bestResult = result.results[0];
            extractAddressComponents(bestResult);
            return bestResult.formatted_address;
          }
          return null;
        } catch (err) {
          console.error('Erro ao obter endereço:', err);
          return null;
        }
      }

      // Função para criar conteúdo do InfoWindow
      async function createInfoWindowContent(lat, lng, isManual = false) {
        const address = await getAddressFromCoords(lat, lng);

        let content = '<div style="padding: 8px;">';
        content += '<strong>Localização do Cliente</strong><br><br>';

        if (address) {
          content += `<strong>Endereço:</strong><br>${address}<br><br>`;
        }

        content += `<strong>Latitude/Longitude:</strong><br>${(lat || 0).toFixed(10)}, ${(lng || 0).toFixed(10)}<br><br>`;

        if (isManual) {
          content += '<small>Posição ajustada manualmente</small>';
        } else {
          content += '<small>Arraste para ajustar a posição</small>';
        }

        content += '</div>';
        return content;
      }

      // Criar InfoWindow inicial e salvar referência global
      clientInfoWindow = new google.maps.InfoWindow();

      // Carregar conteúdo inicial do InfoWindow
      createInfoWindowContent(clientCoords.lat, clientCoords.lng, false).then(content => {
        if (clientInfoWindow) {
          clientInfoWindow.setContent(content);
          clientInfoWindow.open(map, marker);
        }
      });

      // Atualizar InfoWindow quando o marcador for arrastado
      marker.addListener('dragend', async (event) => {
        const newPosition = {
          lat: event.latLng.lat(),
          lng: event.latLng.lng()
        };

        // Atualizar coordenadas globais do cliente
        clientCoords = newPosition;

        // Verificar cobertura na nova posição
        await checkClientCoverage(newPosition.lat, newPosition.lng);

        // Atualizar coordenadas no input se estiver no modo coordenadas
        if (searchMode === 'coordinates' && newPosition && newPosition.lat !== undefined && newPosition.lng !== undefined) {
          coordinatesInput = `${(newPosition.lat || 0).toFixed(10)}, ${(newPosition.lng || 0).toFixed(10)}`;
        }

        // Atualizar endereço usando reverse geocoding
        try {
          const result = await reverseGeocode(newPosition.lat, newPosition.lng);

          if (result.results && result.results.length > 0) {
            const bestResult = result.results[0];
            extractAddressComponents(bestResult);

            // Atualizar o campo de endereço se estiver no modo endereço
            if (searchMode === 'address') {
              addressInput = bestResult.formatted_address || '';
            }
          }
        } catch (err) {
          console.error('Erro ao atualizar endereço:', err);
        }

        // Limpar CTOs e rotas anteriores quando o cliente move o marcador
        clearCTOs();

        // Atualizar conteúdo do InfoWindow com endereço e coordenadas
        if (clientInfoWindow) {
          const content = await createInfoWindowContent(newPosition.lat, newPosition.lng, true);
          clientInfoWindow.setContent(content);
          clientInfoWindow.open(map, marker);
        }
      });

      marker.addListener('click', () => {
        clientInfoWindow.open(map, marker);
      });

      // Buscar CTOs automaticamente após localizar o cliente
      await searchCTOs();

    } catch (err) {
      console.error('❌ Erro completo:', err);
      console.error('❌ Mensagem de erro:', err.message);
      console.error('❌ Stack trace:', err.stack);
      
      // Verificar se é um erro de geocoding sem resultados
      if (err.message && err.message.includes('ZERO_RESULTS')) {
        error = 'Endereço não encontrado. Tente ser mais específico ou verifique se o endereço está correto.';
      } else if (err.message && err.message.includes('Geocoding failed')) {
        const status = err.message.replace('Geocoding failed: ', '');
        if (status === 'OVER_QUERY_LIMIT') {
          error = 'Limite de consultas excedido. Tente novamente mais tarde.';
        } else if (status === 'REQUEST_DENIED') {
          error = 'Erro de autenticação. Verifique a chave da API do Google Maps no arquivo .env';
        } else if (status === 'INVALID_REQUEST') {
          error = 'Endereço inválido. Verifique se o endereço está correto.';
        } else {
          error = `Erro ao buscar endereço (${status}). Verifique sua conexão e a chave da API.`;
        }
      } else if (err.message && err.message.includes('Google Maps Geocoder não está disponível')) {
        error = 'Google Maps não está carregado. Aguarde alguns instantes e tente novamente.';
      } else if (err.message && err.message.includes('Não foi possível criar o Geocoder')) {
        error = 'Erro ao inicializar o serviço de geocoding. Recarregue a página.';
      } else {
        error = `Erro ao localizar endereço: ${err.message || 'Erro desconhecido'}. Tente novamente.`;
      }
    } finally {
      loading = false;
    }
  }

  // Animação dos pontos em "Localizando..."
  $: if (loading) {
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

  function clearMap() {
    // Fechar InfoWindow do cliente se estiver aberto
    if (clientInfoWindow) {
      clientInfoWindow.close();
      clientInfoWindow = null;
    }

    // Limpar todos os marcadores
    markers.forEach(marker => {
      marker.setMap(null);
    });
    markers = [];
    clientMarker = null;
    clientCoords = null;
    clearCTOs();
  }

  function clearCTOs() {
    // Limpar todas as rotas do mapa
    routes.forEach(route => {
      if (route && route.setMap) {
        route.setMap(null);
      }
    });
    routes = [];
    routeData = []; // Limpar dados de rotas também
    editingRoutes = false; // Desativar modo de edição ao limpar
    if (routeEditInterval) {
      clearInterval(routeEditInterval);
      routeEditInterval = null;
    }
    lastRoutePaths.clear();
    if (routeEditInterval) {
      clearInterval(routeEditInterval);
      routeEditInterval = null;
    }
    lastRoutePaths.clear();

    // Remover apenas marcadores de CTOs do mapa
    // NUNCA remover o marcador do cliente (clientMarker)
    markers.forEach(marker => {
      // Se não é o marcador do cliente, remover do mapa
      if (marker !== clientMarker && marker && marker.setMap) {
        marker.setMap(null);
      }
    });

    // Atualizar array de marcadores (manter apenas o do cliente)
    // Garantir que clientMarker sempre fica no array
    if (clientMarker) {
      markers = [clientMarker];
      // Garantir que o marcador do cliente ainda está no mapa
      if (map && clientMarker && typeof clientMarker.getMap === 'function') {
        if (clientMarker.getMap() === null) {
          clientMarker.setMap(map);
        }
      }
    } else {
      markers = [];
    }

    // Limpar array de CTOs
    ctos = [];
    
    // Limpar boxes informativos relacionados a CTOs
    nearestCTOOutsideLimit = null;
  }

  async function searchCTOs() {
    if (!clientCoords) {
      error = 'Por favor, localize o cliente primeiro';
      return;
    }

    loadingCTOs = true;
    error = null;

    // Limpar CTOs anteriores ANTES de buscar novas
    clearCTOs();

    // Pequeno delay para garantir que a limpeza visual foi feita
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
      // ============================================
      // ETAPA 1: Buscar PRÉDIOS dentro de 100m (OTIMIZAÇÃO: reduzido de 250m para melhor performance)
      // ============================================
      console.log(`🏢 [Frontend] ETAPA 1: Buscando PRÉDIOS próximos de (${clientCoords.lat}, ${clientCoords.lng}) dentro de 100m...`);
      
      const prediosResponse = await fetch(getApiUrl(`/api/condominios/nearby?lat=${clientCoords.lat}&lng=${clientCoords.lng}&radius=100`));
      
      let predios = [];
      if (prediosResponse.ok) {
        const prediosData = await prediosResponse.json();
        if (prediosData.success && prediosData.condominios) {
          predios = prediosData.condominios
            .filter(p => p.distancia_metros <= 100)
            .map(p => ({
              nome: p.nome_predio || 'Prédio',
              latitude: parseFloat(p.latitude),
              longitude: parseFloat(p.longitude),
              is_condominio: true,
              condominio_data: p,
              status_cto_condominio: p.status_cto || null,
              ctos_internas: p.ctos_internas || [], // CTOs internas do prédio
              distancia_metros: p.distancia_metros,
              distancia_km: Math.round((p.distancia_metros / 1000) * 1000) / 1000,
              distancia_real: p.distancia_metros,
              // Campos vazios para prédios (não são CTOs)
              vagas_total: 0,
              clientes_conectados: 0,
              pct_ocup: 0,
              cidade: '',
              pop: '',
              id: ''
            }));
          
          console.log(`✅ [Frontend] ${predios.length} prédios encontrados dentro de 100m`);
          
          // Adicionar prédios imediatamente ao array (sem calcular rotas)
          if (predios.length > 0) {
            ctos = [...predios];
            // Desenhar prédios IMEDIATAMENTE (sem esperar CTOs)
            await drawRoutesAndMarkers();
          }
        }
      }
      
      // ============================================
      // VERIFICAÇÃO: Se endereço está FORA da área de cobertura, pular direto para busca avançada
      // ============================================
      // Declarar variável antes do if/else para estar disponível em ambos os casos
      let ctosWithRealDistance = [];
      
      // Se o endereço está FORA da área de cobertura, pular ETAPA 2-4 e ir direto para busca progressiva
      if (isClientCovered === false) {
        console.log(`🚫 [Frontend] Endereço está FORA da área de cobertura. Pulando busca inicial (250m) e indo direto para busca avançada...`);
        
        // Pular ETAPA 2, 3 e 4 - ir direto para ETAPA 5 (busca progressiva)
        // ctosWithRealDistance já está definido como array vazio acima
        
        // Continuar para ETAPA 5 (busca progressiva) abaixo
      } else {
        // ============================================
        // ETAPA 2: Buscar CTOs dentro de 250m (apenas se DENTRO da área de cobertura)
        // ============================================
        console.log(`🔍 [Frontend] ETAPA 2: Buscando CTOs próximas de (${clientCoords.lat}, ${clientCoords.lng})...`);
        
        const response = await fetch(getApiUrl(`/api/ctos/nearby?lat=${clientCoords.lat}&lng=${clientCoords.lng}&radius=250`));
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Erro HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        if (!data.success || !data.ctos || data.ctos.length === 0) {
          // Se não há CTOs mas há prédios, está OK - não precisa buscar mais
          if (predios.length > 0) {
            loadingCTOs = false;
            return;
          }
          // Se não há CTOs dentro de 250m, continuar para buscar progressivamente (500m, 700m, 900m, 1200m)
          // Não mostrar erro ainda - só mostrar se não encontrar até 1200m
          console.log(`⚠️ [Frontend] Nenhuma CTO retornada pela API dentro de 250m. Continuando busca progressiva...`);
        }
        
        // Filtrar apenas CTOs dentro de 250m
        const validCTOs = data.ctos
          .filter(cto => cto.distancia_metros <= 250)
          .map(cto => ({
            ...cto,
            distancia_km: Math.round((cto.distancia_metros / 1000) * 1000) / 1000
          }));
        
        if (validCTOs.length === 0) {
          // Se não há CTOs mas há prédios, está OK - não precisa buscar mais
          if (predios.length > 0) {
            loadingCTOs = false;
            return;
          }
          // Se não há CTOs dentro de 250m, continuar para buscar progressivamente (500m, 700m, 900m, 1200m)
          // Não mostrar erro ainda - só mostrar se não encontrar até 1200m
          console.log(`⚠️ [Frontend] Nenhuma CTO encontrada dentro de 250m. Continuando busca progressiva...`);
        }
        
        console.log(`✅ [Frontend] ${validCTOs.length} CTOs encontradas dentro de 250m`);
        
        // ============================================
        // ETAPA 3: Filtrar CTOs que NÃO estão em prédios
        // ============================================
        const ctosNormais = validCTOs.filter(cto => !cto.is_condominio || cto.is_condominio === false);
        
        if (ctosNormais.length === 0) {
          console.log(`ℹ️ [Frontend] Todas as CTOs encontradas dentro de 250m são de prédios`);
          // IMPORTANTE: Mesmo que todas sejam prédios, continuar com busca progressiva
          // para encontrar CTOs normais em raios maiores (500m, 700m, etc.)
          // Não retornar aqui - deixar a busca progressiva acontecer na ETAPA 5
        } else {
          console.log(`✅ [Frontend] ${ctosNormais.length} CTOs normais (não são prédios) encontradas dentro de 250m`);
        }
        
        console.log(`✅ [Frontend] ${ctosNormais.length} CTOs normais (não são prédios) encontradas`);
        
        // ============================================
        // ETAPA 4: Calcular rotas APENAS para CTOs normais
        // ============================================
        // Buscar mais CTOs inicialmente (ex: 10-15) para garantir que temos 5 válidas após filtrar por distância real
        // Isso garante que mesmo que algumas fiquem fora de 250m real, ainda teremos 5 válidas
        // IMPORTANTE: Se não há CTOs normais dentro de 250m, ctosNormais estará vazio e não calculará rotas aqui
        // A busca progressiva na ETAPA 5 vai buscar CTOs normais em raios maiores
        const ctosToCheck = ctosNormais.length > 0 ? ctosNormais.slice(0, 15) : []; // Buscar até 15 para garantir 5 válidas

        // OTIMIZAÇÃO: Calcular distâncias em paralelo (Promise.all)
        const distancePromises = ctosToCheck.map(async (cto) => {
          try {
            const realDistance = await calculateRealRouteDistance(
              clientCoords.lat,
              clientCoords.lng,
              cto.latitude,
              cto.longitude
            );

            // Filtrar apenas as que estão dentro de 250m REAL
            if (realDistance <= 250) {
              return {
                ...cto,
                distancia_metros: Math.round(realDistance * 100) / 100,
                distancia_km: Math.round((realDistance / 1000) * 1000) / 1000,
                distancia_real: realDistance
              };
            }
            return null;
          } catch (err) {
            console.error(`❌ Erro ao calcular distância real para ${cto.nome}:`, err);
            // Em caso de erro, manter a CTO com distância linear
            return {
              ...cto,
              distancia_real: cto.distancia_metros
            };
          }
        });

        // Aguardar todas as distâncias em paralelo
        ctosWithRealDistance = (await Promise.all(distancePromises))
          .filter(cto => cto !== null);
        
        // Continuar para ETAPA 5 abaixo
      }
      
      // ============================================
      // ETAPA 5: Se não encontrou CTOs normais dentro de 250m EM ROTAS REAIS, buscar progressivamente
      // IMPORTANTE: Esta busca acontece mesmo se todas as CTOs dentro de 250m são prédios
      // ESTRATÉGIA PROGRESSIVA LINEAR: 
      // 1. Buscar CTOs em raios lineares progressivos (250m → 300m → 350m → ... → 1000m)
      // 2. Em cada raio: selecionar top 10 mais próximas (linear)
      // 3. Calcular rotas reais para essas 10 candidatas
      // 4. Escolher a melhor por rota real
      // 5. Se encontrar CTOs no raio, parar e mostrar resultado
      // 6. Se não encontrar, expandir para próximo raio
      // NOTA: Se endereço está FORA da área de cobertura, esta busca é iniciada automaticamente
      // ============================================
      // ctosWithRealDistance já está definido (vazio se fora da área, ou com resultados se dentro)
      const ctosNormaisLimitadas = ctosWithRealDistance.slice(0, 5);
      
      // Limpar referência anterior (usar variável global)
      nearestCTOOutsideLimit = null;
      
      // IMPORTANTE: A busca detalhada deve acontecer se não há CTOs normais dentro de 250m EM ROTAS REAIS
      // Isso inclui o caso onde todas as CTOs dentro de 250m são prédios
      if (ctosNormaisLimitadas.length === 0) {
        console.log(`🔄 [Frontend] Nenhuma CTO normal encontrada dentro de 250m em rotas reais. Iniciando busca progressiva linear...`);
        
        try {
          // ============================================
          // MELHORIA 1: Busca Paralela de Múltiplos Raios
          // Agrupar raios em lotes para buscar em paralelo (mais rápido)
          // ============================================
          const gruposRaios = [
            [250, 300, 350],  // Grupo 1: raios próximos
            [400, 500, 600],  // Grupo 2: raios médios
            [700, 800, 900],   // Grupo 3: raios maiores
            [1000]             // Grupo 4: raio máximo
          ];
          let melhorCTOEncontrada = null;
          let raioUsado = null;
          
          // Buscar progressivamente em grupos paralelos
          for (const grupoRaios of gruposRaios) {
            console.log(`🔍 [Frontend] Buscando CTOs em paralelo nos raios: ${grupoRaios.join(', ')}m...`);
            
            try {
              // Buscar todos os raios do grupo EM PARALELO
              const resultadosParalelos = await Promise.all(
                grupoRaios.map(async (raio) => {
                  try {
                    const searchResponse = await fetch(getApiUrl(`/api/ctos/nearby?lat=${clientCoords.lat}&lng=${clientCoords.lng}&radius=${raio}`));
                    
                    if (!searchResponse.ok) {
                      return { raio, success: false, error: `HTTP ${searchResponse.status}`, ctos: [] };
                    }
                    
                    const searchData = await searchResponse.json();
                    
                    if (!searchData.success) {
                      return { raio, success: false, error: searchData.error || 'Erro desconhecido', ctos: [] };
                    }
                    
                    return { raio, success: true, ctos: searchData.ctos || [] };
                  } catch (err) {
                    return { raio, success: false, error: err.message, ctos: [] };
                  }
                })
              );
              
              // Escolher o MENOR raio que encontrou CTOs
              let searchData = null;
              let raioEncontrado = null;
              
              for (const resultado of resultadosParalelos) {
                if (resultado.success && resultado.ctos && resultado.ctos.length > 0) {
                  searchData = { success: true, ctos: resultado.ctos };
                  raioEncontrado = resultado.raio;
                  console.log(`✅ [Frontend] Encontrei ${resultado.ctos.length} CTO(s) no raio ${resultado.raio}m (menor raio do grupo)`);
                  break; // Usar o menor raio que encontrou
                }
              }
              
              if (!searchData || !searchData.ctos || searchData.ctos.length === 0) {
                console.log(`⚠️ [Frontend] Nenhuma CTO encontrada nos raios ${grupoRaios.join(', ')}m - expandindo busca...`);
                continue; // Tentar próximo grupo
              }
              
              console.log(`📦 [Frontend] API retornou ${searchData.ctos.length} CTO(s) no raio LINEAR de ${raioEncontrado}m`);
              
              // Filtrar apenas CTOs normais (não prédios)
              const allCTOsNormais = searchData.ctos
                .filter(cto => !cto.is_condominio || cto.is_condominio === false);
              
              console.log(`📦 [Frontend] Após filtrar prédios: ${allCTOsNormais.length} CTO(s) normal(is)`);
              
              if (allCTOsNormais.length === 0) {
                console.log(`⚠️ [Frontend] Nenhuma CTO normal encontrada em ${raioEncontrado}m (apenas prédios) - expandindo busca...`);
                continue; // Tentar próximo grupo
              }
              
              // ============================================
              // PASSO 1: Selecionar Top 10 Mais Próximas (por distância linear)
              // ============================================
              // Ordenar por distância LINEAR (menor primeiro)
              allCTOsNormais.sort((a, b) => {
                const distA = a.distancia_metros || 0;
                const distB = b.distancia_metros || 0;
                return distA - distB;
              });
              
              // Pegar as 10 mais próximas (ou menos, se houver menos de 10)
              const top10CTOs = allCTOsNormais.slice(0, Math.min(10, allCTOsNormais.length));
              
              console.log(`📍 [Frontend] Selecionadas ${top10CTOs.length} CTO(s) mais próxima(s) por distância linear em ${raioEncontrado}m:`);
              top10CTOs.forEach((cto, idx) => {
                console.log(`   ${idx + 1}. ${cto.nome} - ${cto.distancia_metros}m (linear)`);
              });
              
              // ============================================
              // PASSO 2: Calcular Rotas REAIS com Early Exit (máximo 10)
              // MELHORIA 2: Parar quando encontrar vencedora clara
              // MELHORIA 3: Timeout adaptativo por distância
              // IMPORTANTE: A rota vai da CTO até o endereço do cliente (origem: CTO, destino: cliente)
              // ============================================
              console.log(`🔄 [Frontend] Calculando rotas REAIS para ${top10CTOs.length} CTO(s) com early exit...`);
              
              // Dividir em lotes para early exit
              const lotes = [];
              for (let i = 0; i < top10CTOs.length; i += 3) {
                lotes.push(top10CTOs.slice(i, i + 3));
              }
              
              let melhorAteAgora = null;
              let melhorDistancia = Infinity;
              const ctosWithRealRoutes = [];
              
              for (let loteIndex = 0; loteIndex < lotes.length; loteIndex++) {
                const lote = lotes[loteIndex];
                console.log(`   📦 [Lote ${loteIndex + 1}/${lotes.length}] Calculando rotas para ${lote.length} CTO(s)...`);
                
                const routePromisesLote = lote.map(async (cto, index) => {
                  try {
                    const indexGlobal = loteIndex * 3 + index + 1;
                    console.log(`   🔄 [${indexGlobal}/${top10CTOs.length}] Calculando rota para ${cto.nome} (${cto.distancia_metros}m linear)...`);
                    
                    // ============================================
                    // MELHORIA 3: Timeout Adaptativo por Distância
                    // ============================================
                    let timeoutMs;
                    if (cto.distancia_metros < 1000) {
                      timeoutMs = 8000;  // Mais rápido para CTOs próximas (< 1km)
                    } else if (cto.distancia_metros < 3000) {
                      timeoutMs = 12000; // Médio para distâncias intermediárias
                    } else if (cto.distancia_metros > 5000) {
                      timeoutMs = 30000; // Maior para distâncias muito longas
                    } else {
                      timeoutMs = 15000; // Padrão
                    }
                    
                    const realDistancePromise = calculateRealRouteDistance(
                      cto.latitude,   // Origem: CTO
                      cto.longitude,  // Origem: CTO
                      clientCoords.lat,  // Destino: Endereço do cliente
                      clientCoords.lng   // Destino: Endereço do cliente
                    );
                    
                    // Adicionar timeout individual para cada rota
                    const timeoutPromise = new Promise((_, reject) => {
                      setTimeout(() => reject(new Error('Timeout ao calcular rota')), timeoutMs);
                    });
                    
                    const realDistance = await Promise.race([realDistancePromise, timeoutPromise]);
                    
                    console.log(`   ✅ [${indexGlobal}/${top10CTOs.length}] ${cto.nome}: ${cto.distancia_metros}m linear → ${realDistance.toFixed(2)}m real`);
                    
                    return {
                      ...cto,
                      distancia_real: realDistance,
                      distancia_linear_original: cto.distancia_metros,
                      route_calculation_failed: false
                    };
                  } catch (err) {
                    const indexGlobal = loteIndex * 3 + index + 1;
                    console.warn(`   ⚠️ [${indexGlobal}/${top10CTOs.length}] Erro ao calcular rota para ${cto.nome}:`, err.message);
                    console.warn(`   ⚠️ Usando distância linear como fallback para ${cto.nome}`);
                    
                    // Em caso de erro, usar distância linear como fallback
                    return {
                      ...cto,
                      distancia_real: cto.distancia_metros, // Usar linear como fallback
                      distancia_linear_original: cto.distancia_metros,
                      route_calculation_failed: true
                    };
                  }
                });
                
                // Aguardar rotas do lote atual
                const rotasLote = await Promise.all(routePromisesLote);
                ctosWithRealRoutes.push(...rotasLote);
                
                // Atualizar melhor até agora
                rotasLote.forEach(cto => {
                  const dist = cto.distancia_real || cto.distancia_metros || Infinity;
                  if (dist < melhorDistancia) {
                    melhorAteAgora = cto;
                    melhorDistancia = dist;
                  }
                });
                
                // ============================================
                // MELHORIA 2: Early Exit - Parar se encontrar vencedora clara
                // ============================================
                if (melhorAteAgora && loteIndex < lotes.length - 1) {
                  // Verificar se há CTOs não calculadas ainda
                  const proximasCTOs = top10CTOs.slice((loteIndex + 1) * 3);
                  
                  if (proximasCTOs.length > 0) {
                    const proximaLinear = proximasCTOs[0].distancia_metros;
                    
                    // Se a melhor real é menor que a próxima linear - 100m, provavelmente é a vencedora
                    if (melhorDistancia < proximaLinear - 100) {
                      console.log(`   ✅ [Early Exit] Vencedora clara encontrada: ${melhorAteAgora.nome} (${melhorDistancia.toFixed(2)}m real) vs próxima linear (${proximaLinear}m)`);
                      console.log(`   ⏩ Pulando cálculo de ${proximasCTOs.length} CTO(s) restante(s)`);
                      break; // Early exit - não precisa calcular as restantes
                    }
                  }
                }
              }
              
              console.log(`✅ [Frontend] ${ctosWithRealRoutes.length} rotas foram calculadas para raio ${raioEncontrado}m`);
              
              // ============================================
              // PASSO 3: Escolher a Melhor CTO (menor rota real)
              // ============================================
              // Comparar distâncias REAIS e escolher a CTO com MENOR rota real
              ctosWithRealRoutes.sort((a, b) => {
                const distA = a.distancia_real || a.distancia_metros || Infinity;
                const distB = b.distancia_real || b.distancia_metros || Infinity;
                return distA - distB; // Ordenar do menor para o maior
              });
              
              const bestCTO = ctosWithRealRoutes[0];
              
              console.log(`🏆 [Frontend] CTO selecionada (menor rota real) no raio ${raioEncontrado}m: ${bestCTO.nome}`);
              console.log(`   📏 Distância LINEAR: ${bestCTO.distancia_linear_original}m`);
              console.log(`   🛣️  Distância REAL (rota): ${(bestCTO.distancia_real || 0).toFixed(2)}m`);
              
              // Mostrar comparação com outras CTOs para debug
              if (ctosWithRealRoutes.length > 1) {
                console.log(`📊 [Frontend] Comparação com outras CTOs no raio ${raioEncontrado}m:`);
                ctosWithRealRoutes.slice(1, Math.min(5, ctosWithRealRoutes.length)).forEach((cto, idx) => {
                  console.log(`   ${idx + 2}. ${cto.nome}: ${(cto.distancia_real || 0).toFixed(2)}m real (${cto.distancia_linear_original || 0}m linear)`);
                });
              }
              
              // Armazenar a melhor CTO encontrada neste raio
              // IMPORTANTE: Preservar TODAS as propriedades da CTO original, especialmente pct_ocup
              melhorCTOEncontrada = {
                ...bestCTO,
                distancia_metros: Math.round(bestCTO.distancia_real * 100) / 100,
                distancia_km: Math.round((bestCTO.distancia_real / 1000) * 1000) / 1000,
                is_out_of_limit: true, // Flag para indicar que está fora do limite de 250m em rotas reais
                search_radius_used: raioEncontrado, // Raio linear usado para busca
                // Garantir que propriedades essenciais existam
                pct_ocup: bestCTO.pct_ocup !== undefined ? bestCTO.pct_ocup : (bestCTO.vagas_total && bestCTO.vagas_total > 0 
                  ? ((bestCTO.clientes_conectados || 0) / bestCTO.vagas_total) * 100 
                  : 0)
              };
              
              raioUsado = raioEncontrado;
              
              console.log(`✅ [Frontend] CTO mais próxima encontrada no raio ${raioUsado}m: ${melhorCTOEncontrada.nome} a ${(melhorCTOEncontrada.distancia_real || 0).toFixed(2)}m real`);
              
              // PARAR aqui - encontramos CTOs neste raio, não precisa expandir mais
              break;
              
            } catch (grupoErr) {
              console.warn(`⚠️ [Frontend] Erro ao processar grupo de raios ${grupoRaios.join(', ')}m:`, grupoErr);
              // Continuar para próximo grupo em caso de erro
              continue;
            }
          }
          
          // Armazenar resultado final
          if (melhorCTOEncontrada) {
            nearestCTOOutsideLimit = melhorCTOEncontrada;
            console.log(`✅ [Frontend] Busca progressiva concluída. CTO selecionada: ${nearestCTOOutsideLimit.nome} (raio linear ${raioUsado}m, rota real ${(nearestCTOOutsideLimit.distancia_real || 0).toFixed(2)}m)`);
            console.log(`📋 [Frontend] CTO armazenada em nearestCTOOutsideLimit:`, {
              nome: nearestCTOOutsideLimit.nome,
              distancia_real: nearestCTOOutsideLimit.distancia_real,
              is_out_of_limit: nearestCTOOutsideLimit.is_out_of_limit
            });
          } else {
            console.warn(`⚠️ [Frontend] Nenhuma CTO encontrada em nenhum dos raios lineares testados (até 1000m)`);
            nearestCTOOutsideLimit = null;
          }
          
        } catch (searchErr) {
          console.error(`❌ [Frontend] Erro na busca progressiva de CTOs:`, searchErr);
          console.error(`❌ [Frontend] Stack trace:`, searchErr.stack);
          console.warn(`⚠️ [Frontend] Não foi possível buscar CTOs`);
          nearestCTOOutsideLimit = null;
        }
      }
      
      // Log de debug para verificar estado antes da ETAPA 6
      console.log(`🔍 [Frontend] ANTES ETAPA 6 - Estado atual:`, {
        ctosNormaisLimitadas: ctosNormaisLimitadas.length,
        nearestCTOOutsideLimit: nearestCTOOutsideLimit ? nearestCTOOutsideLimit.nome : null,
        predios: predios.length,
        isClientCovered: isClientCovered
      });
      
      // ============================================
      // ETAPA 6: Combinar prédios + CTOs normais + CTO mais próxima (se houver)
      // ============================================
      // IMPORTANTE: Limitar a no máximo 5 CTOs de RUA (não contar prédios no limite)
      // Prédios são mostrados separadamente e não contam no limite de 5
      // Se houver CTO mais próxima fora do limite, adicionar ela também
      console.log(`🔄 [Frontend] ETAPA 6: Combinando resultados...`);
      console.log(`   - Prédios: ${predios.length}`);
      console.log(`   - CTOs normais dentro de 250m: ${ctosNormaisLimitadas.length}`);
      console.log(`   - CTO mais próxima fora do limite: ${nearestCTOOutsideLimit ? nearestCTOOutsideLimit.nome : 'nenhuma'}`);
      
      const todasCTOs = [...predios, ...ctosNormaisLimitadas];
      
      // Se não encontrou nenhuma CTO dentro de 250m, adicionar a mais próxima (fora do limite)
      // IMPORTANTE: Adicionar mesmo se houver prédios (a busca detalhada sempre acontece)
      if (ctosNormaisLimitadas.length === 0 && nearestCTOOutsideLimit) {
        todasCTOs.push(nearestCTOOutsideLimit);
        console.log(`✅ [Frontend] CTO mais próxima adicionada ao array: ${nearestCTOOutsideLimit.nome}`);
        console.log(`   📋 Detalhes da CTO:`, {
          nome: nearestCTOOutsideLimit.nome,
          distancia_real: nearestCTOOutsideLimit.distancia_real,
          distancia_metros: nearestCTOOutsideLimit.distancia_metros,
          is_out_of_limit: nearestCTOOutsideLimit.is_out_of_limit
        });
      } else if (ctosNormaisLimitadas.length > 0) {
        // Limpar referência se encontrou CTOs dentro do limite
        console.log(`ℹ️ [Frontend] CTOs encontradas dentro do limite, não usando nearestCTOOutsideLimit`);
        nearestCTOOutsideLimit = null;
      }
      
      console.log(`📊 [Frontend] Total de CTOs após combinação: ${todasCTOs.length}`);
      
      // Só mostrar erro se não encontrou NENHUMA CTO até 5000m (nem dentro de 250m, nem na busca detalhada)
      if (todasCTOs.length === 0) {
        error = 'Nenhuma CTO encontrada próxima ao endereço dentro de um raio de 5000m';
        loadingCTOs = false;
        return;
      }

      // Ordenar por distância (real para normais, linear para prédios)
      // Prédios sempre aparecem primeiro (sem distância real)
      todasCTOs.sort((a, b) => {
        // Se ambos são prédios, manter ordem original
        if (a.is_condominio && b.is_condominio) return 0;
        // Prédios sempre vêm primeiro
        if (a.is_condominio) return -1;
        if (b.is_condominio) return 1;
        // Para CTOs normais, ordenar por distância real
        const distA = a.distancia_real || a.distancia_metros || 0;
        const distB = b.distancia_real || b.distancia_metros || 0;
        return distA - distB;
      });

      // Atribuir ao array final (prédios + até 5 CTOs de rua)
      ctos = todasCTOs;
      
      console.log(`✅ [Frontend] Total de ${ctos.length} CTO(s) encontrada(s) (${predios.length} prédio(s) + ${ctos.length - predios.length} CTO(s) normal(is))`);
      
      // Inicializar visibilidade de TODAS as CTOs como verdadeira (todas visíveis por padrão)
      // IMPORTANTE: Usar ctos (array final) e não apenas ctosRua, para incluir prédios também
      ctoVisibility.clear();
      for (const cto of ctos) {
        const ctoKey = getCTOKey(cto);
        ctoVisibility.set(ctoKey, true); // Todas visíveis por padrão
      }
      ctoVisibility = ctoVisibility; // Forçar reatividade
      ctoNumbersVersion++; // Forçar atualização da numeração
      
      // Aguardar a reatividade do Svelte recalcular ctosRua e ctoNumbers antes de atualizar o mapa
      await tick();
      await tick(); // Duplo tick para garantir que todas as reatividades sejam processadas
      
      // Verificar se ctoNumbers foi calculado corretamente
      console.log(`🔢 [Frontend] Verificando numeração: ctosRua.length=${ctosRua.length}, ctoNumbers.size=${ctoNumbers.size}`);
      if (ctosRua.length > 0 && ctoNumbers.size === 0) {
        console.warn(`⚠️ [Frontend] ctoNumbers está vazio! Forçando recálculo...`);
        ctoNumbers = calculateCTONumbers();
        ctoNumbersVersion++;
        await tick();
      }
      
      // Desenhar rotas e marcadores
      // IMPORTANTE: Garantir que ctos.length > 0 antes de desenhar
      if (ctos.length > 0) {
        try {
          console.log(`🗺️ [Frontend] Desenhando ${ctos.length} CTO(s) no mapa...`);
          await drawRoutesAndMarkers();
          
          // Atualizar numeração dos marcadores para garantir que corresponda à coluna N°
          await tick(); // Aguardar ctoNumbers ser recalculado
          await updateMarkerNumbers();
          
          console.log(`✅ [Frontend] Busca de CTOs concluída com sucesso. ${ctos.length} CTO(s) exibida(s).`);
        } catch (drawErr) {
          console.error(`❌ [Frontend] Erro ao desenhar rotas e marcadores:`, drawErr);
          // Não lançar erro aqui - apenas logar e continuar
          // O importante é que as CTOs foram encontradas e adicionadas ao array
        }
      } else {
        console.warn(`⚠️ [Frontend] Nenhuma CTO para desenhar no mapa`);
      }

    } catch (err) {
      error = err.message || 'Erro ao buscar CTOs';
      console.error(`❌ [Frontend] Erro na busca de CTOs:`, err);
      console.error(`❌ [Frontend] Stack trace:`, err.stack);
    } finally {
      // GARANTIR que loadingCTOs seja sempre desativado, mesmo em caso de erro
      loadingCTOs = false;
      console.log(`✅ [Frontend] Loading desativado. Busca de CTOs finalizada.`);
      
      // IMPORTANTE: Se searchCTOs foi chamado de searchClientLocation, garantir que loading também seja desativado
      // Isso evita que o botão fique travado em "Localizando.."
      if (loading) {
        console.log(`✅ [Frontend] Desativando loading principal também...`);
        loading = false;
      }
    }
  }

  // Função para desenhar rota REAL usando Directions API
  // A rota parte da CTO até o cliente, seguindo exatamente as ruas
  async function drawRealRoute(cto, index) {
    return new Promise((resolve, reject) => {
      const directionsService = new google.maps.DirectionsService();
      const ctoKey = getCTOKey(cto);

      // Parsear coordenadas da CTO com precisão (garantir que são números válidos)
      const ctoLat = parseFloat(cto.latitude);
      const ctoLng = parseFloat(cto.longitude);
      
      // Validar coordenadas
      if (isNaN(ctoLat) || isNaN(ctoLng)) {
        console.warn(`⚠️ CTO ${cto.nome} tem coordenadas inválidas para calcular rota`);
        reject(new Error('Coordenadas inválidas'));
        return;
      }

      // Calcular distância linear para decidir o modo de transporte
      const linearDistance = calculateGeodesicDistance(ctoLat, ctoLng, clientCoords.lat, clientCoords.lng);
      
      // Para distâncias muito longas (> 5000m), usar DRIVING em vez de WALKING
      // WALKING pode falhar ou retornar rotas muito longas para distâncias grandes
      const travelMode = linearDistance > 5000 
        ? google.maps.TravelMode.DRIVING 
        : google.maps.TravelMode.WALKING;
      
      if (cto.is_out_of_limit) {
        console.log(`🚗 [Frontend] Desenhando rota para CTO fora do limite com modo ${travelMode === google.maps.TravelMode.DRIVING ? 'DRIVING' : 'WALKING'} (distância linear: ${linearDistance.toFixed(2)}m)`);
      }

      // Calcular rota da CTO até o cliente (partindo da CTO)
      // IMPORTANTE: Usar coordenadas parseadas para garantir que sejam exatamente as mesmas do marcador
      directionsService.route(
        {
          origin: { lat: ctoLat, lng: ctoLng }, // Origem: CTO (coordenadas parseadas)
          destination: { lat: clientCoords.lat, lng: clientCoords.lng }, // Destino: Cliente
          travelMode: travelMode, // Usar DRIVING para longas distâncias, WALKING para curtas
          unitSystem: google.maps.UnitSystem.METRIC,
          region: 'BR', // Melhorar resultados para o Brasil
          provideRouteAlternatives: false, // Não calcular rotas alternativas (otimização)
          avoidHighways: travelMode === google.maps.TravelMode.WALKING // Evitar rodovias apenas no modo caminhada
        },
        (result, status) => {
          if (status === 'OK' && result.routes && result.routes.length > 0) {
            const route = result.routes[0];
            const path = [];

            // Começar exatamente na CTO (conectado ao marcador)
            // IMPORTANTE: Usar as mesmas coordenadas parseadas usadas no marcador
            path.push({ lat: ctoLat, lng: ctoLng });

            // Usar overview_path da rota que já contém todos os pontos otimizados e detalhados
            // overview_path é a representação mais precisa da rota calculada pela API
            // Ele já segue exatamente as ruas com todos os detalhes necessários
            if (route.overview_path && route.overview_path.length > 0) {
              // overview_path já contém todos os pontos da rota, incluindo início e fim
              // É a forma mais precisa e confiável de obter a rota completa
              route.overview_path.forEach(point => {
                path.push({ lat: point.lat(), lng: point.lng() });
              });
            } else {
              // Fallback: usar steps.path se overview_path não estiver disponível
              if (route.legs && route.legs.length > 0) {
                route.legs.forEach((leg) => {
                  if (leg.steps && leg.steps.length > 0) {
                    leg.steps.forEach((step, stepIndex) => {
                      if (step.path && step.path.length > 0) {
                        step.path.forEach((point, pointIndex) => {
                          const lat = point.lat();
                          const lng = point.lng();
                          
                          // Adicionar todos os pontos, exceto o primeiro do primeiro step (já temos a CTO)
                          if (stepIndex === 0 && pointIndex === 0) {
                            return;
                          }
                          
                          path.push({ lat, lng });
                        });
                      }
                    });
                  }
                });
              }
            }

            // Terminar exatamente no cliente (conectado ao marcador da casinha)
            // IMPORTANTE: Garantir que o último ponto seja exatamente o cliente
            const lastPoint = { lat: clientCoords.lat, lng: clientCoords.lng };
            
            // Remover o último ponto se for muito próximo do cliente (para evitar duplicata)
            // e adicionar o ponto exato do cliente
            if (path.length > 0) {
              const secondLastPoint = path[path.length - 1];
              const distanceToClient = calculateGeodesicDistance(
                secondLastPoint.lat,
                secondLastPoint.lng,
                lastPoint.lat,
                lastPoint.lng
              );
              
              // Se o último ponto está muito próximo do cliente (menos de 1 metro), substituir
              // Caso contrário, adicionar o ponto do cliente
              if (distanceToClient < 1) {
                path[path.length - 1] = lastPoint;
              } else {
                path.push(lastPoint);
              }
            } else {
              // Se não houver pontos, adicionar pelo menos CTO e cliente
              path.push(lastPoint);
            }

            // GARANTIR que o primeiro ponto seja exatamente a CTO e o último seja o cliente
            // Isso corrige qualquer pequena diferença que a API possa ter
            if (path.length > 0) {
              path[0] = { lat: ctoLat, lng: ctoLng };
              path[path.length - 1] = { lat: clientCoords.lat, lng: clientCoords.lng };
            }

            // Validar se o path tem pontos válidos antes de desenhar
            if (path.length === 0) {
              console.warn(`⚠️ Rota para ${cto.nome} não retornou pontos válidos. Usando fallback.`);
              // Calcular cor da rota baseada na cor da CTO
              // Se estiver fora do limite, usar cor laranja/amarela
              const routeColor = cto.is_out_of_limit 
                ? '#FF9800' // Laranja para CTO fora do limite
                : getCTOColor(cto.pct_ocup || 0);
              
              // Fallback: desenhar linha reta conectando os marcadores
              // Usar coordenadas parseadas para garantir alinhamento
              const fallbackPath = [
                { lat: ctoLat, lng: ctoLng },
                { lat: clientCoords.lat, lng: clientCoords.lng }
              ];
              
              // Aplicar offset lateral para evitar sobreposição
              const offsetFallbackPath = applyRouteOffset(fallbackPath, index);
              
              // Configuração da rota fallback
              const fallbackRouteConfig = {
                path: offsetFallbackPath,
                geodesic: true,
                strokeColor: routeColor,
                strokeOpacity: cto.is_out_of_limit ? 0.5 : 0.6,
                strokeWeight: 4,
                map: map,
                zIndex: 500 + index
              };
              
              // Se estiver fora do limite, adicionar estilo pontilhado
              if (cto.is_out_of_limit) {
                fallbackRouteConfig.icons = [{
                  icon: {
                    path: 'M 0,-1 0,1',
                    strokeOpacity: 1,
                    strokeWeight: 3,
                    scale: 4
                  },
                  offset: '0%',
                  repeat: '20px'
                }];
              }
              
              const routePolyline = new google.maps.Polyline(fallbackRouteConfig);
              routes.push(routePolyline);
              const actualRouteIndex = routes.length - 1;
              
              // Anexar chave da CTO na polyline (para controle por chave, sem depender de coordenadas)
              // CRÍTICO: Cada CTO tem sua própria rota única, identificada por ctoKey (não coordenadas)
              try { 
                routePolyline.__ctoKey = ctoKey;
                console.log(`🔑 ctoKey ${ctoKey} anexado à rota fallback ${actualRouteIndex} para CTO ${cto.nome}`);
              } catch (e) {
                console.error(`❌ Erro ao anexar ctoKey à rota fallback:`, e);
              }

              // Armazenar dados da rota para edição (mesmo no fallback)
              routeData.push({
                polyline: routePolyline,
                ctoIndex: index,
                routeIndex: actualRouteIndex,
                ctoKey, // Chave única da CTO (baseada em ID, não coordenadas)
                cto: cto,
                originalPath: [...fallbackPath]
              });
              console.log(`📝 RouteData criado (fallback): ctoKey=${ctoKey}, ctoNome=${cto.nome}, routeIndex=${actualRouteIndex}`);

              // Clique na rota
              // CRÍTICO: Usar closure para capturar a rota específica
              routePolyline.addListener('click', (event) => {
                const currentRouteIndex = routes.findIndex(r => r === routePolyline);
                if (currentRouteIndex === -1) {
                  console.error(`❌ Rota fallback não encontrada no array routes ao clicar! ctoKey: ${ctoKey}`);
                  return;
                }
                console.log(`🖱️ Clique na rota fallback índice ${currentRouteIndex} (CTO: ${cto.nome}, ctoKey: ${ctoKey})`);
                handleRouteClick(currentRouteIndex, event);
              });
              console.log(`✅ Listener de clique adicionado à rota fallback ${actualRouteIndex} para CTO ${cto.nome} (${ctoKey})`);

              // Listeners de edição: sempre anexar; só salvam quando editingRoutes estiver ativo
              routePolyline.addListener('set_at', () => {
                if (!editingRoutes) return;
                saveRouteEdit(index);
              });
              routePolyline.addListener('insert_at', () => {
                if (!editingRoutes) return;
                saveRouteEdit(index);
              });
              routePolyline.addListener('remove_at', () => {
                if (!editingRoutes) return;
                saveRouteEdit(index);
              });

              resolve();
              return;
            }

            // NÃO filtrar segmentos longos - manter TODOS os pontos para máxima precisão
            // A rota deve seguir exatamente as ruas com todos os detalhes
            // Se houver segmentos longos, eles são parte da rota real e devem ser mantidos
            const filteredPath = path; // Manter todos os pontos sem filtragem

            // NÃO aplicar offset - usar a rota exata da API para máxima precisão
            // O offset estava distorcendo a rota e fazendo ela não chegar ao cliente corretamente
            // Se houver sobreposição de rotas, é melhor ter rotas precisas do que rotas deslocadas
            const offsetPath = filteredPath; // Usar path original sem offset

            // Calcular cor da rota baseada na cor da CTO
            // Se estiver fora do limite, usar cor laranja/amarela
            const routeColor = cto.is_out_of_limit 
              ? '#FF9800' // Laranja para CTO fora do limite
              : getCTOColor(cto.pct_ocup || 0);
            
            let routePolyline;
            
            // Se estiver fora do limite, criar traços laranja com espaços vazios entre eles
            if (cto.is_out_of_limit) {
              // Polyline com traços laranja tracejados (linha base transparente, apenas traços visíveis)
              const routeConfig = {
                path: offsetPath,
                geodesic: false, // CRÍTICO: false = seguir exatamente os pontos (não fazer linha reta entre eles)
                strokeColor: '#FF9800', // Laranja (não será visível pois strokeOpacity é 0)
                strokeOpacity: 0, // Linha base transparente - apenas os traços (ícones) serão visíveis
                strokeWeight: 6,
                map: map,
                zIndex: 500 + index,
                editable: editingRoutes // Tornar editável se estiver no modo de edição
              };
              
              // Traços laranja com espaços vazios entre eles
              // A cor vem do strokeColor da polyline base, apenas controlamos a opacidade nos ícones
              routeConfig.icons = [{
                icon: {
                  path: 'M 0,-4 0,4', // Traço vertical
                  strokeOpacity: ROUTE_ORANGE_OPACITY_OUT_OF_LIMIT, // Opacidade configurável
                  strokeWeight: 6,
                  scale: 1
                },
                offset: '0%',
                repeat: '22px' // Espaçamento menor entre traços para ter mais traços e gaps menores
              }];
              
              routePolyline = new google.maps.Polyline(routeConfig);
            } else {
              // Configuração da rota normal (dentro do limite)
              const routeConfig = {
                path: offsetPath,
                geodesic: false, // CRÍTICO: false = seguir exatamente os pontos (não fazer linha reta entre eles)
                strokeColor: routeColor,
                strokeOpacity: 0.7,
                strokeWeight: 5, // Espessura aumentada para melhor visibilidade
                map: map,
                zIndex: 500 + index,
                editable: editingRoutes // Tornar editável se estiver no modo de edição
              };
              
              routePolyline = new google.maps.Polyline(routeConfig);
            }
            
            // Desenhar Polyline usando TODOS os pontos detalhados SEM offset
            // IMPORTANTE: geodesic: false garante que a rota siga EXATAMENTE os pontos fornecidos
            // Isso faz com que a rota siga cada curva e mudança de direção das ruas

            // Adicionar rota ao array ANTES de criar listeners para garantir índice correto
            routes.push(routePolyline);
            const actualRouteIndex = routes.length - 1; // Índice da rota no array routes

            // Anexar chave da CTO na polyline (para controle por chave, sem depender de coordenadas)
            // CRÍTICO: Cada CTO tem sua própria rota única, identificada por ctoKey (não coordenadas)
            try { 
              routePolyline.__ctoKey = ctoKey;
              console.log(`🔑 ctoKey ${ctoKey} anexado à rota ${actualRouteIndex} para CTO ${cto.nome}`);
            } catch (e) {
              console.error(`❌ Erro ao anexar ctoKey à rota:`, e);
            }
            
            // Armazenar dados da rota para edição
            routeData.push({
              polyline: routePolyline,
              ctoIndex: index, // Índice da CTO no array ctos
              routeIndex: actualRouteIndex, // Índice da rota no array routes
              ctoKey, // Chave única da CTO (baseada em ID, não coordenadas)
              cto: cto,
              originalPath: [...filteredPath] // Cópia do path original
            });
            console.log(`📝 RouteData criado: ctoKey=${ctoKey}, ctoNome=${cto.nome}, routeIndex=${actualRouteIndex}`);

            // Adicionar listener de clique na rota para mostrar popup
            // CRÍTICO: Usar closure para capturar a rota específica e garantir que sempre encontramos a CTO correta
            routePolyline.addListener('click', (event) => {
              // Encontrar o índice atual da rota no array (pode ter mudado se outras rotas foram removidas)
              const currentRouteIndex = routes.findIndex(r => r === routePolyline);
              if (currentRouteIndex === -1) {
                console.error(`❌ Rota não encontrada no array routes ao clicar! ctoKey: ${ctoKey}`);
                return;
              }
              console.log(`🖱️ Clique na rota índice ${currentRouteIndex} (CTO: ${cto.nome}, ctoKey: ${ctoKey})`);
              handleRouteClick(currentRouteIndex, event);
            });
            console.log(`✅ Listener de clique adicionado à rota ${actualRouteIndex} para CTO ${cto.nome} (${ctoKey})`);

            // Listeners de edição: sempre anexar; só salvam quando editingRoutes estiver ativo
            // (assim TODAS as rotas ficam editáveis no modo global, inclusive após recriar)
            routePolyline.addListener('set_at', () => {
              if (!editingRoutes) return;
              saveRouteEdit(index); // index é o ctoIndex
            });
            routePolyline.addListener('insert_at', () => {
              if (!editingRoutes) return;
              saveRouteEdit(index);
            });
            routePolyline.addListener('remove_at', () => {
              if (!editingRoutes) return;
              saveRouteEdit(index);
            });
            resolve();
          } else {
            // Melhorar tratamento de erros com diferentes status codes
            let errorMessage = `Não foi possível desenhar rota real para ${cto.nome}.`;
            switch (status) {
              case 'ZERO_RESULTS':
                errorMessage = `Nenhuma rota encontrada para ${cto.nome}.`;
                break;
              case 'NOT_FOUND':
                errorMessage = `Origem ou destino não encontrados para ${cto.nome}.`;
                break;
              case 'OVER_QUERY_LIMIT':
                errorMessage = `Limite de requisições excedido ao calcular rota para ${cto.nome}.`;
                break;
              case 'REQUEST_DENIED':
                errorMessage = `Requisição negada ao calcular rota para ${cto.nome}.`;
                break;
              case 'INVALID_REQUEST':
                errorMessage = `Requisição inválida ao calcular rota para ${cto.nome}.`;
                break;
              default:
                errorMessage = `Erro ao calcular rota para ${cto.nome}. Status: ${status}`;
            }
            console.warn(`⚠️ ${errorMessage}`);
            
            // Calcular cor da rota baseada na cor da CTO
            // Se estiver fora do limite, usar cor laranja/amarela
            const routeColor = cto.is_out_of_limit 
              ? '#FF9800' // Laranja para CTO fora do limite
              : getCTOColor(cto.pct_ocup || 0);
            
            // Fallback: desenhar linha reta conectando exatamente os marcadores
            const fallbackPath = [
              { lat: cto.latitude, lng: cto.longitude }, // Começa na CTO
              { lat: clientCoords.lat, lng: clientCoords.lng } // Termina no cliente
            ];
            
            // Aplicar offset lateral para evitar sobreposição
            const offsetFallbackPath = applyRouteOffset(fallbackPath, index);
            
            let routePolyline;
            
            // Se estiver fora do limite, criar traços laranja com espaços vazios entre eles
            if (cto.is_out_of_limit) {
              // Polyline com traços laranja tracejados (linha base transparente, apenas traços visíveis)
              const fallbackRouteConfig = {
                path: offsetFallbackPath,
                geodesic: true,
                strokeColor: '#FF9800', // Laranja (não será visível pois strokeOpacity é 0)
                strokeOpacity: 0, // Linha base transparente - apenas os traços (ícones) serão visíveis
                strokeWeight: 5,
                map: map,
                zIndex: 500 + index
              };
              
              // Traços laranja com espaços vazios entre eles
              // A cor vem do strokeColor da polyline base, apenas controlamos a opacidade nos ícones
              fallbackRouteConfig.icons = [{
                icon: {
                  path: 'M 0,-4 0,4', // Traço vertical
                  strokeOpacity: ROUTE_ORANGE_OPACITY_OUT_OF_LIMIT, // Opacidade configurável
                  strokeWeight: 5,
                  scale: 1
                },
                offset: '0%',
                repeat: '50px' // Espaçamento menor entre traços para ter mais traços e gaps menores
              }];
              
              routePolyline = new google.maps.Polyline(fallbackRouteConfig);
            } else {
              // Configuração da rota fallback normal (dentro do limite)
              const fallbackRouteConfig = {
                path: offsetFallbackPath,
                geodesic: true,
                strokeColor: routeColor,
                strokeOpacity: 0.6,
                strokeWeight: 4,
                map: map,
                zIndex: 500 + index
              };
              
              routePolyline = new google.maps.Polyline(fallbackRouteConfig);
            }
            routes.push(routePolyline);
            const actualRouteIndex = routes.length - 1;

            // CRÍTICO: Cada CTO tem sua própria rota única, identificada por ctoKey (não coordenadas)
            try { 
              routePolyline.__ctoKey = ctoKey;
              console.log(`🔑 ctoKey ${ctoKey} anexado à rota fallback 2 ${actualRouteIndex} para CTO ${cto.nome}`);
            } catch (e) {
              console.error(`❌ Erro ao anexar ctoKey à rota fallback 2:`, e);
            }

            // Armazenar dados da rota para edição (mesmo no fallback)
            routeData.push({
              polyline: routePolyline,
              ctoIndex: index,
              routeIndex: actualRouteIndex,
              ctoKey, // Chave única da CTO (baseada em ID, não coordenadas)
              cto: cto,
              originalPath: [...fallbackPath]
            });
            console.log(`📝 RouteData criado (fallback 2): ctoKey=${ctoKey}, ctoNome=${cto.nome}, routeIndex=${actualRouteIndex}`);

            // CRÍTICO: Usar closure para capturar a rota específica
            routePolyline.addListener('click', (event) => {
              const currentRouteIndex = routes.findIndex(r => r === routePolyline);
              if (currentRouteIndex === -1) {
                console.error(`❌ Rota fallback 2 não encontrada no array routes ao clicar! ctoKey: ${ctoKey}`);
                return;
              }
              console.log(`🖱️ Clique na rota fallback 2 índice ${currentRouteIndex} (CTO: ${cto.nome}, ctoKey: ${ctoKey})`);
              handleRouteClick(currentRouteIndex, event);
            });
            console.log(`✅ Listener de clique adicionado à rota fallback 2 ${actualRouteIndex} para CTO ${cto.nome} (${ctoKey})`);

            routePolyline.addListener('set_at', () => {
              if (!editingRoutes) return;
              saveRouteEdit(index);
            });
            routePolyline.addListener('insert_at', () => {
              if (!editingRoutes) return;
              saveRouteEdit(index);
            });
            routePolyline.addListener('remove_at', () => {
              if (!editingRoutes) return;
              saveRouteEdit(index);
            });

            resolve();
          }
        }
      );
    });
  }

  // Função para verificar mudanças nas rotas editáveis (usado como fallback)
  function checkRouteChanges() {
    if (editingRouteIndex === null) {
      return;
    }
    
    if (routes.length === 0) {
      return;
    }
    
    // Verificar apenas a rota que está sendo editada
    const routeIndex = editingRouteIndex;
    const route = routes[routeIndex];
    
    if (!route) {
      return;
    }
    
    if (!route.getPath) {
      return;
    }
    
    const routeInfo = routeData.find(rd => rd.polyline === route);
    if (!routeInfo) {
      return;
    }
    
    const ctoIndex = routeInfo.ctoIndex;
      
      try {
        const currentPath = route.getPath();
        if (!currentPath) {
          console.warn(`⏱️ getPath() retornou null/undefined para rota ${routeIndex} (CTO ${ctoIndex})`);
          return;
        }
        
        if (currentPath.getLength && currentPath.getLength() === 0) {
          console.warn(`⏱️ Path vazio para rota ${routeIndex} (CTO ${ctoIndex})`);
          return;
        }
        
        // Converter path para array - pode ser MVCArray ou array normal
        let pathArray = [];
        if (currentPath.forEach) {
          // É um MVCArray do Google Maps
          currentPath.forEach((p, idx) => {
            pathArray.push(p);
          });
        } else if (Array.isArray(currentPath)) {
          pathArray = currentPath;
        } else {
          // Tentar Array.from como fallback
          try {
            pathArray = Array.from(currentPath);
          } catch (e) {
            console.error(`⏱️ Erro ao converter path para array na rota ${routeIndex} (CTO ${ctoIndex}):`, e);
            return;
          }
        }
        
        // Filtrar pontos válidos e converter para string
        // Os pontos podem ser objetos google.maps.LatLng (com métodos lat()/lng()) ou objetos simples {lat, lng}
        const validPoints = pathArray.filter(p => {
          if (!p) return false;
          // Verificar se é objeto google.maps.LatLng (tem métodos)
          if (typeof p.lat === 'function' && typeof p.lng === 'function') return true;
          // Verificar se é objeto simples {lat, lng}
          if (typeof p.lat === 'number' && typeof p.lng === 'number') return true;
          return false;
        });
        
        if (validPoints.length === 0) {
          console.warn(`⏱️ Nenhum ponto válido encontrado na rota ${routeIndex} (CTO ${ctoIndex})`);
          console.warn(`  Path length: ${currentPath.getLength ? currentPath.getLength() : pathArray.length}`);
          console.warn(`  Primeiro ponto:`, pathArray[0]);
          console.warn(`  Tipo do primeiro ponto:`, typeof pathArray[0]);
          if (pathArray[0]) {
            console.warn(`  Propriedades do primeiro ponto:`, Object.keys(pathArray[0]));
            console.warn(`  p.lat:`, pathArray[0].lat, `(tipo: ${typeof pathArray[0].lat})`);
            console.warn(`  p.lng:`, pathArray[0].lng, `(tipo: ${typeof pathArray[0].lng})`);
          }
          return;
        }
        
        // Converter pontos para string, lidando com ambos os formatos
        const currentPathString = validPoints.map(p => {
          // Se tem métodos, chamar os métodos; senão, usar propriedades diretamente
          const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
          const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
          return `${lat.toFixed(6)},${lng.toFixed(6)}`;
        }).join('|');
        const lastPathString = lastRoutePaths.get(ctoIndex);
        
        // Se o path mudou, atualizar (só atualizar se já tiver um path anterior salvo)
        if (lastPathString === undefined) {
          // Primeira vez verificando esta rota, salvar o path inicial
          lastRoutePaths.set(ctoIndex, currentPathString);
          console.log(`  💾 Path inicial salvo para CTO ${ctoIndex} (${currentPathString.split('|').length} pontos)`);
        } else if (currentPathString !== lastPathString) {
          console.log(`🔄 Mudança detectada na rota da CTO ${ctoIndex} (verificação por intervalo)`);
          console.log(`  Path anterior: ${lastPathString.split('|').length} pontos`);
          console.log(`  Path atual: ${currentPathString.split('|').length} pontos`);
          lastRoutePaths.set(ctoIndex, currentPathString);
          saveRouteEdit(ctoIndex);
        }
      } catch (err) {
        console.error(`⏱️ Erro ao verificar mudanças na rota ${routeIndex} (CTO ${ctoIndex}):`, err);
      }
  }

  // Função para ativar/desativar modo de edição de rotas
  function toggleRouteEditing() {
    editingRoutes = !editingRoutes;
    console.log(`🔄 Modo de edição ${editingRoutes ? 'ATIVADO' : 'DESATIVADO'}. Total de rotas: ${routes.length}`);
    
    // Tornar todas as rotas editáveis ou não editáveis
    routes.forEach((route, routeIndex) => {
      if (route && route.setEditable) {
        route.setEditable(editingRoutes);
        console.log(`  ✓ Rota ${routeIndex} tornada ${editingRoutes ? 'editável' : 'não editável'}`);
        
        // Adicionar ou remover listeners quando entrar/sair do modo de edição
        if (editingRoutes) {
          // Encontrar o índice correto da CTO usando routeData
          const routeInfo = routeData.find(rd => rd.polyline === route);
          const ctoIndex = routeInfo ? routeInfo.ctoIndex : routeIndex;
          
          console.log(`  📍 Rota ${routeIndex} mapeada para CTO índice ${ctoIndex}`);
          
          // Salvar path inicial para comparação
          try {
            const initialPath = route.getPath();
            if (!initialPath) {
              console.warn(`  ⚠️ getPath() retornou null/undefined para CTO ${ctoIndex}`);
              return;
            }
            
            if (initialPath.getLength && initialPath.getLength() === 0) {
              console.warn(`  ⚠️ Path inicial vazio para CTO ${ctoIndex}`);
              return;
            }
            
            // Converter path para array - pode ser MVCArray ou array normal
            let initialPathArray = [];
            if (initialPath.forEach) {
              // É um MVCArray do Google Maps
              initialPath.forEach((p) => {
                initialPathArray.push(p);
              });
            } else if (Array.isArray(initialPath)) {
              initialPathArray = initialPath;
            } else {
              // Tentar Array.from como fallback
              try {
                initialPathArray = Array.from(initialPath);
              } catch (e) {
                console.warn(`  ⚠️ Erro ao converter path inicial para array para CTO ${ctoIndex}:`, e);
                return;
              }
            }
            
            // Filtrar pontos válidos (podem ser google.maps.LatLng ou objetos simples {lat, lng})
            const validInitialPoints = initialPathArray.filter(p => {
              if (!p) return false;
              // Verificar se é objeto google.maps.LatLng (tem métodos)
              if (typeof p.lat === 'function' && typeof p.lng === 'function') return true;
              // Verificar se é objeto simples {lat, lng}
              if (typeof p.lat === 'number' && typeof p.lng === 'number') return true;
              return false;
            });
            
            if (validInitialPoints.length === 0) {
              console.warn(`  ⚠️ Nenhum ponto válido no path inicial para CTO ${ctoIndex}`);
              console.warn(`    Path length: ${initialPath.getLength ? initialPath.getLength() : initialPathArray.length}`);
              console.warn(`    Primeiro ponto:`, initialPathArray[0]);
              if (initialPathArray[0]) {
                console.warn(`    Tipo: ${typeof initialPathArray[0]}, lat: ${initialPathArray[0].lat}, lng: ${initialPathArray[0].lng}`);
              }
              return;
            }
            
            // Converter pontos para string, lidando com ambos os formatos
            const initialPathString = validInitialPoints.map(p => {
              // Se tem métodos, chamar os métodos; senão, usar propriedades diretamente
              const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
              const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
              return `${lat.toFixed(6)},${lng.toFixed(6)}`;
            }).join('|');
            lastRoutePaths.set(ctoIndex, initialPathString);
            console.log(`  💾 Path inicial salvo para CTO ${ctoIndex} (${validInitialPoints.length} pontos válidos de ${initialPath.getLength()} total)`);
          } catch (err) {
            console.warn(`  ⚠️ Erro ao salvar path inicial para CTO ${ctoIndex}:`, err);
          }
          
          // Remover listeners antigos se existirem (evitar duplicatas)
          google.maps.event.clearListeners(route, 'set_at');
          google.maps.event.clearListeners(route, 'insert_at');
          google.maps.event.clearListeners(route, 'remove_at');
          
          // Criar funções wrapper para capturar o ctoIndex correto
          const handleSetAt = () => {
            console.log(`🎯 Evento 'set_at' disparado para rota ${routeIndex}, CTO ${ctoIndex}`);
            saveRouteEdit(ctoIndex);
          };
          
          const handleInsertAt = () => {
            console.log(`🎯 Evento 'insert_at' disparado para rota ${routeIndex}, CTO ${ctoIndex}`);
            saveRouteEdit(ctoIndex);
          };
          
          const handleRemoveAt = () => {
            console.log(`🎯 Evento 'remove_at' disparado para rota ${routeIndex}, CTO ${ctoIndex}`);
            saveRouteEdit(ctoIndex);
          };
          
          // Adicionar listeners para salvar alterações
          route.addListener('set_at', handleSetAt);
          route.addListener('insert_at', handleInsertAt);
          route.addListener('remove_at', handleRemoveAt);
          
          console.log(`  ✅ Listeners adicionados para rota ${routeIndex}`);
        } else {
          // Remover listeners ao sair do modo de edição
          google.maps.event.clearListeners(route, 'set_at');
          google.maps.event.clearListeners(route, 'insert_at');
          google.maps.event.clearListeners(route, 'remove_at');
          console.log(`  🗑️ Listeners removidos da rota ${routeIndex}`);
        }
      } else {
        console.warn(`  ⚠️ Rota ${routeIndex} não tem método setEditable`);
      }
    });
    
    // Iniciar verificação por intervalo como fallback (verifica a cada 500ms)
    if (editingRoutes && routes.length > 0) {
      if (routeEditInterval) {
        clearInterval(routeEditInterval);
      }
      let checkCount = 0;
      routeEditInterval = setInterval(() => {
        if (!editingRoutes) {
          // Se o modo foi desativado, o intervalo será limpo na função toggleRouteEditing
          return;
        }
        checkCount++;
        if (checkCount % 10 === 0) {
          console.log(`⏱️ Intervalo rodando... (verificação #${checkCount})`);
        }
        checkRouteChanges();
      }, 500);
      console.log(`  ⏱️ Intervalo de verificação iniciado (500ms) - verificando ${routes.length} rotas`);
    } else if (!editingRoutes && routeEditInterval) {
      clearInterval(routeEditInterval);
      routeEditInterval = null;
      console.log(`  🛑 Intervalo de verificação parado`);
    }
    
    console.log(`📊 RouteData:`, routeData.map(rd => ({ ctoIndex: rd.ctoIndex, ctoNome: rd.cto?.nome })));
  }

  // Função para lidar com clique em uma rota
  function handleRouteClick(routeIndex, event) {
    // Verificar se o routeIndex é válido
    if (routeIndex === null || routeIndex === undefined || routeIndex < 0 || routeIndex >= routes.length) {
      console.warn(`⚠️ handleRouteClick: routeIndex inválido: ${routeIndex}, routes.length: ${routes.length}`);
      return;
    }
    
    const route = routes[routeIndex];
    if (!route) {
      console.warn(`⚠️ handleRouteClick: Rota não encontrada no índice ${routeIndex}`);
      return;
    }
    
    // CRÍTICO: Usar o ctoKey da rota clicada para encontrar a CTO correta
    // Isso garante que mesmo com coordenadas iguais, sempre encontramos a CTO certa
    const clickedCtoKey = route.__ctoKey;
    if (!clickedCtoKey) {
      console.error(`❌ handleRouteClick: Rota no índice ${routeIndex} não tem ctoKey anexado!`);
      console.log(`🔍 Tentando encontrar por polyline...`);
      // Fallback: tentar encontrar por polyline
      const routeInfo = routeData.find(rd => rd && rd.polyline === route);
      if (!routeInfo) {
        console.error(`❌ RouteInfo não encontrada nem por ctoKey nem por polyline`);
        return;
      }
      selectedRouteIndex = routeIndex;
      return;
    }
    
    console.log(`🖱️ Clique na rota ${routeIndex} com ctoKey: ${clickedCtoKey}`);
    
    // Encontrar routeInfo usando APENAS o ctoKey da rota clicada
    // Isso garante que sempre encontramos a CTO correta, mesmo se houver múltiplas rotas com mesma coordenada
    const routeInfo = routeData.find(rd => {
      if (!rd || rd.ctoKey !== clickedCtoKey) return false;
      // Verificar se a polyline está realmente no mapa E é a mesma rota clicada
      if (!rd.polyline || rd.polyline !== route) return false;
      if (!rd.polyline.getMap) return false;
      return rd.polyline.getMap() === map;
    });
    
    if (!routeInfo) {
      console.error(`❌ handleRouteClick: RouteInfo não encontrada para ctoKey ${clickedCtoKey} na rota ${routeIndex}`);
      console.log(`🔍 RouteData disponível:`, routeData.map(rd => ({ 
        ctoKey: rd.ctoKey, 
        ctoNome: rd.cto?.nome, 
        polylineMatches: rd.polyline === route,
        onMap: rd.polyline?.getMap?.() === map 
      })));
      return;
    }
    
    // Verificar se encontramos a CTO correta
    if (routeInfo.ctoKey !== clickedCtoKey) {
      console.error(`❌ ERRO CRÍTICO: RouteInfo encontrada mas ctoKey não corresponde! Esperado: ${clickedCtoKey}, Encontrado: ${routeInfo.ctoKey}`);
      return;
    }
    
    // Encontrar o índice correto da rota no array routes usando a polyline
    const correctRouteIndex = routes.findIndex(r => r === route);
    if (correctRouteIndex === -1) {
      console.error(`❌ Rota não encontrada no array routes!`);
      return;
    }
    
    selectedRouteIndex = correctRouteIndex;
    const ctoNumber = routeInfo.cto ? (ctoNumbers.get(routeInfo.cto) || 'N/A') : 'N/A';
    console.log(`✅ Popup aberto para rota ${correctRouteIndex} (CTO: ${routeInfo.cto?.nome}, ctoKey: ${routeInfo.ctoKey}, número: ${ctoNumber})`);
    
    // Posicionar popup próximo ao ponto de clique na tela
    if (event && event.domEvent) {
      const clickEvent = event.domEvent;
      // Usar coordenadas da viewport (tela) diretamente
      routePopupPosition = {
        x: clickEvent.clientX - 125, // Offset para centralizar o popup no cursor
        y: clickEvent.clientY - 50
      };
    } else if (event && event.latLng) {
      // Fallback: usar coordenadas do mapa se domEvent não estiver disponível
      const mapDiv = document.getElementById('map');
      if (mapDiv) {
        const mapRect = mapDiv.getBoundingClientRect();
        const projection = map.getProjection();
        const scale = Math.pow(2, map.getZoom());
        const worldCoordinate = projection.fromLatLngToPoint(event.latLng);
        const bounds = map.getBounds();
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        const topRight = projection.fromLatLngToPoint(ne);
        const bottomLeft = projection.fromLatLngToPoint(sw);
        const scaleX = mapRect.width / (topRight.x - bottomLeft.x);
        const scaleY = mapRect.height / (topRight.y - bottomLeft.y);
        
        // Converter para coordenadas da viewport
        routePopupPosition = {
          x: mapRect.left + (worldCoordinate.x - bottomLeft.x) * scaleX - 125,
          y: mapRect.top + (worldCoordinate.y - bottomLeft.y) * scaleY - 50
        };
      }
    }
  }

  // Função para fechar o popup de rota
  function closeRoutePopup() {
    // Se uma rota estiver sendo editada e o popup fechado for da mesma rota, finalizar a edição
    if (editingRouteIndex !== null && selectedRouteIndex !== null && editingRouteIndex === selectedRouteIndex) {
      finishEditingRoute(editingRouteIndex);
    }
    
    selectedRouteIndex = null;
    isDraggingRoutePopup = false;
    // Remover listeners globais se estiverem ativos
    document.removeEventListener('mousemove', handleGlobalDrag);
    document.removeEventListener('mouseup', handleGlobalStopDrag);
  }

  // Funções para arrastar o popup livremente pela tela
  function startDraggingRoutePopup(event) {
    event.preventDefault();
    isDraggingRoutePopup = true;
    const popup = event.currentTarget.closest('.route-popup');
    if (popup) {
      const rect = popup.getBoundingClientRect();
      // Usar coordenadas da viewport (tela)
      dragOffset.x = event.clientX - rect.left;
      dragOffset.y = event.clientY - rect.top;
      
      // Adicionar listeners globais para funcionar mesmo quando o mouse sair do popup
      document.addEventListener('mousemove', handleGlobalDrag);
      document.addEventListener('mouseup', handleGlobalStopDrag);
    }
  }

  // Função global para arrastar (chamada quando o mouse se move em qualquer lugar da tela)
  function handleGlobalDrag(event) {
    if (!isDraggingRoutePopup) return;
    event.preventDefault();
    
    // Calcular nova posição usando coordenadas da viewport (tela)
    const newX = event.clientX - dragOffset.x;
    const newY = event.clientY - dragOffset.y;
    
    // Permitir movimento livre pela tela toda
    routePopupPosition = {
      x: newX,
      y: newY
    };
  }

  // Função global para parar o arrasto
  function handleGlobalStopDrag() {
    if (isDraggingRoutePopup) {
      isDraggingRoutePopup = false;
      // Remover listeners globais
      document.removeEventListener('mousemove', handleGlobalDrag);
      document.removeEventListener('mouseup', handleGlobalStopDrag);
    }
  }

  function dragRoutePopup(event) {
    // Esta função ainda é chamada pelo evento local, mas o handleGlobalDrag faz o trabalho real
    handleGlobalDrag(event);
  }

  function stopDraggingRoutePopup() {
    handleGlobalStopDrag();
  }

  // Função para editar uma rota específica
  function editSingleRoute(routeIndex) {
    console.log(`🔧 editSingleRoute chamada com routeIndex: ${routeIndex}`);
    console.log(`📊 routes.length: ${routes.length}, routeData.length: ${routeData.length}`);
    
    // Validar se o routeIndex é válido
    if (routeIndex === null || routeIndex === undefined || routeIndex < 0 || routeIndex >= routes.length) {
      console.error(`❌ routeIndex inválido: ${routeIndex}`);
      return;
    }
    
    // Se já estiver editando outra rota, finalizar primeiro
    if (editingRouteIndex !== null && editingRouteIndex !== routeIndex) {
      finishEditingRoute(editingRouteIndex);
    }
    
    editingRouteIndex = routeIndex;
    const route = routes[routeIndex];
    
    if (!route) {
      console.error(`❌ Rota não encontrada no índice ${routeIndex}`);
      return;
    }
    
    // Encontrar routeInfo correspondente
    const routeInfo = routeData.find(rd => rd.polyline === route);
    
    if (!routeInfo) {
      console.error(`❌ RouteInfo não encontrada para rota ${routeIndex}`);
      console.log(`🔍 routeData:`, routeData.map(rd => ({ ctoIndex: rd.ctoIndex, ctoNome: rd.cto?.nome })));
      return;
    }
    
    const ctoIndex = routeInfo.ctoIndex;
    console.log(`✅ RouteInfo encontrada: CTO ${ctoIndex} (${routeInfo.cto?.nome})`);
    
    if (route && route.setEditable) {
      route.setEditable(true);
      console.log(`✏️ Rota ${routeIndex} (CTO ${ctoIndex}) agora está editável`);
      
      // Salvar path inicial para comparação
      try {
        const initialPath = route.getPath();
        if (!initialPath) {
          console.warn(`⚠️ getPath() retornou null/undefined para CTO ${ctoIndex}`);
          return;
        }
        
        if (initialPath.getLength && initialPath.getLength() === 0) {
          console.warn(`⚠️ Path inicial vazio para CTO ${ctoIndex}`);
          return;
        }
        
        // Converter path para array
        let initialPathArray = [];
        if (initialPath.forEach) {
          initialPath.forEach((p) => {
            initialPathArray.push(p);
          });
        } else if (Array.isArray(initialPath)) {
          initialPathArray = initialPath;
        } else {
          try {
            initialPathArray = Array.from(initialPath);
          } catch (e) {
            console.warn(`⚠️ Erro ao converter path inicial para array para CTO ${ctoIndex}:`, e);
            return;
          }
        }
        
        // Filtrar pontos válidos
        const validInitialPoints = initialPathArray.filter(p => {
          if (!p) return false;
          if (typeof p.lat === 'function' && typeof p.lng === 'function') return true;
          if (typeof p.lat === 'number' && typeof p.lng === 'number') return true;
          return false;
        });
        
        if (validInitialPoints.length === 0) {
          console.warn(`⚠️ Nenhum ponto válido no path inicial para CTO ${ctoIndex}`);
          return;
        }
        
        const initialPathString = validInitialPoints.map(p => {
          const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
          const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
          return `${lat.toFixed(6)},${lng.toFixed(6)}`;
        }).join('|');
        lastRoutePaths.set(ctoIndex, initialPathString);
        console.log(`💾 Path inicial salvo para CTO ${ctoIndex}`);
      } catch (err) {
        console.warn(`⚠️ Erro ao salvar path inicial para CTO ${ctoIndex}:`, err);
      }
      
      // Remover listeners antigos
      google.maps.event.clearListeners(route, 'set_at');
      google.maps.event.clearListeners(route, 'insert_at');
      google.maps.event.clearListeners(route, 'remove_at');
      
      // Adicionar listeners para salvar alterações
      route.addListener('set_at', () => {
        saveRouteEdit(ctoIndex);
      });
      route.addListener('insert_at', () => {
        saveRouteEdit(ctoIndex);
      });
      route.addListener('remove_at', () => {
        saveRouteEdit(ctoIndex);
      });
      
      // Iniciar intervalo de verificação para esta rota
      if (routeEditInterval) {
        clearInterval(routeEditInterval);
      }
      let checkCount = 0;
      routeEditInterval = setInterval(() => {
        if (editingRouteIndex !== routeIndex) {
          return;
        }
        checkCount++;
        checkRouteChanges();
      }, 500);
    }
    
    // NÃO fechar o popup - ele deve permanecer aberto durante a edição
  }

  // Função para finalizar edição de uma rota específica
  function finishEditingRoute(routeIndex) {
    if (editingRouteIndex !== routeIndex) {
      return;
    }
    
    const route = routes[routeIndex];
    if (route && route.setEditable) {
      route.setEditable(false);
      console.log(`✓ Edição da rota ${routeIndex} finalizada`);
      
      // Remover listeners
      google.maps.event.clearListeners(route, 'set_at');
      google.maps.event.clearListeners(route, 'insert_at');
      google.maps.event.clearListeners(route, 'remove_at');
    }
    
    editingRouteIndex = null;
    
    // Parar intervalo
    if (routeEditInterval) {
      clearInterval(routeEditInterval);
      routeEditInterval = null;
    }
  }

  // Função para calcular distância total de um path (array de pontos)
  function calculatePathDistance(path) {
    if (!path || path.length < 2) return 0;
    
    let totalDistance = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const point1 = path[i];
      const point2 = path[i + 1];
      totalDistance += calculateGeodesicDistance(
        point1.lat,
        point1.lng,
        point2.lat,
        point2.lng
      );
    }
    return totalDistance;
  }

  // Função para salvar alterações quando uma rota for editada
  function saveRouteEdit(ctoIndex) {
    console.log(`🔵 saveRouteEdit chamada para CTO índice: ${ctoIndex}`);
    
    // Encontrar a rota correspondente a esta CTO
    const routeInfo = routeData.find(rd => rd.ctoIndex === ctoIndex);
    if (!routeInfo || !routeInfo.polyline) {
      console.warn(`❌ Rota não encontrada para CTO índice ${ctoIndex}. RouteData:`, routeData);
      return;
    }
    
    const route = routeInfo.polyline;
    
    // Obter o path atualizado da rota editada
    const path = route.getPath();
    const updatedPath = [];
    
    path.forEach(point => {
      updatedPath.push({ lat: point.lat(), lng: point.lng() });
    });
    
    console.log(`📏 Path atualizado tem ${updatedPath.length} pontos`);
    
    // Calcular nova distância total do path editado
    const newDistance = calculatePathDistance(updatedPath);
    console.log(`📐 Nova distância calculada: ${newDistance}m`);
    
    // Atualizar dados da rota
    routeInfo.editedPath = updatedPath;
    
    // Atualizar distância no objeto CTO correspondente
    if (ctos && ctos[ctoIndex]) {
      // Arredondar valores para manter consistência com o formato original
      // Formato: 129.15m (0.129km) - 2 casas decimais para metros, 3 para km
      const distanciaMetros = Math.round(newDistance * 100) / 100;
      const distanciaKm = Math.round((newDistance / 1000) * 1000) / 1000;
      
      console.log(`📊 Valores calculados: ${distanciaMetros}m (${distanciaKm}km)`);
      console.log(`📋 CTO antes da atualização:`, {
        nome: ctos[ctoIndex].nome,
        distancia_metros: ctos[ctoIndex].distancia_metros,
        distancia_km: ctos[ctoIndex].distancia_km
      });
      
      // Criar um novo objeto CTO com os valores atualizados para garantir reatividade
      const updatedCTO = {
        ...ctos[ctoIndex],
        distancia_metros: distanciaMetros,
        distancia_km: distanciaKm,
        distancia_real: newDistance
      };
      
      // Criar um novo array com o objeto atualizado para forçar reatividade do Svelte
      ctos = ctos.map((cto, idx) => idx === ctoIndex ? updatedCTO : cto);
      
      // Atualizar também o objeto CTO no routeData para que o popup reflita as mudanças
      if (routeInfo) {
        routeInfo.cto = updatedCTO;
        // Forçar reatividade do routeData também
        routeData = [...routeData];
      }
      
      // Se a CTO editada está fora do limite, atualizar nearestCTOOutsideLimit também
      if (updatedCTO.is_out_of_limit) {
        // Verificar se é a mesma CTO que está em nearestCTOOutsideLimit
        // Usar ID da CTO para comparação (mais confiável que coordenadas que podem mudar)
        if (nearestCTOOutsideLimit) {
          const nearestId = nearestCTOOutsideLimit.id_cto || nearestCTOOutsideLimit.id;
          const updatedId = updatedCTO.id_cto || updatedCTO.id;
          const nearestNome = nearestCTOOutsideLimit.nome;
          const updatedNome = updatedCTO.nome;
          
          console.log(`🔍 Comparando CTOs: nearestId=${nearestId}, updatedId=${updatedId}, nearestNome=${nearestNome}, updatedNome=${updatedNome}`);
          
          // Comparar por ID ou nome (caso ID não esteja disponível)
          if ((nearestId && updatedId && nearestId === updatedId) || 
              (nearestNome && updatedNome && nearestNome === updatedNome)) {
            // Atualizar nearestCTOOutsideLimit com os novos valores
            nearestCTOOutsideLimit = {
              ...nearestCTOOutsideLimit,
              distancia_metros: distanciaMetros,
              distancia_km: distanciaKm,
              distancia_real: newDistance
            };
            // Forçar reatividade do Svelte criando um novo objeto
            nearestCTOOutsideLimit = {...nearestCTOOutsideLimit};
            console.log(`🔄 nearestCTOOutsideLimit atualizado com nova distância: ${distanciaMetros}m (${distanciaKm}km)`);
            console.log(`📋 nearestCTOOutsideLimit após atualização:`, {
              nome: nearestCTOOutsideLimit.nome,
              distancia_metros: nearestCTOOutsideLimit.distancia_metros,
              distancia_km: nearestCTOOutsideLimit.distancia_km,
              distancia_real: nearestCTOOutsideLimit.distancia_real
            });
          } else {
            console.log(`⚠️ CTO editada não corresponde à nearestCTOOutsideLimit. IDs: ${nearestId} vs ${updatedId}, Nomes: ${nearestNome} vs ${updatedNome}`);
          }
        } else {
          console.log(`⚠️ CTO editada está fora do limite mas nearestCTOOutsideLimit é null`);
        }
      }
      
      console.log(`✅ Rota da CTO ${ctoIndex} (${updatedCTO.nome}) editada. Nova distância: ${distanciaMetros}m (${distanciaKm}km)`);
      console.log(`📋 CTO após atualização:`, {
        nome: ctos[ctoIndex].nome,
        distancia_metros: ctos[ctoIndex].distancia_metros,
        distancia_km: ctos[ctoIndex].distancia_km
      });
    } else {
      console.warn(`❌ CTO não encontrada no índice ${ctoIndex}. Array ctos:`, ctos);
    }
  }

  // Função para restaurar rota original (desfazer edições)
  function restoreRoute(routeIndex) {
    const route = routes[routeIndex];
    const routeInfo = routeData.find(rd => rd.polyline === route);
    
    if (route && routeInfo && routeInfo.originalPath) {
      route.setPath(routeInfo.originalPath.map(p => new google.maps.LatLng(p.lat, p.lng)));
      routeInfo.editedPath = null;
      console.log(`Rota ${routeIndex} restaurada para o path original`);
    }
  }

  // Função para calcular offset para CTOs com coordenadas duplicadas
  function calculateMarkerOffset(coordinateKey, indexInGroup, totalInGroup) {
    // Offset em graus (mínimo para deixar marcadores quase colados, mas ainda visíveis)
    // Usar um padrão sequencial lado a lado
    const baseOffset = 0.00002; // Aproximadamente 2-3 metros
    
    if (totalInGroup === 1) {
      return { latOffset: 0, lngOffset: 0 };
    }
    
    // Calcular posição sequencial: distribuir em linha horizontal
    // Centralizar o grupo (se houver número ímpar, o do meio fica no centro)
    const centerIndex = (totalInGroup - 1) / 2;
    const offsetFromCenter = indexInGroup - centerIndex;
    
    // Colocar lado a lado horizontalmente (apenas longitude muda)
    return {
      latOffset: 0,
      lngOffset: baseOffset * offsetFromCenter
    };
  }

  // Função para atualizar visibilidade de CTOs no mapa baseado em ctoVisibility
  async function updateMapVisibility() {
    if (!map || !ctosRua || ctosRua.length === 0) return;
    
    // Remover marcadores e rotas de CTOs que não estão mais visíveis
    const markersToRemove = [];
    const routesToRemove = [];
    
    // Verificar cada CTO e remover marcador/rota se não estiver visível
    for (let i = 0; i < ctosRua.length; i++) {
      const cto = ctosRua[i];
      const ctoKey = getCTOKey(cto);
      const isVisible = ctoVisibility.get(ctoKey) !== false;
      
      if (!isVisible) {
        // CTO não está visível, remover marcador e rota
        // Encontrar marcador associado a esta CTO
        const ctoMarker = markers.find((marker) => {
          if (!marker) return false;
          if (marker === clientMarker) return false;
          if (marker.getMap && marker.getMap() !== map) return false;
          return marker.__ctoKey === ctoKey;
        });
        
        if (ctoMarker) {
          markersToRemove.push(ctoMarker);
        }
        
        // Encontrar rota associada a esta CTO específica usando ctoKey
        // CRÍTICO: Usar APENAS ctoKey, nunca coordenadas (múltiplas CTOs podem ter mesma coordenada)
        const routeInfo = routeData.find(rd => {
          if (!rd || rd.ctoKey !== ctoKey) return false;
          // Verificar se a polyline está realmente no mapa
          const polyline = rd.polyline;
          if (!polyline || !polyline.getMap) return false;
          return polyline.getMap() === map;
        });
        
        if (routeInfo && routeInfo.polyline) {
          console.log(`🗑️ Removendo rota da CTO ${cto.nome} (${ctoKey}) - rota específica desta CTO`);
          routesToRemove.push(routeInfo.polyline);
          // Marcar para remoção do routeData também (será removido no loop abaixo)
        } else {
          console.log(`⚠️ Rota não encontrada para CTO ${cto.nome} (${ctoKey}) - pode já ter sido removida`);
        }
      }
    }
    
    // Remover marcadores do mapa e do array (com dedupe e remoção robusta)
    const uniqueMarkersToRemove = Array.from(new Set(markersToRemove));
    uniqueMarkersToRemove.forEach(marker => {
      try {
        marker.setMap(null);
      } catch (_) {}
      // Remover sempre do array, mesmo se findIndex falhar por algum motivo
      markers = markers.filter(m => m !== marker);
    });
    
    // Remover rotas do mapa e do array
    // Ordenar por índice decrescente para evitar problemas ao remover múltiplas rotas
    const routesToRemoveWithIndex = routesToRemove.map(route => {
      const routeIndex = routes.findIndex(r => r === route);
      return { route, routeIndex };
    }).filter(item => item.routeIndex !== -1).sort((a, b) => b.routeIndex - a.routeIndex);
    
    routesToRemoveWithIndex.forEach(({ route, routeIndex }) => {
      route.setMap(null);
      // Se a rota que está sendo removida estava sendo editada, finalizar edição
      if (editingRouteIndex === routeIndex) {
        finishEditingRoute(routeIndex);
      }
      // Se a rota que está sendo removida tinha o popup aberto, fechar o popup
      if (selectedRouteIndex === routeIndex) {
        selectedRouteIndex = null;
      }
      
      // Remover do routeData também (usar polyline para encontrar - mais confiável)
      // CRÍTICO: Remover apenas a entrada específica desta rota, não outras rotas com mesma coordenada
      const routeInfoToRemove = routeData.find(rd => rd && rd.polyline === route);
      if (routeInfoToRemove) {
        const routeDataIndex = routeData.findIndex(rd => rd === routeInfoToRemove);
        if (routeDataIndex !== -1) {
          console.log(`🗑️ Removendo routeData[${routeDataIndex}] para CTO ${routeInfoToRemove.cto?.nome} (${routeInfoToRemove.ctoKey})`);
          routeData.splice(routeDataIndex, 1);
        }
      } else {
        console.warn(`⚠️ RouteInfo não encontrado em routeData para rota removida no índice ${routeIndex}`);
      }
      
      routes.splice(routeIndex, 1);
      // Ajustar editingRouteIndex se necessário (se removemos uma rota antes da que está sendo editada)
      if (editingRouteIndex !== null && editingRouteIndex > routeIndex) {
        editingRouteIndex--;
      }
      // Ajustar selectedRouteIndex se necessário (se removemos uma rota antes da que está selecionada)
      if (selectedRouteIndex !== null && selectedRouteIndex > routeIndex) {
        selectedRouteIndex--;
      }
    });
    
    // Adicionar marcadores e rotas de CTOs que agora estão visíveis mas não estão no mapa
    for (let i = 0; i < ctosRua.length; i++) {
      const cto = ctosRua[i];
      const ctoKey = getCTOKey(cto);
      const isVisible = ctoVisibility.get(ctoKey) !== false;
      
      if (isVisible) {
        // Verificar se o marcador já existe no mapa
        const ctoLat = parseFloat(cto.latitude);
        const ctoLng = parseFloat(cto.longitude);
        
        if (isNaN(ctoLat) || isNaN(ctoLng)) continue;
        
        const markerExists = markers.some(marker => {
          if (!marker) return false;
          if (marker === clientMarker) return false; // Ignorar marcador do cliente
          if (marker.getMap && marker.getMap() !== map) return false;
          return marker.__ctoKey === ctoKey;
        });
        
        // Verificar se a rota existe E está no mapa (não apenas em routeData)
        // CRÍTICO: Usar APENAS ctoKey para identificar rotas, nunca coordenadas
        // Múltiplas CTOs podem ter a mesma coordenada, mas cada uma DEVE ter sua própria rota única
        const routeExists = routeData.some(rd => {
          if (!rd || rd.ctoKey !== ctoKey) return false;
          // Verificar se a polyline está realmente no mapa
          const polyline = rd.polyline;
          if (!polyline || !polyline.getMap) return false;
          return polyline.getMap() === map;
        });
        
        // Se não existe marcador, criar
        if (!markerExists) {
          // Encontrar o índice da CTO no array ctos completo
          const ctoIndex = ctos.findIndex(c => getCTOKey(c) === ctoKey);
          if (ctoIndex !== -1) {
            // Criar marcador usando a mesma lógica de drawRoutesAndMarkers
            await createCTOMarker(ctos[ctoIndex], ctoIndex);
          }
        }
        
        // Se não existe rota no mapa e a CTO precisa de rota, criar
        // IMPORTANTE: Cada CTO tem sua própria rota, mesmo que compartilhe coordenadas com outras
        // Incluir CTOs normais dentro de 250m OU CTOs fora do limite (is_out_of_limit)
        if (!routeExists && !cto.is_condominio && cto.distancia_metros && cto.distancia_metros > 0 && (cto.distancia_real || cto.is_out_of_limit)) {
          const ctoIndex = ctos.findIndex(c => getCTOKey(c) === ctoKey);
          if (ctoIndex !== -1) {
            console.log(`📍 Criando rota ÚNICA para CTO ${cto.nome} (${ctoKey}) - mesmo que outras CTOs tenham mesma coordenada`);
            await drawRealRoute(ctos[ctoIndex], ctoIndex);
          }
        } else if (routeExists) {
          console.log(`✓ Rota já existe para CTO ${cto.nome} (${ctoKey}) - rota específica desta CTO`);
        }
      }
    }
    
    // Atualizar numeração dos marcadores existentes no mapa
    await updateMarkerNumbers();
    
    // Atualizar numeração dos marcadores
    ctoNumbersVersion++;
    await tick();
  }
  
  // Função para atualizar os números dos marcadores no mapa baseado em ctoNumbers
  async function updateMarkerNumbers() {
    if (!map || !ctosRua || ctosRua.length === 0) return;
    
    // Para cada CTO visível, encontrar seu marcador e atualizar o label
    for (const cto of ctosRua) {
      const ctoKey = getCTOKey(cto);
      const isVisible = ctoVisibility.get(ctoKey) !== false;
      
      if (!isVisible) continue; // Pular CTOs não visíveis
      
      const ctoLat = parseFloat(cto.latitude);
      const ctoLng = parseFloat(cto.longitude);
      
      if (isNaN(ctoLat) || isNaN(ctoLng)) continue;
      
      // Encontrar o marcador correspondente a esta CTO (por chave, sem depender de coordenadas)
      const ctoMarker = markers.find(marker => {
        if (!marker) return false;
        if (marker === clientMarker) return false; // Ignorar marcador do cliente
        if (marker.getMap && marker.getMap() !== map) return false;
        return marker.__ctoKey === ctoKey;
      });
      
      if (ctoMarker) {
        // Obter o número correto da CTO baseado em ctoNumbers
        const markerNumber = ctoNumbers.get(cto);
        
        // Verificar se é prédio (prédios não têm numeração)
        const isPredio = cto.is_condominio === true;
        
        if (!isPredio && markerNumber) {
          // Atualizar o label do marcador
          ctoMarker.setLabel({
            text: `${markerNumber}`,
            color: '#FFFFFF',
            fontSize: '14px',
            fontWeight: 'bold'
          });
        } else if (isPredio) {
          // Remover label se for prédio
          ctoMarker.setLabel(null);
        }
      }
    }
  }
  
  // Função auxiliar para criar marcador de CTO (extraída da lógica de drawRoutesAndMarkers)
  async function createCTOMarker(cto, index) {
    if (!map || !cto) return;
    
    const ctoLat = parseFloat(cto.latitude);
    const ctoLng = parseFloat(cto.longitude);
    const ctoKey = getCTOKey(cto);
    
    if (isNaN(ctoLat) || isNaN(ctoLng)) return;
    
    const originalPosition = { lat: ctoLat, lng: ctoLng };
    const isPredio = cto.is_condominio === true;
    
    // Determinar cor e ícone (mesma lógica de drawRoutesAndMarkers)
    let ctoColor;
    if (isPredio) {
      const statusCto = cto.status_cto_condominio || cto.condominio_data?.status_cto || '';
      const isAtivado = statusCto && statusCto.toUpperCase().trim() === 'ATIVADO';
      ctoColor = isAtivado ? '#28A745' : '#95A5A6';
    } else {
      // Para CTOs normais, usar cor baseada na porcentagem de ocupação
      // Se estiver fora do limite, usar cor laranja
      if (cto.is_out_of_limit) {
        ctoColor = '#FF9800'; // Laranja para CTO fora do limite
      } else {
        ctoColor = getCTOColor(cto.pct_ocup || 0);
      }
    }
    
    // Criar ícone
    let iconConfig;
    if (isPredio) {
      const statusCto = cto.status_cto_condominio || cto.condominio_data?.status_cto || '';
      const isAtivado = statusCto && statusCto.toUpperCase().trim() === 'ATIVADO';
      const windowColor = isAtivado ? '#28A745' : '#95A5A6';
      const strokeColor = isAtivado ? '#1E7E34' : '#7F8C8D';
      
      const svgContent = `
        <svg width="24" height="32" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="4" width="20" height="26" fill="#F5F5F5" stroke="${strokeColor}" stroke-width="1.5"/>
          <rect x="4" y="6" width="4" height="4" fill="${windowColor}"/>
          <rect x="10" y="6" width="4" height="4" fill="${windowColor}"/>
          <rect x="16" y="6" width="4" height="4" fill="${windowColor}"/>
          <rect x="4" y="11" width="4" height="4" fill="${windowColor}"/>
          <rect x="10" y="11" width="4" height="4" fill="${windowColor}"/>
          <rect x="16" y="11" width="4" height="4" fill="${windowColor}"/>
          <rect x="4" y="16" width="4" height="4" fill="${windowColor}"/>
          <rect x="10" y="16" width="4" height="4" fill="${windowColor}"/>
          <rect x="16" y="16" width="4" height="4" fill="${windowColor}"/>
          <rect x="4" y="21" width="4" height="4" fill="${windowColor}"/>
          <rect x="10" y="21" width="4" height="4" fill="${windowColor}"/>
          <rect x="16" y="21" width="4" height="4" fill="${windowColor}"/>
          <rect x="4" y="26" width="4" height="4" fill="${windowColor}"/>
          <rect x="10" y="26" width="4" height="4" fill="${windowColor}"/>
          <rect x="16" y="26" width="4" height="4" fill="${windowColor}"/>
          <path d="M 8 30 Q 12 26, 16 30" stroke="${strokeColor}" stroke-width="1.5" fill="none"/>
          <line x1="8" y1="30" x2="16" y2="30" stroke="${strokeColor}" stroke-width="1.5"/>
        </svg>
      `.trim();
      
      const svgDataUri = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svgContent);
      iconConfig = {
        url: svgDataUri,
        scaledSize: new google.maps.Size(24, 32),
        anchor: new google.maps.Point(12, 32),
        origin: new google.maps.Point(0, 0)
      };
    } else {
      iconConfig = {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 18,
        fillColor: ctoColor,
        fillOpacity: 1,
        strokeColor: '#000000',
        strokeWeight: 3,
        anchor: new google.maps.Point(0, 0)
      };
    }
    
    // Usar ctoNumbers para numeração que corresponde à coluna N° da tabela
    const markerNumber = isPredio ? null : ctoNumbers.get(cto);
    
    const ctoMarker = new google.maps.Marker({
      position: originalPosition,
      map: map,
      title: isPredio 
        ? `🏢 ${cto.nome} (PRÉDIO) - ${cto.distancia_metros}m - Não cria rota`
        : `${cto.nome} - ${cto.distancia_metros}m (${cto.vagas_total - cto.clientes_conectados} portas disponíveis)`,
      icon: iconConfig,
      label: isPredio ? undefined : (markerNumber ? {
        text: `${markerNumber}`,
        color: '#FFFFFF',
        fontSize: '14px',
        fontWeight: 'bold'
      } : undefined),
      zIndex: 1000 + index,
      optimized: false
    });

    // Anexar chave estável da CTO no marcador (evita depender de comparação por coordenadas)
    try { ctoMarker.__ctoKey = ctoKey; } catch (_) {}
    
    markers.push(ctoMarker);
  }

  async function drawRoutesAndMarkers() {
    if (!map || !clientCoords || ctos.length === 0) {
      console.warn(`⚠️ drawRoutesAndMarkers: Condições não atendidas. map: ${!!map}, clientCoords: ${!!clientCoords}, ctos.length: ${ctos.length}`);
      return;
    }

    console.log(`🗺️ drawRoutesAndMarkers: Iniciando desenho de ${ctos.length} CTOs`);
    console.log(`📊 ctoVisibility Map size: ${ctoVisibility.size}`);

    const bounds = new google.maps.LatLngBounds();
    bounds.extend(clientCoords);

    // Desenhar rotas e marcadores para cada CTO

    // IMPORTANTE: Cada CTO tem sua própria rota única, mesmo que compartilhem coordenadas
    // Usamos ctoKey (baseado em ID) para identificar rotas, nunca coordenadas
    // Não precisamos mais de markerNumber, usamos ctoNumbers.get(cto) que já está calculado

    // OTIMIZAÇÃO DE PERFORMANCE: Separar rotas de marcadores
    // 1. Primeiro: Criar todos os marcadores (rápido)
    // 2. Depois: Calcular todas as rotas em paralelo (Promise.all)
    
    // Preparar lista de CTOs que precisam de rotas
    const ctosParaRotas = [];
    const ctosParaMarcadores = [];

    for (let i = 0; i < ctos.length; i++) {
      const cto = ctos[i];

      // Validar coordenadas antes de processar
      if (isNaN(cto.latitude) || isNaN(cto.longitude) || 
          cto.latitude === null || cto.longitude === null ||
          cto.latitude === undefined || cto.longitude === undefined) {
        console.warn(`⚠️ CTO ${i + 1} (${cto.nome}) tem coordenadas inválidas (${cto.latitude}, ${cto.longitude}), pulando...`);
        continue;
      }

      // Validar se as coordenadas estão dentro de um range válido
      if (cto.latitude < -90 || cto.latitude > 90 || cto.longitude < -180 || cto.longitude > 180) {
        console.warn(`⚠️ CTO ${i + 1} (${cto.nome}) tem coordenadas fora do range válido (${cto.latitude}, ${cto.longitude}), pulando...`);
        continue;
      }

      // Parsear coordenadas com precisão (garantir que são números válidos)
      const ctoLat = parseFloat(cto.latitude);
      const ctoLng = parseFloat(cto.longitude);
      
      // Validar se as coordenadas são números válidos
      if (isNaN(ctoLat) || isNaN(ctoLng)) {
        console.warn(`⚠️ CTO ${i + 1} (${cto.nome}) tem coordenadas inválidas, pulando...`);
        continue;
      }
      
      // Posição original (SEMPRE usar esta para marcadores e rotas de CTOs de rua)
      const originalPosition = { lat: ctoLat, lng: ctoLng };
      
      // Verificar se é prédio
      const isPredio = cto.is_condominio === true;
      
      if (isPredio) {
        console.log(`🏢 Prédio detectado: ${cto.nome}, coordenadas: ${ctoLat}, ${ctoLng}`);
      }
      
      // Usar posição original para bounds
      bounds.extend(originalPosition);

      // Verificar visibilidade da CTO
      // IMPORTANTE: Se não existe no Map, considerar como visível (padrão)
      const ctoKey = getCTOKey(cto);
      const visibilityValue = ctoVisibility.get(ctoKey);
      const isVisible = visibilityValue !== false; // true ou undefined = visível, false = não visível
      
      // Se não estiver visível, pular esta CTO
      if (!isVisible) {
        console.log(`⏭️ CTO ${cto.nome} (${ctoKey}) está marcada como não visível, pulando...`);
        continue;
      }
      
      // Separar CTOs que precisam de rotas das que não precisam
      // Incluir CTOs normais dentro de 250m OU CTOs fora do limite (is_out_of_limit)
      // IMPORTANTE: CTOs com is_out_of_limit também precisam de rota (já foi calculada)
      if (!cto.is_condominio && !isPredio && cto.distancia_metros && cto.distancia_metros > 0 && (cto.distancia_real || cto.is_out_of_limit)) {
        // CTOs normais que precisam de rotas (dentro de 250m ou fora do limite)
        ctosParaRotas.push({ cto, index: i, originalPosition, ctoLat, ctoLng, isPredio });
        if (cto.is_out_of_limit) {
          console.log(`🔄 [Frontend] CTO fora do limite adicionada para rota: ${cto.nome}`);
        }
      }
      
      // Todas as CTOs precisam de marcadores
      ctosParaMarcadores.push({ cto, index: i, originalPosition, ctoLat, ctoLng, isPredio });
    }

    // ETAPA 1: Calcular TODAS as rotas em PARALELO (melhoria de performance crítica)
    console.log(`🚀 [Performance] Calculando ${ctosParaRotas.length} rotas em paralelo...`);
    const routePromises = ctosParaRotas.map(({ cto, index }) => 
      drawRealRoute(cto, index).catch(err => {
        console.warn(`⚠️ Erro ao desenhar rota para CTO ${index + 1} (${cto.nome}):`, err);
        return null; // Retornar null em caso de erro para não quebrar Promise.all
      })
    );
    
    // Aguardar todas as rotas em paralelo
    await Promise.all(routePromises);
    console.log(`✅ [Performance] Todas as rotas calculadas!`);

    // ETAPA 2: Criar todos os marcadores (já que rotas estão prontas)
    console.log(`📍 Criando ${ctosParaMarcadores.length} marcadores...`);
    for (const { cto, index, originalPosition, ctoLat, ctoLng, isPredio } of ctosParaMarcadores) {

      // Adicionar marcador da CTO
      let ctoMarker = null;
      let markerCreated = false;
      
      // isPredio já foi definido acima (linha 2578)
      
      try {
        
        // Para prédios, usar verde baseado no STATUS_CTO
        // STATUS_CTO = "ATIVADO" → verde mais vivo (#28A745 ou similar)
        // STATUS_CTO ≠ "ATIVADO" → verde mais apagado (#6C757D ou #95A5A6)
        let ctoColor;
        if (isPredio) {
          const statusCto = cto.status_cto_condominio || cto.condominio_data?.status_cto || '';
          const isAtivado = statusCto && statusCto.toUpperCase().trim() === 'ATIVADO';
          // Verde mais vivo para ATIVADO, verde mais apagado para outros
          ctoColor = isAtivado ? '#28A745' : '#95A5A6'; // #28A745 = verde vivo, #95A5A6 = verde apagado/cinza
        } else {
          // Para CTOs normais, usar cor baseada na porcentagem de ocupação
          // Se estiver fora do limite, usar cor laranja
          if (cto.is_out_of_limit) {
            ctoColor = '#FF9800'; // Laranja para CTO fora do limite
          } else {
            ctoColor = getCTOColor(cto.pct_ocup || 0);
          }
        }

        // Usar ctoNumbers para numeração que corresponde à coluna N° da tabela
        // APENAS para CTOs normais (prédios não têm numeração)
        const currentMarkerNumber = isPredio ? null : ctoNumbers.get(cto);

        // Visual diferente para prédios: usar ícone de prédio com múltiplos andares
        // Usar imagem SVG do prédio em vez de path customizado
        let iconConfig;
        
        if (isPredio) {
          // Determinar qual ícone usar baseado no status
          const statusCto = cto.status_cto_condominio || cto.condominio_data?.status_cto || '';
          const isAtivado = statusCto && statusCto.toUpperCase().trim() === 'ATIVADO';
          
          console.log(`🏢 Criando marcador de prédio: ${cto.nome}, status: ${statusCto}, ativado: ${isAtivado}`);
          
          // Criar SVG inline como data URI para garantir carregamento
          // Cores baseadas no status
          const windowColor = isAtivado ? '#28A745' : '#95A5A6';
          const strokeColor = isAtivado ? '#1E7E34' : '#7F8C8D';
          
          // SVG do prédio com janelas em grade 3x5
          const svgContent = `
            <svg width="24" height="32" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
              <!-- Corpo do prédio -->
              <rect x="2" y="4" width="20" height="26" fill="#F5F5F5" stroke="${strokeColor}" stroke-width="1.5"/>
              
              <!-- Janelas em grade 3x5 (15 janelas) -->
              <!-- Linha 1 -->
              <rect x="4" y="6" width="4" height="4" fill="${windowColor}"/>
              <rect x="10" y="6" width="4" height="4" fill="${windowColor}"/>
              <rect x="16" y="6" width="4" height="4" fill="${windowColor}"/>
              
              <!-- Linha 2 -->
              <rect x="4" y="11" width="4" height="4" fill="${windowColor}"/>
              <rect x="10" y="11" width="4" height="4" fill="${windowColor}"/>
              <rect x="16" y="11" width="4" height="4" fill="${windowColor}"/>
              
              <!-- Linha 3 -->
              <rect x="4" y="16" width="4" height="4" fill="${windowColor}"/>
              <rect x="10" y="16" width="4" height="4" fill="${windowColor}"/>
              <rect x="16" y="16" width="4" height="4" fill="${windowColor}"/>
              
              <!-- Linha 4 -->
              <rect x="4" y="21" width="4" height="4" fill="${windowColor}"/>
              <rect x="10" y="21" width="4" height="4" fill="${windowColor}"/>
              <rect x="16" y="21" width="4" height="4" fill="${windowColor}"/>
              
              <!-- Linha 5 -->
              <rect x="4" y="26" width="4" height="4" fill="${windowColor}"/>
              <rect x="10" y="26" width="4" height="4" fill="${windowColor}"/>
              <rect x="16" y="26" width="4" height="4" fill="${windowColor}"/>
              
              <!-- Entrada arqueada na base -->
              <path d="M 8 30 Q 12 26, 16 30" stroke="${strokeColor}" stroke-width="1.5" fill="none"/>
              <line x1="8" y1="30" x2="16" y2="30" stroke="${strokeColor}" stroke-width="1.5"/>
            </svg>
          `.trim();
          
          // Converter SVG para data URI
          const svgDataUri = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svgContent);
          
          // Usar imagem SVG inline para prédios
          iconConfig = {
            url: svgDataUri,
            scaledSize: new google.maps.Size(24, 32), // Tamanho do ícone (24x32 pixels)
            anchor: new google.maps.Point(12, 32), // Anchor na base do prédio (centro horizontal, base vertical)
            origin: new google.maps.Point(0, 0) // Origem da imagem
          };
        } else {
          // Para CTOs de rua: usar círculo com anchor no centro (0,0)
          iconConfig = {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 18,
            fillColor: ctoColor,
            fillOpacity: 1,
            strokeColor: '#000000',
            strokeWeight: 3,
            anchor: new google.maps.Point(0, 0) // Centro do círculo - CRÍTICO para alinhamento correto
          };
        }

        // Para CTOs de rua, sempre usar originalPosition (já definido acima)
        // Isso garante alinhamento perfeito entre marcador e rota
        // IMPORTANTE: As coordenadas devem ser exatamente as mesmas usadas na rota
        ctoMarker = new google.maps.Marker({
          position: originalPosition,
          map: map,
          title: isPredio 
            ? `🏢 ${cto.nome} (PRÉDIO) - ${cto.distancia_metros}m - Não cria rota`
            : `${cto.nome} - ${cto.distancia_metros}m (${cto.vagas_total - cto.clientes_conectados} portas disponíveis)`,
          icon: iconConfig,
          label: isPredio ? undefined : (currentMarkerNumber ? { // Sem label para prédios, label numérico para CTOs normais
            text: `${currentMarkerNumber}`,
            color: '#FFFFFF',
            fontSize: '14px',
            fontWeight: 'bold'
          } : undefined),
          zIndex: 1000 + index, // Usar index em vez de markerNumber (que não existe neste escopo)
          optimized: false // Garantir que todos os marcadores sejam renderizados
        });

        // Anexar chave estável da CTO no marcador (evita depender de comparação por coordenadas)
        const ctoKey = getCTOKey(cto);
        try { ctoMarker.__ctoKey = ctoKey; } catch (_) {}

        // Verificar se o marcador foi criado com sucesso
        // IMPORTANTE: Adicionar ao array sempre que o marcador foi criado, mesmo que getMap() ainda não esteja disponível
        if (ctoMarker) {
          // Garantir que o marcador está no mapa (pode ter sido criado sem map por engano)
          if (!ctoMarker.getMap()) {
            ctoMarker.setMap(map);
          }
          markers.push(ctoMarker);
          markerCreated = true;
          console.log(`✅ Marcador criado para CTO: ${cto.nome} (${ctoKey}), total de marcadores: ${markers.length}`);

          // Não precisa incrementar markerNumber, pois usamos ctoNumbers.get(cto) que já está calculado

          // InfoWindow para a CTO ou Prédio
          let infoWindowContent = '';
          
          if (isPredio) {
            // InfoWindow para PRÉDIO com CTOs internas
            const nomePredio = cto.nome || 'Prédio';
            const statusCto = cto.status_cto_condominio || 'N/A';
            const ctosInternas = cto.ctos_internas || [];
            
            let ctosListHTML = '';
            if (ctosInternas.length > 0) {
              ctosListHTML = '<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #ddd;">';
              ctosListHTML += `<strong style="color: #6C757D; font-size: 13px;">CTOs Internas (${ctosInternas.length}):</strong><br>`;
              
              ctosInternas.forEach((ctoInterna, idx) => {
                // Verificar se a CTO interna está ativa
                const statusCtoInterna = ctoInterna.status_cto || '';
                const isAtiva = statusCtoInterna && statusCtoInterna.toUpperCase().trim() === 'ATIVADO';
                const borderColor = isAtiva ? '#28A745' : '#DC3545';
                const bgColor = isAtiva ? '#f8f9fa' : '#fff5f5';
                
                ctosListHTML += `
                  <div style="margin-top: 8px; padding: 8px; background-color: ${bgColor}; border-left: 3px solid ${borderColor}; border-radius: 4px;">
                    <strong style="color: #333; font-size: 12px;">CTO ${idx + 1}:</strong><br>
                    <strong>Nome:</strong> ${String(ctoInterna.nome || 'N/A')}<br>
                    <strong>ID:</strong> ${String(ctoInterna.id || 'N/A')}<br>
                    <strong>Portas Disponíveis:</strong> ${Number(ctoInterna.portas_disponiveis || 0)}<br>
                    <strong>Portas Totais:</strong> ${Number(ctoInterna.vagas_total || 0)}<br>
                    <strong>Portas Conectadas:</strong> ${Number(ctoInterna.clientes_conectados || 0)}<br>
                    <strong>Status:</strong> <span style="color: ${isAtiva ? '#28A745' : '#DC3545'}; font-weight: bold;">${String(ctoInterna.status_cto || 'N/A')}</span><br>
                    ${!isAtiva ? '<div style="color: #DC3545; font-size: 11px; margin-top: 4px; font-weight: bold;">⚠️ CTO NÃO ATIVA</div>' : ''}
                  </div>
                `;
              });
              
              // Resumo total
              const totalPortasDisponiveis = ctosInternas.reduce((sum, c) => sum + (c.portas_disponiveis || 0), 0);
              const totalPortasTotais = ctosInternas.reduce((sum, c) => sum + (c.vagas_total || 0), 0);
              const totalPortasConectadas = ctosInternas.reduce((sum, c) => sum + (c.clientes_conectados || 0), 0);
              
              ctosListHTML += `
                <div style="margin-top: 8px; padding: 8px; background-color: #e8f5e9; border-left: 3px solid #28A745; border-radius: 4px;">
                  <strong style="color: #1B5E20;">Resumo Total:</strong><br>
                  <strong>Total de Portas Disponíveis:</strong> ${totalPortasDisponiveis}<br>
                  <strong>Total de Portas:</strong> ${totalPortasTotais}<br>
                  <strong>Total de Portas Conectadas:</strong> ${totalPortasConectadas}<br>
                </div>
              `;
              
              ctosListHTML += '</div>';
            } else {
              ctosListHTML = `
                <div style="margin-top: 12px; padding: 8px; background-color: #fff3cd; border-left: 3px solid #ffc107; border-radius: 4px;">
                  <strong style="color: #856404;">(Sem CTOs implantadas)</strong>
                </div>
              `;
            }
            
            // Conteúdo inicial do InfoWindow (será atualizado com endereço)
            infoWindowContent = `
              <div style="padding: 12px; font-family: 'Inter', sans-serif; line-height: 1.6; max-width: 350px;">
                <div style="background-color: #FFE5E5; padding: 8px; margin-bottom: 12px; border-left: 4px solid #DC3545; border-radius: 4px;">
                  <strong style="color: #DC3545; font-size: 14px;">🏢 PRÉDIO/CONDOMÍNIO</strong>
                </div>
                <strong>Nome:</strong> ${String(nomePredio)}<br>
                <strong>Status:</strong> ${String(statusCto)}<br>
                <strong>Distância:</strong> ${Number(cto.distancia_metros || 0)}m (${Number(cto.distancia_km || 0)}km)<br>
                <div id="predio-endereco-${index}" style="margin-top: 8px;">
                  <strong>Endereço:</strong> <span style="color: #6C757D;">Carregando...</span>
                </div>
                ${ctosListHTML}
              </div>
            `;
          } else {
            // InfoWindow para CTO NORMAL (rua)
            // Verificar se a CTO está ativa
            const statusCto = cto.status_cto || '';
            const isAtiva = statusCto && statusCto.toUpperCase().trim() === 'ATIVADO';
            
            // Adicionar alerta vermelho se não estiver ativa
            let alertaHTML = '';
            if (!isAtiva) {
              alertaHTML = `
                <div style="background-color: #DC3545; color: white; padding: 12px; margin-bottom: 12px; border-radius: 4px; font-weight: bold; text-align: center;">
                  ⚠️ CTO NÃO ATIVA
                </div>
              `;
            }
            
            infoWindowContent = `
              <div style="padding: 8px; font-family: 'Inter', sans-serif; line-height: 1.6;">
                ${alertaHTML}
                <strong>Cidade:</strong> ${String(cto.cidade || 'N/A')}<br>
                <strong>POP:</strong> ${String(cto.pop || 'N/A')}<br>
                <strong>Nome:</strong> ${String(cto.nome || 'N/A')}<br>
                <strong>ID:</strong> ${String(cto.id || 'N/A')}<br>
                <strong>Status:</strong> <span style="color: ${isAtiva ? '#28A745' : '#DC3545'}; font-weight: bold;">${String(statusCto || 'N/A')}</span><br>
                <strong>Total de Portas:</strong> ${Number(cto.vagas_total || 0)}<br>
                <strong>Portas Conectadas:</strong> ${Number(cto.clientes_conectados || 0)}<br>
                <strong>Portas Disponíveis:</strong> ${Number((cto.vagas_total || 0) - (cto.clientes_conectados || 0))}<br>
                <strong>Distância:</strong> ${Number(cto.distancia_metros || 0)}m (${Number(cto.distancia_km || 0)}km)
              </div>
            `;
          }
          
          const ctoInfoWindow = new google.maps.InfoWindow({
            content: infoWindowContent
          });

          // Adicionar listener de clique (async para buscar endereço do prédio)
          ctoMarker.addListener('click', async () => {
            ctoInfoWindow.open(map, ctoMarker);
            
            // Se for prédio, buscar endereço completo via reverse geocoding
            if (isPredio) {
              try {
                const predioLat = parseFloat(cto.latitude);
                const predioLng = parseFloat(cto.longitude);
                
                if (!isNaN(predioLat) && !isNaN(predioLng)) {
                  const result = await reverseGeocode(predioLat, predioLng);
                  
                  if (result.results && result.results.length > 0) {
                    // Priorizar resultado com mais informações (street_address ou premise)
                    // Se não encontrar, usar o primeiro resultado
                    let bestResult = result.results.find(r => {
                      const types = r.types || [];
                      return types.includes('street_address') || 
                             types.includes('premise') || 
                             types.includes('route');
                    }) || result.results[0];
                    const components = bestResult.address_components || [];
                    
                    // Extrair todos os componentes do endereço de forma mais completa
                    const streetComponent = components.find(c => 
                      c.types.includes('route')
                    );
                    const streetNumberComponent = components.find(c => 
                      c.types.includes('street_number')
                    );
                    const neighborhoodComponent = components.find(c => 
                      c.types.includes('sublocality') || 
                      c.types.includes('sublocality_level_1') ||
                      c.types.includes('neighborhood') ||
                      c.types.includes('sublocality_level_2')
                    );
                    const cityComponent = components.find(c => 
                      c.types.includes('locality') || 
                      c.types.includes('administrative_area_level_2')
                    );
                    const stateComponent = components.find(c => 
                      c.types.includes('administrative_area_level_1')
                    );
                    const postalCodeComponent = components.find(c => 
                      c.types.includes('postal_code')
                    );
                    
                    const rua = streetComponent?.long_name || streetComponent?.short_name || '';
                    const numero = streetNumberComponent?.long_name || '';
                    const bairro = neighborhoodComponent?.long_name || neighborhoodComponent?.short_name || '';
                    const cidade = cityComponent?.long_name || '';
                    const estado = stateComponent?.short_name || '';
                    const cep = postalCodeComponent?.long_name || '';
                    
                    // Formatar endereço completo de forma mais estruturada
                    let enderecoCompleto = '';
                    const partesEndereco = [];
                    
                    // Adicionar rua
                    if (rua) {
                      partesEndereco.push(rua);
                    }
                    
                    // Adicionar número
                    if (numero) {
                      partesEndereco.push(numero);
                    }
                    
                    // Se temos rua ou número, formatar como "Rua, Número"
                    if (partesEndereco.length > 0) {
                      enderecoCompleto = partesEndereco.join(', ');
                    }
                    
                    // Adicionar bairro
                    if (bairro) {
                      if (enderecoCompleto) {
                        enderecoCompleto += ` - ${bairro}`;
                      } else {
                        enderecoCompleto = bairro;
                      }
                    }
                    
                    // Adicionar cidade e estado
                    if (cidade) {
                      if (enderecoCompleto) {
                        enderecoCompleto += `, ${cidade}`;
                      } else {
                        enderecoCompleto = cidade;
                      }
                      
                      if (estado) {
                        enderecoCompleto += ` - ${estado}`;
                      }
                    }
                    
                    // Adicionar CEP
                    if (cep) {
                      if (enderecoCompleto) {
                        enderecoCompleto += `, ${cep}`;
                      } else {
                        enderecoCompleto = `CEP: ${cep}`;
                      }
                    }
                    
                    // Se não conseguiu montar endereço estruturado, usar o formatted_address do Google
                    if (!enderecoCompleto || (!rua && !numero && !bairro)) {
                      enderecoCompleto = bestResult.formatted_address || 'Endereço não disponível';
                    }
                    
                    // Atualizar conteúdo do InfoWindow com endereço
                    const enderecoElement = document.getElementById(`predio-endereco-${index}`);
                    if (enderecoElement) {
                      enderecoElement.innerHTML = `<strong>Endereço:</strong> ${enderecoCompleto}`;
                    } else {
                      // Se o elemento não foi encontrado, atualizar o conteúdo completo do InfoWindow
                      const nomePredio = cto.nome || 'Prédio';
                      const statusCto = cto.status_cto_condominio || 'N/A';
                      const ctosInternas = cto.ctos_internas || [];
                      
                      let ctosListHTML = '';
                      if (ctosInternas.length > 0) {
                        ctosListHTML = '<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #ddd;">';
                        ctosListHTML += `<strong style="color: #6C757D; font-size: 13px;">CTOs Internas (${ctosInternas.length}):</strong><br>`;
                        
                        ctosInternas.forEach((ctoInterna, idx) => {
                          const statusCtoInterna = ctoInterna.status_cto || '';
                          const isAtiva = statusCtoInterna && statusCtoInterna.toUpperCase().trim() === 'ATIVADO';
                          const borderColor = isAtiva ? '#28A745' : '#DC3545';
                          const bgColor = isAtiva ? '#f8f9fa' : '#fff5f5';
                          
                          ctosListHTML += `
                            <div style="margin-top: 8px; padding: 8px; background-color: ${bgColor}; border-left: 3px solid ${borderColor}; border-radius: 4px;">
                              <strong style="color: #333; font-size: 12px;">CTO ${idx + 1}:</strong><br>
                              <strong>Nome:</strong> ${String(ctoInterna.nome || 'N/A')}<br>
                              <strong>ID:</strong> ${String(ctoInterna.id || 'N/A')}<br>
                              <strong>Portas Disponíveis:</strong> ${Number(ctoInterna.portas_disponiveis || 0)}<br>
                              <strong>Portas Totais:</strong> ${Number(ctoInterna.vagas_total || 0)}<br>
                              <strong>Portas Conectadas:</strong> ${Number(ctoInterna.clientes_conectados || 0)}<br>
                              <strong>Status:</strong> <span style="color: ${isAtiva ? '#28A745' : '#DC3545'}; font-weight: bold;">${String(ctoInterna.status_cto || 'N/A')}</span><br>
                              ${!isAtiva ? '<div style="color: #DC3545; font-size: 11px; margin-top: 4px; font-weight: bold;">⚠️ CTO NÃO ATIVA</div>' : ''}
                            </div>
                          `;
                        });
                        
                        const totalPortasDisponiveis = ctosInternas.reduce((sum, c) => sum + (c.portas_disponiveis || 0), 0);
                        const totalPortasTotais = ctosInternas.reduce((sum, c) => sum + (c.vagas_total || 0), 0);
                        const totalPortasConectadas = ctosInternas.reduce((sum, c) => sum + (c.clientes_conectados || 0), 0);
                        
                        ctosListHTML += `
                          <div style="margin-top: 8px; padding: 8px; background-color: #e8f5e9; border-left: 3px solid #28A745; border-radius: 4px;">
                            <strong style="color: #1B5E20;">Resumo Total:</strong><br>
                            <strong>Total de Portas Disponíveis:</strong> ${totalPortasDisponiveis}<br>
                            <strong>Total de Portas:</strong> ${totalPortasTotais}<br>
                            <strong>Total de Portas Conectadas:</strong> ${totalPortasConectadas}<br>
                          </div>
                        `;
                        
                        ctosListHTML += '</div>';
                      } else {
                        ctosListHTML = `
                          <div style="margin-top: 12px; padding: 8px; background-color: #fff3cd; border-left: 3px solid #ffc107; border-radius: 4px;">
                            <strong style="color: #856404;">(Sem CTOs implantadas)</strong>
                          </div>
                        `;
                      }
                      
                      const updatedContent = `
                        <div style="padding: 12px; font-family: 'Inter', sans-serif; line-height: 1.6; max-width: 350px;">
                          <div style="background-color: #FFE5E5; padding: 8px; margin-bottom: 12px; border-left: 4px solid #DC3545; border-radius: 4px;">
                            <strong style="color: #DC3545; font-size: 14px;">🏢 PRÉDIO/CONDOMÍNIO</strong>
                          </div>
                          <strong>Nome:</strong> ${String(nomePredio)}<br>
                          <strong>Status:</strong> ${String(statusCto)}<br>
                          <strong>Distância:</strong> ${Number(cto.distancia_metros || 0)}m (${Number(cto.distancia_km || 0)}km)<br>
                          <div style="margin-top: 8px;">
                            <strong>Endereço:</strong> ${enderecoCompleto}
                          </div>
                          ${ctosListHTML}
                        </div>
                      `;
                      ctoInfoWindow.setContent(updatedContent);
                    }
                  }
                }
              } catch (err) {
                console.error('Erro ao buscar endereço do prédio:', err);
                const enderecoElement = document.getElementById(`predio-endereco-${index}`);
                if (enderecoElement) {
                  enderecoElement.innerHTML = '<strong>Endereço:</strong> <span style="color: #DC3545;">Não foi possível obter o endereço</span>';
                }
              }
            }
          });
        } else {
          console.error(`❌ Falha ao criar marcador ${isPredio ? 'de prédio' : currentMarkerNumber} para ${cto.nome}: marcador não foi adicionado ao mapa`);
        }

      } catch (markerErr) {
        console.error(`❌ Erro ao criar marcador para CTO ${index + 1} (${cto.nome}):`, markerErr);
        // Se o marcador foi parcialmente criado, tentar removê-lo
        if (ctoMarker && ctoMarker.setMap) {
          try {
            ctoMarker.setMap(null);
          } catch (e) {
            // Ignorar erro ao remover
          }
        }
      }
      
      // Se o marcador não foi criado, não incrementar o contador
      // Mas apenas avisar se não for prédio (prédios não têm numeração mesmo)
      if (!markerCreated && !isPredio) {
        console.warn(`⚠️ CTO ${index + 1} (${cto.nome}) não foi marcada no mapa. Numeração não incrementada.`);
      }
    }

    const ctoMarkersCount = markers.filter(m => m !== clientMarker).length;
    console.log(`✅ drawRoutesAndMarkers concluído: ${ctoMarkersCount} marcadores criados de ${ctos.length} CTOs`);

    if (ctoMarkersCount !== ctos.length) {
      console.warn(`⚠️ ATENÇÃO: Esperado ${ctos.length} marcadores, mas apenas ${ctoMarkersCount} foram criados!`);
      console.log(`📋 CTOs esperadas:`, ctos.map(c => `${c.nome} (${getCTOKey(c)})`));
      console.log(`📍 Marcadores criados:`, markers.filter(m => m !== clientMarker).map(m => `${m.__ctoKey || 'SEM_CHAVE'}`));
    }

    // Ajustar zoom para mostrar todos os pontos com padding mínimo para maximizar visibilidade
    if (bounds.getNorthEast() && bounds.getSouthWest()) {
      // Adicionar padding mínimo para garantir que todos os marcadores fiquem visíveis
      map.fitBounds(bounds, {
        top: 40,
        right: 40,
        bottom: 40,
        left: 40
      });
      
      // Aguardar ajuste do mapa
      await new Promise((resolve) => {
        const boundsListener = google.maps.event.addListener(map, 'bounds_changed', () => {
          google.maps.event.removeListener(boundsListener);
          resolve();
        });
        setTimeout(() => {
          google.maps.event.removeListener(boundsListener);
          resolve();
        }, 1000);
      });
      
      // Verificar se todos os marcadores estão visíveis
      const finalBounds = map.getBounds();
      if (finalBounds) {
        let allMarkersVisible = true;
        
        // Verificar cliente
        if (!finalBounds.contains(clientCoords)) {
          allMarkersVisible = false;
        }
        
        // Verificar todas as CTOs
        if (allMarkersVisible) {
          for (const cto of ctos) {
            if (!finalBounds.contains({ lat: cto.latitude, lng: cto.longitude })) {
              allMarkersVisible = false;
              console.warn(`⚠️ CTO ${cto.nome} não está visível nos bounds finais`);
              break;
            }
          }
        }
        
        // Se algum marcador não está visível, ajustar novamente com mais padding
        if (!allMarkersVisible) {
          map.fitBounds(bounds, {
            top: 60,
            right: 60,
            bottom: 60,
            left: 60
          });
          
          await new Promise((resolve) => {
            const boundsListener = google.maps.event.addListener(map, 'bounds_changed', () => {
              google.maps.event.removeListener(boundsListener);
              resolve();
            });
    setTimeout(() => {
              google.maps.event.removeListener(boundsListener);
              resolve();
            }, 1000);
          });
        }
      }
    }

    // Ajustar zoom máximo se necessário (permitir zoom até 19 para melhor visualização)
    const listener = google.maps.event.addListener(map, 'bounds_changed', () => {
      if (map.getZoom() > 19) {
        map.setZoom(19);
      }
      google.maps.event.removeListener(listener);
    });
  }

  // Função para abrir modal de relatório
  async function openReportModal() {
    // Expandir mapa completamente e minimizar tabela para ocupar máximo de espaço
    // 1. Minimizar a tabela para liberar espaço
    if (!isListMinimized) {
      isListMinimized = true;
    }
    
    // 2. Expandir o mapa se estiver minimizado
    if (isMapMinimized) {
      isMapMinimized = false;
    }
    
    // 3. Calcular e definir altura máxima do mapa
    const container = document.querySelector('.main-area');
    const containerHeight = container ? container.getBoundingClientRect().height : 800;
    // Com a tabela minimizada, deixar apenas 90px para ela + handle + margem
    const minSpaceForList = 90;
    const maxMapHeight = Math.max(containerHeight - minSpaceForList, 300);
    mapHeightPixels = maxMapHeight;
    
    // 4. Aguardar o Svelte atualizar o DOM
    await tick();
    
    // 5. Aplicar estilos diretamente para garantir que o mapa ocupe o espaço máximo
    const mapElement = document.querySelector('.map-container');
    const listElement = document.querySelector('.results-table-container, .empty-state');
    
    if (mapElement) {
      mapElement.style.height = `${maxMapHeight}px`;
      mapElement.style.flex = '0 0 auto';
      mapElement.style.minHeight = `${maxMapHeight}px`;
    }
    
    if (listElement) {
      listElement.style.flex = '0 0 auto';
      listElement.style.minHeight = '60px';
    }
    
    // 6. Aguardar um pouco mais para garantir que o DOM foi atualizado
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // 7. Disparar evento resize do Google Maps para garantir que o mapa se ajuste corretamente
    if (map && google?.maps) {
      google.maps.event.trigger(map, 'resize');
    }
    
    // Limpar erros anteriores
    reportFormErrors = {};
    
    // Limpar número do ALA (será preenchido pelo usuário)
    reportForm.numeroALA = '';
    
    // Pré-preencher o projetista com o usuário logado
    reportForm.projetista = currentUser || '';
    
    // Fechar InfoWindow do cliente automaticamente
    if (clientInfoWindow) {
      clientInfoWindow.close();
    }

    // Pré-preencher formulário com dados do endereço
    reportForm.cidade = clientAddressData.cidade;
    reportForm.enderecoCompleto = clientAddressData.enderecoCompleto;
    reportForm.numeroEndereco = clientAddressData.numero;
    reportForm.cep = clientAddressData.cep;

    // Limpar erros anteriores
    reportFormErrors = {};
    mapPreviewImage = '';
    capturingMap = true;

    // Abrir modal primeiro
    showReportModal = true;

    // Capturar mapa automaticamente
    try {
      const capturedImage = await captureMapAutomatically();
      mapPreviewImage = capturedImage;
    } catch (captureError) {
      console.error('Erro ao capturar mapa:', captureError);
      error = 'Erro ao capturar mapa automaticamente: ' + captureError.message;
    } finally {
      capturingMap = false;
    }
  }

  // Função para capturar automaticamente o mapa
  async function captureMapAutomatically() {
    if (!map || !clientCoords) {
      throw new Error('Mapa não está pronto para captura');
    }

    try {
      // Salvar estado atual do mapa
      const currentCenter = map.getCenter();
      const currentZoom = map.getZoom();

      // Criar bounds incluindo cliente
      const bounds = new google.maps.LatLngBounds();
      bounds.extend(clientCoords);

      // Adicionar todas as CTOs aos bounds (se houver)
      if (ctos.length > 0) {
        ctos.forEach(cto => {
          bounds.extend({ lat: cto.latitude, lng: cto.longitude });
        });
      }

      // Usar fitBounds com padding mínimo para maximizar o zoom
      map.fitBounds(bounds, {
        top: 15,
        right: 15,
        bottom: 15,
        left: 15
      });

      // Aguardar o mapa ajustar completamente usando evento idle
      await new Promise((resolve) => {
        const idleListener = google.maps.event.addListener(map, 'idle', () => {
          google.maps.event.removeListener(idleListener);
          resolve();
        });
        setTimeout(() => {
          google.maps.event.removeListener(idleListener);
          resolve();
        }, 2000);
      });

      // Aguardar um pouco mais para garantir estabilidade
      await new Promise(resolve => setTimeout(resolve, 500));

      // Agora aumentar o zoom gradualmente até encontrar o máximo que ainda mostra tudo
      let currentZoomLevel = map.getZoom();
      let bestZoom = currentZoomLevel;

      // Tentar aumentar o zoom gradualmente (máximo até zoom 20 para mais detalhes)
      for (let testZoom = currentZoomLevel + 1; testZoom <= 20; testZoom++) {
        map.setZoom(testZoom);
        
        // Aguardar evento idle após cada mudança de zoom
        await new Promise((resolve) => {
          const idleListener = google.maps.event.addListener(map, 'idle', () => {
            google.maps.event.removeListener(idleListener);
            resolve();
          });
          setTimeout(() => {
            google.maps.event.removeListener(idleListener);
            resolve();
          }, 800);
        });

        // Verificar se todas as CTOs e o cliente ainda estão visíveis
        const testBounds = map.getBounds();
        if (!testBounds) {
          break;
        }

        let allVisible = testBounds.contains(clientCoords);
        
        // Verificar todas as CTOs (se houver)
        if (allVisible && ctos.length > 0) {
          for (const cto of ctos) {
            if (!testBounds.contains({ lat: cto.latitude, lng: cto.longitude })) {
              allVisible = false;
              break;
            }
          }
        }

        if (allVisible) {
          bestZoom = testZoom;
        } else {
          // Se não está mais visível, usar o último zoom válido
          break;
        }
      }

      // Aplicar o melhor zoom encontrado
      map.setZoom(bestZoom);
      
      // Aguardar estabilização final
      await new Promise((resolve) => {
        const idleListener = google.maps.event.addListener(map, 'idle', () => {
          google.maps.event.removeListener(idleListener);
          resolve();
        });
        setTimeout(() => {
          google.maps.event.removeListener(idleListener);
          resolve();
        }, 1500);
      });

      // Verificação final: garantir que tudo está visível
      const finalBounds = map.getBounds();
      if (finalBounds) {
        let finalAllVisible = finalBounds.contains(clientCoords);
        if (finalAllVisible) {
          for (const cto of ctos) {
            if (!finalBounds.contains({ lat: cto.latitude, lng: cto.longitude })) {
              finalAllVisible = false;
        break;
      }
    }
  }

        // Se algo não está visível, reduzir zoom um nível (mas manter zoom alto se possível)
        if (!finalAllVisible && bestZoom > 16) {
          map.setZoom(bestZoom - 1);
          await new Promise((resolve) => {
            const idleListener = google.maps.event.addListener(map, 'idle', () => {
              google.maps.event.removeListener(idleListener);
              resolve();
            });
            setTimeout(() => {
              google.maps.event.removeListener(idleListener);
              resolve();
            }, 1000);
          });
        }
      }

      // Aguardar estabilidade final antes de capturar (reduzido)
      await new Promise(resolve => setTimeout(resolve, 500));

      // Aguardar evento idle do mapa para garantir renderização
      await new Promise((resolve) => {
        const idleListener = google.maps.event.addListener(map, 'idle', () => {
          google.maps.event.removeListener(idleListener);
          resolve();
        });
        setTimeout(() => {
          google.maps.event.removeListener(idleListener);
          resolve();
        }, 1000);
      });

      const mapElement = document.getElementById('map');
      if (!mapElement) {
        throw new Error('Elemento do mapa não encontrado');
      }
      
      // Garantir que o elemento está visível
      mapElement.style.visibility = 'visible';
      mapElement.style.opacity = '1';
      mapElement.style.display = 'block';
      
      // Aguardar alguns frames após ajustar estilos
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        void mapElement.offsetHeight;
      }
      
      // Capturar usando html2canvas com configurações otimizadas
      
      const canvas = await html2canvas(mapElement, {
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#ffffff', // Branco para evitar fundo cinza
        scale: 2,
        logging: false,
        timeout: 20000,
        imageTimeout: 10000,
        removeContainer: true,
        foreignObjectRendering: false,
        onclone: (clonedDoc, clonedWindow) => {
          // Garantir que o body e html tenham fundo branco
          if (clonedDoc.body) {
            clonedDoc.body.style.background = '#ffffff';
            clonedDoc.body.style.backgroundColor = '#ffffff';
          }
          if (clonedDoc.documentElement) {
            clonedDoc.documentElement.style.background = '#ffffff';
            clonedDoc.documentElement.style.backgroundColor = '#ffffff';
          }
          
          const clonedMap = clonedDoc.getElementById('map');
          if (clonedMap) {
            clonedMap.style.visibility = 'visible';
            clonedMap.style.opacity = '1';
            clonedMap.style.display = 'block';
            clonedMap.style.transform = 'none';
            clonedMap.style.position = 'relative';
            clonedMap.style.overflow = 'visible';
            clonedMap.style.background = '#ffffff';
            clonedMap.style.backgroundColor = '#ffffff';
            
            // Remover qualquer overlay ou elemento que possa causar problemas
            const allElements = clonedMap.querySelectorAll('*');
            allElements.forEach((el) => {
              if (el.style) {
                // Remover backgrounds cinzas ou semi-transparentes
                const bg = el.style.background || el.style.backgroundColor;
                if (bg && (bg.includes('rgba') || bg.includes('rgb') || bg.includes('#f5f5f5') || bg.includes('#f0f0f0') || bg.includes('#e5e5e5'))) {
                  el.style.background = 'transparent';
                  el.style.backgroundColor = 'transparent';
                }
                // Garantir que elementos estão visíveis
                el.style.visibility = 'visible';
                el.style.opacity = '1';
              }
            });
          }
        }
      });

      // Converter para base64 com qualidade máxima
      const imageData = canvas.toDataURL('image/png', 1.0);
      return imageData;
    } catch (err) {
      console.error('Erro ao capturar mapa:', err);
      throw err;
    }
  }


  // Função para lidar com entrada do número do ALA (apenas números)
  function handleNumeroALAInput(event) {
    const input = event.target.value;
    // Remover "ALA-" se o usuário digitou e qualquer caractere que não seja número
    let numbersOnly = input.replace(/^ALA-/i, '').replace(/[^0-9]/g, '');
    
    // Verificar se havia caracteres não numéricos (além do prefixo ALA-)
    const inputWithoutPrefix = input.replace(/^ALA-/i, '');
    const hadNonNumeric = inputWithoutPrefix.length > numbersOnly.length;
    
    if (hadNonNumeric) {
      // Se tentou digitar letras ou caracteres especiais, mostrar erro
      reportFormErrors.numeroALA = 'Digite apenas números';
    } else {
      // Limpar erro se estiver correto
      if (reportFormErrors.numeroALA === 'Digite apenas números') {
        reportFormErrors.numeroALA = '';
      }
    }
    
    // Atualizar valor com prefixo ALA- (sempre com prefixo quando houver números)
    reportForm.numeroALA = numbersOnly ? `ALA-${numbersOnly}` : '';
    
    // Atualizar o valor do input para mostrar "ALA-" + números
    event.target.value = numbersOnly ? `ALA-${numbersOnly}` : '';
    
    // Validar campo após atualizar valor
    validateField('numeroALA');
  }

  // Função para validar um campo individual e limpar erro se válido
  function validateField(fieldName) {
    if (!reportFormErrors[fieldName]) {
      return; // Se não há erro, não precisa validar
    }

    let isValid = false;

    switch (fieldName) {
      case 'numeroALA':
        if (reportForm.numeroALA.trim()) {
          const numeroSemPrefixo = reportForm.numeroALA.replace(/^ALA-/i, '');
          if (numeroSemPrefixo && /^\d+$/.test(numeroSemPrefixo)) {
            isValid = true;
          }
        }
        break;
      case 'cidade':
        isValid = reportForm.cidade.trim().length > 0;
        break;
      case 'enderecoCompleto':
        isValid = reportForm.enderecoCompleto.trim().length > 0;
        break;
      case 'numeroEndereco':
        isValid = reportForm.numeroEndereco.trim().length > 0;
        break;
      case 'cep':
        isValid = reportForm.cep.trim().length > 0;
        break;
      case 'tabulacaoFinal':
        isValid = !!reportForm.tabulacaoFinal;
        break;
      case 'projetista':
        isValid = reportForm.projetista && reportForm.projetista.trim().length > 0;
        break;
    }

    if (isValid) {
      // Limpar erro se o campo estiver válido
      delete reportFormErrors[fieldName];
      reportFormErrors = reportFormErrors; // Trigger reactivity
    }
  }

  // Função para validar formulário
  function validateReportForm() {
    reportFormErrors = {};
    let isValid = true;

    // Validar número do ALA
    if (!reportForm.numeroALA.trim()) {
      reportFormErrors.numeroALA = 'Campo obrigatório';
      isValid = false;
    } else {
      // Verificar se contém apenas números após "ALA-"
      const numeroSemPrefixo = reportForm.numeroALA.replace(/^ALA-/i, '');
      if (!numeroSemPrefixo || !/^\d+$/.test(numeroSemPrefixo)) {
        reportFormErrors.numeroALA = 'Digite apenas números';
        isValid = false;
      }
    }
    if (!reportForm.cidade.trim()) {
      reportFormErrors.cidade = 'Campo obrigatório';
      isValid = false;
    }
    if (!reportForm.enderecoCompleto.trim()) {
      reportFormErrors.enderecoCompleto = 'Campo obrigatório';
      isValid = false;
    }
    if (!reportForm.numeroEndereco.trim()) {
      reportFormErrors.numeroEndereco = 'Campo obrigatório';
      isValid = false;
    }
    if (!reportForm.cep.trim()) {
      reportFormErrors.cep = 'Campo obrigatório';
      isValid = false;
    }
    if (!reportForm.tabulacaoFinal) {
      reportFormErrors.tabulacaoFinal = 'Campo obrigatório';
      isValid = false;
    }
    if (!reportForm.projetista || !reportForm.projetista.trim()) {
      reportFormErrors.projetista = 'Campo obrigatório';
      isValid = false;
    }

    return isValid;
  }

  // Função para obter lista de campos obrigatórios não preenchidos
  function getMissingRequiredFields() {
    const missingFields = [];
    const fieldLabels = {
      numeroALA: 'Número ALA',
      cidade: 'Cidade',
      enderecoCompleto: 'Endereço Completo',
      numeroEndereco: 'Número do Endereço',
      cep: 'CEP',
      tabulacaoFinal: 'Tabulação Final',
      projetista: 'Projetista'
    };

    for (const [field, label] of Object.entries(fieldLabels)) {
      if (reportFormErrors[field]) {
        missingFields.push(label);
      }
    }

    return missingFields;
  }

  // Função para fechar modal
  function closeReportModal() {
    showReportModal = false;
    reportFormErrors = {};
    mapPreviewImage = '';
    capturingMap = false;
    showPopupInstructions = false; // Limpar instruções ao fechar modal
  }

  async function exportToPDF() {
    if (!validateReportForm()) {
        return;
      }

    generatingPDF = true;
    error = null;

    try {
      if (!mapPreviewImage) {
        error = 'Erro: Mapa não foi capturado. Por favor, feche e abra o modal novamente.';
        generatingPDF = false;
        return;
      }

      const now = new Date();
      const dateStr = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const horaFormatada = `${timeStr}h`;
      const dataHoraLegivel = `${dateStr} ${timeStr}`;

      currentVIALA = '';

      const viAlaRecord = {
        ala: reportForm.numeroALA || '',
        data: dataHoraLegivel,
        hora: horaFormatada,
        projetista: reportForm.projetista || '',
        cidade: reportForm.cidade || '',
        endereco: reportForm.enderecoCompleto || '',
        latitude: clientCoords ? clientCoords.lat.toFixed(6) : '',
        longitude: clientCoords ? clientCoords.lng.toFixed(6) : '',
        tabulacaoFinal: reportForm.tabulacaoFinal || ''
      };

      console.log('💾 [Frontend] Registrando VI ALA no Supabase...', viAlaRecord);

      const registerController = new AbortController();
      const registerTimeoutId = setTimeout(() => registerController.abort(), 15000);

      let registerResponse;
      try {
        registerResponse = await fetch(getApiUrl('/api/vi-ala/register'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(viAlaRecord),
          signal: registerController.signal
        });
      } finally {
        clearTimeout(registerTimeoutId);
      }

      if (!registerResponse.ok) {
        const errorText = await registerResponse.text();
        throw new Error(`HTTP ${registerResponse.status}: ${errorText}`);
      }

      const registerData = await registerResponse.json();

      if (!registerData.success || !registerData.viAla) {
        throw new Error(registerData.error || 'Não foi possível registrar o VI ALA na base');
      }

      currentVIALA = registerData.viAla;
      console.log(`✅ [Frontend] VI ALA registrado: ${currentVIALA} (${registerData.storage || 'supabase'})`);

      const mapImageData = mapPreviewImage;
      
      console.log('Iniciando geração de PDF...', { 
        temImagem: !!mapImageData, 
        tamanhoImagem: mapImageData ? mapImageData.length : 0,
        viAla: currentVIALA
      });

      // Buscar data de atualização da base (opcional, não bloqueia)
      let baseLastModifiedText = '';
      try {
        const savedLastModified = localStorage.getItem('baseLastModified');
        if (savedLastModified) {
          const lastModified = new Date(savedLastModified);
          baseLastModifiedText = lastModified.toLocaleDateString('pt-BR', { 
            day: '2-digit', month: '2-digit', year: 'numeric'
          }) + ' - ' + lastModified.toLocaleTimeString('pt-BR', {
            hour: '2-digit', minute: '2-digit'
          });
        }
      } catch (err) {}
      
      fetch(getApiUrl('/api/base-last-modified'))
        .then(res => res.json())
        .then(data => {
          if (data.success && data.lastModified) {
            localStorage.setItem('baseLastModified', data.lastModified);
          }
        })
        .catch(() => {});
      
      console.log('Dados preparados, criando HTML do PDF...');

      // Criar nome do arquivo PDF com VI ALA no formato: "VI ALA - XXXXXXX - ALA-15002 - Engenharia.pdf"
      let pdfFileName = '';
      if (currentVIALA && currentVIALA.trim() !== '') {
        // Converter formato "VI ALA-0000001" para "VI ALA - 0000001" se necessário
        const viAlaFormatted = currentVIALA.replace(/VI\s*ALA-/, 'VI ALA - ');
        pdfFileName = `${viAlaFormatted} - ${reportForm.numeroALA || 'ALA-00000'} - Engenharia.pdf`;
      } else {
        // Se não tiver VI ALA, usar formato antigo
        pdfFileName = `${reportForm.numeroALA || 'ALA-00000'} - Engenharia.pdf`;
      }

      // Criar conteúdo HTML para o PDF
      // Separar o style em uma variável para evitar conflito com o parser do Svelte
      const pdfStyles = `
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { 
                font-family: 'Inter', 'Segoe UI', Arial, sans-serif; 
                padding: 0 8px 0 8px; 
                background: white !important; 
                margin: 0;
                font-size: 13px;
                line-height: 1.4;
                color: #333;
                height: auto;
                min-height: auto;
                position: relative;
                z-index: 2;
              }
              .pdf-header {
                background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
                color: white;
                padding: 8px 12px;
                border-radius: 4px 4px 0 0;
                margin-top: 0;
                margin-bottom: 6px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                box-shadow: 0 2px 6px rgba(123, 104, 238, 0.3);
                position: relative;
                z-index: 1;
              }
              .pdf-header h1 {
                font-size: 20px;
                font-weight: 700;
                margin: 0;
                color: white;
                letter-spacing: 0.2px;
                text-shadow: 0 1px 2px rgba(0,0,0,0.1);
                line-height: 1.4;
              }
              .pdf-header .date-info {
                font-size: 11px;
                opacity: 0.95;
                text-align: right;
                font-weight: 500;
                line-height: 1.4;
              }
              .report-container { 
                display: flex; 
                gap: 8px; 
                margin-bottom: 6px; 
                align-items: stretch; 
                height: auto;
              }
              .report-header { 
                background: linear-gradient(to bottom, #f8f9fa 0%, #ffffff 100%);
                padding: 8px;
                border-radius: 4px;
                border: 1px solid #e0e0e0;
                flex: 0 0 38%;
                box-shadow: 0 1px 3px rgba(0,0,0,0.08);
                display: flex;
                flex-direction: column;
              }
              .report-header h2 { 
                color: #7B68EE; 
                margin-top: 0; 
                margin-bottom: 5px; 
                font-size: 14px;
                font-weight: 700;
                padding-bottom: 3px;
                border-bottom: 2px solid #7B68EE;
                line-height: 1.3;
              }
              .report-info { 
                display: grid;
                grid-template-columns: 1fr;
                gap: 3px;
                margin-bottom: 5px;
                flex: 1;
              }
              .report-info-item { 
                display: flex;
                flex-direction: column;
                gap: 2px;
                padding: 3px 0;
                border-bottom: 1px solid #f0f0f0;
              }
              .report-info-item:last-child {
                border-bottom: none;
              }
              .report-info-label { 
                font-weight: 600; 
                color: #666; 
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.2px;
                line-height: 1.3;
              }
              .report-info-value { 
                color: #333; 
                font-size: 12px;
                font-weight: 500;
                word-break: break-word;
                line-height: 1.4;
              }
              .summary-stats {
                margin-top: auto;
                padding-top: 5px;
                border-top: 2px solid #7B68EE;
                display: flex;
                flex-direction: column;
                gap: 2px;
              }
              .summary-stats p {
                margin: 0;
                font-size: 11px;
                color: #333;
                line-height: 1.3;
              }
              .summary-stats strong {
                color: #7B68EE;
                font-weight: 700;
              }
              .map-section { 
                flex: 1;
                display: flex; 
                flex-direction: column; 
                background: transparent !important;
                min-height: 0;
                align-items: center;
                position: relative;
                z-index: 1;
              }
              .map-section h2 { 
                color: #7B68EE; 
                margin-bottom: 5px; 
                font-size: 14px;
                font-weight: 700;
                margin-top: 0;
                text-align: center;
                padding-bottom: 3px;
                border-bottom: 2px solid #7B68EE;
                width: 100%;
                line-height: 1.3;
              }
              .map-wrapper {
                display: inline-flex;
                flex-direction: column;
                align-items: center;
                width: auto;
                max-width: 100%;
              }
              .map-image-container { 
                display: inline-block;
                width: auto;
                max-width: 100%;
                position: relative; 
                background: transparent !important; 
                border: 2px solid #7B68EE; 
                border-radius: 4px; 
                padding: 0; 
                overflow: hidden;
                box-shadow: 0 1px 4px rgba(123, 104, 238, 0.2);
                line-height: 0;
              }
              .map-image-container::before,
              .map-image-container::after { 
                display: none !important; 
              }
              .map-image { 
                display: block; 
                width: auto;
                height: auto;
                max-width: 100%;
                max-height: 320px;
                object-fit: contain;
                box-shadow: none; 
                background: transparent !important; 
                opacity: 1 !important; 
                filter: none !important;
                border-radius: 3px;
                margin: 0;
                padding: 0;
              }
              .map-image::before,
              .map-image::after { 
                display: none !important; 
              }
              .base-update-info {
                margin-top: 6px;
                font-size: 10px;
                color: #666;
                text-align: right;
                font-style: italic;
                padding-right: 0;
                width: 100%;
                align-self: flex-end;
                margin-left: 0;
                margin-right: 0;
              }
              @page {
                size: landscape;
                margin: 0.2cm 0.3cm 0.15cm 0.3cm;
                padding: 0;
              }
              @media print {
                * {
                  page-break-inside: avoid;
                  /* Forçar impressão de backgrounds independente da configuração do navegador */
                  print-color-adjust: exact !important;
                  -webkit-print-color-adjust: exact !important;
                  color-adjust: exact !important;
                }
                body { 
                  background: white !important;
                  padding: 0 4px 0 4px !important;
                  margin: 0 !important;
                  height: auto !important;
                  min-height: auto !important;
                  font-size: 13px !important;
                  line-height: 1.4 !important;
                  print-color-adjust: exact !important;
                  -webkit-print-color-adjust: exact !important;
                  color-adjust: exact !important;
                }
                .pdf-header {
                  page-break-after: avoid;
                  margin-top: 0 !important;
                  margin-bottom: 6px !important;
                  padding: 8px 12px !important;
                  print-color-adjust: exact !important;
                  -webkit-print-color-adjust: exact !important;
                  color-adjust: exact !important;
                }
                .pdf-header h1 {
                  font-size: 20px !important;
                  line-height: 1.3 !important;
                }
                .pdf-header .date-info {
                  font-size: 11px !important;
                  line-height: 1.3 !important;
                }
                .report-container {
                  page-break-inside: avoid;
                  height: auto;
                  gap: 8px !important;
                  margin-bottom: 6px !important;
                }
                .report-header {
                  padding: 8px !important;
                  print-color-adjust: exact !important;
                  -webkit-print-color-adjust: exact !important;
                  color-adjust: exact !important;
                }
                .report-header h2 {
                  margin-bottom: 5px !important;
                  padding-bottom: 3px !important;
                  font-size: 14px !important;
                  line-height: 1.3 !important;
                }
                .report-info {
                  gap: 3px !important;
                  margin-bottom: 5px !important;
                }
                .report-info-item {
                  padding: 3px 0 !important;
                  gap: 2px !important;
                }
                .report-info-label {
                  font-size: 11px !important;
                  line-height: 1.2 !important;
                }
                .report-info-value {
                  font-size: 12px !important;
                  line-height: 1.3 !important;
                }
                .summary-stats {
                  padding-top: 5px !important;
                  gap: 2px !important;
                }
                .summary-stats p {
                  font-size: 11px !important;
                  line-height: 1.3 !important;
                }
                .map-section h2 {
                  margin-bottom: 5px !important;
                  padding-bottom: 3px !important;
                  font-size: 14px !important;
                  line-height: 1.3 !important;
                }
                .table-container {
                  page-break-inside: avoid;
                  margin-top: 5px !important;
                  margin-bottom: 0 !important;
                  padding: 5px !important;
                  position: relative !important;
                  z-index: 1 !important;
                }
                .table-container h2 {
                  margin-bottom: 5px !important;
                  padding-bottom: 3px !important;
                  font-size: 14px !important;
                  line-height: 1.3 !important;
                }
                .map-image-container {
                  display: inline-block !important;
                  width: auto !important;
                  max-width: 100% !important;
                  height: auto !important;
                  background: transparent !important;
                  padding: 0 !important;
                  page-break-inside: avoid;
                }
                .map-image { 
                  display: block !important;
                  width: auto !important;
                  height: auto !important;
                  max-width: 100% !important;
                  max-height: 320px !important;
                  object-fit: contain !important;
                  margin: 0 !important;
                  padding: 0 !important;
                  page-break-inside: avoid; 
                  background: transparent !important; 
                  opacity: 1 !important; 
                  filter: none !important; 
                }
                .map-section { 
                  background: transparent !important;
                  page-break-inside: avoid;
                  height: auto;
                  position: relative !important;
                  z-index: 1 !important;
                }
                table {
                  page-break-inside: avoid;
                  font-size: 11px !important;
                  print-color-adjust: exact !important;
                  -webkit-print-color-adjust: exact !important;
                  color-adjust: exact !important;
                }
                thead {
                  print-color-adjust: exact !important;
                  -webkit-print-color-adjust: exact !important;
                  color-adjust: exact !important;
                }
                th {
                  padding: 5px 4px !important;
                  font-size: 11px !important;
                  line-height: 1.3 !important;
                  print-color-adjust: exact !important;
                  -webkit-print-color-adjust: exact !important;
                  color-adjust: exact !important;
                }
                tbody tr {
                  print-color-adjust: exact !important;
                  -webkit-print-color-adjust: exact !important;
                  color-adjust: exact !important;
                }
                }
                td {
                  padding: 4px 4px !important;
                  font-size: 11px !important;
                  line-height: 1.3 !important;
                  print-color-adjust: exact !important;
                  -webkit-print-color-adjust: exact !important;
                  color-adjust: exact !important;
                }
                thead {
                  display: table-header-group;
                  print-color-adjust: exact !important;
                  -webkit-print-color-adjust: exact !important;
                  color-adjust: exact !important;
                }
                tfoot {
                  display: table-footer-group;
                }
                .footer {
                  page-break-before: avoid;
                  margin-top: 3px !important;
                  margin-bottom: 0 !important;
                  padding-top: 3px !important;
                  padding-bottom: 0 !important;
                  font-size: 10px !important;
                  line-height: 1.3 !important;
                }
                .footer p {
                  margin: 0 !important;
                  padding: 0 !important;
                }
                .watermark {
                  position: fixed !important;
                  bottom: 10px !important;
                  left: 50% !important;
                  transform: translateX(-50%) !important;
                  font-size: 14px !important;
                  color: #333 !important;
                  opacity: 1 !important;
                  font-weight: 700 !important;
                  z-index: 1000 !important;
                  pointer-events: none !important;
                  white-space: nowrap !important;
                  text-align: center !important;
                }
              }
              .table-container {
                margin-top: 5px;
                overflow-x: auto;
                background: white;
                border-radius: 4px;
                padding: 5px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.08);
                margin-bottom: 0;
                position: relative;
                z-index: 1;
              }
              .table-container h2 {
                color: #7B68EE;
                margin: 0 0 5px 0;
                font-size: 14px;
                font-weight: 700;
                padding-bottom: 3px;
                border-bottom: 2px solid #7B68EE;
                text-align: left;
                line-height: 1.3;
              }
              table { 
                width: 100%; 
                border-collapse: separate;
                border-spacing: 0;
                border: 2px solid #7B68EE;
                font-size: 11px;
                box-shadow: 0 1px 4px rgba(123, 104, 238, 0.15);
                border-radius: 4px;
                overflow: hidden;
              }
              thead {
                background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
              }
              th { 
                color: white; 
                padding: 5px 4px; 
                text-align: center; 
                font-weight: 700;
                border-right: 1px solid rgba(255,255,255,0.3);
                border-bottom: 2px solid rgba(255,255,255,0.4);
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.2px;
                white-space: nowrap;
                line-height: 1.3;
              }
              th:last-child {
                border-right: none;
              }
              td { 
                padding: 4px 4px; 
                border-right: 1px solid #ddd;
                border-bottom: 1px solid #e0e0e0;
                text-align: center;
                font-size: 11px;
                color: #000000;
                font-weight: 500;
                vertical-align: middle;
                line-height: 1.3;
              }
              td:last-child {
                border-right: none;
              }
              tbody tr:nth-child(even) { 
                background-color: #f8f9fa; 
              }
              tbody tr:nth-child(odd) {
                background-color: #ffffff;
              }
              tbody tr:last-child td {
                border-bottom: none;
              }
              tbody tr:hover {
                background-color: #f0f4ff;
              }
              .footer {
                margin-top: 3px;
                padding-top: 3px;
                border-top: 1px solid #7B68EE;
                text-align: center;
                font-size: 10px;
                color: #666;
                margin-bottom: 0;
                padding-bottom: 0;
                line-height: 1.3;
              }
              .footer p {
                margin: 0;
                padding: 0;
              }
              .watermark {
                position: fixed;
                bottom: 10px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 14px;
                color: #333;
                opacity: 1;
                font-weight: 700;
                z-index: 1000;
                pointer-events: none;
                white-space: nowrap;
                text-align: center;
                position: relative;
                z-index: 1;
              }
              @media print {
                .watermark {
                  position: fixed !important;
                  bottom: 10px !important;
                  left: 50% !important;
                  transform: translateX(-50%) !important;
                  font-size: 14px !important;
                  opacity: 1 !important;
                  font-weight: 700 !important;
                  color: #333 !important;
                  text-align: center !important;
                }
              }
      `;
      
      // Garantir que currentVIALA está definido e formatado corretamente
      const viAlaDisplay = currentVIALA ? ` - ${currentVIALA}` : '';
      const numeroALADisplay = reportForm.numeroALA || '';
      
      // Filtrar apenas CTOs de rua que estão marcadas (visíveis) para o relatório (ANTES de usar no HTML)
      // IMPORTANTE: Calcular ANTES de usar na template string para evitar erro "Cannot access before initialization"
      const ctosRuaReport = ctos.filter(cto => {
        // Excluir prédios
        if (cto.is_condominio) return false;
        
        // Verificar se está marcada (visível) na tabela
        const ctoKey = getCTOKey(cto);
        const isVisible = ctoVisibility.get(ctoKey) !== false;
        
        return isVisible;
      });
      
      // Verificar se há CTO fora do limite e preparar texto do total
      const ctoForaLimite = ctosRuaReport.find(cto => cto.is_out_of_limit);
      let totalEquipamentosTexto = '';
      if (ctoForaLimite) {
        const distancia = ctoForaLimite.distancia_real || ctoForaLimite.distancia_metros || 0;
        const distanciaTexto = distancia >= 1000 ? `${(distancia / 1000).toFixed(2)} km` : `${Math.round(distancia)} m`;
        totalEquipamentosTexto = `<p><strong style="font-weight: bold; color: #F44336;">Fora do limite: Equipamento mais próximo está a ${distanciaTexto} de distância.</strong></p>`;
      } else {
        totalEquipamentosTexto = `<p><strong>Total:</strong> <span style="font-weight: bold; color: #000000;">${ctosRuaReport.length}</span> <strong style="font-weight: bold; color: #000000;">${ctosRuaReport.length === 1 ? 'Equipamento encontrado' : 'Equipamentos encontrados'} dentro de 250m</strong></p>`;
      }
      
      let htmlContent = `
        <html>
          <head>
            <meta charset="UTF-8">
            <title>${pdfFileName.replace('.pdf', '')}</title>
            <style>${pdfStyles}</style>
          </head>
          <body>
            <div class="pdf-header">
              <h1>Relatório de Análise de Viabilidade Técnica${viAlaDisplay}<br><span style="font-size: 15px; font-weight: 500; opacity: 0.95;">Alares Engenharia - ${numeroALADisplay}</span></h1>
              <div class="date-info">
                <div style="margin-bottom: 3px; line-height: 1.4;">Gerado em: ${dateStr} às ${timeStr}</div>
                <div style="font-size: 10px; opacity: 0.85; line-height: 1.3;">Sistema de Viabilidade Técnica</div>
              </div>
            </div>
            <div class="report-container">
              <div class="report-header">
                <h2>Informações do Relatório</h2>
                <div class="report-info">
                  <div class="report-info-item">
                    <span class="report-info-label">Número do ALA</span>
                    <span class="report-info-value">${reportForm.numeroALA}</span>
                  </div>
                  <div class="report-info-item">
                    <span class="report-info-label">Cidade</span>
                    <span class="report-info-value">${reportForm.cidade}</span>
                  </div>
                  <div class="report-info-item">
                    <span class="report-info-label">Endereço Completo</span>
                    <span class="report-info-value">${reportForm.enderecoCompleto}</span>
                  </div>
                  <div class="report-info-item">
                    <span class="report-info-label">Número do Endereço</span>
                    <span class="report-info-value">${reportForm.numeroEndereco}</span>
                  </div>
                  <div class="report-info-item">
                    <span class="report-info-label">CEP do Endereço</span>
                    <span class="report-info-value">${reportForm.cep}</span>
                  </div>
                  ${clientCoords ? `
                  <div class="report-info-item">
                    <span class="report-info-label">Latitude e Longitude</span>
                    <span class="report-info-value">${clientCoords.lat.toFixed(6)}, ${clientCoords.lng.toFixed(6)}</span>
                  </div>
                  ` : ''}
                  <div class="report-info-item">
                    <span class="report-info-label">Tabulação Final</span>
                    <span class="report-info-value">${reportForm.tabulacaoFinal}</span>
                  </div>
                  <div class="report-info-item">
                    <span class="report-info-label">Projetista</span>
                    <span class="report-info-value">${reportForm.projetista}</span>
                  </div>
                </div>
                <div class="summary-stats">
                  ${totalEquipamentosTexto}
                  <p><strong>Total de Portas Disponíveis:</strong> <span style="font-weight: bold; color: #000000;">${ctosRuaReport.reduce((sum, cto) => sum + (cto.vagas_total - cto.clientes_conectados), 0)}</span> <strong style="font-weight: bold; color: #000000;">portas</strong></p>
                </div>
              </div>
              ${mapImageData ? `
              <div class="map-section">
                <h2>Visualização do Mapa</h2>
                <div class="map-wrapper">
                  <div class="map-image-container">
                    <img src="${mapImageData}" alt="Mapa com CTOs e Cliente" class="map-image" />
                  </div>
                  ${baseLastModifiedText ? `<div class="base-update-info">*Última atualização da base em ${baseLastModifiedText}</div>` : ''}
                </div>
              </div>
              ` : ''}
            </div>
            <div class="table-container">
              <h2>Equipamentos CTO Encontrados</h2>
              <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Cidade</th>
                  <th>POP</th>
                  <th>Nome</th>
                  <th>ID</th>
                  <th>Total de Portas</th>
                  <th>Portas Conectadas</th>
                  <th>Portas Disponíveis</th>
                  <th>Distância</th>
                </tr>
              </thead>
              <tbody>
      `;

      // ctosRuaReport já foi definido acima (antes do htmlContent)
      ctosRuaReport.forEach((cto, index) => {
        const portasDisponiveis = cto.vagas_total - cto.clientes_conectados;
        const semPortas = portasDisponiveis === 0;
        const styleColor = semPortas ? ' style="color: #F44336;"' : '';
        htmlContent += `
          <tr${styleColor}>
            <td${styleColor}>${index + 1}</td>
            <td${styleColor}>${cto.cidade}</td>
            <td${styleColor}>${cto.pop}</td>
            <td${styleColor}>${cto.nome}</td>
            <td${styleColor}>${cto.id}</td>
            <td${styleColor}>${cto.vagas_total}</td>
            <td${styleColor}>${cto.clientes_conectados}</td>
            <td${styleColor}>${cto.vagas_total - cto.clientes_conectados}</td>
            <td${styleColor}>${cto.distancia_metros}m (${cto.distancia_km}km)</td>
          </tr>
        `;
      });

      htmlContent += `
              </tbody>
            </table>
            </div>
            <div class="watermark">Setor de Planejamento e Projetos - Engenharia Alares</div>
          </body>
        </html>
      `;

      console.log('HTML do PDF criado com sucesso, tamanho:', htmlContent.length, 'caracteres');

      // Criar nova janela para abrir PDF em nova aba
      console.log('Abrindo janela de impressão em nova aba...');
      const printWindow = window.open('', '_blank');
      
      // Verificar se a janela foi aberta (pode ser bloqueada por popup blocker)
      if (!printWindow || !printWindow.document) {
        console.error('Falha ao abrir janela de impressão - popup bloqueado?');
        generatingPDF = false;
        showPopupInstructions = true; // Mostrar instruções sobreposta ao modal
        error = null; // Limpar erro anterior para mostrar instruções
        return;
      }
      
      console.log('Janela de impressão aberta com sucesso');
      
      // Função auxiliar para finalizar a geração do PDF
      let pdfGenerationFinished = false;
      let printTimeoutId = null;
      let safetyTimeoutId = null;
      
      const finishPDFGeneration = () => {
        if (!pdfGenerationFinished) {
          pdfGenerationFinished = true;
          generatingPDF = false;
          if (printTimeoutId) clearTimeout(printTimeoutId);
          if (safetyTimeoutId) clearTimeout(safetyTimeoutId);
          
          // Limpar apenas os campos que devem ser preenchidos manualmente
          reportForm.numeroALA = '';
          reportForm.tabulacaoFinal = '';
          reportFormErrors = {};
          
          closeReportModal();
        }
      };

      // Função para tentar imprimir (só executa uma vez)
      const tryPrint = () => {
        if (pdfGenerationFinished) {
          console.log('PDF já foi finalizado, ignorando tentativa de impressão');
          return;
        }
        
        console.log('Tentando imprimir PDF...');
        
        if (printTimeoutId) {
          clearTimeout(printTimeoutId);
          printTimeoutId = null;
        }
        
        if (printWindow && !printWindow.closed) {
          try {
            printWindow.print();
            console.log('Comando de impressão executado com sucesso');
            finishPDFGeneration();
          } catch (printErr) {
            console.error('Erro ao imprimir:', printErr);
            error = 'Erro ao abrir diálogo de impressão: ' + printErr.message;
            finishPDFGeneration();
          }
        } else {
          console.warn('Janela de impressão foi fechada antes de imprimir');
          finishPDFGeneration();
        }
      };

      // Escrever o conteúdo HTML na nova janela
      console.log('Escrevendo conteúdo HTML na janela...');
      printWindow.document.open();
      printWindow.document.write(htmlContent);
      printWindow.document.close();
      
      // Definir título da janela
      printWindow.document.title = pdfFileName.replace('.pdf', '');
      console.log('Conteúdo HTML escrito, aguardando carregamento...');
      
      // Aguardar que o documento seja totalmente carregado
      const waitForDocument = () => {
        try {
          // Verificar se o documento está pronto
          if (printWindow && printWindow.document && printWindow.document.readyState === 'complete') {
            // Verificar se há imagens no documento
            const images = printWindow.document.querySelectorAll('img');
            const totalImages = images.length;
            
            console.log(`Documento carregado. Encontradas ${totalImages} imagens.`);
            
            if (totalImages === 0) {
              // Se não há imagens, imprimir após um pequeno delay
              printTimeoutId = setTimeout(tryPrint, 300);
              return;
            }
            
            // Para imagens base64 (data URLs), elas geralmente já estão "carregadas"
            let imagesReadyCount = 0;
            
            images.forEach((img) => {
              // Verificar se é uma imagem base64 (data URL)
              const isDataUrl = img.src && img.src.startsWith('data:');
              
              if (isDataUrl) {
                // Para data URLs, verificar se o src foi definido corretamente
                if (img.src && (img.complete || img.naturalWidth > 0)) {
                  imagesReadyCount++;
                } else {
                  // Forçar carregamento mesmo sendo data URL
                  const tempImg = new Image();
                  tempImg.onload = () => {
                    imagesReadyCount++;
                    if (imagesReadyCount === totalImages && !pdfGenerationFinished) {
                      printTimeoutId = setTimeout(tryPrint, 300);
                    }
                  };
                  tempImg.onerror = () => {
                    imagesReadyCount++;
                    if (imagesReadyCount === totalImages && !pdfGenerationFinished) {
                      printTimeoutId = setTimeout(tryPrint, 300);
                    }
                  };
                  tempImg.src = img.src;
                }
              } else {
                // Para imagens normais, verificar se estão carregadas
                if (img.complete && img.naturalWidth > 0) {
                  imagesReadyCount++;
                } else {
                  img.onload = () => {
                    imagesReadyCount++;
                    if (imagesReadyCount === totalImages && !pdfGenerationFinished) {
                      printTimeoutId = setTimeout(tryPrint, 300);
                    }
                  };
                  img.onerror = () => {
                    imagesReadyCount++;
                    if (imagesReadyCount === totalImages && !pdfGenerationFinished) {
                      printTimeoutId = setTimeout(tryPrint, 300);
                    }
                  };
                }
              }
            });
            
            // Se todas as imagens já estão prontas (especialmente para base64)
            if (imagesReadyCount === totalImages) {
              console.log('Todas as imagens estão prontas, agendando impressão...');
              printTimeoutId = setTimeout(tryPrint, 300);
              return;
            }
            
            console.log(`Aguardando imagens carregarem... (${imagesReadyCount}/${totalImages})`);
            
            // Timeout de segurança caso alguma imagem não carregue (2 segundos para base64)
            safetyTimeoutId = setTimeout(() => {
              if (!pdfGenerationFinished) {
                console.warn('Timeout ao aguardar imagens, imprimindo mesmo assim...');
                tryPrint();
              }
            }, 2000);
          } else {
            // Tentar novamente após um pequeno delay
            setTimeout(waitForDocument, 50);
          }
        } catch (err) {
          console.error('Erro ao aguardar documento:', err);
          // Tentar imprimir mesmo com erro após um delay
          setTimeout(() => {
            if (!pdfGenerationFinished) {
              tryPrint();
            }
          }, 500);
        }
      };
      
      // Aguardar um pouco antes de iniciar a verificação (dar tempo para o DOM renderizar)
      setTimeout(() => {
        waitForDocument();
      }, 100);
      
      // Timeout de segurança global: garantir que o estado seja resetado mesmo em caso de erro (8 segundos)
      setTimeout(() => {
        if (!pdfGenerationFinished) {
          console.warn('Timeout global na geração de PDF, resetando estado...');
          finishPDFGeneration();
        }
      }, 8000);

    } catch (err) {
      console.error('Erro na geração de PDF:', err);
      generatingPDF = false;
      currentVIALA = '';

      if (err.name === 'AbortError') {
        error = 'Tempo esgotado ao registrar o VI ALA no Supabase. Tente novamente.';
      } else if (err.message && err.message.includes('HTTP 500')) {
        error = 'Não foi possível salvar o VI ALA no Supabase. O PDF não foi gerado para evitar número duplicado.';
      } else {
        error = 'Erro ao registrar VI ALA / exportar PDF: ' + err.message;
      }
    }
  }

</script>

<!-- Tela de Loading -->
{#if isLoading}
  <div class="loading-fullscreen">
    <Loading currentMessage={loadingMessage} />
  </div>
{:else}
<!-- Conteúdo da Ferramenta de Viabilidade -->
<div class="viabilidade-content">
  <div class="main-layout">
    <!-- Painel de Busca -->
    <aside class="search-panel" class:minimized={isSearchPanelMinimized} style="width: {isSearchPanelMinimized ? '60px' : sidebarWidthStyle} !important; flex: 0 0 auto;">
      <div class="panel-header">
        <div class="panel-header-content">
          {#if !isSearchPanelMinimized}
            <h2>Viabilidade Alares</h2>
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
          <p>Localize o cliente e encontre CTOs próximas</p>
        {/if}
      </div>

      {#if !isSearchPanelMinimized}
      <div class="search-section">
        <!-- Box de aviso quando não há base de dados -->
        {#if !baseDataExists}
          <div class="base-data-warning">
            <div class="warning-icon">⚠️</div>
            <div class="warning-content">
              <h3>Atenção</h3>
              <p>Nenhuma base de dados foi carregada. Não é possível identificar as CTOs dentro da nossa estrutura de rede.</p>
            </div>
          </div>
        {/if}
        
        <div class="search-form">

          <div class="search-mode-selector">
            <button 
              class="mode-button"
              class:active={searchMode === 'address'}
              on:click={() => searchMode = 'address'}
            >
              Endereço
            </button>
            <button 
              class="mode-button"
              class:active={searchMode === 'coordinates'}
              on:click={() => searchMode = 'coordinates'}
            >
              Coordenadas
            </button>
          </div>

          {#if searchMode === 'address'}
            <div class="form-group">
              <label for="address">Endereço (Rua e Número)</label>
              <input 
                type="text" 
                id="address"
                bind:value={addressInput}
                placeholder="Ex: Rua Exemplo, 123, São Paulo"
                disabled={loading}
              />
            </div>
          {:else}
            <div class="form-group">
              <label for="coordinates">Coordenadas (Latitude, Longitude)</label>
              <input 
                type="text" 
                id="coordinates"
                bind:value={coordinatesInput}
                placeholder="Ex: -22.5728462249402, -47.40101216301998"
                disabled={loading}
              />
            </div>
          {/if}

          <button 
            class="search-button"
            on:click={searchClientLocation}
            disabled={loading || !googleMapsLoaded}
          >
            {#if loading}
              <span class="hourglass-icon">⏳</span> Localizando{loadingDots}
            {:else}
              Localizar no Mapa
            {/if}
          </button>

          {#if clientCoords}
            <button 
              class="search-button generate-report-button"
              on:click={openReportModal}
            >
              Gerar Relatório
            </button>
          {/if}

          {#if error}
            <div class="error-message">
              {error}
            </div>
          {/if}
          
          <!-- Box informativo de cobertura -->
          {#if clientCoords && isClientCovered === false}
            {@const distanciaValida = distanceToCoverage !== null && distanceToCoverage !== undefined && !isNaN(distanceToCoverage) && distanceToCoverage >= 0}
            <div class="coverage-info-box">
              <div class="coverage-info-header">
                <span class="coverage-info-icon">⚠️</span>
                <span class="coverage-info-title">Fora da Área de Cobertura</span>
                <button 
                  class="info-icon" 
                  on:click={() => showInfoForaCobertura = !showInfoForaCobertura}
                  title="Informação"
                  aria-label="Informação sobre área de cobertura"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" fill="#7B68EE" stroke="#7B68EE" stroke-width="1"/>
                    <path d="M12 16V12" stroke="white" stroke-width="2" stroke-linecap="round"/>
                    <circle cx="12" cy="8" r="1" fill="white"/>
                  </svg>
                </button>
              </div>
              <div class="coverage-info-content">
                {#if distanciaValida}
                  <p>O endereço está localizado a <strong>{distanceToCoverage >= 1000 ? `${(distanceToCoverage / 1000).toFixed(2)} km` : `${Math.round(distanceToCoverage)} m`}</strong> da área de cobertura mais próxima.</p>
                {:else}
                  <p>O endereço está localizado <strong>fora da área de cobertura</strong>. Calculando distância...</p>
                {/if}
              </div>
            </div>
            {#if showInfoForaCobertura}
              <div 
                class="info-modal-overlay" 
                on:click={() => showInfoForaCobertura = false}
                on:keydown={(e) => e.key === 'Escape' && (showInfoForaCobertura = false)}
                role="button"
                tabindex="-1"
                aria-label="Fechar modal de informação"
              >
                <div 
                  class="info-modal-box" 
                  on:click|stopPropagation
                  on:keydown={(e) => e.key === 'Enter' && e.stopPropagation()}
                  role="dialog"
                  tabindex="0"
                  aria-modal="true"
                >
                  <div class="info-modal-header">
                    <h3>Informação</h3>
                    <button class="info-modal-close" on:click={() => showInfoForaCobertura = false} aria-label="Fechar">×</button>
                  </div>
                  <div class="info-modal-body">
                    <p>O endereço pesquisado está localizado fora da área de cobertura da rede. A distância informada representa a distância em metros ou quilômetros até a área de cobertura mais próxima.</p>
                  </div>
                </div>
              </div>
            {/if}
          {/if}
          
          {#if clientCoords && isClientCovered === true}
            <div class="coverage-info-box coverage-info-box-success">
              <div class="coverage-info-header">
                <span class="coverage-info-icon">✅</span>
                <span class="coverage-info-title">Dentro da Área de Cobertura</span>
              </div>
            </div>
          {/if}
          
          <!-- Box informativo da CTO mais próxima (fora do limite) -->
          {#if nearestCTOOutsideLimit && (nearestCTOOutsideLimit.distancia_real || nearestCTOOutsideLimit.distancia_metros)}
            {@const distancia = nearestCTOOutsideLimit.distancia_real || nearestCTOOutsideLimit.distancia_metros || 0}
            <div class="coverage-info-box coverage-info-box-warning">
              <div class="coverage-info-header">
                <span class="coverage-info-icon">📍</span>
                <span class="coverage-info-title">Fora do Limite</span>
                <button 
                  class="info-icon" 
                  on:click={() => showInfoForaLimite = !showInfoForaLimite}
                  title="Informação"
                  aria-label="Informação sobre CTO fora do limite"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" fill="#7B68EE" stroke="#7B68EE" stroke-width="1"/>
                    <path d="M12 16V12" stroke="white" stroke-width="2" stroke-linecap="round"/>
                    <circle cx="12" cy="8" r="1" fill="white"/>
                  </svg>
                </button>
              </div>
              <div class="coverage-info-content">
                <p>
                  Equipamento mais próximo é <strong>{nearestCTOOutsideLimit.nome || 'N/A'}</strong> a 
                  <strong>{distancia >= 1000 ? `${(distancia / 1000).toFixed(2)} km` : `${Math.round(distancia)} m`}</strong>.
                </p>
              </div>
            </div>
            {#if showInfoForaLimite}
              <div 
                class="info-modal-overlay" 
                on:click={() => showInfoForaLimite = false}
                on:keydown={(e) => e.key === 'Escape' && (showInfoForaLimite = false)}
                role="button"
                tabindex="-1"
                aria-label="Fechar modal de informação"
              >
                <div 
                  class="info-modal-box" 
                  on:click|stopPropagation
                  on:keydown={(e) => e.key === 'Enter' && e.stopPropagation()}
                  role="dialog"
                  tabindex="0"
                  aria-modal="true"
                >
                  <div class="info-modal-header">
                    <h3>Informação</h3>
                    <button class="info-modal-close" on:click={() => showInfoForaLimite = false} aria-label="Fechar">×</button>
                  </div>
                  <div class="info-modal-body">
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
          {/if}

          {#if ctos.length > 0}
            <div class="results-info">
              <p>
                <strong>{ctosRua.length}</strong> 
                {ctosRua.length === 1 ? 'Equipamento encontrado' : 'Equipamentos encontrados'}
                <button 
                  class="info-icon" 
                  on:click={() => showInfoEquipamentos = !showInfoEquipamentos}
                  title="Informação"
                  aria-label="Informação sobre equipamentos"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" fill="#7B68EE" stroke="#7B68EE" stroke-width="1"/>
                    <path d="M12 16V12" stroke="white" stroke-width="2" stroke-linecap="round"/>
                    <circle cx="12" cy="8" r="1" fill="white"/>
                  </svg>
                </button>
              </p>
              {#if showInfoEquipamentos}
                <div 
                  class="info-modal-overlay" 
                  on:click={() => showInfoEquipamentos = false}
                  on:keydown={(e) => e.key === 'Escape' && (showInfoEquipamentos = false)}
                  role="button"
                  tabindex="-1"
                  aria-label="Fechar modal de informação"
                >
                  <div 
                    class="info-modal-box" 
                    on:click|stopPropagation
                    on:keydown={(e) => e.key === 'Enter' && e.stopPropagation()}
                    role="dialog"
                    tabindex="0"
                    aria-modal="true"
                  >
                    <div class="info-modal-header">
                      <h3>Informação</h3>
                      <button class="info-modal-close" on:click={() => showInfoEquipamentos = false} aria-label="Fechar">×</button>
                    </div>
                    <div class="info-modal-body">
                      {#if nearestCTOOutsideLimit && ctosRua.some(cto => cto.is_out_of_limit)}
                        {@const ctoForaLimite = ctosRua.find(cto => cto.is_out_of_limit) || nearestCTOOutsideLimit}
                        {@const distancia = ctoForaLimite.distancia_real || ctoForaLimite.distancia_metros || 0}
                        <p>
                          Esse equipamento está além da metragem limite padrão para atendimento que é de 250m. 
                          Com isso o sistema buscou o equipamento mais próximo <strong>{ctoForaLimite.nome || 'N/A'}</strong> 
                          que está a <strong>{distancia >= 1000 ? `${(distancia / 1000).toFixed(2)} km` : `${Math.round(distancia)} m`}</strong> de distância.
                        </p>
                      {:else}
                        <p>Quantidade total de equipamentos CTO encontrados dentro de um raio de 250 metros do endereço pesquisado.</p>
                      {/if}
                    </div>
                  </div>
                </div>
              {/if}
            </div>

            {@const totalPortasDisponiveis = ctosRua.reduce((sum, cto) => sum + ((cto.vagas_total || 0) - (cto.clientes_conectados || 0)), 0)}
            <div class="results-info">
              <p>
                <strong>{totalPortasDisponiveis}</strong> 
                {totalPortasDisponiveis === 1 ? 'Porta disponível encontrada' : 'Portas disponíveis encontradas'}
                <button 
                  class="info-icon" 
                  on:click={() => showInfoPortas = !showInfoPortas}
                  title="Informação"
                  aria-label="Informação sobre portas disponíveis"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" fill="#7B68EE" stroke="#7B68EE" stroke-width="1"/>
                    <path d="M12 16V12" stroke="white" stroke-width="2" stroke-linecap="round"/>
                    <circle cx="12" cy="8" r="1" fill="white"/>
                  </svg>
                </button>
              </p>
              {#if showInfoPortas}
                <div 
                  class="info-modal-overlay" 
                  on:click={() => showInfoPortas = false}
                  on:keydown={(e) => e.key === 'Escape' && (showInfoPortas = false)}
                  role="button"
                  tabindex="-1"
                  aria-label="Fechar modal de informação"
                >
                  <div 
                    class="info-modal-box" 
                    on:click|stopPropagation
                    on:keydown={(e) => e.key === 'Enter' && e.stopPropagation()}
                    role="dialog"
                    tabindex="0"
                    aria-modal="true"
                  >
                    <div class="info-modal-header">
                      <h3>Informação</h3>
                      <button class="info-modal-close" on:click={() => showInfoPortas = false} aria-label="Fechar">×</button>
                    </div>
                    <div class="info-modal-body">
                      {#if nearestCTOOutsideLimit && ctosRua.some(cto => cto.is_out_of_limit)}
                        {@const ctoForaLimite = ctosRua.find(cto => cto.is_out_of_limit) || nearestCTOOutsideLimit}
                        <p>
                          Soma total de portas disponível do equipamento <strong>{ctoForaLimite.nome || 'N/A'}</strong> 
                          que se encontra fora da metragem limite padrão para atendimento que é de 250m.
                        </p>
                      {:else}
                        <p>Soma total de portas disponíveis (não conectadas) de todos os equipamentos CTO encontrados dentro de um raio de 250 metros do endereço pesquisado.</p>
                      {/if}
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
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

    <!-- Área Principal (Mapa e Lista) -->
    <main class="main-area">
      <!-- Mapa -->
      <div class="map-container" class:minimized={isMapMinimized} style={mapContainerStyle}>
        <div class="map-header">
          <h3>Mapa</h3>
          <button 
            class="minimize-button" 
            disabled={isResizingSidebar || isResizingMapTable}
            on:click={async () => {
              isMapMinimized = !isMapMinimized;
              
              // Limpar estilos inline para respeitar o estado reativo
              const mapElement = document.querySelector('.map-container');
              const mapDiv = document.getElementById('map');
              
              if (mapElement) {
                if (isMapMinimized) {
                  // Quando minimizar, garantir que TODOS os estilos inline sejam removidos
                  // para que o CSS reativo funcione corretamente
                  mapElement.style.height = '';
                  mapElement.style.minHeight = '';
                  mapElement.style.maxHeight = '';
                  mapElement.style.flex = '';
                  mapElement.style.overflow = 'hidden';
                  
                  // Garantir que o elemento do mapa esteja completamente oculto
                  if (mapDiv) {
                    mapDiv.style.display = 'none';
                    mapDiv.style.visibility = 'hidden';
                    mapDiv.style.height = '0';
                    mapDiv.style.overflow = 'hidden';
                  }
                } else {
                  // Quando expandir, aplicar altura atual e restaurar visibilidade
                  mapElement.style.height = `${mapHeightPixels}px`;
                  mapElement.style.minHeight = `${mapHeightPixels}px`;
                  mapElement.style.flex = '0 0 auto';
                  mapElement.style.overflow = '';
                  
                  // Restaurar visibilidade do elemento do mapa
                  if (mapDiv) {
                    mapDiv.style.display = '';
                    mapDiv.style.visibility = '';
                    mapDiv.style.height = '';
                    mapDiv.style.overflow = '';
                  }
                }
              }
              
              // Aguardar atualização do DOM
              await tick();
              
              if (!isMapMinimized && map && google?.maps) {
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
            {isMapMinimized ? '⬇️' : '⬆️'}
          </button>
        </div>
        <div id="map" class="map" class:hidden={isMapMinimized}></div>
        
        <!-- Popup de informações da rota -->
        {#if selectedRouteIndex !== null && selectedRouteIndex < routes.length}
          {@const route = routes[selectedRouteIndex]}
          {@const routeInfo = route ? routeData.find(rd => rd.polyline === route) : null}
          {@const cto = routeInfo ? routeInfo.cto : null}
          {@const ctoIndex = routeInfo ? routeInfo.ctoIndex : selectedRouteIndex}
          {@const ctoNumber = cto ? (ctoNumbers.get(cto) || 'N/A') : 'N/A'}
          {@const distanciaMetros = cto ? (cto.distancia_real || cto.distancia_metros || 0) : 0}
          {@const distanciaKm = distanciaMetros > 0 ? Math.round((distanciaMetros / 1000) * 100) / 100 : 0}
          {@const distancia = cto && distanciaMetros > 0 ? `${Math.round(distanciaMetros * 100) / 100}m (${distanciaKm}km)` : 'N/A'}
          <div 
            class="route-popup"
            style="left: {routePopupPosition.x}px; top: {routePopupPosition.y}px;"
            on:mousemove={dragRoutePopup}
            on:mouseup={stopDraggingRoutePopup}
            on:mouseleave={stopDraggingRoutePopup}
          >
            <div class="route-popup-content">
              <div 
                class="route-popup-header"
                on:mousedown={startDraggingRoutePopup}
                style="cursor: move;"
              >
                <h3>Rota ({ctoNumber})</h3>
                <button class="route-popup-close" on:click={closeRoutePopup}>×</button>
              </div>
              <div class="route-popup-info">
                <p><strong>CTO:</strong> {cto ? cto.nome : 'N/A'}</p>
                <p><strong>Metragem:</strong> {distancia}</p>
              </div>
              <div class="route-popup-actions">
                {#if editingRouteIndex === selectedRouteIndex}
                  <button 
                    class="route-popup-button finish"
                    on:click={() => finishEditingRoute(selectedRouteIndex)}
                  >
                    ✓ Finalizar Edição
                  </button>
                {:else}
                  <button 
                    class="route-popup-button edit"
                    on:click={() => editSingleRoute(selectedRouteIndex)}
                  >
                   Editar Rota
                  </button>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Handle de redimensionamento horizontal (mapa/lista) -->
      <div 
        class="resize-handle resize-handle-horizontal"
        on:mousedown|stopPropagation={startResizeMapTable}
        on:touchstart|stopPropagation={startResizeMapTable}
        class:resizing={isResizingMapTable}
        role="separator"
        aria-label="Ajustar altura do mapa e lista"
        tabindex="0"
      >
      </div>

      <!-- Tabela de Resultados -->
      {#if ctosRua.length > 0}
        <div class="results-table-container" class:minimized={isListMinimized} style="flex: {isListMinimized ? '0 0 auto' : '1 1 auto'}; min-height: {isListMinimized ? '60px' : '200px'};">
          <div class="table-header">
            <h3>Tabela de Equipamentos Encontrados - {ctosRua.length} Equipamentos Encontrados</h3>
            <div class="table-header-buttons">
              <button 
                class="minimize-button" 
                disabled={isResizingSidebar || isResizingMapTable}
                on:click={async () => {
                  isListMinimized = !isListMinimized;
                  
                  // Limpar estilos inline para respeitar o estado reativo
                  const listElement = document.querySelector('.results-table-container, .empty-state');
                  if (listElement) {
                    if (isListMinimized) {
                      // Quando minimizar, garantir que os estilos inline sejam removidos
                      listElement.style.flex = '';
                      listElement.style.minHeight = '';
                    } else {
                      // Quando expandir, aplicar estilos padrão
                      listElement.style.flex = '1 1 auto';
                      listElement.style.minHeight = '200px';
                    }
                  }
                  
                  if (map && google?.maps) {
                    await tick();
                    setTimeout(() => {
                      if (map && google.maps) {
                        google.maps.event.trigger(map, 'resize');
                      }
                    }, 100);
                  }
                }}
                aria-label={isListMinimized ? 'Expandir tabela' : 'Minimizar tabela'}
                title={isListMinimized ? 'Expandir' : 'Minimizar'}
              >
                {isListMinimized ? '⬆️' : '⬇️'}
              </button>
            </div>
          </div>
          {#if !isListMinimized}
            <div class="table-wrapper">
              <table class="results-table" on:selectstart={preventTextSelection}>
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
                          for (const cto of ctosRua) {
                            const ctoKey = getCTOKey(cto);
                            newVisibility.set(ctoKey, isChecked);
                          }
                          ctoVisibility = newVisibility;
                          ctoNumbersVersion++;
                          await tick();
                          // Atualizar mapa removendo/adicionando marcadores e rotas
                          await updateMapVisibility();
                        }}
                      />
                    </th>
                    <th class:selected={selectedColumns.includes(1)} on:click={(e) => handleColumnHeaderClick(e, 1)}>N°</th>
                    <th class:selected={selectedColumns.includes(2)} on:click={(e) => handleColumnHeaderClick(e, 2)}>CTO</th>
                    <th class:selected={selectedColumns.includes(3)} on:click={(e) => handleColumnHeaderClick(e, 3)}>Status</th>
                    <th class:selected={selectedColumns.includes(4)} on:click={(e) => handleColumnHeaderClick(e, 4)}>Cidade</th>
                    <th class:selected={selectedColumns.includes(5)} on:click={(e) => handleColumnHeaderClick(e, 5)}>POP</th>
                    <th class:selected={selectedColumns.includes(6)} on:click={(e) => handleColumnHeaderClick(e, 6)}>CHASSE</th>
                    <th class:selected={selectedColumns.includes(7)} on:click={(e) => handleColumnHeaderClick(e, 7)}>PLACA</th>
                    <th class:selected={selectedColumns.includes(8)} on:click={(e) => handleColumnHeaderClick(e, 8)}>OLT</th>
                    <th class:selected={selectedColumns.includes(9)} on:click={(e) => handleColumnHeaderClick(e, 9)}>ID CTO</th>
                    <th class:selected={selectedColumns.includes(10)} on:click={(e) => handleColumnHeaderClick(e, 10)}>Data de Criação</th>
                    <th class:selected={selectedColumns.includes(11)} on:click={(e) => handleColumnHeaderClick(e, 11)}>Portas Total</th>
                    <th class:selected={selectedColumns.includes(12)} on:click={(e) => handleColumnHeaderClick(e, 12)}>Ocupadas</th>
                    <th class:selected={selectedColumns.includes(13)} on:click={(e) => handleColumnHeaderClick(e, 13)}>Disponíveis</th>
                    <th class:selected={selectedColumns.includes(14)} on:click={(e) => handleColumnHeaderClick(e, 14)}>Ocupação</th>
                    <th class:selected={selectedColumns.includes(15)} on:click={(e) => handleColumnHeaderClick(e, 15)}>Latitude</th>
                    <th class:selected={selectedColumns.includes(16)} on:click={(e) => handleColumnHeaderClick(e, 16)}>Longitude</th>
                  </tr>
                </thead>
                <tbody>
                  {#each ctosRua as cto, rowIndex}
                    {@const ctoKey = getCTOKey(cto)}
                    {@const isVisible = ctoVisibility.get(ctoKey) !== false}
                    {@const pctOcup = isNaN(parseFloat(cto.pct_ocup)) ? 0 : parseFloat(cto.pct_ocup || 0)}
                    {@const occupationClass = pctOcup < 50 ? 'low' : pctOcup >= 50 && pctOcup < 80 ? 'medium' : 'high'}
                    {@const statusCto = getStatusCTO(cto)}
                    {@const statusCtoUpper = statusCto.toUpperCase().trim()}
                    {@const statusClass = statusCtoUpper === 'ATIVADO' ? 'low' : statusCtoUpper === 'NAO ATIVADO' || statusCtoUpper === 'NÃO ATIVADO' ? 'high' : ''}
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
                    <tr class:row-selected={selectedRows.includes(rowIndex)}>
                      <td class="checkbox-cell" class:cell-selected={selectedCells.includes(cellKey0) || selectedRows.includes(rowIndex) || selectedColumns.includes(0)}>
                        <input 
                          type="checkbox" 
                          checked={isVisible}
                          on:click|stopPropagation={(e) => {
                            e.stopPropagation();
                          }}
                          on:change={async (e) => {
                            const isChecked = e.target.checked;
                            ctoVisibility.set(ctoKey, isChecked);
                            ctoVisibility = ctoVisibility;
                            ctoNumbersVersion++;
                            await tick();
                            // Atualizar mapa removendo/adicionando marcador e rota
                            await updateMapVisibility();
                          }}
                        />
                      </td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey1) || selectedRows.includes(rowIndex) || selectedColumns.includes(1)} on:click={(e) => handleCellClick(e, rowIndex, 1)}>{ctoNumbers.get(cto) || '-'}</td>
                      <td class="cto-name-cell" class:cell-selected={selectedCells.includes(cellKey2) || selectedRows.includes(rowIndex) || selectedColumns.includes(2)} on:click={(e) => handleCellClick(e, rowIndex, 2)}><strong>{cto.nome || ''}</strong></td>
                      <td class:cell-selected={selectedCells.includes(cellKey3) || selectedRows.includes(rowIndex) || selectedColumns.includes(3)} on:click={(e) => handleCellClick(e, rowIndex, 3)}>
                        {#if statusClass}
                          <span class="status-badge {statusClass}">{statusCto}</span>
                        {:else}
                          {statusCto}
                        {/if}
                      </td>
                      <td class:cell-selected={selectedCells.includes(cellKey4) || selectedRows.includes(rowIndex) || selectedColumns.includes(4)} on:click={(e) => handleCellClick(e, rowIndex, 4)}>{cto.cidade || 'N/A'}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey5) || selectedRows.includes(rowIndex) || selectedColumns.includes(5)} on:click={(e) => handleCellClick(e, rowIndex, 5)}>{cto.pop || 'N/A'}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey6) || selectedRows.includes(rowIndex) || selectedColumns.includes(6)} on:click={(e) => handleCellClick(e, rowIndex, 6)}>{cto.olt || 'N/A'}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey7) || selectedRows.includes(rowIndex) || selectedColumns.includes(7)} on:click={(e) => handleCellClick(e, rowIndex, 7)}>{cto.slot || 'N/A'}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey8) || selectedRows.includes(rowIndex) || selectedColumns.includes(8)} on:click={(e) => handleCellClick(e, rowIndex, 8)}>{cto.pon || 'N/A'}</td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey9) || selectedRows.includes(rowIndex) || selectedColumns.includes(9)} on:click={(e) => handleCellClick(e, rowIndex, 9)}>{cto.id_cto || cto.id || 'N/A'}</td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey10) || selectedRows.includes(rowIndex) || selectedColumns.includes(10)} on:click={(e) => handleCellClick(e, rowIndex, 10)}>{formatDataCriacao(cto)}</td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey11) || selectedRows.includes(rowIndex) || selectedColumns.includes(11)} on:click={(e) => handleCellClick(e, rowIndex, 11)}>{cto.vagas_total || 0}</td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey12) || selectedRows.includes(rowIndex) || selectedColumns.includes(12)} on:click={(e) => handleCellClick(e, rowIndex, 12)}>{cto.clientes_conectados || 0}</td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey13) || selectedRows.includes(rowIndex) || selectedColumns.includes(13)} on:click={(e) => handleCellClick(e, rowIndex, 13)}>{(cto.vagas_total || 0) - (cto.clientes_conectados || 0)}</td>
                      <td class:cell-selected={selectedCells.includes(cellKey14) || selectedRows.includes(rowIndex) || selectedColumns.includes(14)} on:click={(e) => handleCellClick(e, rowIndex, 14)}>
                        <span class="occupation-badge {occupationClass}">{(pctOcup || 0).toFixed(1)}%</span>
                      </td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey15) || selectedRows.includes(rowIndex) || selectedColumns.includes(15)} on:click={(e) => handleCellClick(e, rowIndex, 15)}>{cto.latitude || ''}</td>
                      <td class="numeric" class:cell-selected={selectedCells.includes(cellKey16) || selectedRows.includes(rowIndex) || selectedColumns.includes(16)} on:click={(e) => handleCellClick(e, rowIndex, 16)}>{cto.longitude || ''}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>
      {:else if !isLoading && !error}
        <div class="empty-state" class:minimized={isListMinimized} style="flex: {isListMinimized ? '0 0 auto' : '1 1 auto'}; min-height: {isListMinimized ? '60px' : '200px'};">
          <div class="table-header">
            <h3>Tabela de Equipamentos Encontrados - Nenhum Equipamento Pesquisado</h3>
            <div class="table-header-buttons">
              <button 
                class="minimize-button" 
                disabled={isResizingSidebar || isResizingMapTable}
                on:click={async () => {
                  isListMinimized = !isListMinimized;
                  
                  // Limpar estilos inline para respeitar o estado reativo
                  const listElement = document.querySelector('.results-table-container, .empty-state');
                  if (listElement) {
                    if (isListMinimized) {
                      // Quando minimizar, garantir que os estilos inline sejam removidos
                      listElement.style.flex = '';
                      listElement.style.minHeight = '';
                    } else {
                      // Quando expandir, aplicar estilos padrão
                      listElement.style.flex = '1 1 auto';
                      listElement.style.minHeight = '200px';
                    }
                  }
                  
                  if (map && google?.maps) {
                    await tick();
                    setTimeout(() => {
                      if (map && google.maps) {
                        google.maps.event.trigger(map, 'resize');
                      }
                    }, 100);
                  }
                }}
                aria-label={isListMinimized ? 'Expandir tabela' : 'Minimizar tabela'}
                title={isListMinimized ? 'Expandir' : 'Minimizar'}
              >
                {isListMinimized ? '⬆️' : '⬇️'}
              </button>
            </div>
          </div>
          {#if !isListMinimized}
            <p>🔍 Localize um cliente para ver os equipamentos encontrados aqui</p>
          {/if}
        </div>
      {/if}
    </main>
  </div>
</div>
{/if}
<!-- Fim do bloco {:else} do loading -->

<!-- Modal de Relatório -->
{#if showReportModal}
  <div 
    class="modal-overlay" 
    role="dialog"
    tabindex="-1"
  >
    <!-- Mensagem de pop-up bloqueado sobreposta ao modal -->
    {#if showPopupInstructions}
      <div 
        class="popup-instructions-overlay" 
        on:click|stopPropagation
        on:keydown={(e) => e.key === 'Enter' && e.stopPropagation()}
        role="dialog"
        tabindex="0"
        aria-modal="true"
      >
        <div class="popup-instructions">
          <div class="popup-instructions-header">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="#FF9800"/>
            </svg>
            <h3>Pop-ups bloqueados pelo navegador</h3>
          </div>
          <div class="popup-instructions-content">
            <p>Para gerar o PDF, é necessário permitir pop-ups para este site.</p>
            <div class="popup-instructions-steps">
              <h4>Como permitir pop-ups:</h4>
              <div class="instruction-step">
                <strong>Chrome/Edge:</strong>
                <ol>
                  <li>Clique no ícone de bloqueio de pop-ups na barra de endereços</li>
                  <li>Selecione "Sempre permitir pop-ups e redirecionamentos"</li>
                  <li>Clique em "Concluído"</li>
                  <li>Tente gerar o PDF novamente</li>
                </ol>
              </div>
              <div class="instruction-step">
                <strong>Firefox:</strong>
                <ol>
                  <li>Clique no ícone de bloqueio na barra de endereços</li>
                  <li>Marque "Permitir pop-ups"</li>
                  <li>Tente gerar o PDF novamente</li>
                </ol>
              </div>
              <div class="instruction-step">
                <strong>Safari:</strong>
                <ol>
                  <li>Vá em Safari → Preferências → Sites</li>
                  <li>Selecione "Pop-ups" no menu lateral</li>
                  <li>Encontre este site e selecione "Permitir"</li>
                  <li>Tente gerar o PDF novamente</li>
                </ol>
              </div>
            </div>
            <button class="popup-instructions-close" on:click={() => showPopupInstructions = false}>
              Entendi, fechar
            </button>
          </div>
        </div>
      </div>
    {/if}
    
    <div 
      class="modal-content" 
      on:click|stopPropagation
      on:keydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div class="modal-header">
        <h2 id="modal-title">Preencher Relatório</h2>
        <button class="modal-close" on:click={closeReportModal} aria-label="Fechar modal">×</button>
      </div>

      <div class="modal-body">
        <form on:submit|preventDefault={exportToPDF}>
          <!-- 1. Número do ALA -->
          <div class="form-group">
            <label for="numeroALA">1. Número do ALA <span class="required">*</span></label>
            <input 
              type="text" 
              id="numeroALA"
              value={reportForm.numeroALA}
              on:input={handleNumeroALAInput}
              placeholder="Digite apenas números"
              class:error={reportFormErrors.numeroALA}
            />
            {#if reportFormErrors.numeroALA}
              <span class="error-message">{reportFormErrors.numeroALA}</span>
            {/if}
          </div>

          <!-- 2. Cidade -->
          <div class="form-group">
            <label for="cidade">2. Cidade <span class="required">*</span></label>
            <input 
              type="text" 
              id="cidade"
              bind:value={reportForm.cidade}
              on:input={() => validateField('cidade')}
              placeholder="Cidade"
              class:error={reportFormErrors.cidade}
            />
            {#if reportFormErrors.cidade}
              <span class="error-message">{reportFormErrors.cidade}</span>
            {/if}
          </div>

          <!-- 3. Endereço Completo -->
          <div class="form-group">
            <label for="enderecoCompleto">3. Endereço Completo <span class="required">*</span></label>
            <input 
              type="text" 
              id="enderecoCompleto"
              bind:value={reportForm.enderecoCompleto}
              on:input={() => validateField('enderecoCompleto')}
              placeholder="Endereço completo"
              class:error={reportFormErrors.enderecoCompleto}
            />
            {#if reportFormErrors.enderecoCompleto}
              <span class="error-message">{reportFormErrors.enderecoCompleto}</span>
            {/if}
          </div>

          <!-- 4. Número do Endereço -->
          <div class="form-group">
            <label for="numeroEndereco">4. Número do Endereço <span class="required">*</span></label>
            <input 
              type="text" 
              id="numeroEndereco"
              bind:value={reportForm.numeroEndereco}
              on:input={() => validateField('numeroEndereco')}
              placeholder="Número do endereço"
              class:error={reportFormErrors.numeroEndereco}
            />
            {#if reportFormErrors.numeroEndereco}
              <span class="error-message">{reportFormErrors.numeroEndereco}</span>
            {/if}
          </div>

          <!-- 5. CEP do Endereço -->
          <div class="form-group">
            <label for="cep">5. CEP do Endereço <span class="required">*</span></label>
            <input 
              type="text" 
              id="cep"
              bind:value={reportForm.cep}
              on:input={() => validateField('cep')}
              placeholder="CEP"
              class:error={reportFormErrors.cep}
            />
            {#if reportFormErrors.cep}
              <span class="error-message">{reportFormErrors.cep}</span>
            {/if}
          </div>

          <!-- 6. Tabulação Final -->
          <div class="form-group">
            <label for="tabulacaoFinal">6. Tabulação Final <span class="required">*</span></label>
            <select 
              id="tabulacaoFinal"
              bind:value={reportForm.tabulacaoFinal}
              on:change={() => validateField('tabulacaoFinal')}
              class:error={reportFormErrors.tabulacaoFinal}
            >
              <option value="" disabled>Selecione uma opção</option>
              {#each tabulacoesList as tabulacao}
                <option value={tabulacao}>{tabulacao}</option>
              {/each}
            </select>
            {#if reportFormErrors.tabulacaoFinal}
              <span class="error-message">{reportFormErrors.tabulacaoFinal}</span>
            {/if}
          </div>

          <!-- 7. Projetista -->
          <div class="form-group">
            <label for="projetista">7. Projetista <span class="required">*</span></label>
            <input 
              type="text" 
              id="projetista"
              bind:value={reportForm.projetista}
              readonly
              class:error={reportFormErrors.projetista}
              style="background-color: #f5f5f5; cursor: not-allowed;"
            />
            {#if reportFormErrors.projetista}
              <span class="error-message">{reportFormErrors.projetista}</span>
            {/if}
          </div>

          <!-- 8. Prévia do Mapa -->
          <div class="form-group">
            <label for="map-preview-area">8. Prévia do Mapa <span class="required">*</span></label>
            <div class="map-preview-container">
              {#if capturingMap}
                <div class="preview-loading">
                  <div class="loading-spinner"></div>
                  <p style="text-align: center; color: #7B68EE; margin-top: 1rem; font-weight: 600;">
                    Capturando mapa...
                  </p>
                </div>
              {:else if mapPreviewImage}
                <div class="preview-image-wrapper">
                  <img src={mapPreviewImage} alt="Prévia do Mapa" class="preview-image" />
                </div>
                <p style="font-size: 0.85rem; color: #666; margin-top: 0.5rem; font-style: italic; text-align: center;">
                  O mapa foi capturado automaticamente com todas as CTOs encontradas e suas rotas visíveis.
                </p>
              {:else}
                <div class="preview-error">
                  <p style="text-align: center; color: #F44336; padding: 2rem;">
                    ⚠️ Erro ao capturar mapa. Por favor, feche e abra o modal novamente.
                  </p>
                </div>
              {/if}
              
              {#if Object.keys(reportFormErrors).length > 0}
                {@const missingFields = getMissingRequiredFields()}
                {#if missingFields.length > 0}
                  <div style="margin-top: 1rem; padding: 0.75rem; background-color: #ffebee; border: 1px solid #F44336; border-radius: 4px;">
                    <p style="color: #F44336; font-weight: 600; margin: 0 0 0.5rem 0; font-size: 0.9rem;">
                      ⚠️ Campos obrigatórios não preenchidos:
                    </p>
                    <ul style="color: #F44336; margin: 0; padding-left: 1.5rem; font-size: 0.85rem;">
                      {#each missingFields as field}
                        <li style="margin-bottom: 0.25rem;">{field}</li>
                      {/each}
                    </ul>
                  </div>
                {/if}
              {/if}
            </div>
          </div>

          <div class="modal-actions">
            <button type="button" class="btn-cancel" on:click={closeReportModal}>Cancelar</button>
            <button type="submit" class="btn-submit" disabled={generatingPDF}>
              {generatingPDF ? '⏳ Gerando PDF...' : 'Gerar Relatório'}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
{/if}

<!-- Modal de Trocar Senha do Usuário -->
{#if showChangePasswordModal}
  <div 
    class="modal-overlay" 
    role="dialog"
    tabindex="-1"
  >
    <div 
      class="modal-content add-projetista-modal" 
      on:click|stopPropagation
      on:keydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="change-password-title"
    >
      <div class="modal-header">
        <h2 id="change-password-title">Alterar Dados - {currentUser}</h2>
        <button class="modal-close" on:click={closeChangePasswordModal} aria-label="Fechar modal">×</button>
      </div>

      <div class="modal-body">
        <!-- Seção de Alterar Nome -->
        <div style="margin-bottom: 2rem; padding-bottom: 2rem; border-bottom: 1px solid #e0e0e0;">
          <h3 class="settings-section-title">Alterar Nome do Usuário</h3>
          <form on:submit|preventDefault={changeUserName}>
            <div class="form-group">
              <label for="newUserName">Novo Nome <span class="required">*</span></label>
              <input 
                type="text" 
                id="newUserName"
                bind:value={newUserName}
                placeholder="Digite o novo nome"
                required
                class:error={changeUserNameError && !newUserName.trim()}
              />
            </div>

            {#if changeUserNameError}
              <div class="error-message-modal">
                {changeUserNameError}
              </div>
            {/if}

            {#if changeUserNameSuccess}
              <div class="success-message-modal">
                ✅ Nome alterado com sucesso!
              </div>
            {/if}

            <div class="modal-actions" style="margin-top: 1rem;">
              <button type="submit" class="btn-add-confirm">
                Alterar Nome
              </button>
            </div>
          </form>
        </div>

        <!-- Seção de Alterar Senha -->
        <div>
          <h3 class="settings-section-title">Alterar Senha</h3>
          <form on:submit|preventDefault={changeUserPassword}>
            <div class="form-group">
              <label for="newPasswordUser">Nova Senha <span class="required">*</span></label>
            <div class="password-input-wrapper">
              {#if showChangePassword}
                <input 
                  type="text"
                  id="newPasswordUser"
                  bind:value={newPassword}
                  placeholder="Digite a nova senha"
                  required
                  class:error={changePasswordError && !newPassword.trim()}
                />
              {:else}
                <input 
                  type="password"
                  id="newPasswordUser"
                  bind:value={newPassword}
                  placeholder="Digite a nova senha"
                  required
                  class:error={changePasswordError && !newPassword.trim()}
                />
              {/if}
              <button 
                type="button"
                class="password-toggle"
                on:click={() => showChangePassword = !showChangePassword}
                aria-label={showChangePassword ? 'Ocultar senha' : 'Mostrar senha'}
                title={showChangePassword ? 'Ocultar senha' : 'Mostrar senha'}
              >
                {#if showChangePassword}
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {:else}
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label for="confirmPasswordUser">Confirmar Nova Senha <span class="required">*</span></label>
            <div class="password-input-wrapper">
              {#if showConfirmPassword}
                <input 
                  type="text"
                  id="confirmPasswordUser"
                  bind:value={confirmPassword}
                  placeholder="Digite a senha novamente"
                  required
                  class:error={changePasswordError && newPassword !== confirmPassword}
                />
              {:else}
                <input 
                  type="password"
                  id="confirmPasswordUser"
                  bind:value={confirmPassword}
                  placeholder="Digite a senha novamente"
                  required
                  class:error={changePasswordError && newPassword !== confirmPassword}
                />
              {/if}
              <button 
                type="button"
                class="password-toggle"
                on:click={() => showConfirmPassword = !showConfirmPassword}
                aria-label={showConfirmPassword ? 'Ocultar senha' : 'Mostrar senha'}
                title={showConfirmPassword ? 'Ocultar senha' : 'Mostrar senha'}
              >
                {#if showConfirmPassword}
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {:else}
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {/if}
              </button>
            </div>
          </div>

          {#if changePasswordError}
            <div class="error-message-modal">
              {changePasswordError}
            </div>
          {/if}

          {#if changePasswordSuccess}
            <div class="success-message-modal">
              ✅ Senha alterada com sucesso!
            </div>
          {/if}

          <div class="modal-actions" style="margin-top: 1rem;">
            <button type="button" class="btn-cancel" on:click={closeChangePasswordModal}>Fechar</button>
            <button type="submit" class="btn-add-confirm">
              Alterar Senha
            </button>
          </div>
        </form>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Modal para Adicionar Projetista -->
{#if showAddProjetistaModal}
  <div 
    class="modal-overlay" 
    on:click={closeAddProjetistaModal}
    on:keydown={(e) => e.key === 'Escape' && closeAddProjetistaModal()}
    role="button"
    tabindex="-1"
    aria-label="Fechar modal"
  >
    <div 
      class="modal-content add-projetista-modal" 
      on:click|stopPropagation
      on:keydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="add-projetista-title"
    >
      <div class="modal-header">
        <h2 id="add-projetista-title">Adicionar Projetista</h2>
        <button class="modal-close" on:click={closeAddProjetistaModal} aria-label="Fechar modal">×</button>
      </div>

      <div class="modal-body">
        <div class="form-group">
          <label for="newProjetistaName">Nome do Projetista <span class="required">*</span></label>
          <input 
            type="text" 
            id="newProjetistaName"
            bind:value={newProjetistaName}
            placeholder="Digite o nome do projetista"
            on:keydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addProjetista();
              }
            }}
          />
        </div>

        <div class="modal-actions">
          <button type="button" class="btn-cancel" on:click={closeAddProjetistaModal}>Cancelar</button>
          <button type="button" class="btn-submit" on:click={addProjetista} disabled={!newProjetistaName.trim()}>
            Adicionar
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Modal para Adicionar Tabulação -->
{#if showAddTabulacaoModal}
  <div 
    class="modal-overlay" 
    on:click={closeAddTabulacaoModal}
    on:keydown={(e) => e.key === 'Escape' && closeAddTabulacaoModal()}
    role="button"
    tabindex="-1"
    aria-label="Fechar modal"
  >
    <div 
      class="modal-content add-projetista-modal" 
      on:click|stopPropagation
      on:keydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="add-tabulacao-title"
    >
      <div class="modal-header">
        <h2 id="add-tabulacao-title">Adicionar Tabulação</h2>
        <button class="modal-close" on:click={closeAddTabulacaoModal} aria-label="Fechar modal">×</button>
      </div>

      <div class="modal-body">
        <div class="form-group">
          <label for="newTabulacaoName">Nome da Tabulação <span class="required">*</span></label>
          <input 
            type="text" 
            id="newTabulacaoName"
            bind:value={newTabulacaoName}
            placeholder="Digite o nome da tabulação"
            on:keydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTabulacao();
              }
            }}
          />
        </div>

        <div class="modal-actions">
          <button type="button" class="btn-cancel" on:click={closeAddTabulacaoModal}>Cancelar</button>
          <button type="button" class="btn-submit" on:click={addTabulacao} disabled={!newTabulacaoName.trim()}>
            Adicionar
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Tela de Configurações -->
{#if showSettingsModal}
    <Config 
      onClose={closeSettingsModal}
      onReloadCTOs={reloadCTOsData}
      onUpdateProjetistas={(list) => { projetistasList = list; }}
      onUpdateTabulacoes={(list) => { tabulacoesList = list; }}
      baseDataExists={baseDataExists}
      userTipo={userTipo}
      currentUser={currentUser}
    />
{/if}

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  }

  .loading-fullscreen {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100vw;
    height: 100vh;
    z-index: 10000;
  }

  .viabilidade-content {
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
    gap: 0.75rem;
    padding: 1rem;
    padding-bottom: 1.75rem;
    overflow: hidden;
    align-items: flex-start;
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
    flex: 0 0 auto;
    height: calc(100% - 2.75rem);
    box-sizing: border-box;
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

  .map-header .minimize-button {
    position: relative;
    z-index: 10001;
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

  .resize-handle {
    flex-shrink: 0;
    background: transparent;
    transition: background 0.2s;
    z-index: 10;
  }

  .resize-handle-vertical {
    width: 8px;
    cursor: col-resize;
    margin: 0 -4px;
  }

  .resize-handle-vertical:hover {
    background: rgba(123, 104, 238, 0.2);
  }

  .resize-handle-vertical.resizing {
    background: rgba(123, 104, 238, 0.4);
  }

  .resize-handle-horizontal {
    height: 8px;
    cursor: row-resize;
    margin: -4px 0;
  }

  .resize-handle-horizontal:hover {
    background: rgba(123, 104, 238, 0.2);
  }

  .resize-handle-horizontal.resizing {
    background: rgba(123, 104, 238, 0.4);
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

  .map-container {
    background: white;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    isolation: isolate;
  }

  .map-container.minimized {
    min-height: 60px !important;
    height: auto !important;
    flex: 0 0 auto !important;
    overflow: hidden !important;
  }
  
  .map-container.minimized .map-header {
    flex-shrink: 0 !important;
    height: auto !important;
    min-height: auto !important;
    max-height: none !important;
    display: flex !important;
    visibility: visible !important;
    padding: 1rem 1.5rem !important;
    background: #f9fafb !important;
    border-bottom: none !important;
    position: relative !important;
    z-index: 10000 !important;
  }
  
  .map-container.minimized .map-header h3 {
    display: block !important;
    visibility: visible !important;
  }
  
  .map-container.minimized .map-header .minimize-button {
    display: block !important;
    visibility: visible !important;
  }
  
  .map-container.minimized .map {
    display: none !important;
    visibility: hidden !important;
    height: 0 !important;
    min-height: 0 !important;
    overflow: hidden !important;
  }
  
  .map-container.minimized .map-header {
    display: flex !important;
    visibility: visible !important;
    height: auto !important;
    min-height: auto !important;
  }

  .map-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e5e7eb;
    background: #f9fafb;
    position: relative;
    z-index: 10000;
  }

  .map-header h3 {
    margin: 0;
    color: #4c1d95;
    font-size: 1.25rem;
    font-weight: 600;
    position: relative;
    z-index: 10001;
  }

  .map-container.minimized .map-header {
    border-bottom: none;
    display: flex !important;
    visibility: visible !important;
    height: auto !important;
    min-height: auto !important;
    padding: 1rem 1.5rem !important;
    background: #f9fafb !important;
    position: relative !important;
    z-index: 10000 !important;
  }
  
  .map-container.minimized .map-header h3 {
    display: block !important;
    visibility: visible !important;
  }
  
  .map-container.minimized .map-header .minimize-button {
    display: block !important;
    visibility: visible !important;
  }

  .map {
    flex: 1;
    min-height: 300px;
    width: 100%;
    height: 100%;
    position: relative;
    z-index: 1;
  }

  .map.hidden {
    display: none !important;
    visibility: hidden !important;
    height: 0 !important;
    min-height: 0 !important;
    overflow: hidden !important;
  }

  .results-table-container {
    background: white;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    min-height: 200px;
    overflow: visible;
    flex: 1 1 auto;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }

  .results-table-container.minimized {
    padding: 1rem 1.5rem;
    overflow: hidden;
  }

  .results-table-container.minimized .table-header {
    margin-bottom: 0;
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


  .table-wrapper {
    overflow-y: auto;
    overflow-x: auto;
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    -webkit-overflow-scrolling: touch;
  }

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
    user-select: none;
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
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    cursor: cell;
    white-space: nowrap; /* Evitar quebra de linha - manter conteúdo em uma única linha */
  }

  .results-table .cto-name-cell {
    white-space: nowrap;
    min-width: 150px;
    text-align: center;
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    cursor: cell;
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

  .results-table th.selected {
    background-color: rgba(100, 149, 237, 0.2) !important;
    border-bottom: 2px solid #6495ED !important;
  }

  .results-table tbody tr.row-selected {
    background-color: rgba(100, 149, 237, 0.1) !important;
  }

  .results-table tbody tr.row-selected:hover {
    background-color: rgba(100, 149, 237, 0.15) !important;
  }

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

  /* Estilos para badge de Status */
  .status-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-weight: 600;
    font-size: 0.8125rem;
    white-space: nowrap; /* Evitar quebra de linha */
    display: inline-block; /* Garantir que o badge não quebre */
  }

  .status-badge.low {
    background: #dcfce7;
    color: #166534;
  }

  .status-badge.high {
    background: #fee2e2;
    color: #991b1b;
  }

  /* Garantir que a célula de Status não quebre linha */
  .results-table td:nth-child(4) {
    white-space: nowrap;
  }

  /* Garantir que a célula de Cidade não quebre linha */
  .results-table td:nth-child(5) {
    white-space: nowrap;
  }

  .empty-state {
    background: white;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    padding: 1.5rem;
    color: #6b7280;
    flex: 1 1 auto;
    min-height: 200px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    width: 100%;
    max-width: 100%;
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

  .error-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    padding: 2rem;
    text-align: center;
  }

  .error-container h2 {
    color: #7B68EE;
    margin-bottom: 1rem;
  }

  .error-container button {
    background: linear-gradient(135deg, #7B68EE 0%, #6B5BEE 100%);
    color: white;
    border: none;
    border-radius: 8px;
    padding: 0.75rem 1.5rem;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    margin-top: 1rem;
  }

  .error-container button:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(123, 104, 238, 0.3);
  }

  /* Estilos antigos mantidos para compatibilidade com Viabilidade */
  .app-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    position: relative;
  }

  .app-container::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(135deg, rgba(123, 104, 238, 0.7) 0%, rgba(100, 149, 237, 0.7) 100%);
    z-index: 0;
  }

  .app-container > * {
    position: relative;
    z-index: 1;
  }

  header {
    background: linear-gradient(135deg, rgba(123, 104, 238, 0.95) 0%, rgba(100, 149, 237, 0.95) 100%);
    color: white;
    padding: 1rem 2rem;
    box-shadow: 0 4px 6px rgba(0,0,0,0.2);
    backdrop-filter: blur(10px);
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: relative;
    z-index: 1000;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .back-button {
    background: rgba(255, 255, 255, 0.15);
    border: 1.5px solid rgba(255, 255, 255, 0.25);
    border-radius: 10px;
    padding: 0.625rem;
    cursor: pointer;
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    backdrop-filter: blur(10px);
  }

  .back-button:hover {
    background: rgba(255, 255, 255, 0.25);
    border-color: rgba(255, 255, 255, 0.4);
    transform: translateX(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .back-button:active {
    transform: translateX(0);
  }

  header h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }


  .search-section {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .form-group {
    margin-bottom: 1rem;
  }

  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: #4c1d95;
    font-size: 0.875rem;
  }

  .form-group input {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 1rem;
    box-sizing: border-box;
  }

  .form-group input:focus {
    outline: none;
    border-color: #7B68EE;
    box-shadow: 0 0 0 3px rgba(123, 104, 238, 0.1);
  }

  .search-button {
    width: 100%;
    padding: 0.75rem;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s;
    box-shadow: 0 4px 6px rgba(123, 104, 238, 0.3);
    margin-bottom: 0.25rem;
  }
  
  .generate-report-button {
    margin-top: -0.5rem;
    margin-bottom: 0.75rem;
  }

  .search-button:hover:not(:disabled) {
    background: linear-gradient(135deg, #9370DB 0%, #7B9EE8 100%);
    transform: translateY(-2px);
    box-shadow: 0 6px 12px rgba(123, 104, 238, 0.4);
  }

  .search-button:disabled {
    background: #ccc;
    cursor: not-allowed;
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

  /* Popup de informações da rota */
  .route-popup {
    position: fixed;
    z-index: 1000;
    pointer-events: none;
  }

  .route-popup-content {
    background: white;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    padding: 1rem;
    min-width: 250px;
    pointer-events: all;
    user-select: none;
  }

  .route-popup-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid #e0e0e0;
    user-select: none;
  }
  
  .route-popup-header:active {
    cursor: grabbing;
  }

  .route-popup-header h3 {
    margin: 0;
    font-size: 1.1rem;
    color: #333;
  }

  .route-popup-close {
    background: none;
    border: none;
    font-size: 1.5rem;
    color: #999;
    cursor: pointer;
    padding: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .route-popup-close:hover {
    color: #333;
  }

  .route-popup-info {
    margin-bottom: 0.75rem;
  }

  .route-popup-info p {
    margin: 0.5rem 0;
    font-size: 0.9rem;
    color: #666;
  }

  .route-popup-info strong {
    color: #333;
  }

  .route-popup-actions {
    display: flex;
    gap: 0.5rem;
  }

  .route-popup-button {
    flex: 1;
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 6px;
    font-size: 0.9rem;
    cursor: pointer;
    transition: all 0.3s;
  }

  .route-popup-button.edit {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
  }

  .route-popup-button.edit:hover {
    background: linear-gradient(135deg, #9370DB 0%, #7B9EE8 100%);
    transform: translateY(-1px);
    box-shadow: 0 4px 8px rgba(123, 104, 238, 0.3);
  }

  .route-popup-button.finish {
    background: linear-gradient(135deg, #F44336 0%, #E53935 100%);
    color: white;
  }

  .route-popup-button.finish:hover {
    background: linear-gradient(135deg, #EF5350 0%, #E53935 100%);
    transform: translateY(-1px);
    box-shadow: 0 4px 8px rgba(244, 67, 54, 0.3);
  }

  .error-message {
    margin-top: 1rem;
    padding: 0.75rem;
    background: #ffebee;
    color: #c62828;
    border-radius: 4px;
    border-left: 4px solid #c62828;
  }

  .popup-instructions-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10001;
    padding: 2rem;
  }

  .popup-instructions {
    background: linear-gradient(135deg, #fff3e0 0%, #ffe0b2 100%);
    border: 2px solid #FF9800;
    border-radius: 8px;
    padding: 1.5rem;
    box-shadow: 0 4px 12px rgba(255, 152, 0, 0.2);
    max-width: 600px;
    max-height: 90vh;
    overflow-y: auto;
    position: relative;
  }

  .popup-instructions-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .popup-instructions-header h3 {
    margin: 0;
    color: #E65100;
    font-size: 1.1rem;
    font-weight: 600;
  }

  .popup-instructions-content {
    color: #5D4037;
  }

  .popup-instructions-content > p {
    margin: 0 0 1rem 0;
    font-size: 1rem;
    font-weight: 500;
  }

  .popup-instructions-steps {
    margin: 1rem 0;
  }

  .popup-instructions-steps h4 {
    margin: 0 0 0.75rem 0;
    color: #E65100;
    font-size: 0.95rem;
    font-weight: 600;
  }

  .instruction-step {
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: white;
    border-radius: 6px;
    border-left: 3px solid #FF9800;
  }

  .instruction-step strong {
    display: block;
    margin-bottom: 0.5rem;
    color: #E65100;
    font-size: 0.9rem;
  }

  .instruction-step ol {
    margin: 0.5rem 0 0 1.25rem;
    padding: 0;
  }

  .instruction-step li {
    margin-bottom: 0.4rem;
    font-size: 0.9rem;
    line-height: 1.4;
    color: #5D4037;
  }

  .popup-instructions-close {
    margin-top: 1rem;
    padding: 0.75rem 1.5rem;
    background: linear-gradient(135deg, #FF9800 0%, #F57C00 100%);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s;
    box-shadow: 0 2px 6px rgba(255, 152, 0, 0.3);
  }

  .popup-instructions-close:hover {
    background: linear-gradient(135deg, #F57C00 0%, #E65100 100%);
    transform: translateY(-1px);
    box-shadow: 0 4px 8px rgba(255, 152, 0, 0.4);
  }

  .results-info {
    margin-top: 1rem;
    padding: 0.6rem 1rem;
    background: linear-gradient(135deg, rgba(123, 104, 238, 0.15) 0%, rgba(100, 149, 237, 0.15) 100%);
    border-radius: 8px;
    border-left: 4px solid #7B68EE;
    color: #5A4FCF;
  }
  
  .results-info + .results-info {
    margin-top: 0.25rem;
  }

  .results-info p {
    margin: 0;
    padding: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .results-info strong {
    color: #7B68EE;
  }

  .base-data-warning {
    margin: 1rem;
    padding: 1.25rem;
    background: linear-gradient(135deg, rgba(244, 67, 54, 0.1) 0%, rgba(255, 152, 0, 0.1) 100%);
    border: 2px solid #F44336;
    border-radius: 8px;
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    box-shadow: 0 2px 8px rgba(244, 67, 54, 0.2);
  }

  .warning-icon {
    font-size: 2rem;
    flex-shrink: 0;
    line-height: 1;
  }

  .warning-content h3 {
    margin: 0 0 0.5rem 0;
    color: #F44336;
    font-size: 1.1rem;
    font-weight: 600;
  }

  .warning-content p {
    margin: 0;
    color: #333;
    font-size: 0.95rem;
    line-height: 1.5;
  }

  .info-icon {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1rem;
    padding: 0;
    margin: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    opacity: 0.8;
    transition: all 0.2s ease;
    flex-shrink: 0;
  }

  .info-icon svg {
    width: 100%;
    height: 100%;
    transition: all 0.2s ease;
  }

  .info-icon:hover {
    opacity: 1;
    transform: scale(1.1);
  }

  .info-icon:hover svg {
    filter: brightness(1.1);
  }

  .info-icon:focus {
    outline: 2px solid #7B68EE;
    outline-offset: 2px;
    border-radius: 50%;
  }

  .info-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    animation: fadeIn 0.2s ease;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .info-modal-box {
    background: white;
    border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    max-width: 500px;
    width: 90%;
    max-height: 90vh;
    overflow-y: auto;
    animation: slideUp 0.3s ease;
  }

  @keyframes slideUp {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .info-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.5rem;
    border-bottom: 2px solid #7B68EE;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
  }

  .info-modal-header h3 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .info-modal-close {
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
  }

  .info-modal-close:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .info-modal-body {
    padding: 1.5rem;
  }

  .info-modal-body p {
    margin: 0;
    color: #333;
    line-height: 1.6;
    font-size: 1rem;
  }


  .logout-button {
    padding: 0.625rem 1.125rem;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    box-shadow: 0 2px 6px rgba(123, 104, 238, 0.25);
    font-family: 'Inter', sans-serif;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .logout-button:hover {
    background: linear-gradient(135deg, #6B5BEE 0%, #5A8FE8 100%);
    transform: translateY(-1px);
    box-shadow: 0 4px 10px rgba(123, 104, 238, 0.35);
  }

  .logout-button:active {
    transform: translateY(0);
    box-shadow: 0 2px 4px rgba(123, 104, 238, 0.3);
  }




  /* Modal de Relatório */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 20px;
  }

  .modal-content {
    background: white;
    border-radius: 12px;
    max-width: 600px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.5rem;
    border-bottom: 2px solid #7B68EE;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }

  .modal-close {
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
  }

  .modal-close:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .modal-body {
    padding: 1.5rem;
  }

  .form-group {
    margin-bottom: 1.5rem;
  }

  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 600;
    color: #333;
    font-size: 0.95rem;
  }

  .required {
    color: #F44336;
  }

  .form-group input,
  .form-group select {
    width: 100%;
    padding: 0.75rem;
    border: 2px solid #ddd;
    border-radius: 6px;
    font-size: 1rem;
    font-family: 'Inter', sans-serif;
    transition: border-color 0.3s;
    box-sizing: border-box;
  }

  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: #7B68EE;
    box-shadow: 0 0 0 3px rgba(123, 104, 238, 0.1);
  }

  .form-group input.error,
  .form-group select.error {
    border-color: #F44336;
  }

  .error-message {
    display: block;
    color: #F44336;
    font-size: 0.85rem;
    margin-top: 0.25rem;
  }

  /* Box informativo de cobertura */
  .coverage-info-box {
    margin-top: 1rem;
    padding: 1rem;
    background: linear-gradient(135deg, #fff3cd 0%, #ffeaa7 100%);
    border: 2px solid #ffc107;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(255, 193, 7, 0.2);
  }

  .coverage-info-box-success {
    background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%);
    border-color: #28A745;
    box-shadow: 0 2px 8px rgba(40, 167, 69, 0.2);
  }

  .coverage-info-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .coverage-info-icon {
    font-size: 1.25rem;
    flex-shrink: 0;
  }

  .coverage-info-title {
    font-weight: 600;
    font-size: 0.95rem;
    color: #856404;
    flex: 1; /* Ocupar espaço disponível para empurrar o botão para a direita */
  }

  .coverage-info-header .info-icon {
    margin-left: auto; /* Empurrar o botão para a direita */
    flex-shrink: 0;
  }

  /* Botão informativo no box "Fora da Área de Cobertura" - usar cor amarela */
  .coverage-info-box .coverage-info-header .info-icon svg circle {
    fill: #ffc107;
    stroke: #ffc107;
  }

  .coverage-info-box .coverage-info-header .info-icon:focus {
    outline: 2px solid #ffc107;
    outline-offset: 2px;
    border-radius: 50%;
  }

  /* Botão informativo no box "Fora do Limite" - usar cor laranja */
  .coverage-info-box-warning .coverage-info-header .info-icon svg circle {
    fill: #FF9800;
    stroke: #FF9800;
  }

  .coverage-info-box-warning .coverage-info-header .info-icon:focus {
    outline: 2px solid #FF9800;
    outline-offset: 2px;
    border-radius: 50%;
  }

  .coverage-info-box-success .coverage-info-title {
    color: #155724;
  }

  .coverage-info-content {
    margin-top: 0.5rem;
  }

  .coverage-info-content p {
    margin: 0;
    font-size: 0.875rem;
    color: #856404;
    line-height: 1.5;
  }

  .coverage-info-box-success .coverage-info-content p {
    color: #155724;
  }

  .coverage-info-content strong {
    font-weight: 700;
    color: #856404;
  }

  .coverage-info-box-success .coverage-info-content strong {
    color: #155724;
  }

  .coverage-info-box-warning {
    background: linear-gradient(135deg, #ffe0b2 0%, #ffcc80 100%);
    border-color: #FF9800;
    box-shadow: 0 2px 8px rgba(255, 152, 0, 0.2);
  }

  .coverage-info-box-warning .coverage-info-title {
    color: #E65100;
  }

  .coverage-info-box-warning .coverage-info-content p {
    color: #E65100;
  }

  .coverage-info-box-warning .coverage-info-content strong {
    color: #E65100;
  }

  .password-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .password-input-wrapper input {
    padding-right: 3rem;
  }

  .password-toggle {
    position: absolute;
    right: 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #718096;
    transition: all 0.2s ease;
  }

  .password-toggle:hover {
    color: #7B68EE;
  }

  .password-toggle svg {
    width: 20px;
    height: 20px;
  }

  .error-message-modal {
    background: #ffebee;
    border: 1px solid #F44336;
    color: #C53030;
    padding: 0.75rem;
    border-radius: 6px;
    font-size: 0.875rem;
    margin-bottom: 1rem;
  }

  .success-message-modal {
    background: #e8f5e9;
    border: 1px solid #4caf50;
    color: #2e7d32;
    padding: 0.75rem;
    border-radius: 6px;
    font-size: 0.875rem;
    margin-bottom: 1rem;
    font-weight: 500;
  }

  .modal-actions {
    display: flex;
    gap: 1rem;
    justify-content: flex-end;
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid #ddd;
  }

  .btn-cancel,
  .btn-submit {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s;
    font-family: 'Inter', sans-serif;
  }

  .btn-cancel {
    background: #e0e0e0;
    color: #333;
  }

  .btn-cancel:hover {
    background: #d0d0d0;
  }

  .btn-submit {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
  }

  .btn-submit:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(123, 104, 238, 0.4);
  }

  /* Estilos para prévia do mapa */
  .map-preview-container {
    width: 100%;
    margin-top: 0.5rem;
  }

  .preview-image-wrapper {
    position: relative;
    display: inline-block;
    width: auto;
    max-width: 100%;
    border: 2px solid #ddd;
    border-radius: 6px;
    overflow: hidden;
    background: #f9f9f9;
  }

  .preview-image {
    display: block;
    width: auto;
    height: auto;
    max-width: 100%;
  }



  .preview-loading {
    padding: 3rem 2rem;
    text-align: center;
    background: #f5f5f5;
    border: 2px dashed #ddd;
    border-radius: 6px;
  }

  .loading-spinner {
    border: 4px solid #f3f3f3;
    border-top: 4px solid #7B68EE;
    border-radius: 50%;
    width: 40px;
    height: 40px;
    animation: spin 1s linear infinite;
    margin: 0 auto;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .preview-error {
    padding: 2rem;
    background: #ffebee;
    border: 2px solid #F44336;
    border-radius: 6px;
  }

  .add-projetista-modal {
    max-width: 400px;
  }

  .settings-section-title {
    color: #7B68EE;
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0 0 1.5rem 0;
    padding-bottom: 0.75rem;
    border-bottom: 2px solid #7B68EE;
  }

  .btn-add-confirm {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.75rem 1.5rem;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: 'Inter', sans-serif;
  }

  .btn-add-confirm:hover {
    background: linear-gradient(135deg, #8B7AE8 0%, #7499F0 100%);
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(123, 104, 238, 0.3);
  }

  .btn-add-confirm:active {
    transform: translateY(0);
  }
</style>
