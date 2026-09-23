<script>
  import { onMount, onDestroy } from 'svelte';
  import { getApiUrl } from '../config.js';

  // Props do componente
  export let currentUser = '';
  export let userTipo = 'user';
  export let onBackToDashboard = () => {};
  export let onSettingsRequest = null;
  export let onSettingsHover = null;

  // Estados da ferramenta
  let isLoading = false;
  let loadingMessage = '';
  let showSettingsModal = false;
  
  // Estados do dashboard
  let activeReport = 'stats'; // 'stats' ou 'timeline'
  let showPeriodModal = false; // Controla abertura do modal de período
  let dateFilterMode = 'single'; // 'single' ou 'range'
  let selectedStartDate = null; // Data inicial selecionada
  let selectedEndDate = null; // Data final selecionada (null se for seleção única)
  let calendarMonth = new Date().getMonth(); // Mês atual do calendário (0-11)
  let calendarYear = new Date().getFullYear(); // Ano atual do calendário
  
  // Dados das APIs
  let statsData = {
    stats: [],
    total: 0
  };
  let timelineData = {
    timeline: [],
    total: 0,
    period: 'DIA'
  };
  
  // Dados processados para os gráficos (reativos)
  $: pieChartData = getPieChartData(statsData.stats, statsData.total);
  $: lineChartData = getLineChartData(timelineData.timeline);
  
  // Estados de loading específicos
  let loadingStats = false;
  let loadingTimeline = false;
  let error = null;
  
  // Estados do upload
  let uploadingFile = false;
  let uploadProgress = 0;
  let uploadError = null;
  let uploadSuccess = false;
  let selectedFile = null;
  
  // Intervalo para atualização automática
  let refreshInterval = null;
  const REFRESH_INTERVAL_MS = 60000; // 1 minuto

  // Função para abrir configurações
  function openSettings() {
    showSettingsModal = true;
  }

  // Função para pré-carregar configurações no hover
  function preloadSettingsData() {
    // Pré-carregar dados se necessário
  }
  
  // Função para fechar configurações
  function closeSettingsModal() {
    showSettingsModal = false;
    uploadError = null;
    uploadSuccess = false;
    selectedFile = null;
    uploadProgress = 0;
  }
  
  // Função para selecionar arquivo
  function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
      // Verificar se é um arquivo Excel
      const validExtensions = ['.xlsx', '.xls'];
      const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
      
      if (!validExtensions.includes(fileExtension)) {
        uploadError = 'Por favor, selecione um arquivo Excel (.xlsx ou .xls)';
        return;
      }
      
      selectedFile = file;
      uploadError = null;
      uploadSuccess = false;
    }
  }
  
  // Função para fazer upload do arquivo
  async function uploadBaseFile() {
    if (!selectedFile) {
      uploadError = 'Por favor, selecione um arquivo antes de fazer upload';
      return;
    }
    
    uploadingFile = true;
    uploadError = null;
    uploadSuccess = false;
    uploadProgress = 0;
    
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      
      const apiUrl = getApiUrl('/api/vi-ala/upload-base');
      
      // Simular progresso (já que não temos progresso real do servidor)
      const progressInterval = setInterval(() => {
        if (uploadProgress < 90) {
          uploadProgress += 10;
        }
      }, 200);
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        body: formData
      });
      
      clearInterval(progressInterval);
      uploadProgress = 100;
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Erro desconhecido' }));
        throw new Error(errorData.error || `HTTP ${response.status}: ${await response.text()}`);
      }
      
      const data = await response.json();
      
      if (data.success) {
        uploadSuccess = true;
        selectedFile = null;
        
        // Recarregar dados do dashboard
        await loadStats();
        await loadTimeline();
        
        // Limpar mensagem de sucesso após 3 segundos
        setTimeout(() => {
          uploadSuccess = false;
        }, 3000);
      } else {
        throw new Error(data.error || 'Erro ao fazer upload do arquivo');
      }
    } catch (err) {
      console.error('Erro ao fazer upload:', err);
      uploadError = err.message || 'Erro ao fazer upload do arquivo';
      uploadProgress = 0;
    } finally {
      uploadingFile = false;
    }
  }

  // Função para carregar estatísticas
  async function loadStats() {
    loadingStats = true;
    error = null;
    
    try {
      const response = await fetch(getApiUrl('/api/vi-ala/stats'));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      
      const data = await response.json();
      if (data.success) {
        statsData = data;
        console.log('📊 [Dashboard] Estatísticas carregadas:', statsData);
      } else {
        throw new Error(data.error || 'Erro ao carregar estatísticas');
      }
    } catch (err) {
      console.error('Erro ao carregar estatísticas:', err);
      error = err.message;
    } finally {
      loadingStats = false;
    }
  }

  // Função para carregar timeline
  async function loadTimeline() {
    // Se não houver data selecionada, não fazer nada (não mostrar erro)
    if (!selectedStartDate) {
      timelineData = {
        timeline: [],
        total: 0,
        period: 'DIA'
      };
      error = null;
      return;
    }
    
    loadingTimeline = true;
    error = null;
    
    try {
      // Determinar período baseado na seleção
      let period = 'DIA'; // Padrão: agrupar por dia
      
      // Se for um único dia, agrupar por hora
      if (dateFilterMode === 'single' || !selectedEndDate || selectedStartDate === selectedEndDate) {
        period = 'HORA';
      }
      
      let url = `/api/vi-ala/timeline?period=${period}`;
      
      // Adicionar filtros de data
      url += `&startDate=${selectedStartDate}`;
      if (selectedEndDate) {
        url += `&endDate=${selectedEndDate}`;
      } else {
        // Se for um único dia, usar a mesma data como fim
        url += `&endDate=${selectedStartDate}`;
      }
      
      const response = await fetch(getApiUrl(url));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      
      const data = await response.json();
      if (data.success) {
        timelineData = data;
      } else {
        throw new Error(data.error || 'Erro ao carregar timeline');
      }
    } catch (err) {
      console.error('Erro ao carregar timeline:', err);
      error = err.message;
    } finally {
      loadingTimeline = false;
    }
  }

  // Função para atualizar dados do relatório ativo
  async function refreshActiveReport() {
    if (activeReport === 'stats') {
      await loadStats();
    } else if (activeReport === 'timeline') {
      // Se não houver data selecionada, definir o dia atual
      if (!selectedStartDate) {
        // Usar data local ao invés de UTC para evitar problemas de timezone
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        selectedStartDate = `${year}-${month}-${day}`;
        selectedEndDate = null;
        dateFilterMode = 'single';
      }
      await loadTimeline();
    }
  }

  // Função para selecionar data no calendário
  function selectDate(date) {
    if (dateFilterMode === 'single') {
      // Modo único: selecionar apenas uma data
      selectedStartDate = date;
      selectedEndDate = null;
    } else {
      // Modo intervalo: selecionar início e fim
      if (!selectedStartDate || (selectedStartDate && selectedEndDate)) {
        // Primeira seleção ou resetar
        selectedStartDate = date;
        selectedEndDate = null;
      } else {
        // Segunda seleção - definir fim
        if (date < selectedStartDate) {
          // Se a data selecionada for anterior à inicial, trocar
          selectedEndDate = selectedStartDate;
          selectedStartDate = date;
        } else {
          selectedEndDate = date;
        }
      }
    }
  }
  
  // Função para aplicar filtro de data
  async function applyDateFilter() {
    if (!selectedStartDate) {
      error = 'Por favor, selecione pelo menos uma data';
      return;
    }
    
    showPeriodModal = false;
    
    if (activeReport === 'timeline') {
      await loadTimeline();
    }
  }
  
  // Função para limpar seleção
  function clearDateSelection() {
    selectedStartDate = null;
    selectedEndDate = null;
  }
  
  // Função para navegar mês do calendário
  function changeCalendarMonth(direction) {
    if (direction === 'prev') {
      if (calendarMonth === 0) {
        calendarMonth = 11;
        calendarYear--;
      } else {
        calendarMonth--;
      }
    } else {
      if (calendarMonth === 11) {
        calendarMonth = 0;
        calendarYear++;
      } else {
        calendarMonth++;
      }
    }
  }
  
  // Função para obter dias do mês para o calendário
  function getCalendarDays() {
    const firstDay = new Date(calendarYear, calendarMonth, 1);
    const lastDay = new Date(calendarYear, calendarMonth + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay(); // 0 = Domingo, 6 = Sábado
    
    const days = [];
    
    // Dias do mês anterior (para preencher primeira semana)
    const prevMonth = calendarMonth === 0 ? 11 : calendarMonth - 1;
    const prevYear = calendarMonth === 0 ? calendarYear - 1 : calendarYear;
    const prevMonthLastDay = new Date(prevYear, prevMonth + 1, 0).getDate();
    
    for (let i = startingDayOfWeek - 1; i >= 0; i--) {
      days.push({
        day: prevMonthLastDay - i,
        month: prevMonth,
        year: prevYear,
        isCurrentMonth: false
      });
    }
    
    // Dias do mês atual
    for (let day = 1; day <= daysInMonth; day++) {
      days.push({
        day,
        month: calendarMonth,
        year: calendarYear,
        isCurrentMonth: true
      });
    }
    
    // Dias do próximo mês (para preencher última semana)
    const daysToAdd = 42 - days.length; // 6 semanas * 7 dias = 42
    for (let day = 1; day <= daysToAdd; day++) {
      const nextMonth = calendarMonth === 11 ? 0 : calendarMonth + 1;
      const nextYear = calendarMonth === 11 ? calendarYear + 1 : calendarYear;
      days.push({
        day,
        month: nextMonth,
        year: nextYear,
        isCurrentMonth: false
      });
    }
    
    return days;
  }
  
  // Função para verificar se uma data está selecionada
  function isDateSelected(day, month, year) {
    if (!selectedStartDate) return false;
    
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    
    if (dateFilterMode === 'single') {
      return selectedStartDate === dateStr;
    } else {
      // Modo intervalo
      if (!selectedEndDate) {
        return selectedStartDate === dateStr;
      }
      return dateStr >= selectedStartDate && dateStr <= selectedEndDate;
    }
  }
  
  // Função para verificar se uma data está no intervalo selecionado
  function isDateInRange(day, month, year) {
    if (!selectedStartDate || dateFilterMode === 'single') return false;
    
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    
    if (!selectedEndDate) {
      return selectedStartDate === dateStr;
    }
    
    return dateStr >= selectedStartDate && dateStr <= selectedEndDate;
  }
  
  // Função para formatar data para exibição
  function formatDateRange() {
    if (!selectedStartDate) {
      return 'Selecionar período';
    }
    
    // Converter YYYY-MM-DD para DD/MM/YYYY sem problemas de timezone
    const [year, month, day] = selectedStartDate.split('-');
    const startFormatted = `${day}/${month}/${year}`;
    
    if (dateFilterMode === 'single' || !selectedEndDate) {
      return startFormatted;
    }
    
    // Converter YYYY-MM-DD para DD/MM/YYYY sem problemas de timezone
    const [endYear, endMonth, endDay] = selectedEndDate.split('-');
    const endFormatted = `${endDay}/${endMonth}/${endYear}`;
    return `${startFormatted} - ${endFormatted}`;
  }
  
  // Função para formatar data YYYY-MM-DD para DD/MM/YYYY
  function formatDateString(dateStr) {
    if (!dateStr) return '';
    const [year, month, day] = dateStr.split('-');
    return `${day}/${month}/${year}`;
  }
  
  // Função para obter string de data no formato YYYY-MM-DD
  function getDateString(day, month, year) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  
  // Função para obter nome do mês em português
  function getMonthName(month) {
    const months = [
      'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
      'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
    ];
    return months[month];
  }

  // Função para mudar relatório ativo
  async function changeReport(report) {
    activeReport = report;
    
    // Se for Evolução Temporal, sempre definir o dia atual se não houver data selecionada
    if (report === 'timeline') {
      if (!selectedStartDate) {
        // Usar data local ao invés de UTC para evitar problemas de timezone
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        selectedStartDate = `${year}-${month}-${day}`;
        selectedEndDate = null;
        dateFilterMode = 'single';
      }
      // Carregar timeline imediatamente após definir a data
      await loadTimeline();
    } else {
      await refreshActiveReport();
    }
  }

  // Inicializar ferramenta quando o componente é montado
  onMount(async () => {
    try {
      // Registrar função de configurações com o parent
      if (onSettingsRequest && typeof onSettingsRequest === 'function') {
        onSettingsRequest(openSettings);
      }
      
      // Registrar função de pré-carregamento no hover
      if (onSettingsHover && typeof onSettingsHover === 'function') {
        onSettingsHover(preloadSettingsData);
      }
      
      // Carregar dados iniciais
      await loadStats();
      
      // Sempre carregar timeline (mesmo que não seja o relatório ativo inicialmente)
      // Se o relatório ativo for timeline, definir data atual automaticamente
      if (activeReport === 'timeline') {
        if (!selectedStartDate) {
          // Usar data local ao invés de UTC para evitar problemas de timezone
          const now = new Date();
          const year = now.getFullYear();
          const month = String(now.getMonth() + 1).padStart(2, '0');
          const day = String(now.getDate()).padStart(2, '0');
          selectedStartDate = `${year}-${month}-${day}`;
          selectedEndDate = null;
          dateFilterMode = 'single';
        }
        await loadTimeline();
      }
      
      // Configurar atualização automática
      refreshInterval = setInterval(() => {
        refreshActiveReport();
      }, REFRESH_INTERVAL_MS);
      
    } catch (err) {
      console.error('Erro ao inicializar ferramenta:', err);
      isLoading = false;
    }
  });

  // Cleanup ao desmontar
  onDestroy(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });

  // Mapeamento de cores específicas para cada tabulação
  const tabulacaoColors = {
    '(Aprovado - Portas Disponíveis)': '#10B981', // Verde
    'Aprovado Com Portas': '#10B981', // legado
    'Aprovado Com Alívio de Rede/Cleanup': '#3B82F6', // Azul
    'Aprovado Prédio Não Cabeado': '#8B5CF6', // Roxo claro
    'Aprovado - Endereço não Localizado': '#F59E0B', // Laranja
    'Fora da Área de Cobertura': '#EF4444', // Vermelho
    'Não Informado': '#9CA3AF' // Cinza
  };

  // Função para obter cor da tabulação
  function getTabulacaoColor(tabulacao) {
    return tabulacaoColors[tabulacao] || '#7B68EE'; // Cor padrão roxa
  }

  // Cores para o gráfico de pizza (fallback se não houver cor específica)
  const pieColors = [
    '#7B68EE', '#8B5CF6', '#9D7AFF', '#A78BFA', '#C084FC',
    '#D8B4FE', '#E9D5FF', '#F3E8FF', '#6495ED', '#7C3AED'
  ];

  // Função para calcular dados do gráfico de pizza
  function getPieChartData(stats, total) {
    if (!stats || !Array.isArray(stats) || stats.length === 0 || !total || total === 0) {
      console.log('⚠️ [PieChart] Dados inválidos:', { stats, total });
      return [];
    }

    console.log('📊 [PieChart] Processando dados:', { stats, total });

    const centerX = 200;
    const centerY = 200;
    const radius = 150;
    let currentAngle = -90; // Começar do topo

    const slices = stats.map((stat, index) => {
      const sliceAngle = (stat.value / total) * 360;
      const startAngle = currentAngle;
      const endAngle = currentAngle + sliceAngle;

      const startAngleRad = (startAngle * Math.PI) / 180;
      const endAngleRad = (endAngle * Math.PI) / 180;

      const x1 = centerX + radius * Math.cos(startAngleRad);
      const y1 = centerY + radius * Math.sin(startAngleRad);
      const x2 = centerX + radius * Math.cos(endAngleRad);
      const y2 = centerY + radius * Math.sin(endAngleRad);

      const largeArcFlag = sliceAngle > 180 ? 1 : 0;
      const path = `M ${centerX} ${centerY} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2} Z`;

      // Posição do label
      const labelAngle = (startAngle + endAngle) / 2;
      const labelAngleRad = (labelAngle * Math.PI) / 180;
      const labelRadius = radius * 0.7;
      const labelX = centerX + labelRadius * Math.cos(labelAngleRad);
      const labelY = centerY + labelRadius * Math.sin(labelAngleRad);

      // Atualizar ângulo para próximo slice
      currentAngle = endAngle;

      return {
        path,
        labelX,
        labelY,
        percentage: stat.percentage,
        label: stat.label,
        value: stat.value,
        color: getTabulacaoColor(stat.label)
      };
    });

    console.log('✅ [PieChart] Slices gerados:', slices);
    return slices;
  }

  // Função para calcular dados do gráfico de linha
  function getLineChartData(timeline) {
    if (!timeline || timeline.length === 0) {
      return [];
    }

    const padding = 60;
    const chartWidth = 800 - padding * 2;
    const chartHeight = 400 - padding * 2;
    const maxValue = Math.max(...timeline.map(d => d.count), 1);
    const data = timeline;

    const result = [];

    // Grid
    const gridLines = [];
    for (let i = 0; i < 6; i++) {
      const y = padding + (chartHeight / 5) * i;
      gridLines.push({
        x1: padding,
        y: y,
        x2: 800 - padding,
        labelX: padding - 10,
        label: Math.round(maxValue - (maxValue / 5) * i)
      });
    }
    result.push({ type: 'grid', lines: gridLines });

    // Linha do gráfico
    const linePoints = data.map((d, i) => {
      const x = padding + (chartWidth / (data.length - 1 || 1)) * i;
      const y = padding + chartHeight - (d.count / maxValue) * chartHeight;
      return `${x},${y}`;
    }).join(' ');
    result.push({ type: 'line', points: linePoints });

    // Pontos
    const points = data.map((point, i) => {
      const x = padding + (chartWidth / (data.length - 1 || 1)) * i;
      const y = padding + chartHeight - (point.count / maxValue) * chartHeight;
      return { x, y, count: point.count };
    });
    result.push({ type: 'points', points: points });

    // Labels do eixo X
    const labels = data.map((point, i) => {
      const x = padding + (chartWidth / (data.length - 1 || 1)) * i;
      const y = 400 - padding + 20;
      
      // Se o período for HORA, mostrar apenas a hora (ex: "20:30h")
      let labelText = point.period;
      if (timelineData.period === 'HORA' && point.period) {
        // Formato esperado: "DD/MM/YYYY HH:MM" ou "DD/MM/YYYY HH:00"
        const horaMatch = point.period.match(/(\d{2}):(\d{2})/);
        if (horaMatch) {
          const [, hour, minute] = horaMatch;
          labelText = `${hour}:${minute}h`;
        } else {
          // Tentar formato alternativo
          const parts = point.period.split(' ');
          if (parts.length > 1) {
            const timePart = parts[1];
            if (timePart.includes(':')) {
              labelText = timePart + 'h';
            }
          }
        }
      }
      
      return { x, y, text: labelText };
    });
    result.push({ type: 'labels', labels: labels });

    return result;
  }
</script>

<!-- Conteúdo da Ferramenta Dashboard CENSUP -->
<div class="dashboard-censup-content">
  {#if isLoading}
    <div class="full-loading-container">
      <div class="custom-spinner-wrapper">
        <div class="custom-spinner"></div>
        <p class="loading-text">{loadingMessage || 'Carregando...'}</p>
      </div>
    </div>
  {:else}
    <div class="dashboard-layout">
      <!-- Sidebar -->
      <aside class="sidebar">
        <nav class="sidebar-nav">
          <button 
            class="nav-item"
            class:active={activeReport === 'stats'}
            on:click={() => changeReport('stats')}
          >
            <span class="nav-icon">🥧</span>
            <span class="nav-label">Estatísticas por Tabulação</span>
          </button>
          
          <button 
            class="nav-item"
            class:active={activeReport === 'timeline'}
            on:click={() => changeReport('timeline')}
          >
            <span class="nav-icon">📈</span>
            <span class="nav-label">Evolução Temporal</span>
          </button>
        </nav>
        
      </aside>

      <!-- Área de Conteúdo -->
      <main class="main-content">
        {#if error}
          <div class="error-message">
            <p>❌ Erro: {error}</p>
            <button on:click={refreshActiveReport}>Tentar novamente</button>
          </div>
        {/if}

        {#if activeReport === 'stats'}
          <!-- Relatório de Estatísticas -->
          <div class="report-section">
            <div class="report-header">
              <h1>Estatísticas por Tabulação</h1>
              <p class="subtitle">Distribuição dos relatórios gerados por tabulação final</p>
            </div>

            {#if loadingStats}
              <div class="loading-container">
                <div class="custom-spinner-wrapper">
                  <div class="custom-spinner"></div>
                  <p class="loading-text">Carregando estatísticas...</p>
                </div>
              </div>
            {:else if statsData.stats.length === 0}
              <div class="empty-state">
                <p>📭 Nenhum dado disponível ainda.</p>
                <p>Gere alguns relatórios na ferramenta Viabilidade Alares para ver as estatísticas.</p>
              </div>
            {:else}
              <div class="stats-container">
                <!-- Gráfico de Pizza -->
                <div class="chart-container">
                  <h2>Distribuição por Tabulação</h2>
                  <div class="pie-chart-wrapper">
                    {#if statsData.stats && statsData.stats.length === 1 && statsData.total > 0}
                      <!-- Caso especial: apenas uma tabulação (100%) - mostrar círculo completo -->
                      <svg class="pie-chart" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
                        <circle cx="200" cy="200" r="150" fill={getTabulacaoColor(statsData.stats[0].label)} stroke="#fff" stroke-width="2" />
                        <text x="200" y="200" text-anchor="middle" dominant-baseline="middle" fill="#fff" font-size="20" font-weight="bold" style="text-shadow: 1px 1px 3px rgba(0,0,0,0.5);">
                          {statsData.stats[0].percentage}%
                        </text>
                      </svg>
                    {:else if pieChartData && pieChartData.length > 0}
                      <!-- Múltiplas tabulações - mostrar gráfico de pizza -->
                      <svg class="pie-chart" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
                        {#each pieChartData as slice, index}
                          <path
                            d={slice.path}
                            fill={slice.color}
                            stroke="#fff"
                            stroke-width="2"
                            class="pie-slice"
                            data-label={slice.label}
                          />
                          {#if parseFloat(slice.percentage) >= 5}
                            <text
                              x={slice.labelX}
                              y={slice.labelY}
                              text-anchor="middle"
                              dominant-baseline="middle"
                              fill="#fff"
                              font-size="14"
                              font-weight="bold"
                              style="text-shadow: 1px 1px 2px rgba(0,0,0,0.5); pointer-events: none;"
                            >
                              {slice.percentage}%
                            </text>
                          {/if}
                        {/each}
                      </svg>
                    {:else}
                      <!-- Círculo vazio quando não há dados -->
                      <svg class="pie-chart" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
                        <circle cx="200" cy="200" r="150" fill="rgba(123, 104, 238, 0.1)" stroke="rgba(123, 104, 238, 0.3)" stroke-width="2" />
                        <text x="200" y="200" text-anchor="middle" dominant-baseline="middle" fill="#7B68EE" font-size="16" font-weight="500">
                          Sem dados
                        </text>
                      </svg>
                    {/if}
                  </div>
                  
                  <!-- Legenda -->
                  <div class="legend">
                    {#each statsData.stats as stat, index}
                      <div class="legend-item">
                        <div 
                          class="legend-color" 
                          style="background-color: {getTabulacaoColor(stat.label)}"
                        ></div>
                        <span class="legend-label">{stat.label}</span>
                        <span class="legend-value">{stat.value} ({stat.percentage}%)</span>
                      </div>
                    {/each}
                  </div>
                </div>

                <!-- Total por Tabulação -->
                <div class="summary-card">
                  <h3>Total por Tabulação</h3>
                  <div class="tabulacao-list">
                    {#each statsData.stats as stat, index}
                      <div class="tabulacao-item">
                        <div 
                          class="tabulacao-color-square" 
                          style="background-color: {getTabulacaoColor(stat.label)}"
                        ></div>
                        <span class="tabulacao-name">{stat.label}</span>
                        <span class="tabulacao-count">{stat.value}</span>
                      </div>
                    {/each}
                  </div>
                </div>
              </div>
            {/if}
          </div>
        {:else if activeReport === 'timeline'}
          <!-- Relatório de Timeline -->
          <div class="report-section">
            <div class="report-header">
              <div class="header-content">
                <div class="header-title-section">
                  <h1>Evolução Temporal</h1>
                  <p class="subtitle">Quantidade de VI ALAs gerados ao longo do tempo</p>
                </div>
              </div>
            </div>

            {#if loadingTimeline}
              <div class="loading-container">
                <div class="custom-spinner-wrapper">
                  <div class="custom-spinner"></div>
                  <p class="loading-text">Carregando timeline...</p>
                </div>
              </div>
            {:else if timelineData.timeline.length === 0}
              <div class="empty-state">
                <p>📭 Nenhum dado disponível ainda.</p>
                <p>Gere alguns relatórios na ferramenta Viabilidade Alares para ver a evolução.</p>
              </div>
            {:else}
              <div class="timeline-container">
                <!-- Gráfico de Linha -->
                <div class="chart-container">
                  <div class="chart-header">
                    <h2>
                      {#if selectedStartDate && (!selectedEndDate || selectedStartDate === selectedEndDate)}
                        Evolução por Hora - {formatDateString(selectedStartDate)}
                      {:else if selectedStartDate && selectedEndDate}
                        Evolução por Dia - {formatDateString(selectedStartDate)} a {formatDateString(selectedEndDate)}
                      {:else}
                        Evolução Temporal
                      {/if}
                    </h2>
                    <div class="period-filter-container">
                      <button 
                        class="period-filter-btn"
                        on:click={() => showPeriodModal = true}
                      >
                        <span>📅 {formatDateRange()}</span>
                        <span class="filter-icon">📅</span>
                      </button>
                    </div>
                  </div>
                  <div class="line-chart-wrapper">
                    <svg class="line-chart" viewBox="0 0 800 400">
                      {#each lineChartData as item}
                        {#if item.type === 'grid'}
                          <!-- Grid -->
                          <g class="grid">
                            {#each item.lines as line}
                              <line x1={line.x1} y1={line.y} x2={line.x2} y2={line.y} stroke="#e5e7eb" stroke-width="1" />
                              <text x={line.labelX} y={line.y} text-anchor="end" dominant-baseline="middle" fill="#6b7280" font-size="12">
                                {line.label}
                              </text>
                            {/each}
                          </g>
                        {:else if item.type === 'line'}
                          <!-- Linha do gráfico -->
                          <polyline
                            points={item.points}
                            fill="none"
                            stroke="#7B68EE"
                            stroke-width="3"
                            class="line-path"
                          />
                        {:else if item.type === 'points'}
                          <!-- Pontos -->
                          {#each item.points as point}
                            <circle
                              cx={point.x}
                              cy={point.y}
                              r="5"
                              fill="#7B68EE"
                              stroke="#fff"
                              stroke-width="2"
                              class="data-point"
                            />
                            <text
                              x={point.x}
                              y={point.y - 15}
                              text-anchor="middle"
                              fill="#374151"
                              font-size="12"
                              font-weight="bold"
                            >
                              {point.count}
                            </text>
                          {/each}
                        {:else if item.type === 'labels'}
                          <!-- Eixo X (períodos) -->
                          <g class="x-axis">
                            {#each item.labels as label}
                              <text
                                x={label.x}
                                y={label.y}
                                text-anchor="middle"
                                fill="#6b7280"
                                font-size="11"
                                transform="rotate(-45 {label.x} {label.y})"
                              >
                                {label.text}
                              </text>
                            {/each}
                          </g>
                        {/if}
                      {/each}
                    </svg>
                  </div>
                </div>

                <!-- Tabela de Dados -->
                <div class="data-table-container">
                  <h3>Dados Detalhados</h3>
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>Período</th>
                        <th>Quantidade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each timelineData.timeline as point}
                        <tr>
                          <td>
                            {#if timelineData.period === 'HORA' && point.period}
                              {@const horaMatch = point.period.match(/(\d{2}):(\d{2})/)}
                              {#if horaMatch}
                                {@const [, hour, minute] = horaMatch}
                                {hour}:{minute}h
                              {:else}
                                {point.period}
                              {/if}
                            {:else}
                              {point.period}
                            {/if}
                          </td>
                          <td class="count-cell">{point.count}</td>
                        </tr>
                      {/each}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td><strong>Total</strong></td>
                        <td><strong>{timelineData.total}</strong></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </main>
    </div>
  {/if}
  
  <!-- Modal de Filtro de Período -->
  {#if showPeriodModal}
    <div class="period-modal-overlay" on:click={() => showPeriodModal = false} on:keydown={(e) => e.key === 'Escape' && (showPeriodModal = false)}>
      <div class="period-modal" on:click|stopPropagation>
        <div class="period-modal-header">
          <h2>📅 Filtrar por Período</h2>
          <button class="close-btn" on:click={() => showPeriodModal = false}>✕</button>
        </div>
        
        <div class="period-modal-content">
          <!-- Modo de Seleção -->
          <div class="filter-mode-selector">
            <button 
              class="mode-btn"
              class:active={dateFilterMode === 'single'}
              on:click={() => { dateFilterMode = 'single'; clearDateSelection(); }}
            >
              Selecionar um Dia
            </button>
            <button 
              class="mode-btn"
              class:active={dateFilterMode === 'range'}
              on:click={() => { dateFilterMode = 'range'; clearDateSelection(); }}
            >
              Intervalo de Datas
            </button>
          </div>
          
          <!-- Calendário Visual -->
          <div class="calendar-container">
            <div class="calendar-header">
              <button class="calendar-nav-btn" on:click={() => changeCalendarMonth('prev')}>
                ‹
              </button>
              <h3 class="calendar-month-year">
                {getMonthName(calendarMonth)} {calendarYear}
              </h3>
              <button class="calendar-nav-btn" on:click={() => changeCalendarMonth('next')}>
                ›
              </button>
            </div>
            
            <div class="calendar-weekdays">
              {#each ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as day}
                <div class="weekday">{day}</div>
              {/each}
            </div>
            
            <div class="calendar-days">
              {#each getCalendarDays() as calendarDay}
                <button
                  class="calendar-day"
                  class:other-month={!calendarDay.isCurrentMonth}
                  class:selected={isDateSelected(calendarDay.day, calendarDay.month, calendarDay.year)}
                  class:in-range={isDateInRange(calendarDay.day, calendarDay.month, calendarDay.year)}
                  on:click={() => selectDate(getDateString(calendarDay.day, calendarDay.month, calendarDay.year))}
                >
                  {calendarDay.day}
                </button>
              {/each}
            </div>
          </div>
          
          <!-- Inputs de Data (Alternativa) -->
          <div class="date-inputs-section">
            <h4>Ou digite as datas:</h4>
            <div class="date-inputs">
              <div class="date-input-group">
                <label for="startDateInput">Data Inicial</label>
                <input 
                  type="date" 
                  id="startDateInput"
                  value={selectedStartDate || ''}
                  on:input={(e) => {
                    selectedStartDate = e.target.value;
                    if (dateFilterMode === 'single') {
                      selectedEndDate = null;
                    }
                  }}
                />
              </div>
              
              {#if dateFilterMode === 'range'}
                <div class="date-input-group">
                  <label for="endDateInput">Data Final</label>
                  <input 
                    type="date" 
                    id="endDateInput"
                    value={selectedEndDate || ''}
                    min={selectedStartDate || undefined}
                    on:input={(e) => selectedEndDate = e.target.value}
                  />
                </div>
              {/if}
            </div>
          </div>
          
          <!-- Botão Hoje -->
          <div class="today-button-container">
            <button 
              class="today-btn"
              on:click={() => {
                const today = new Date().toISOString().split('T')[0];
                selectedStartDate = today;
                selectedEndDate = dateFilterMode === 'range' ? today : null;
                calendarMonth = new Date().getMonth();
                calendarYear = new Date().getFullYear();
              }}
            >
              Hoje
            </button>
          </div>
        </div>
        
        <div class="period-modal-footer">
          <button class="cancel-btn" on:click={() => showPeriodModal = false}>
            Cancelar
          </button>
          <button 
            class="apply-btn" 
            on:click={applyDateFilter}
            disabled={!selectedStartDate}
          >
            Aplicar
          </button>
        </div>
      </div>
    </div>
  {/if}
  
  <!-- Modal de Configurações -->
  {#if showSettingsModal}
    <div class="settings-modal-overlay" on:click={closeSettingsModal} on:keydown={(e) => e.key === 'Escape' && closeSettingsModal()}>
      <div class="settings-modal" on:click|stopPropagation>
        <div class="settings-modal-header">
          <h2>⚙️ Configurações - Dashboard CENSUP</h2>
          <button class="close-btn" on:click={closeSettingsModal}>✕</button>
        </div>
        
        <div class="settings-modal-content">
          <div class="settings-section">
            <h3>📤 Upload de Base de Dados</h3>
            <p class="settings-description">
              Faça upload de um arquivo Excel (.xlsx ou .xls) com os dados da base VI ALA.
              O arquivo deve conter as colunas: VI ALA, ALA, DATA, PROJETISTA, CIDADE, ENDEREÇO, LATITUDE, LONGITUDE, TABULAÇÃO FINAL.
            </p>
            
            <div class="upload-section">
              <div class="file-input-wrapper">
                <input
                  type="file"
                  id="baseFileInput"
                  accept=".xlsx,.xls"
                  on:change={handleFileSelect}
                  disabled={uploadingFile}
                  style="display: none;"
                />
                <label for="baseFileInput" class="file-input-label" class:disabled={uploadingFile}>
                  {#if selectedFile}
                    📄 {selectedFile.name}
                  {:else}
                    📁 Selecionar Arquivo Excel
                  {/if}
                </label>
              </div>
              
              {#if selectedFile && !uploadingFile}
                <button class="upload-btn" on:click={uploadBaseFile}>
                  ⬆️ Fazer Upload
                </button>
              {/if}
              
              {#if uploadingFile}
                <div class="upload-progress">
                  <div class="progress-bar">
                    <div class="progress-fill" style="width: {uploadProgress}%"></div>
                  </div>
                  <p class="progress-text">Enviando... {uploadProgress}%</p>
                </div>
              {/if}
              
              {#if uploadError}
                <div class="upload-error">
                  ❌ {uploadError}
                </div>
              {/if}
              
              {#if uploadSuccess}
                <div class="upload-success">
                  ✅ Arquivo enviado com sucesso! Os dados foram atualizados.
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .dashboard-censup-content {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #f5f7fa;
  }

  .dashboard-layout {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* Sidebar */
  .sidebar {
    width: 280px;
    background: rgba(255, 255, 255, 0.95);
    border-right: 1px solid rgba(123, 104, 238, 0.2);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.05);
  }

  .sidebar-nav {
    padding: 1.5rem 1rem 1rem 1rem;
    flex: 1;
  }

  .nav-item {
    width: 100%;
    padding: 0.75rem 1rem;
    margin-bottom: 0.5rem;
    background: transparent;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    transition: all 0.2s;
    text-align: left;
    color: #5b21b6;
    font-weight: 500;
  }

  .nav-item:hover {
    background: rgba(123, 104, 238, 0.1);
    color: #4c1d95;
  }

  .nav-item.active {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: #fff;
    box-shadow: 0 2px 6px rgba(123, 104, 238, 0.3);
  }

  .nav-icon {
    font-size: 1.25rem;
  }

  .nav-label {
    font-size: 0.875rem;
    font-weight: 500;
  }

  .period-selector {
    padding: 1rem;
    border-top: 1px solid rgba(123, 104, 238, 0.2);
    border-bottom: 1px solid rgba(123, 104, 238, 0.2);
    background: rgba(123, 104, 238, 0.05);
  }

  .period-selector h3 {
    margin: 0 0 0.75rem 0;
    font-size: 0.875rem;
    color: #4c1d95;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .period-buttons {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.5rem;
  }

  .period-btn {
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid rgba(123, 104, 238, 0.2);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 500;
    color: #5b21b6;
    transition: all 0.2s;
  }

  .period-btn:hover {
    background: rgba(123, 104, 238, 0.1);
    border-color: #7B68EE;
    color: #4c1d95;
  }

  .period-btn.active {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: #fff;
    border-color: #7B68EE;
    box-shadow: 0 2px 4px rgba(123, 104, 238, 0.2);
  }


  /* Main Content */
  .main-content {
    flex: 1;
    overflow-y: auto;
    padding: 2rem;
  }

  .error-message {
    background: rgba(254, 226, 226, 0.9);
    border: 1px solid rgba(123, 104, 238, 0.3);
    color: #991b1b;
    padding: 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .error-message button {
    margin-top: 0.5rem;
    padding: 0.5rem 1rem;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: #fff;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s;
    box-shadow: 0 2px 6px rgba(123, 104, 238, 0.3);
  }

  .error-message button:hover {
    box-shadow: 0 4px 8px rgba(123, 104, 238, 0.4);
    transform: translateY(-1px);
  }

  .report-section {
    max-width: 1200px;
    margin: 0 auto;
  }

  .report-header {
    margin-bottom: 2rem;
  }

  .header-content {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
  }

  .header-title-section {
    flex: 1;
  }

  .report-header h1 {
    margin: 0 0 0.5rem 0;
    font-size: 2rem;
    color: #4c1d95;
    font-weight: 600;
  }

  .subtitle {
    margin: 0;
    color: #5b21b6;
    font-size: 1rem;
    opacity: 0.8;
  }

  .loading-container {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 400px;
    padding: 3rem;
  }

  .custom-spinner-wrapper {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
  }

  .custom-spinner {
    width: 60px;
    height: 60px;
    border: 4px solid rgba(123, 104, 238, 0.2);
    border-top-color: #7B68EE;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .loading-text {
    color: #5b21b6;
    font-size: 1rem;
    font-weight: 500;
    margin: 0;
    opacity: 0.8;
  }

  .full-loading-container {
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #f5f7fa;
  }

  .empty-state {
    text-align: center;
    padding: 3rem;
    color: #5b21b6;
    background: rgba(255, 255, 255, 0.9);
    border-radius: 12px;
    border: 1px solid rgba(123, 104, 238, 0.2);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .empty-state p {
    margin: 0.5rem 0;
  }

  /* Stats Container */
  .stats-container {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 2rem;
  }

  .chart-container {
    background: rgba(255, 255, 255, 0.9);
    border-radius: 12px;
    padding: 2rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    border: 1px solid rgba(123, 104, 238, 0.2);
  }

  .chart-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    padding-bottom: 0.75rem;
    border-bottom: 2px solid #7B68EE;
  }

  .chart-container h2 {
    margin: 0;
    font-size: 1.25rem;
    color: #4c1d95;
    font-weight: 600;
  }

  .pie-chart-wrapper {
    display: flex;
    justify-content: center;
    align-items: center;
    margin-bottom: 2rem;
  }

  .pie-chart {
    width: 100%;
    max-width: 400px;
    height: 400px;
  }

  .pie-slice {
    transition: opacity 0.2s;
    cursor: pointer;
  }

  .pie-slice:hover {
    opacity: 0.8;
  }

  .legend {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .legend-color {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .legend-label {
    flex: 1;
    font-size: 0.875rem;
    color: #5b21b6;
    font-weight: 500;
  }

  .legend-value {
    font-size: 0.875rem;
    font-weight: 600;
    color: #4c1d95;
  }

  .summary-card {
    background: rgba(255, 255, 255, 0.9);
    border-radius: 12px;
    padding: 2rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    border: 1px solid rgba(123, 104, 238, 0.2);
    height: fit-content;
  }

  .summary-card h3 {
    margin: 0 0 1.5rem 0;
    font-size: 1.25rem;
    color: #4c1d95;
    font-weight: 600;
    border-bottom: 2px solid #7B68EE;
    padding-bottom: 0.75rem;
  }

  .tabulacao-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .tabulacao-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    border-radius: 8px;
    transition: background 0.2s;
  }

  .tabulacao-item:hover {
    background: rgba(123, 104, 238, 0.05);
  }

  .tabulacao-color-square {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    flex-shrink: 0;
    border: 2px solid rgba(255, 255, 255, 0.8);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .tabulacao-name {
    flex: 1;
    color: #5b21b6;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .tabulacao-count {
    color: #4c1d95;
    font-size: 1rem;
    font-weight: 600;
    min-width: 40px;
    text-align: right;
  }

  /* Timeline Container */
  .timeline-container {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .line-chart-wrapper {
    background: rgba(255, 255, 255, 0.9);
    border-radius: 12px;
    padding: 2rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    border: 1px solid rgba(123, 104, 238, 0.2);
    overflow-x: auto;
  }

  .line-chart {
    width: 100%;
    min-width: 800px;
    height: 400px;
  }

  .line-path {
    fill: none;
    stroke: #7B68EE;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .data-point {
    cursor: pointer;
    transition: r 0.2s;
  }

  .data-point:hover {
    r: 7;
  }

  .data-table-container {
    background: rgba(255, 255, 255, 0.9);
    border-radius: 12px;
    padding: 2rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    border: 1px solid rgba(123, 104, 238, 0.2);
  }

  .data-table-container h3 {
    margin: 0 0 1.5rem 0;
    font-size: 1.25rem;
    color: #4c1d95;
    font-weight: 600;
    border-bottom: 2px solid #7B68EE;
    padding-bottom: 0.75rem;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
  }

  .data-table thead {
    background: rgba(123, 104, 238, 0.1);
  }

  .data-table th {
    padding: 0.75rem 1rem;
    text-align: left;
    font-size: 0.875rem;
    font-weight: 600;
    color: #4c1d95;
    border-bottom: 2px solid #7B68EE;
  }

  .data-table td {
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    color: #5b21b6;
    border-bottom: 1px solid rgba(123, 104, 238, 0.2);
  }

  .data-table tbody tr:hover {
    background: rgba(123, 104, 238, 0.05);
  }

  .data-table tfoot {
    background: rgba(123, 104, 238, 0.1);
    font-weight: 600;
  }

  .data-table tfoot td {
    color: #4c1d95;
    border-top: 2px solid #7B68EE;
  }

  .count-cell {
    text-align: right;
    font-weight: 600;
    color: #7B68EE;
  }

  /* Responsividade */
  @media (max-width: 1024px) {
    .stats-container {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 768px) {
    .dashboard-layout {
      flex-direction: column;
    }

    .sidebar {
      width: 100%;
      border-right: none;
      border-bottom: 1px solid #e5e7eb;
      max-height: 300px;
    }

    .main-content {
      padding: 1rem;
    }

    .period-buttons {
      grid-template-columns: repeat(3, 1fr);
    }
  }

  /* Modal de Configurações */
  .settings-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10000;
    backdrop-filter: blur(4px);
  }

  .settings-modal {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    width: 90%;
    max-width: 600px;
    max-height: 90vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .settings-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.5rem;
    border-bottom: 2px solid #7B68EE;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: #fff;
  }

  .settings-modal-header h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .close-btn {
    background: rgba(255, 255, 255, 0.2);
    border: none;
    color: #fff;
    font-size: 1.5rem;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.3);
  }

  .settings-modal-content {
    padding: 1.5rem;
  }

  .settings-section {
    margin-bottom: 2rem;
  }

  .settings-section h3 {
    margin: 0 0 0.75rem 0;
    color: #4c1d95;
    font-size: 1.125rem;
    font-weight: 600;
  }

  .settings-description {
    margin: 0 0 1rem 0;
    color: #6b7280;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .upload-section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .file-input-wrapper {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .file-input-label {
    padding: 0.75rem 1rem;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: #fff;
    border-radius: 8px;
    cursor: pointer;
    text-align: center;
    font-weight: 500;
    transition: all 0.2s;
    border: 2px solid transparent;
  }

  .file-input-label:hover:not(.disabled) {
    box-shadow: 0 4px 8px rgba(123, 104, 238, 0.3);
    transform: translateY(-1px);
  }

  .file-input-label.disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .upload-btn {
    padding: 0.75rem 1.5rem;
    background: linear-gradient(135deg, #10B981 0%, #059669 100%);
    color: #fff;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 500;
    font-size: 0.875rem;
    transition: all 0.2s;
  }

  .upload-btn:hover {
    box-shadow: 0 4px 8px rgba(16, 185, 129, 0.3);
    transform: translateY(-1px);
  }

  .upload-progress {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .progress-bar {
    width: 100%;
    height: 8px;
    background: #e5e7eb;
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #7B68EE 0%, #6495ED 100%);
    transition: width 0.3s;
  }

  .progress-text {
    margin: 0;
    color: #6b7280;
    font-size: 0.875rem;
    text-align: center;
  }

  .upload-error {
    padding: 0.75rem;
    background: #FEE2E2;
    border: 1px solid #FCA5A5;
    border-radius: 8px;
    color: #DC2626;
    font-size: 0.875rem;
  }

  .upload-success {
    padding: 0.75rem;
    background: #D1FAE5;
    border: 1px solid #6EE7B7;
    border-radius: 8px;
    color: #059669;
    font-size: 0.875rem;
  }

  /* Botão de Filtro de Período */
  .period-filter-container {
    position: relative;
    flex-shrink: 0;
  }

  .period-filter-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: #fff;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.2s;
    box-shadow: 0 2px 4px rgba(123, 104, 238, 0.2);
  }

  .period-filter-btn:hover {
    box-shadow: 0 4px 8px rgba(123, 104, 238, 0.3);
    transform: translateY(-1px);
  }

  .filter-icon {
    font-size: 0.875rem;
  }

  /* Modal de Filtro de Período */
  .period-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10001;
    backdrop-filter: blur(4px);
  }

  .period-modal {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    width: 90%;
    max-width: 700px;
    max-height: 90vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .period-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.5rem;
    border-bottom: 2px solid #7B68EE;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: #fff;
  }

  .period-modal-header h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .period-modal-content {
    padding: 1.5rem;
  }

  .filter-mode-selector {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    border-bottom: 2px solid #e5e7eb;
    padding-bottom: 1rem;
  }

  .mode-btn {
    flex: 1;
    padding: 0.75rem 1rem;
    background: #f3f4f6;
    border: 2px solid transparent;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    color: #6b7280;
    transition: all 0.2s;
  }

  .mode-btn:hover {
    background: #e5e7eb;
  }

  .mode-btn.active {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: #fff;
    border-color: #7B68EE;
  }

  /* Calendário Visual */
  .calendar-container {
    margin: 1.5rem 0;
  }

  .calendar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: #f9fafb;
    border-radius: 8px;
  }

  .calendar-nav-btn {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 1.25rem;
    color: #374151;
    transition: all 0.2s;
  }

  .calendar-nav-btn:hover {
    background: #f3f4f6;
    border-color: #7B68EE;
    color: #7B68EE;
  }

  .calendar-month-year {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: #374151;
  }

  .calendar-weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 0.25rem;
    margin-bottom: 0.5rem;
  }

  .weekday {
    text-align: center;
    font-size: 0.75rem;
    font-weight: 600;
    color: #6b7280;
    padding: 0.5rem;
  }

  .calendar-days {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 0.25rem;
  }

  .calendar-day {
    aspect-ratio: 1;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    color: #374151;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 40px;
  }

  .calendar-day:hover {
    background: #f3f4f6;
    border-color: #7B68EE;
    color: #7B68EE;
  }

  .calendar-day.other-month {
    color: #d1d5db;
    background: #f9fafb;
  }

  .calendar-day.selected {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: #fff;
    border-color: #7B68EE;
    font-weight: 600;
    box-shadow: 0 2px 4px rgba(123, 104, 238, 0.3);
  }

  .calendar-day.in-range {
    background: rgba(123, 104, 238, 0.1);
    border-color: rgba(123, 104, 238, 0.3);
    color: #7B68EE;
  }

  .date-inputs-section {
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid #e5e7eb;
  }

  .date-inputs-section h4 {
    margin: 0 0 0.75rem 0;
    font-size: 0.875rem;
    color: #6b7280;
    font-weight: 500;
  }

  .date-inputs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .date-input-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .date-input-group label {
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
  }

  .date-input-group input[type="date"] {
    padding: 0.75rem;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    font-size: 0.875rem;
    color: #374151;
    transition: all 0.2s;
  }

  .date-input-group input[type="date"]:focus {
    outline: none;
    border-color: #7B68EE;
    box-shadow: 0 0 0 3px rgba(123, 104, 238, 0.1);
  }

  .today-button-container {
    margin-top: 1rem;
    text-align: center;
  }

  .today-btn {
    padding: 0.5rem 1rem;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    color: #374151;
    transition: all 0.2s;
  }

  .today-btn:hover {
    background: #e5e7eb;
    border-color: #7B68EE;
    color: #7B68EE;
  }

  .period-modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 1rem 1.5rem;
    border-top: 1px solid #e5e7eb;
    background: #f9fafb;
  }

  .cancel-btn, .apply-btn {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 500;
    font-size: 0.875rem;
    transition: all 0.2s;
  }

  .cancel-btn {
    background: #f3f4f6;
    color: #374151;
  }

  .cancel-btn:hover {
    background: #e5e7eb;
  }

  .apply-btn {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: #fff;
  }

  .apply-btn:hover {
    box-shadow: 0 4px 8px rgba(123, 104, 238, 0.3);
    transform: translateY(-1px);
  }
</style>
