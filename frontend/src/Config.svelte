<script>
  import { onMount } from 'svelte';
  import { getApiUrl } from './config';
  import {
    toolsRegistry,
    mergePermissionsWithRegistry,
    buildPermissionsPayload,
    getToolsForPermissions
  } from './tools/toolsRegistry.js';

  // Props
  export let onClose = () => {};
  export let onReloadCTOs = async () => {};
  export let onUpdateProjetistas = (list) => {};
  export let onUpdateTabulacoes = (list) => {};
  export let baseDataExists = true;
  export let userTipo = 'user'; // Tipo de usuário: 'admin' ou 'user'
  export let currentUser = ''; // Nome do usuário atual

  // Estados
  let projetistasList = [];
  let onlineUsers = [];
  let usersInfo = {}; // Armazena informações de status e timestamps dos usuários
  let onlineUsersInterval = null;
  let lastOnlineUsersHash = ''; // Hash para detectar mudanças e ajustar polling
  let pollingInterval = 15000; // Intervalo inicial: 15 segundos (otimizado)
  let forceUpdate = 0; // Forçar atualização do componente quando necessário
  
  // Lista filtrada de projetistas (excluindo o usuário atual)
  $: projetistasListFiltrada = projetistasList.filter(projetista => {
    if (!currentUser) return true; // Se não há usuário logado, mostrar todos
    // Comparação case-insensitive para filtrar o usuário atual
    return projetista.toLowerCase().trim() !== currentUser.toLowerCase().trim();
  });
  let tabulacoesList = [
    'Aprovado Com Portas',
    'Aprovado Com Alívio de Rede/Cleanup',
    'Aprovado Prédio Não Cabeado',
    'Aprovado - Endereço não Localizado',
    'Fora da Área de Cobertura'
  ];
  let viAlasList = [];
  
  let showDeleteConfirmModal = false;
  let projetistaToDelete = '';
  let showDeleteTabulacaoModal = false;
  let tabulacaoToDelete = '';
  let showAddTabulacaoModal = false;
  let newTabulacaoName = '';
  let tabulacaoError = '';
  let showAddProjetistaModal = false;
  let newProjetistaName = '';
  let newProjetistaSenha = '';
  let showProjetistaPassword = false;
  let projetistaError = '';
  let uploadingBase = false;
  let uploadMessage = '';
  let uploadSuccess = false;
  let baseLastModified = null;
  let coverageLastModified = null; // Data da última atualização da mancha de cobertura
  let uploadPollInterval = null; // Intervalo de polling para verificar status
  let showDeleteBaseModal = false; // Modal de confirmação para deletar base
  let deletingBase = false; // Flag para indicar que está deletando base
  let showChangeRoleModal = false; // Modal para alterar tipo de usuário
  let projetistaToChangeRole = '';
  let projetistaSenha = ''; // Senha do projetista selecionado
  let newRole = 'user';
  let changeRoleError = '';
  let toolPermissions = {}; // Permissões de ferramentas: { 'tool-id': true/false }
  let loadingChangeRole = false; // Estado de carregamento do modal
  let totalCTOsLoaded = 0; // Total de CTOs carregadas (para exibir na mensagem)
  
  // Variáveis para cálculo de mancha (separado do upload)
  let calculatingCoverage = false;
  let coverageMessage = '';
  let coverageSuccess = false;
  let coveragePollInterval = null;
  
  // Variáveis para progresso do upload e cálculo
  let uploadProgress = {
    stage: 'idle', // 'idle', 'deleting', 'uploading', 'calculating', 'completed', 'error', 'processing', 'inserting', 'updating'
    uploadPercent: 0,
    calculationPercent: 0,
    message: '',
    totalRows: 0,
    processedRows: 0,
    importedRows: 0,
    totalCTOs: 0,
    processedCTOs: 0
  };
  
  // Variável para garantir que o progresso nunca diminua (sempre crescente)
  let lastUploadPercent = 0;
  
  // Variável para animação suave do progresso (mostra todos os valores inteiros de 0% a 100%)
  let displayedPercent = 0;
  let targetPercent = 0;
  let animationFrameId = null;
  let animationTimeoutId = null;
  
  // Função para animar o progresso gradualmente (mostra TODOS os valores inteiros de 0% a 100%)
  // GARANTE que nunca haverá saltos abruptos - sempre passa por todos os valores sequencialmente
  function animateProgress() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (animationTimeoutId) {
      clearTimeout(animationTimeoutId);
      animationTimeoutId = null;
    }
    
    const animate = () => {
      // Se ainda há diferença entre o valor exibido e o alvo
      if (displayedPercent < targetPercent) {
        // PROTEÇÃO CRÍTICA: SEMPRE incrementar apenas 1% por vez (valores inteiros: 0%, 1%, 2%, 3%...)
        // NUNCA pular valores, mesmo que o backend tenha avançado muito (ex: 80% → 90%)
        // Garantir que sempre passe por: 80% → 81% → 82% → ... → 89% → 90%
        const currentInt = Math.floor(displayedPercent);
        const targetInt = Math.round(targetPercent); // Garantir que target também seja inteiro
        displayedPercent = Math.min(targetInt, currentInt + 1);
        
        // Continuar animando se ainda não chegou ao alvo
        if (displayedPercent < targetInt) {
          // Calcular delay baseado na diferença restante
          // Quanto maior a diferença, mais rápido (mas SEMPRE mostra todos os valores)
          // Exemplo: se backend vai de 80% → 90%, anima: 80→81→82→...→89→90 (rápido, mas sequencial)
          const diff = targetInt - displayedPercent;
          let delay;
          if (diff > 20) {
            delay = 10; // Muito rápido para grandes saltos (10ms entre cada 1%)
          } else if (diff > 10) {
            delay = 20; // Rápido para saltos médios (20ms entre cada 1%)
          } else if (diff > 5) {
            delay = 30; // Moderado (30ms entre cada 1%)
          } else {
            delay = 50; // Velocidade normal (50ms entre cada 1%)
          }
          
          animationTimeoutId = setTimeout(() => {
            animationFrameId = requestAnimationFrame(animate);
          }, delay);
        } else {
          // Chegou ao alvo - garantir valor exato (inteiro)
          displayedPercent = Math.round(targetPercent);
          animationFrameId = null;
          animationTimeoutId = null;
        }
      } else {
        animationFrameId = null;
        animationTimeoutId = null;
      }
    };
    
    animationFrameId = requestAnimationFrame(animate);
  }
  
  // Reagir a mudanças no uploadProgress e atualizar targetPercent em tempo real
  // Isso garante que a barra evolua durante o processo, não apenas no final
  // IMPORTANTE: Reagir a TODAS as propriedades relevantes do uploadProgress
  $: if (uploadingBase && uploadProgress) {
    // Forçar reatividade observando todas as propriedades relevantes
    const stage = uploadProgress.stage;
    const processedRows = uploadProgress.processedRows || 0;
    const totalRows = uploadProgress.totalRows || 0;
    const uploadPercent = uploadProgress.uploadPercent || 0;
    
    // Calcular percentual total baseado no progresso atual
    const calculatedPercent = calculateTotalUploadPercent(uploadProgress);
    const newTargetPercent = Math.round(Math.max(calculatedPercent, lastUploadPercent || 0));
    
    // Atualizar lastUploadPercent se o novo valor for maior (nunca diminuir)
    if (newTargetPercent > (lastUploadPercent || 0)) {
      lastUploadPercent = newTargetPercent;
    }
    
    // Atualizar targetPercent (isso vai disparar a animação se necessário)
    // Sempre atualizar, mesmo que seja o mesmo valor, para garantir reatividade
    targetPercent = newTargetPercent;
  }
  
  // Reagir a mudanças no targetPercent (quando o backend atualiza o progresso)
  // GARANTE que sempre anima, mesmo que o backend avance rapidamente
  $: if (uploadingBase) {
    if (targetPercent > displayedPercent) {
      // Se o alvo aumentou (mesmo que muito), iniciar animação
      // A animação sempre passará por todos os valores: 80% → 81% → 82% → ... → 90%
      animateProgress();
    } else if (targetPercent < displayedPercent) {
      // Se o alvo diminuiu (não deveria acontecer, mas por segurança), ajustar
      displayedPercent = Math.round(targetPercent);
    }
  }
  
  // Função para calcular percentual total real do processo de upload
  // Baseado nos estágios e progresso de cada um, de 0% a 100%
  // Mais precisa e responsiva aos dados reais do backend
  function calculateTotalUploadPercent(progress) {
    // Se não temos progresso, retornar 0%
    if (!progress) {
      return 0;
    }
    
    // Se está completo, retornar 100%
    if (progress.stage === 'completed') {
      return 100;
    }
    
    // Se há erro, retornar percentual atual (máximo 95%)
    if (progress.stage === 'error') {
      return Math.min(95, progress.uploadPercent || 0);
    }
    
    // Distribuição do tempo por estágio (baseado em experiência real):
    // 1. Carregando CTOs existentes: 0-5% (rápido, ~20-30s para 218k CTOs)
    // 2. Processando Excel: 5-80% (maior parte do tempo, baseado em processedRows/totalRows)
    // 3. Deletando CTOs: 80-85% (pode levar tempo se houver muitas)
    // 4. Inserindo CTOs: 85-90% (pode variar)
    // 5. Atualizando CTOs: 90-95% (pode ser lento)
    // 6. Finalizando: 95-100%
    
    // Estágio: Carregando CTOs existentes (0% a 5%)
    // Se stage é 'idle' ou não definido, estamos no início
    if (!progress.stage || progress.stage === 'idle') {
      // Se temos processedRows ou totalRows do processamento Excel, já passou do carregamento
      if (progress.processedRows > 0 && progress.totalRows > 0 && progress.stage !== 'idle') {
        // Já passou do carregamento inicial, está processando
        return 5;
      }
      // Ainda carregando CTOs existentes ou início do processo
      // Se temos uploadPercent do backend (0-5%), usar diretamente
      if (progress.uploadPercent !== undefined && progress.uploadPercent !== null && progress.uploadPercent > 0) {
        return Math.min(5, Math.max(0, Math.round(progress.uploadPercent)));
      }
      // Se a mensagem indica carregamento de CTOs, mostrar progresso mínimo
      const message = (progress.message || '').toLowerCase();
      if (message.includes('carregando cto') || message.includes('iniciando')) {
        // Se já começou mas ainda não temos percentual, mostrar 0% (início)
        return 0;
      }
      // Fallback: início do processo - SEMPRE retornar 0%
      return 0;
    }
    
    // Estágio: Processando Excel (maior parte do tempo - 5% a 80%)
    if (progress.stage === 'processing') {
      const basePercent = 5;
      const stageRange = 75; // 5% a 80% = 75% de range
      
      // ÚNICA FONTE: Usar processedRows/totalRows (não confiar em uploadPercent do backend)
      if (progress.totalRows > 0 && progress.processedRows >= 0) {
        // Se totalRows é uma estimativa (maior que processedRows), usar processedRows como base
        // Caso contrário, calcular normalmente
        const actualTotal = progress.totalRows >= progress.processedRows ? progress.totalRows : progress.processedRows;
        // Calcular progresso do processamento (0-100%)
        const processingProgressPercent = Math.min(100, Math.max(0, (progress.processedRows / actualTotal) * 100));
        // Aplicar fórmula: 5% + (progresso_processamento / 100) * 75%
        const calculatedPercent = basePercent + (processingProgressPercent / 100) * stageRange;
        // Garantir que está no range 5-80% e arredondar com precisão
        return Math.min(80, Math.max(basePercent, Math.round(calculatedPercent * 100) / 100));
      }
      
      // Se não temos dados ainda, retornar início do estágio
      return basePercent;
    }
    
    // Estágio: Deletando CTOs (80% a 85%)
    // Fórmula: Progresso total = 80% + (progresso_deleção / 100) * 5%
    if (progress.stage === 'deleting') {
      const basePercent = 80;
      const stageRange = 5; // 80% a 85% = 5% de range
      
      // PRIORIDADE 1: Usar processedRows/totalRows se disponível (mais preciso e responsivo)
      if (progress.totalRows > 0 && progress.processedRows >= 0) {
        // Calcular progresso da deleção (0-100%)
        const deleteProgressPercent = Math.min(100, Math.max(0, (progress.processedRows / progress.totalRows) * 100));
        // Aplicar fórmula: 80% + (progresso_deleção / 100) * 5%
        const calculatedPercent = basePercent + (deleteProgressPercent / 100) * stageRange;
        // Garantir que está no range 80-85% e arredondar
        return Math.min(85, Math.max(basePercent, Math.round(calculatedPercent * 100) / 100));
      }
      
      // PRIORIDADE 2: Usar uploadPercent do backend (já calculado corretamente: 80-85%)
      if (progress.uploadPercent !== undefined && progress.uploadPercent !== null && progress.uploadPercent >= 80) {
        // uploadPercent já está no range 80-85% do backend
        return Math.min(85, Math.max(80, Math.round(progress.uploadPercent * 100) / 100));
      }
      
      // Estimativa inicial (início do estágio)
      return basePercent;
    }
    
    // Estágio: Inserindo CTOs (85% a 90%)
    // Fórmula: Progresso total = 85% + (progresso_inserção / 100) * 5%
    if (progress.stage === 'inserting') {
      const basePercent = 85;
      const stageRange = 5; // 85% a 90% = 5% de range
      
      // PRIORIDADE 1: Usar processedRows/totalRows se disponível (mais preciso e responsivo)
      if (progress.totalRows > 0 && progress.processedRows >= 0) {
        // Calcular progresso da inserção (0-100%)
        const insertProgressPercent = Math.min(100, Math.max(0, (progress.processedRows / progress.totalRows) * 100));
        // Aplicar fórmula: 85% + (progresso_inserção / 100) * 5%
        const calculatedPercent = basePercent + (insertProgressPercent / 100) * stageRange;
        // Garantir que está no range 85-90% e arredondar
        return Math.min(90, Math.max(basePercent, Math.round(calculatedPercent * 100) / 100));
      }
      
      // PRIORIDADE 2: Usar uploadPercent do backend (já calculado corretamente: 85-90%)
      if (progress.uploadPercent !== undefined && progress.uploadPercent !== null) {
        // uploadPercent já está no range 85-90% do backend
        return Math.min(90, Math.max(85, Math.round(progress.uploadPercent * 100) / 100));
      }
      
      // Estimativa inicial (início do estágio)
      return basePercent;
    }
    
    // Estágio: Atualizando CTOs (90% a 95%)
    // Fórmula: Progresso total = 90% + (progresso_atualização / 100) * 5%
    if (progress.stage === 'updating') {
      const basePercent = 90;
      const stageRange = 5; // 90% a 95% = 5% de range
      
      // PRIORIDADE 1: Usar processedRows/totalRows se disponível (mais preciso e responsivo)
      if (progress.totalRows > 0 && progress.processedRows >= 0) {
        // Calcular progresso da atualização (0-100%)
        const updateProgressPercent = Math.min(100, Math.max(0, (progress.processedRows / progress.totalRows) * 100));
        // Aplicar fórmula: 90% + (progresso_atualização / 100) * 5%
        const calculatedPercent = basePercent + (updateProgressPercent / 100) * stageRange;
        // Garantir que está no range 90-95% e arredondar
        return Math.min(95, Math.max(basePercent, Math.round(calculatedPercent * 100) / 100));
      }
      
      // PRIORIDADE 2: Usar uploadPercent do backend (já calculado corretamente: 90-95%)
      if (progress.uploadPercent !== undefined && progress.uploadPercent !== null) {
        // uploadPercent já está no range 90-95% do backend
        return Math.min(95, Math.max(90, Math.round(progress.uploadPercent * 100) / 100));
      }
      
      // Estimativa inicial (início do estágio)
      return basePercent;
    }
    
    // Estágio: Uploading (modo legado - sem comparação inteligente)
    if (progress.stage === 'uploading') {
      const basePercent = 5;
      const stageRange = 90; // 5% a 95% = 90% de range
      const uploadProgressValue = Math.min(100, Math.max(0, progress.uploadPercent || 0));
      return Math.min(95, Math.round(basePercent + (uploadProgressValue / 100) * stageRange));
    }
    
    // Fallback: usar uploadPercent se disponível
    if (progress.uploadPercent !== undefined && progress.uploadPercent !== null) {
      return Math.min(95, Math.round(progress.uploadPercent));
    }
    
    // Fallback final: retornar 5% (início do processo)
    return 5;
  }

  // Carregar dados do localStorage primeiro (instantâneo)
  function loadFromLocalStorage() {
    try {
      const savedProjetistas = localStorage.getItem('projetistasList');
      if (savedProjetistas) {
        projetistasList = JSON.parse(savedProjetistas);
      }
      
      const savedTabulacoes = localStorage.getItem('tabulacoesList');
      if (savedTabulacoes) {
        tabulacoesList = JSON.parse(savedTabulacoes);
      }
      
      // Carregar data de modificação do localStorage se existir
      const savedLastModified = localStorage.getItem('baseLastModified');
      if (savedLastModified) {
        baseLastModified = new Date(savedLastModified);
      }
      
      // Carregar dados de usuários online do localStorage para mostrar instantaneamente
      const savedOnlineUsers = localStorage.getItem('onlineUsers');
      if (savedOnlineUsers) {
        try {
          const parsed = JSON.parse(savedOnlineUsers);
          onlineUsers = Array.isArray(parsed) ? parsed : [];
          console.log('✅ [Config] onlineUsers carregado do localStorage:', onlineUsers);
        } catch (e) {
          console.warn('Erro ao carregar onlineUsers do localStorage:', e);
          onlineUsers = [];
        }
      } else {
        console.log('⚠️ [Config] Nenhum onlineUsers encontrado no localStorage');
      }
      
      const savedUsersInfo = localStorage.getItem('usersInfo');
      if (savedUsersInfo) {
        try {
          usersInfo = JSON.parse(savedUsersInfo);
          console.log('✅ [Config] usersInfo carregado do localStorage:', Object.keys(usersInfo).length, 'usuários');
        } catch (e) {
          console.warn('Erro ao carregar usersInfo do localStorage:', e);
          usersInfo = {};
        }
      } else {
        console.log('⚠️ [Config] Nenhum usersInfo encontrado no localStorage');
      }
      
      // Forçar atualização inicial após carregar do localStorage
      forceUpdate = forceUpdate + 1;
      console.log('🔄 [Config] Forçando atualização inicial após carregar do localStorage');
    } catch (err) {
      console.error('Erro ao carregar do localStorage:', err);
    }
  }

  // Carregar dados ao montar (atualizar com dados do servidor)
  onMount(async () => {
    // Limpar qualquer polling anterior que possa ter ficado ativo
    if (uploadPollInterval) {
      clearInterval(uploadPollInterval);
      uploadPollInterval = null;
    }
    
    // Carregar do localStorage primeiro para mostrar instantaneamente
    loadFromLocalStorage();
    
    // Carregar usuários online IMEDIATAMENTE (prioridade alta para mostrar indicador verde rápido)
    loadOnlineUsers().catch(err => {
      console.error('Erro ao carregar usuários online:', err);
    });
    
    // Depois carregar outros dados do servidor em paralelo
    Promise.all([
      loadProjetistas(),
      loadTabulacoes(),
      loadBaseLastModified(),
      loadCoverageLastModified(),
      loadViAlas()
    ]).catch(err => {
      console.error('Erro ao carregar dados:', err);
    });
    
    // Função para polling adaptativo de usuários online
    const startAdaptivePolling = () => {
      // Limpar intervalo anterior se existir
      if (onlineUsersInterval) {
        clearInterval(onlineUsersInterval);
      }
      
      // Verificar se a aba está visível antes de fazer polling
      const pollIfVisible = () => {
        // BLOQUEAR polling durante upload/cálculo
        if (uploadingBase) {
          return; // Não fazer polling durante upload
        }
        // Usar Page Visibility API para evitar polling quando aba está em background
        if (typeof document !== 'undefined' && !document.hidden) {
          loadOnlineUsers();
        }
      };
      
      // Fazer primeira verificação imediatamente
      pollIfVisible();
      
      // Configurar polling adaptativo
      onlineUsersInterval = setInterval(() => {
        pollIfVisible();
      }, pollingInterval);
    };
    
    // Iniciar polling adaptativo
    startAdaptivePolling();
    
    // Listener para detectar quando a aba volta a ficar visível
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          // Quando a aba volta a ficar visível, atualizar imediatamente
          loadOnlineUsers();
        }
      });
    }
    
    // Limpar intervalos quando componente for destruído
    return () => {
      if (onlineUsersInterval) {
        clearInterval(onlineUsersInterval);
        onlineUsersInterval = null;
      }
      if (uploadPollInterval) {
        clearInterval(uploadPollInterval);
        uploadPollInterval = null;
      }
      if (coveragePollInterval) {
        clearInterval(coveragePollInterval);
        coveragePollInterval = null;
      }
    };
  });
  
  // Verificação reativa: limpar polling se não houver upload em andamento
  $: {
    if (!uploadingBase && uploadPollInterval) {
      console.log('🛑 [Polling] Limpando polling - não há upload em andamento');
      clearInterval(uploadPollInterval);
      uploadPollInterval = null;
    }
    if (!calculatingCoverage && coveragePollInterval) {
      console.log('🛑 [Polling] Limpando polling de cobertura - não há cálculo em andamento');
      clearInterval(coveragePollInterval);
      coveragePollInterval = null;
    }
  }

  // Carregar projetistas
  async function loadProjetistas() {
    try {
      const response = await fetch(getApiUrl('/api/projetistas'));
      const text = await response.text();
      if (text && text.trim() !== '') {
        const data = JSON.parse(text);
        if (data.success) {
          projetistasList = data.projetistas || [];
          try {
            localStorage.setItem('projetistasList', JSON.stringify(projetistasList));
          } catch (err) {
            console.error('Erro ao salvar no localStorage:', err);
          }
        }
      }
    } catch (err) {
      console.error('Erro ao carregar projetistas:', err);
      // Se falhar, manter dados do localStorage que já foram carregados
    }
  }

  // Carregar tabulações
  async function loadTabulacoes() {
    try {
      const response = await fetch(getApiUrl('/api/tabulacoes'));
      const text = await response.text();
      if (text && text.trim() !== '') {
        const data = JSON.parse(text);
        if (data.success) {
          tabulacoesList = data.tabulacoes || tabulacoesList;
          try {
            localStorage.setItem('tabulacoesList', JSON.stringify(tabulacoesList));
          } catch (err) {
            console.error('Erro ao salvar no localStorage:', err);
          }
        }
      }
    } catch (err) {
      console.error('Erro ao carregar tabulações:', err);
      // Se falhar, manter dados do localStorage que já foram carregados
    }
  }

  // Carregar data da última atualização da base
  async function loadBaseLastModified() {
    try {
      console.log('🔄 [Frontend] Carregando data da última atualização...');
      const response = await fetch(getApiUrl('/api/base-last-modified'));
      const text = await response.text();
      if (text && text.trim() !== '') {
        const data = JSON.parse(text);
        console.log('📥 [Frontend] Resposta do backend:', data);
        if (data.success) {
          // Verificar se há dados na base
          if (data.hasData === false) {
            // Não há dados na tabela ctos
            console.log('⚠️ [Frontend] Não há dados na base');
            baseLastModified = null;
            baseDataExists = false;
            // Limpar localStorage
            try {
              localStorage.removeItem('baseLastModified');
            } catch (err) {
              console.error('Erro ao limpar localStorage:', err);
            }
            return;
          }
          
          // Se há dados, atualizar baseDataExists
          console.log('✅ [Frontend] Base de dados existe, atualizando...');
          baseDataExists = true;
          
          // Armazenar total de CTOs se disponível
          if (data.total_ctos !== undefined) {
            totalCTOsLoaded = data.total_ctos;
            console.log(`📊 [Frontend] Total de CTOs: ${totalCTOsLoaded}`);
          }
          
          // Sempre atualizar lastModified quando há dados (backend sempre retorna)
          if (data.lastModified) {
            // Criar nova instância de Date para garantir reatividade do Svelte
            const newDate = new Date(data.lastModified);
            baseLastModified = newDate;
            console.log(`📅 [Frontend] Data atualizada: ${baseLastModified.toLocaleString('pt-BR')}`);
            console.log(`📅 [Frontend] baseDataExists: ${baseDataExists}, baseLastModified: ${baseLastModified}`);
            // Salvar no localStorage para próxima vez
            try {
              localStorage.setItem('baseLastModified', data.lastModified);
            } catch (err) {
              console.error('Erro ao salvar no localStorage:', err);
            }
          } else if (data.hasData === true) {
            // Fallback: se tem dados mas não tem lastModified, usar data atual
            const newDate = new Date();
            baseLastModified = newDate;
            console.log('⚠️ [Frontend] LastModified não disponível, usando data atual como fallback');
            try {
              localStorage.setItem('baseLastModified', baseLastModified.toISOString());
            } catch (err) {
              console.error('Erro ao salvar no localStorage:', err);
            }
          }
          
          // Forçar atualização reativa do Svelte
          baseDataExists = baseDataExists; // Trigger reatividade
        } else {
          console.warn('⚠️ [Frontend] Resposta não foi bem-sucedida:', data);
        }
      } else {
        console.warn('⚠️ [Frontend] Resposta vazia do backend');
      }
    } catch (err) {
      console.error('❌ [Frontend] Erro ao carregar data de modificação:', err);
      // Se falhar, manter dados do localStorage que já foram carregados
    }
  }

  // Função para carregar data da última atualização da mancha de cobertura
  async function loadCoverageLastModified() {
    try {
      console.log('🔄 [Frontend] Carregando data da última atualização da mancha de cobertura...');
      const response = await fetch(getApiUrl('/api/coverage/calculate-status'));
      if (!response.ok) {
        console.warn('⚠️ [Frontend] Erro ao buscar status da mancha de cobertura');
        coverageLastModified = null;
        return;
      }
      
      const data = await response.json();
      if (data.success && data.status === 'completed' && data.created_at) {
        const newDate = new Date(data.created_at);
        coverageLastModified = newDate;
        console.log(`📅 [Frontend] Data da mancha atualizada: ${coverageLastModified.toLocaleString('pt-BR')}`);
      } else {
        coverageLastModified = null;
        console.log('ℹ️ [Frontend] Nenhuma mancha de cobertura encontrada');
      }
    } catch (err) {
      console.error('❌ [Frontend] Erro ao carregar data da mancha de cobertura:', err);
      coverageLastModified = null;
    }
  }

  // Carregar usuários online - NOVA VERSÃO usando tabela do Supabase como fonte principal
  async function loadOnlineUsers() {
    try {
      // Buscar dados de entrada/saída do Supabase (fonte principal)
      const entradaSaidaResponse = await fetch(getApiUrl('/api/projetistas/entrada-saida'));
      
      // Resetar listas usando reatribuição reativa
      onlineUsers = [];
      usersInfo = {};
      
      // Processar dados de entrada/saída do Supabase como fonte principal
      if (entradaSaidaResponse.ok) {
        const entradaSaidaData = await entradaSaidaResponse.json();
        console.log('🔍 [Config] Dados recebidos da API:', entradaSaidaData);
        console.log('🔍 [Config] Lista de projetistas:', projetistasList);
        
        if (entradaSaidaData.success && entradaSaidaData.entradaSaida) {
          console.log('🔍 [Config] Registros de entrada/saída:', entradaSaidaData.entradaSaida);
          
          // Agrupar por projetista e pegar o registro mais recente de cada um
          const registrosPorProjetista = {};
          
          entradaSaidaData.entradaSaida.forEach(registro => {
            const nome = registro.nome_projetista;
            console.log(`🔍 [Config] Processando registro para: "${nome}"`);
            console.log(`🔍 [Config] Registro completo:`, registro);
            
            if (!registrosPorProjetista[nome] || 
                new Date(registro.created_at) > new Date(registrosPorProjetista[nome].created_at)) {
              registrosPorProjetista[nome] = registro;
            }
          });
          
          console.log('🔍 [Config] Registros agrupados por projetista:', registrosPorProjetista);
          
          // Construir lista de usuários online e usersInfo baseado na tabela do Supabase
          Object.keys(registrosPorProjetista).forEach(nome => {
            const registro = registrosPorProjetista[nome];
            
            console.log(`🔍 [Config] Verificando status para: "${nome}"`);
            console.log(`🔍 [Config] data_saida:`, registro.data_saida);
            
            // Se não tem data_saida, o usuário está online (fonte principal)
            const estaOnline = !registro.data_saida;
            console.log(`🔍 [Config] Esta online? ${estaOnline}`);
            
            if (estaOnline) {
              // Usuário está online - adicionar à lista de online
              console.log(`✅ [Config] Adicionando "${nome}" à lista de online`);
              if (!onlineUsers.includes(nome)) {
                // Usar reatribuição para garantir que o Svelte detecte a mudança
                onlineUsers = [...onlineUsers, nome];
                console.log(`✅ [Config] "${nome}" adicionado à lista onlineUsers`);
              } else {
                console.log(`⚠️ [Config] "${nome}" já estava na lista onlineUsers`);
              }
              
              // Criar timestamp de login a partir de data_entrada e hora_entrada
              if (registro.data_entrada && registro.hora_entrada) {
                const loginTimestamp = new Date(`${registro.data_entrada}T${registro.hora_entrada}`).getTime();
                // Usar reatribuição para garantir que o Svelte detecte a mudança
                usersInfo = {
                  ...usersInfo,
                  [nome]: {
                    status: 'online',
                    loginTime: loginTimestamp,
                    dataEntrada: registro.data_entrada,
                    horaEntrada: registro.hora_entrada
                  }
                };
                console.log(`✅ [Config] usersInfo criado para "${nome}":`, usersInfo[nome]);
              } else {
                // Fallback se não tiver data/hora
                usersInfo = {
                  ...usersInfo,
                  [nome]: {
                    status: 'online',
                    loginTime: Date.now()
                  }
                };
                console.log(`⚠️ [Config] usersInfo criado sem data/hora para "${nome}"`);
              }
            } else {
              // Usuário está offline - usar dados de saída
              if (registro.data_saida && registro.hora_saida) {
                const logoutTimestamp = new Date(`${registro.data_saida}T${registro.hora_saida}`).getTime();
                // Usar reatribuição para garantir que o Svelte detecte a mudança
                usersInfo = {
                  ...usersInfo,
                  [nome]: {
                    status: 'offline',
                    logoutTime: logoutTimestamp,
                    dataEntrada: registro.data_entrada,
                    horaEntrada: registro.hora_entrada,
                    dataSaida: registro.data_saida,
                    horaSaida: registro.hora_saida
                  }
                };
              } else {
                // Fallback se não tiver data/hora de saída
                usersInfo = {
                  ...usersInfo,
                  [nome]: {
                    status: 'offline',
                    logoutTime: Date.now()
                  }
                };
              }
            }
          });
          
          console.log('✅ [Config] Lista final de onlineUsers:', onlineUsers);
          console.log('✅ [Config] usersInfo final:', usersInfo);
        }
      }
      
      // Fallback: Se não houver dados da tabela, usar API antiga como backup
      if (onlineUsers.length === 0) {
        try {
          const onlineResponse = await fetch(getApiUrl('/api/users/online'));
          if (onlineResponse.ok) {
            const data = await onlineResponse.json();
            if (data.success && data.onlineUsers && data.onlineUsers.length > 0) {
              // Usar reatribuição para garantir que o Svelte detecte a mudança
              onlineUsers = [...(data.onlineUsers || [])];
              const newUsersInfo = data.usersInfo || {};
              usersInfo = { ...usersInfo, ...newUsersInfo };
            }
          }
        } catch (fallbackErr) {
          console.warn('Erro ao usar fallback da API antiga:', fallbackErr);
        }
      }
      
      // Garantir que todos os projetistas na lista tenham informação de status
      projetistasList.forEach(projetista => {
        console.log(`🔍 [Config] Verificando projetista da lista: "${projetista}"`);
        console.log(`🔍 [Config] Está em onlineUsers?`, onlineUsers.includes(projetista));
        console.log(`🔍 [Config] onlineUsers atual:`, onlineUsers);
        console.log(`🔍 [Config] Tem usersInfo?`, !!usersInfo[projetista]);
        console.log(`🔍 [Config] usersInfo para este projetista:`, usersInfo[projetista]);
        
        // Tentar encontrar correspondência case-insensitive ou com espaços
        const matchingOnlineUser = onlineUsers.find(u => 
          u.toLowerCase().trim() === projetista.toLowerCase().trim()
        );
        
        if (matchingOnlineUser) {
          console.log(`✅ [Config] Encontrada correspondência: "${projetista}" <-> "${matchingOnlineUser}"`);
          // Se encontrou correspondência mas não tem usersInfo, criar
          if (!usersInfo[projetista] && usersInfo[matchingOnlineUser]) {
            usersInfo = {
              ...usersInfo,
              [projetista]: usersInfo[matchingOnlineUser]
            };
            console.log(`✅ [Config] Copiado usersInfo de "${matchingOnlineUser}" para "${projetista}"`);
          }
          // Garantir que está na lista de online
          if (!onlineUsers.includes(projetista)) {
            // Usar reatribuição para garantir que o Svelte detecte a mudança
            onlineUsers = [...onlineUsers, projetista];
            console.log(`✅ [Config] Adicionado "${projetista}" à lista onlineUsers`);
          }
        }
        
        if (!usersInfo[projetista]) {
          // Se não tem informação na tabela, verificar se está na lista de online
          if (onlineUsers.includes(projetista) || matchingOnlineUser) {
            usersInfo = {
              ...usersInfo,
              [projetista]: {
                status: 'online',
                loginTime: Date.now()
              }
            };
            console.log(`✅ [Config] Criado usersInfo online para "${projetista}"`);
          } else {
            // Se não está online e não tem registro, considerar offline
            usersInfo = {
              ...usersInfo,
              [projetista]: {
                status: 'offline'
              }
            };
            console.log(`⚠️ [Config] Criado usersInfo offline para "${projetista}"`);
          }
        }
      });
      
      console.log('✅ [Config] Estado final após garantir status:');
      console.log('✅ [Config] onlineUsers:', onlineUsers);
      console.log('✅ [Config] usersInfo:', usersInfo);
      
      // Detectar mudanças para ajustar polling adaptativo
      const currentHash = JSON.stringify({ onlineUsers, usersInfo });
      const hasChanged = currentHash !== lastOnlineUsersHash;
      
      if (hasChanged) {
        // Se houve mudanças, reduzir intervalo temporariamente para atualizar mais rápido
        pollingInterval = 10000; // 10 segundos quando há mudanças
        lastOnlineUsersHash = currentHash;
        
        // Reiniciar polling com novo intervalo
        if (onlineUsersInterval) {
          clearInterval(onlineUsersInterval);
          onlineUsersInterval = setInterval(() => {
            if (typeof document !== 'undefined' && !document.hidden) {
              loadOnlineUsers();
            }
          }, pollingInterval);
        }
      } else {
        // Se não houve mudanças, aumentar intervalo gradualmente (até máximo de 30s)
        if (pollingInterval < 30000) {
          pollingInterval = Math.min(pollingInterval + 5000, 30000); // Aumentar em 5s até 30s
          
          // Reiniciar polling com novo intervalo
          if (onlineUsersInterval) {
            clearInterval(onlineUsersInterval);
            onlineUsersInterval = setInterval(() => {
              // BLOQUEAR polling durante upload/cálculo
              if (uploadingBase) {
                return; // Não fazer polling durante upload
              }
              if (typeof document !== 'undefined' && !document.hidden) {
                loadOnlineUsers();
              }
            }, pollingInterval);
          }
        }
      }
      
      // Salvar no localStorage para próxima vez (cache para carregamento instantâneo)
      try {
        localStorage.setItem('onlineUsers', JSON.stringify(onlineUsers));
        localStorage.setItem('usersInfo', JSON.stringify(usersInfo));
      } catch (e) {
        console.warn('Erro ao salvar onlineUsers/usersInfo no localStorage:', e);
      }
      
      // Forçar atualização do componente para garantir que o indicador seja atualizado
      forceUpdate = forceUpdate + 1;
      
      console.log(`✅ [Config] Usuários online carregados: ${onlineUsers.length} online, ${Object.keys(usersInfo).length} com informações`);
      console.log(`⏱️ [Config] Próximo polling em: ${pollingInterval / 1000}s`);
      console.log(`🔄 [Config] Forçando atualização do componente (forceUpdate: ${forceUpdate})`);
    } catch (err) {
      console.error('Erro ao carregar usuários online:', err);
    }
  }
  
  // Função auxiliar para verificar se um projetista está online (com correspondência case-insensitive)
  function isProjetistaOnline(projetista) {
    if (!projetista) {
      console.log(`🔍 [isProjetistaOnline] projetista inválido:`, projetista);
      return false;
    }
    
    if (!Array.isArray(onlineUsers)) {
      console.log(`🔍 [isProjetistaOnline] onlineUsers não é array:`, onlineUsers);
      return false;
    }
    
    // Verificação exata primeiro
    if (onlineUsers.includes(projetista)) {
      console.log(`✅ [isProjetistaOnline] "${projetista}" encontrado exatamente em onlineUsers`);
      return true;
    }
    
    // Verificação case-insensitive
    const found = onlineUsers.some(u => u.toLowerCase().trim() === projetista.toLowerCase().trim());
    if (found) {
      const matchingUser = onlineUsers.find(u => u.toLowerCase().trim() === projetista.toLowerCase().trim());
      console.log(`✅ [isProjetistaOnline] "${projetista}" encontrado (case-insensitive) como "${matchingUser}"`);
    } else {
      console.log(`❌ [isProjetistaOnline] "${projetista}" NÃO encontrado em onlineUsers:`, onlineUsers);
    }
    
    return found;
  }
  
  // Função para obter texto do tooltip baseado no status do usuário
  function getProjetistaTooltip(projetista) {
    if (!projetista) return 'Status desconhecido';
    
    // Verificar primeiro se está na lista de online (MESMA LÓGICA EXATA da bolinha verde)
    // Isso garante que o tooltip sempre corresponda à cor da bolinha
    const isOnline = isProjetistaOnline(projetista);
    
    // Tentar encontrar o usersInfo correspondente (case-insensitive)
    let info = usersInfo && typeof usersInfo === 'object' ? usersInfo[projetista] : null;
    if (!info && usersInfo && typeof usersInfo === 'object') {
      // Tentar encontrar correspondência case-insensitive
      const matchingKey = Object.keys(usersInfo).find(k => 
        k.toLowerCase().trim() === projetista.toLowerCase().trim()
      );
      if (matchingKey) {
        info = usersInfo[matchingKey];
      }
    }
    
    // Se está online (mesma verificação da bolinha verde), SEMPRE mostrar "Ativo"
    if (isOnline) {
      // Prioridade 1: Usar data_entrada e hora_entrada do Supabase se disponível
      if (info && info.dataEntrada && info.horaEntrada) {
        try {
          // Formatar data corretamente: dataEntrada vem como "YYYY-MM-DD"
          const [ano, mes, dia] = info.dataEntrada.split('-');
          const formattedDate = `${dia}/${mes}/${ano}`;
          
          // horaEntrada vem como HH:MM:SS, pegar apenas HH:MM
          const horaFormatada = info.horaEntrada.substring(0, 5);
          return `Ativo desde ${formattedDate} - ${horaFormatada}h`;
        } catch (err) {
          console.error('Erro ao formatar data de entrada do Supabase:', err);
        }
      }
      
      // Prioridade 2: Tentar obter timestamp de login
      if (info && info.loginTime) {
        try {
          const date = new Date(info.loginTime);
          // Verificar se a data é válida
          if (!isNaN(date.getTime())) {
            const formattedDate = date.toLocaleDateString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric'
            });
            const formattedTime = date.toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit'
            });
            return `Ativo desde ${formattedDate} - ${formattedTime}h`;
          }
        } catch (err) {
          console.error('Erro ao formatar data de login:', err);
        }
      }
      
      // Se está online mas não tem timestamp, mostrar apenas "Ativo"
      return 'Ativo';
    }
    
    // Se NÃO está online (mesma verificação da bolinha vermelha), mostrar "Inativo"
    // Prioridade 1: Usar data_saida e hora_saida do Supabase se disponível
    if (info && info.dataSaida && info.horaSaida) {
      try {
        // Formatar data corretamente: dataSaida vem como "YYYY-MM-DD"
        const [ano, mes, dia] = info.dataSaida.split('-');
        const formattedDate = `${dia}/${mes}/${ano}`;
        
        // horaSaida vem como HH:MM:SS, pegar apenas HH:MM
        const horaFormatada = info.horaSaida.substring(0, 5);
        return `Inativo desde ${formattedDate} - ${horaFormatada}h`;
      } catch (err) {
        console.error('Erro ao formatar data de saída do Supabase:', err);
      }
    }
    
    // Prioridade 2: Tentar obter timestamp de logout
    if (info && info.logoutTime) {
      try {
        const date = new Date(info.logoutTime);
        // Verificar se a data é válida
        if (!isNaN(date.getTime())) {
          const formattedDate = date.toLocaleDateString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          });
          const formattedTime = date.toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit'
          });
          return `Inativo desde ${formattedDate} - ${formattedTime}h`;
        }
      } catch (err) {
        console.error('Erro ao formatar data de logout:', err);
      }
    }
    
    // Se não está online e não tem informação de logout, retornar status básico
    return 'Inativo';
  }

  // Carregar VI ALAs
  async function loadViAlas() {
    try {
      console.log('📥 Carregando VI ALAs...');
      const response = await fetch(getApiUrl('/api/vi-ala/list'));
      
      if (!response.ok) {
        console.warn('⚠️ Erro ao carregar VI ALAs (status:', response.status, ')');
        viAlasList = [];
        return;
      }
      
      const text = await response.text();
      if (text && text.trim() !== '') {
        const data = JSON.parse(text);
        if (data.success && data.viAlas) {
          // Os dados já vêm ordenados do backend, mas garantir ordenação
          const sorted = (data.viAlas || []).sort((a, b) => {
            const numA = typeof a.numero === 'number' ? a.numero : parseInt(a.numero) || 0;
            const numB = typeof b.numero === 'number' ? b.numero : parseInt(b.numero) || 0;
            return numB - numA; // Ordem decrescente (mais recente primeiro)
          });
          
          // Limitar aos 10 mais recentes (backend já limita, mas garantir)
          viAlasList = sorted.slice(0, 10);
          console.log(`✅ ${viAlasList.length} VI ALAs carregados`);
        } else {
          viAlasList = [];
          console.log('ℹ️ Nenhum VI ALA encontrado na base');
        }
      } else {
        viAlasList = [];
      }
    } catch (err) {
      console.error('❌ Erro ao carregar VI ALAs:', err);
      viAlasList = [];
    }
  }

  // Função para baixar a base de dados do VI ALA
  async function downloadViAlaBase() {
    try {
      const response = await fetch(getApiUrl('/api/vi-ala.xlsx'));
      
      if (!response.ok) {
        // Tentar ler como JSON se não for um arquivo
        try {
          const errorData = await response.json();
          alert(`Erro ao baixar arquivo: ${errorData.error || 'Arquivo não encontrado'}`);
        } catch {
          alert(`Erro ao baixar arquivo (status: ${response.status})`);
        }
        return;
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'base_VI ALA.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      
      console.log('✅ Base VI ALA baixada com sucesso');
    } catch (err) {
      console.error('Erro ao baixar base de dados do VI ALA:', err);
      alert('Erro ao baixar arquivo. Tente novamente.');
    }
  }

  // Função para fechar modal de deletar base
  function closeDeleteBaseModal() {
    showDeleteBaseModal = false;
  }

  // Função para deletar base atual
  async function deleteBase() {
    closeDeleteBaseModal();
    deletingBase = true;
    uploadMessage = '';
    uploadSuccess = false;

    try {
      const apiUrl = getApiUrl('/api/base/delete');
      console.log('🗑️ [Delete] Deletando base de dados...');
      console.log('🔗 [Delete] URL:', apiUrl);

      const response = await fetch(apiUrl, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-Usuario': currentUser || '', // Enviar usuário no header para autorização
        },
        body: JSON.stringify({ usuario: currentUser || '' }), // Também no body para compatibilidade
      });

      console.log('📥 [Delete] Resposta recebida:', response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ [Delete] Erro HTTP:', response.status, errorText);
        
        try {
          const errorData = JSON.parse(errorText);
          throw new Error(errorData.error || `Erro ao deletar base (${response.status})`);
        } catch {
          throw new Error(`Erro ao deletar base (${response.status}): ${errorText.substring(0, 200)}`);
        }
      }

      const data = await response.json();
      console.log('✅ [Delete] Dados recebidos:', data);

      if (data.success) {
        uploadSuccess = true;
        uploadMessage = data.message || 'Base de dados deletada com sucesso!';
        baseLastModified = null;
        baseDataExists = false;
        
        // Limpar localStorage
        try {
          localStorage.removeItem('baseLastModified');
        } catch (err) {
          console.error('Erro ao limpar localStorage:', err);
        }
        
        // Recarregar os dados das CTOs (vai retornar vazio agora)
        if (onReloadCTOs) {
          try {
            await onReloadCTOs();
            console.log('✅ Base de dados recarregada após deleção');
          } catch (err) {
            console.error('Erro ao recarregar base de dados:', err);
          }
        }
      } else {
        uploadSuccess = false;
        uploadMessage = data.error || 'Erro ao deletar base de dados';
      }
    } catch (err) {
      uploadSuccess = false;
      
      if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
        uploadMessage = 'Não foi possível conectar ao servidor. Verifique se o backend está online.';
      } else {
        uploadMessage = `Erro ao deletar base: ${err.message}`;
      }
      
      console.error('❌ [Delete] Erro ao deletar base:', err);
    } finally {
      deletingBase = false;
    }
  }

  // Função para fechar tela de configurações
  function closeSettings() {
    // Limpar polling se estiver ativo
    if (uploadPollInterval) {
      clearInterval(uploadPollInterval);
      uploadPollInterval = null;
    }
    uploadMessage = '';
    uploadSuccess = false;
    uploadingBase = false;
    showDeleteBaseModal = false;
    deletingBase = false;
    if (onClose) {
      onClose();
    }
  }

  // Função para abrir modal de confirmação de exclusão
  function confirmDeleteProjetista(nome) {
    projetistaToDelete = nome;
    showDeleteConfirmModal = true;
  }

  // Função para fechar modal de confirmação
  function closeDeleteConfirmModal() {
    showDeleteConfirmModal = false;
    projetistaToDelete = '';
  }

  // Função para abrir modal de confirmação de exclusão de tabulação
  function confirmDeleteTabulacao(nome) {
    tabulacaoToDelete = nome;
    showDeleteTabulacaoModal = true;
  }

  // Função para fechar modal de confirmação de tabulação
  function closeDeleteTabulacaoModal() {
    showDeleteTabulacaoModal = false;
    tabulacaoToDelete = '';
  }

  // Função para abrir modal de adicionar tabulação
  function openAddTabulacaoModal() {
    showAddTabulacaoModal = true;
    newTabulacaoName = '';
    tabulacaoError = '';
  }

  // Função para fechar modal de adicionar tabulação
  function closeAddTabulacaoModal() {
    showAddTabulacaoModal = false;
    newTabulacaoName = '';
    tabulacaoError = '';
  }

  // Função para adicionar tabulação
  async function addTabulacao() {
    tabulacaoError = '';
    
    if (!newTabulacaoName || !newTabulacaoName.trim()) {
      tabulacaoError = 'Nome da tabulação é obrigatório';
      return;
    }
    
    try {
      const response = await fetch(getApiUrl('/api/tabulacoes'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          nome: newTabulacaoName.trim()
        }),
      });

      const data = await response.json();

      if (data.success) {
        tabulacoesList = data.tabulacoes || [];
        
        try {
          localStorage.setItem('tabulacoesList', JSON.stringify(tabulacoesList));
        } catch (err) {
          console.error('Erro ao sincronizar localStorage:', err);
        }
        
        // Notificar componente pai sobre a atualização
        if (onUpdateTabulacoes) {
          onUpdateTabulacoes(tabulacoesList);
        }
        
        closeAddTabulacaoModal();
      } else {
        tabulacaoError = data.error || 'Erro ao adicionar tabulação';
      }
    } catch (err) {
      console.error('Erro ao adicionar tabulação:', err);
      tabulacaoError = 'Erro ao adicionar tabulação. Tente novamente.';
    }
  }

  // Função para deletar tabulação
  async function deleteTabulacao() {
    if (!tabulacaoToDelete) return;
    
    const nome = tabulacaoToDelete;
    closeDeleteTabulacaoModal();

    try {
      const response = await fetch(getApiUrl(`/api/tabulacoes/${encodeURIComponent(nome)}`), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          tabulacoesList = data.tabulacoes || [];
          
          try {
            localStorage.setItem('tabulacoesList', JSON.stringify(tabulacoesList));
          } catch (err) {
            console.error('Erro ao sincronizar localStorage:', err);
          }
          
          // Notificar componente pai sobre a atualização
          if (onUpdateTabulacoes) {
            onUpdateTabulacoes(tabulacoesList);
          }
          
          console.log(`Tabulação "${nome}" deletada com sucesso do banco de dados.`);
          return;
        } else {
          console.warn(`Aviso da API: ${data.message || 'Erro ao deletar tabulação'}`);
        }
      } else {
        try {
          const errorData = await response.json();
          console.error(`Erro da API: ${errorData.detail || 'Erro desconhecido'}`);
        } catch (e) {
          console.error(`Erro HTTP ${response.status}: ${response.statusText}`);
        }
      }
    } catch (err) {
      console.error('Erro ao deletar tabulação:', err);
    }
  }

  // Função para deletar projetista
  async function deleteProjetista() {
    if (!projetistaToDelete) return;
    
    const nome = projetistaToDelete;
    closeDeleteConfirmModal();

    try {
      const response = await fetch(getApiUrl(`/api/projetistas/${encodeURIComponent(nome)}`), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-Usuario': currentUser || '', // Enviar usuário no header para autorização
        },
        body: JSON.stringify({ usuario: currentUser || '' }), // Também no body para compatibilidade
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          projetistasList = data.projetistas || [];
          
          try {
            localStorage.setItem('projetistasList', JSON.stringify(projetistasList));
          } catch (err) {
            console.error('Erro ao sincronizar localStorage:', err);
          }
          
          // Notificar componente pai sobre a atualização
          if (onUpdateProjetistas) {
            onUpdateProjetistas(projetistasList);
          }
          
          console.log(`Projetista "${nome}" deletado com sucesso do banco de dados.`);
          return;
        } else {
          console.warn(`Aviso da API: ${data.message || 'Erro ao deletar projetista'}`);
        }
      } else {
        try {
          const errorData = await response.json();
          console.error(`Erro da API: ${errorData.detail || 'Erro desconhecido'}`);
        } catch (e) {
          console.error(`Erro HTTP ${response.status}: ${response.statusText}`);
        }
      }
    } catch (err) {
      console.error('Erro ao conectar com a API:', err);
    }

    // Se a API não funcionou, deletar localmente (fallback)
    projetistasList = projetistasList.filter(p => p !== nome);
    
    try {
      localStorage.setItem('projetistasList', JSON.stringify(projetistasList));
      console.log(`Projetista "${nome}" deletado localmente (API não disponível).`);
    } catch (localErr) {
      console.error('Erro ao salvar no localStorage:', localErr);
    }
    
    // Notificar componente pai sobre a atualização
    if (onUpdateProjetistas) {
      onUpdateProjetistas(projetistasList);
    }
  }

  // Função para abrir modal de adicionar projetista
  function openAddProjetistaModal() {
    showAddProjetistaModal = true;
    newProjetistaName = '';
    newProjetistaSenha = '';
    projetistaError = '';
    showProjetistaPassword = false;
  }

  // Função para fechar modal de adicionar projetista
  function closeAddProjetistaModal() {
    showAddProjetistaModal = false;
    newProjetistaName = '';
    newProjetistaSenha = '';
    projetistaError = '';
    showProjetistaPassword = false;
  }

  // Função para abrir modal de alterar tipo de usuário
  function openChangeRoleModal(nome) {
    projetistaToChangeRole = nome;
    projetistaSenha = ''; // Resetar senha
    newRole = 'user'; // Default
    changeRoleError = '';
    loadingChangeRole = true; // Iniciar carregamento
    
    // Inicializar permissões de ferramentas (todas marcadas por padrão)
    toolPermissions = mergePermissionsWithRegistry({});
    
    // Abrir modal imediatamente para melhorar a experiência do usuário
    showChangeRoleModal = true;
    
    // Carregar dados em paralelo após abrir o modal
    Promise.all([
      loadProjetistaData(nome),
      loadToolPermissions(nome)
    ]).then(() => {
      loadingChangeRole = false; // Finalizar carregamento quando dados chegarem
    }).catch(err => {
      console.warn('Erro ao carregar dados do projetista:', err);
      loadingChangeRole = false; // Finalizar carregamento mesmo em caso de erro
    });
  }
  
  // Função para carregar dados completos do projetista (nome, senha, tipo)
  async function loadProjetistaData(nomeProjetista) {
    try {
      const response = await fetch(getApiUrl(`/api/projetistas/${encodeURIComponent(nomeProjetista)}`), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Usuario': currentUser || '',
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.projetista) {
          projetistaSenha = data.projetista.senha || '';
          newRole = data.projetista.tipo || 'user';
        }
      }
    } catch (err) {
      console.warn('Erro ao carregar dados do projetista:', err);
      // Em caso de erro, manter valores padrão
    }
  }
  
  // Função para carregar permissões de ferramentas do backend
  async function loadToolPermissions(nomeProjetista) {
    try {
      const response = await fetch(getApiUrl(`/api/projetistas/${encodeURIComponent(nomeProjetista)}/permissions`), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Usuario': currentUser || '',
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          toolPermissions = mergePermissionsWithRegistry(data.permissions || {});
        }
      }
    } catch (err) {
      console.warn('Erro ao carregar permissões de ferramentas:', err);
      // Em caso de erro, manter todas as ferramentas habilitadas por padrão
    }
  }

  // Função para fechar modal de alterar tipo
  function closeChangeRoleModal() {
    showChangeRoleModal = false;
    projetistaToChangeRole = '';
    projetistaSenha = '';
    newRole = 'user';
    changeRoleError = '';
    toolPermissions = {};
    loadingChangeRole = false; // Resetar estado de carregamento
  }
  
  // Função para alternar permissão de uma ferramenta
  function toggleToolPermission(toolId) {
    toolPermissions[toolId] = !toolPermissions[toolId];
    // Forçar atualização reativa
    toolPermissions = { ...toolPermissions };
  }

  // Função para alterar tipo de usuário
  async function changeUserRole() {
    if (!projetistaToChangeRole) return;
    
    changeRoleError = '';
    
    if (!newRole || (newRole !== 'admin' && newRole !== 'user')) {
      changeRoleError = 'Tipo inválido. Deve ser "admin" ou "user"';
      return;
    }
    
    try {
      // 1. Alterar tipo de usuário
      const roleResponse = await fetch(getApiUrl(`/api/projetistas/${encodeURIComponent(projetistaToChangeRole)}/role`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Usuario': currentUser || '',
        },
        body: JSON.stringify({
          tipo: newRole,
          usuario: currentUser || ''
        }),
      });

      const roleData = await roleResponse.json();

      if (!roleData.success) {
        changeRoleError = roleData.error || 'Erro ao alterar tipo de usuário';
        return;
      }
      
      // 2. Salvar permissões de ferramentas
      const permissionsResponse = await fetch(getApiUrl(`/api/projetistas/${encodeURIComponent(projetistaToChangeRole)}/permissions`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Usuario': currentUser || '',
        },
        body: JSON.stringify({
          permissions: buildPermissionsPayload(toolPermissions),
          usuario: currentUser || ''
        }),
      });
      
      const permissionsData = await permissionsResponse.json();
      
      if (!permissionsData.success) {
        console.warn('Erro ao salvar permissões de ferramentas:', permissionsData.error);
        // Não bloquear o fluxo se apenas as permissões falharem
      }

      closeChangeRoleModal();
      // Recarregar lista de projetistas
      await loadProjetistas();
    } catch (err) {
      console.error('Erro ao alterar tipo de usuário:', err);
      changeRoleError = 'Erro ao alterar tipo de usuário. Tente novamente.';
    }
  }

  // Função para adicionar projetista
  async function addProjetista() {
    projetistaError = '';
    
    if (!newProjetistaName || !newProjetistaName.trim()) {
      projetistaError = 'Nome do projetista é obrigatório';
      return;
    }
    
    if (!newProjetistaSenha || !newProjetistaSenha.trim()) {
      projetistaError = 'Senha é obrigatória';
      return;
    }
    
    try {
      const response = await fetch(getApiUrl('/api/projetistas'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Usuario': currentUser || '', // Enviar usuário no header para autorização
        },
        body: JSON.stringify({
          nome: newProjetistaName.trim(),
          senha: newProjetistaSenha.trim(),
          usuario: currentUser || '' // Também no body para compatibilidade
        }),
      });

      // Verificar status da resposta primeiro
      if (!response.ok) {
        const errorText = await response.text();
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: errorText || `Erro HTTP ${response.status}` };
        }
        console.error('❌ [Add Projetista] Erro HTTP:', response.status, errorData);
        projetistaError = errorData.error || `Erro ao adicionar projetista (${response.status})`;
        return;
      }

      const data = await response.json();
      console.log('📦 [Add Projetista] Resposta:', data);

      if (data.success) {
        projetistasList = data.projetistas || [];
        
        try {
          localStorage.setItem('projetistasList', JSON.stringify(projetistasList));
        } catch (err) {
          console.error('Erro ao sincronizar localStorage:', err);
        }
        
        // Notificar componente pai sobre a atualização
        if (onUpdateProjetistas) {
          onUpdateProjetistas(projetistasList);
        }
        
        closeAddProjetistaModal();
      } else {
        console.error('❌ [Add Projetista] Erro na resposta:', data);
        projetistaError = data.error || 'Erro ao adicionar projetista';
      }
    } catch (err) {
      console.error('Erro ao adicionar projetista:', err);
      projetistaError = 'Erro ao adicionar projetista. Tente novamente.';
    }
  }


  // Função para criar mancha de cobertura
  async function handleCreateCoverage() {
    if (calculatingCoverage || uploadingBase) {
      return;
    }
    
    if (!baseDataExists) {
      coverageMessage = '⚠️ É necessário carregar uma base de dados primeiro!';
      coverageSuccess = false;
      return;
    }
    
    calculatingCoverage = true;
    coverageMessage = 'Iniciando cálculo da mancha de cobertura...';
    coverageSuccess = false;
    
    // Limpar qualquer polling anterior
    if (coveragePollInterval) {
      clearInterval(coveragePollInterval);
      coveragePollInterval = null;
    }
    
    // Inicializar progresso
    uploadProgress = {
      stage: 'calculating',
      uploadPercent: 100,
      calculationPercent: 0,
      message: 'Iniciando cálculo da mancha de cobertura...',
      totalRows: 0,
      processedRows: 0,
      importedRows: 0,
      totalCTOs: 0,
      processedCTOs: 0
    };
    
    try {
      const apiUrl = getApiUrl('/api/coverage/calculate');
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Erro HTTP: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.success) {
        coverageMessage = 'Cálculo iniciado! Aguardando processamento...';
        
        // Iniciar polling do progresso
        coveragePollInterval = setInterval(async () => {
          try {
            const progressRes = await fetch(getApiUrl('/api/upload-progress'));
            if (progressRes.ok) {
              const progressData = await progressRes.json();
              if (progressData.success) {
                // O backend retorna uploadProgress diretamente (não dentro de .progress)
                // Atualizar progresso com os dados recebidos (usar valores do backend diretamente, não fallback)
                uploadProgress = {
                  stage: progressData.stage !== undefined ? progressData.stage : uploadProgress.stage,
                  uploadPercent: progressData.uploadPercent !== undefined ? progressData.uploadPercent : uploadProgress.uploadPercent,
                  calculationPercent: progressData.calculationPercent !== undefined ? progressData.calculationPercent : uploadProgress.calculationPercent,
                  message: progressData.message !== undefined ? progressData.message : uploadProgress.message,
                  totalRows: progressData.totalRows !== undefined ? progressData.totalRows : uploadProgress.totalRows,
                  processedRows: progressData.processedRows !== undefined ? progressData.processedRows : uploadProgress.processedRows,
                  importedRows: progressData.importedRows !== undefined ? progressData.importedRows : uploadProgress.importedRows,
                  totalCTOs: progressData.totalCTOs !== undefined ? progressData.totalCTOs : uploadProgress.totalCTOs,
                  processedCTOs: progressData.processedCTOs !== undefined ? progressData.processedCTOs : uploadProgress.processedCTOs
                };
                
                coverageMessage = uploadProgress.message || 'Calculando área de cobertura...';
                
                // Verificar se cálculo foi concluído
                if (uploadProgress.stage === 'completed') {
                  console.log('✅ [Config] Cálculo concluído detectado!');
                  clearInterval(coveragePollInterval);
                  coveragePollInterval = null;
                  calculatingCoverage = false;
                  coverageSuccess = true;
                  coverageMessage = '✅ Área de cobertura criada com sucesso!';
                  
                  // Forçar atualização do componente
                  forceUpdate++;
                  
                  // Recarregar dados
                  if (onReloadCTOs) {
                    try {
                      await onReloadCTOs();
                    } catch (err) {
                      console.error('Erro ao recarregar CTOs:', err);
                    }
                  }
                  
                  // Recarregar data da última atualização da mancha
                  await loadCoverageLastModified();
                } else if (uploadProgress.stage === 'error') {
                  console.log('❌ [Config] Erro no cálculo detectado!');
                  clearInterval(coveragePollInterval);
                  coveragePollInterval = null;
                  calculatingCoverage = false;
                  coverageSuccess = false;
                  coverageMessage = `❌ Erro: ${uploadProgress.message || 'Erro ao calcular área de cobertura'}`;
                  
                  // Forçar atualização do componente
                  forceUpdate++;
                } else if (uploadProgress.stage === 'calculating') {
                  // Ainda calculando, atualizar mensagem
                  coverageMessage = uploadProgress.message || `Calculando área de cobertura... ${uploadProgress.calculationPercent || 0}%`;
                }
              }
            }
          } catch (err) {
            console.error('Erro ao buscar progresso:', err);
          }
        }, 2000);
      } else {
        throw new Error(data.error || 'Erro ao iniciar cálculo');
      }
    } catch (err) {
      console.error('Erro ao criar mancha de cobertura:', err);
      calculatingCoverage = false;
      coverageSuccess = false;
      coverageMessage = `❌ Erro ao criar mancha de cobertura: ${err.message}`;
      
      if (coveragePollInterval) {
        clearInterval(coveragePollInterval);
        coveragePollInterval = null;
      }
    }
  }
  
  // Função para fazer upload da nova base de dados
  async function handleBaseUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    uploadMessage = '';
    uploadSuccess = false;
    uploadingBase = true;
    lastUploadPercent = 0; // Resetar progresso quando inicia novo upload
    displayedPercent = 0; // Resetar progresso animado
    targetPercent = 0; // Resetar alvo
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    try {
      const formData = new FormData();
      formData.append('file', file);

      // Obter URL da API com tratamento de erro robusto
      let apiUrl;
      try {
        apiUrl = getApiUrl('/api/upload-base');
      } catch (urlError) {
        console.error('❌ [Upload] Erro ao obter URL da API:', urlError);
        throw new Error('Erro ao construir URL da API. Verifique a configuração VITE_API_URL.');
      }
      
      // Validar URL antes de fazer fetch
      if (!apiUrl) {
        console.error('❌ [Upload] apiUrl é null ou undefined');
        throw new Error('URL da API inválida (null/undefined). Verifique a configuração VITE_API_URL.');
      }
      
      if (typeof apiUrl !== 'string') {
        console.error('❌ [Upload] apiUrl não é string:', typeof apiUrl, apiUrl);
        throw new Error(`URL da API inválida (tipo: ${typeof apiUrl}). Verifique a configuração VITE_API_URL.`);
      }
      
      if (apiUrl.trim() === '') {
        console.error('❌ [Upload] apiUrl é string vazia');
        throw new Error('URL da API inválida (string vazia). Verifique a configuração VITE_API_URL.');
      }
      
      // Validar se é uma URL válida ou path relativo
      const isAbsoluteUrl = apiUrl.startsWith('http://') || apiUrl.startsWith('https://');
      const isRelativePath = apiUrl.startsWith('/');
      
      if (!isAbsoluteUrl && !isRelativePath) {
        console.error('❌ [Upload] apiUrl não é URL absoluta nem path relativo:', apiUrl);
        throw new Error(`URL da API inválida (formato incorreto): ${apiUrl}`);
      }
      
      // Se é URL absoluta, validar formato
      if (isAbsoluteUrl) {
        try {
          new URL(apiUrl);
        } catch (urlError) {
          console.error('❌ [Upload] Erro ao validar URL:', urlError);
          throw new Error(`URL da API inválida (formato incorreto): ${apiUrl}`);
        }
      }
      
      console.log('📤 [Upload] Enviando arquivo para:', apiUrl);
      console.log('📤 [Upload] Método HTTP:', 'POST');
      console.log('📤 [Upload] Tamanho do arquivo:', file.size, 'bytes');
      console.log('📤 [Upload] Tipo do arquivo:', file.type || 'não especificado');
      console.log('📤 [Upload] FormData criado:', formData.has('file'));

      // Fazer fetch com tratamento de erro específico
      let response;
      try {
        const fetchOptions = {
          method: 'POST',
          body: formData
        };
        console.log('📤 [Upload] Opções do fetch:', { method: fetchOptions.method, hasBody: !!fetchOptions.body });
        response = await fetch(apiUrl, fetchOptions);
      } catch (fetchError) {
        console.error('❌ [Upload] Erro no fetch:', fetchError);
        console.error('❌ [Upload] URL usada:', apiUrl);
        console.error('❌ [Upload] Tipo do erro:', fetchError.name);
        console.error('❌ [Upload] Mensagem:', fetchError.message);
        
        if (fetchError.name === 'TypeError' && fetchError.message.includes('Failed to fetch')) {
          throw new Error('Não foi possível conectar ao servidor. Verifique se o backend está online.');
        }
        throw fetchError;
      }

      console.log('📥 [Upload] Resposta recebida:', response.status, response.statusText);
      console.log('📥 [Upload] Content-Type:', response.headers.get('content-type'));

      // Verificar se a resposta é OK antes de tentar ler
      if (!response.ok) {
        // Tentar ler como texto primeiro
        const errorText = await response.text();
        console.error('❌ [Upload] Erro HTTP:', response.status, errorText.substring(0, 200));
        
        if (response.status === 502) {
          throw new Error('Servidor não está respondendo (502 Bad Gateway). Verifique se o backend está online.');
        } else if (response.status === 504) {
          throw new Error('Timeout do servidor. O arquivo pode ser muito grande. Tente novamente.');
        } else {
          // Tentar parsear como JSON se possível
          try {
            const errorData = JSON.parse(errorText);
            // Usar a mensagem de erro do servidor diretamente (já vem formatada)
            throw new Error(errorData.error || `Erro do servidor (${response.status})`);
          } catch {
            throw new Error(`Erro do servidor (${response.status}): ${errorText.substring(0, 200) || response.statusText}`);
          }
        }
      }

      const text = await response.text();
      let data;
      
      if (!text || text.trim() === '') {
        throw new Error(`Resposta vazia do servidor (${response.status} ${response.statusText})`);
      }
      
      try {
        data = JSON.parse(text);
        console.log('✅ [Upload] Dados recebidos:', data);
      } catch (parseErr) {
        console.error('❌ [Upload] Erro ao parsear JSON:', parseErr);
        console.error('❌ [Upload] Resposta recebida (primeiros 500 chars):', text.substring(0, 500));
        throw new Error(`Erro ao processar resposta do servidor. O servidor retornou: ${text.substring(0, 200)}`);
      }

      if (data.success) {
        // Se o backend indicou que está processando em background
        if (data.processing) {
          uploadSuccess = true; // Verde indicando que está tudo correto, é só aguardar
          uploadingBase = true; // Manter flag de upload ativo
          
          // Resetar variáveis de animação
          displayedPercent = 0;
          targetPercent = 0;
          lastUploadPercent = 0;
          if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
          }
          if (animationTimeoutId) {
            clearTimeout(animationTimeoutId);
            animationTimeoutId = null;
          }
          
          // Inicializar progresso (começar do zero)
          uploadProgress = {
            stage: 'idle',
            uploadPercent: 0,
            calculationPercent: 0,
            message: 'Iniciando atualização da base de dados...',
            totalRows: 0,
            processedRows: 0,
            importedRows: 0,
            totalCTOs: 0,
            processedCTOs: 0
          };
          lastUploadPercent = 0; // Resetar progresso quando inicia novo upload
          
          // Limpar qualquer polling anterior
          if (uploadPollInterval) {
            clearInterval(uploadPollInterval);
            uploadPollInterval = null;
          }
          
          // Iniciar polling do progresso (mais frequente para atualização suave)
          uploadPollInterval = setInterval(async () => {
            try {
              const progressRes = await fetch(getApiUrl('/api/upload-progress'));
              if (progressRes.ok) {
                const progressData = await progressRes.json();
                if (progressData.success) {
                  // Atualizar progresso (garantir que todos os campos estejam presentes)
                  uploadProgress = {
                    stage: progressData.stage !== undefined ? progressData.stage : uploadProgress.stage,
                    uploadPercent: progressData.uploadPercent !== undefined ? progressData.uploadPercent : (uploadProgress.uploadPercent || 0),
                    calculationPercent: progressData.calculationPercent !== undefined ? progressData.calculationPercent : (uploadProgress.calculationPercent || 0),
                    message: progressData.message !== undefined ? progressData.message : uploadProgress.message,
                    totalRows: progressData.totalRows !== undefined ? progressData.totalRows : (uploadProgress.totalRows || 0),
                    processedRows: progressData.processedRows !== undefined ? progressData.processedRows : (uploadProgress.processedRows || 0),
                    importedRows: progressData.importedRows !== undefined ? progressData.importedRows : (uploadProgress.importedRows || 0),
                    totalCTOs: progressData.totalCTOs !== undefined ? progressData.totalCTOs : (uploadProgress.totalCTOs || 0),
                    processedCTOs: progressData.processedCTOs !== undefined ? progressData.processedCTOs : (uploadProgress.processedCTOs || 0)
                  };
                  
                  // Mensagem fixa: sempre "Carregando..." com a porcentagem
                  // A porcentagem será calculada e exibida no template
                  // Não precisamos atualizar uploadMessage aqui, será calculado no template
                  if (progressData.stage === 'completed') {
                    // Processo completo!
                    clearInterval(uploadPollInterval);
                    uploadPollInterval = null;
                    // Garantir que o progresso chegue a 100%
                    targetPercent = 100;
                    // Aguardar um pouco para animação chegar a 100% antes de desativar
                    setTimeout(() => {
                      uploadingBase = false;
                      displayedPercent = 0;
                      targetPercent = 0;
                      lastUploadPercent = 0;
                      if (animationFrameId) {
                        cancelAnimationFrame(animationFrameId);
                        animationFrameId = null;
                      }
                      if (animationTimeoutId) {
                        clearTimeout(animationTimeoutId);
                        animationTimeoutId = null;
                      }
                    }, 2000); // Aumentar para 2s para garantir que chegue a 100%
                    uploadSuccess = true;
                    
                    // Recarregar dados primeiro para obter o total atual de CTOs
                    await loadBaseLastModified();
                    
                    // Formatar número com pontos (ex: 218908 -> 218.908)
                    const formatNumber = (num) => {
                      if (!num || num === 0) return '0';
                      return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
                    };
                    
                    // Usar totalCTOsLoaded atualizado pelo loadBaseLastModified, ou fallback
                    const totalCTOs = totalCTOsLoaded || progressData.totalCTOs || progressData.importedRows || 0;
                    uploadMessage = `✅ Base de dados Atualizada com sucesso!<br>                  (${formatNumber(totalCTOs)} CTOs)`;
                    if (onReloadCTOs) {
                      try {
                        await onReloadCTOs();
                      } catch (err) {
                        console.error('Erro ao recarregar CTOs:', err);
                      }
                    }
                  } else if (progressData.stage === 'error') {
                    clearInterval(uploadPollInterval);
                    uploadPollInterval = null;
                    if (animationFrameId) {
                      cancelAnimationFrame(animationFrameId);
                      animationFrameId = null;
                    }
                    if (animationTimeoutId) {
                      clearTimeout(animationTimeoutId);
                      animationTimeoutId = null;
                    }
                    uploadingBase = false;
                    uploadSuccess = false;
                    uploadMessage = progressData.message || 'Erro ao processar upload';
                    displayedPercent = 0;
                    targetPercent = 0;
                    lastUploadPercent = 0;
                  }
                }
              }
            } catch (pollErr) {
              console.error('❌ [Upload] Erro ao verificar progresso:', pollErr);
              // Continuar tentando
            }
          }, 500); // Verificar a cada 500ms para atualização mais suave e responsiva
          
          // Timeout de segurança (5 minutos)
          setTimeout(() => {
            if (uploadPollInterval) {
              clearInterval(uploadPollInterval);
              uploadPollInterval = null;
            }
            if (uploadingBase) {
              if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
              }
              if (animationTimeoutId) {
                clearTimeout(animationTimeoutId);
                animationTimeoutId = null;
              }
              uploadingBase = false;
              uploadSuccess = false;
              uploadMessage = 'Processamento demorou mais que o esperado. Verifique os logs do servidor.';
              displayedPercent = 0;
              targetPercent = 0;
              lastUploadPercent = 0;
            }
          }, 300000); // 5 minutos
          
          event.target.value = '';
          return; // Não limpar uploadingBase ainda
        } else {
          // Processamento imediato (não em background)
          uploadSuccess = true;
          
          if (data.lastModified) {
            baseLastModified = new Date(data.lastModified);
          }
          
          // Recarregar os dados das CTOs
          if (onReloadCTOs) {
            try {
              await onReloadCTOs();
              console.log('✅ Base de dados recarregada com sucesso');
            } catch (err) {
              console.error('Erro ao recarregar base de dados:', err);
            }
          }
          
          // Buscar total de CTOs atualizado
          await loadBaseLastModified();
          
          // Formatar número com pontos (ex: 218908 -> 218.908)
          const formatNumber = (num) => {
            if (!num || num === 0) return '0';
            return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
          };
          
          // Usar totalCTOsLoaded atualizado pelo loadBaseLastModified
          const totalCTOs = totalCTOsLoaded || 0;
          uploadMessage = `✅ Base de dados Atualizada com sucesso!<br>                  (${formatNumber(totalCTOs)} CTOs)`;

          event.target.value = '';
          uploadingBase = false;
        }
      } else {
        uploadSuccess = false;
        uploadMessage = data.error || 'Erro ao atualizar base de dados';
        uploadingBase = false;
      }
    } catch (err) {
      // Limpar polling se houver erro
      if (uploadPollInterval) {
        clearInterval(uploadPollInterval);
        uploadPollInterval = null;
      }
      
      uploadSuccess = false;
      uploadingBase = false;
      
      // Mensagens de erro mais específicas
      if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
        uploadMessage = 'Não foi possível conectar ao servidor. Verifique se o backend está online e tente novamente.';
      } else if (err.message.includes('CORS')) {
        uploadMessage = 'Erro de CORS. O servidor não está permitindo requisições do frontend.';
      } else if (err.message.includes('502')) {
        uploadMessage = 'Servidor não está respondendo (502 Bad Gateway). Verifique se o backend está online no Railway.';
      } else if (err.message.includes('504')) {
        uploadMessage = 'Timeout do servidor. O arquivo pode ser muito grande ou o processamento está demorando. Tente novamente.';
      } else {
        // Exibir mensagem de erro diretamente (já vem formatada do backend)
        uploadMessage = err.message;
      }
      
      console.error('❌ [Upload] Erro ao fazer upload da base:', err);
      console.error('❌ [Upload] Tipo do erro:', err.name);
      console.error('❌ [Upload] Mensagem:', err.message);
    }
  }
</script>

<!-- Tela de Configurações -->
<div 
  class="settings-screen" 
  on:keydown={(e) => e.key === 'Escape' && closeSettings()}
  role="dialog"
  aria-modal="true"
  tabindex="0"
  aria-labelledby="settings-title"
>
  <div class="settings-screen-content">
    <div class="settings-header">
      <h2 id="settings-title">Configurações</h2>
      <button class="settings-close" on:click={closeSettings} aria-label="Fechar configurações">×</button>
    </div>

    <div class="settings-body">
      <div class="settings-section">
        <h3>Projetistas</h3>
        {#if projetistasListFiltrada.length === 0}
          <p class="empty-message">Nenhum projetista cadastrado.</p>
        {:else}
          <div class="projetistas-list">
            {#each projetistasListFiltrada as projetista}
              <div class="projetista-item">
                <div class="projetista-name-wrapper">
                  <span 
                    class="projetista-name" 
                    title={onlineUsers && usersInfo ? getProjetistaTooltip(projetista) : 'Carregando...'}
                  >
                    {projetista}
                  </span>
                  {#key forceUpdate}
                    {#if isProjetistaOnline(projetista)}
                      <span class="online-indicator" title="Online">🟢</span>
                    {:else}
                      <span class="offline-indicator" title="Offline">🔴</span>
                    {/if}
                  {/key}
                </div>
                {#if userTipo === 'admin'}
                  <div class="projetista-actions">
                    {#if projetista.toLowerCase() !== currentUser.toLowerCase()}
                      <button 
                        class="btn-change-role" 
                        on:click={() => openChangeRoleModal(projetista)}
                        aria-label="Alterar tipo de {projetista}"
                        title="Alterar tipo de usuário"
                      >
                        👤
                      </button>
                      <button 
                        class="btn-delete" 
                        on:click={() => confirmDeleteProjetista(projetista)}
                        aria-label="Excluir {projetista}"
                        title="Excluir {projetista}"
                      >
                        🗑️
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        {#if userTipo === 'admin'}
          <div class="add-projetista-section">
            <button 
              class="btn-add" 
              on:click={openAddProjetistaModal}
              title="Adicionar novo projetista"
            >
              + Adicionar novo projetista
            </button>
          </div>
        {/if}
      </div>

      <div class="settings-section">
        <h3>Tabulações</h3>
        {#if tabulacoesList.length === 0}
          <p class="empty-message">Nenhuma tabulação cadastrada.</p>
        {:else}
          <div class="projetistas-list">
            {#each tabulacoesList as tabulacao}
              <div class="projetista-item">
                <span class="projetista-name">{tabulacao}</span>
                <button 
                  class="btn-delete" 
                  on:click={() => confirmDeleteTabulacao(tabulacao)}
                  aria-label="Excluir {tabulacao}"
                  title="Excluir {tabulacao}"
                >
                  🗑️
                </button>
              </div>
            {/each}
          </div>
        {/if}
        <div class="add-projetista-section">
          <button 
            class="btn-add" 
            on:click={openAddTabulacaoModal}
            title="Adicionar nova tabulação"
          >
            + Adicionar nova tabulação
          </button>
        </div>
      </div>

      <div class="settings-section">
        <h3>VI ALAs</h3>
        {#if viAlasList.length === 0}
          <p class="empty-message">Nenhum VI ALA gerado ainda.</p>
        {:else}
          <div class="projetistas-list">
            {#each viAlasList as viAla}
              <div class="projetista-item vi-ala-item">
                <div class="vi-ala-info">
                  <span class="projetista-name">{viAla.id || `VI ALA-${String(viAla.numero || 0).padStart(7, '0')}`}</span>
                  {#if viAla.numero_ala && viAla.numero_ala.trim()}
                    <span class="vi-ala-details">
                      {viAla.numero_ala.trim()}{#if viAla.projetista && viAla.projetista.trim()} - {viAla.projetista.trim()}{/if}
                    </span>
                  {:else if viAla.projetista && viAla.projetista.trim()}
                    <span class="vi-ala-details">
                      {viAla.projetista.trim()}
                    </span>
                  {/if}
                  {#if viAla.data_geracao && viAla.data_geracao.trim()}
                    <span class="vi-ala-date">
                      {(() => {
                        try {
                          let dateStr = String(viAla.data_geracao).trim();
                          
                          // Se for um objeto Date, converter para string ISO
                          if (dateStr instanceof Date) {
                            dateStr = dateStr.toISOString();
                          }
                          
                          let date = null;
                          
                          // Tentar parsear formato DD/MM/YYYY HH:MM ou DD/MM/YYYY
                          if (dateStr.includes('/')) {
                            const parts = dateStr.split(' ');
                            const datePart = parts[0]; // "DD/MM/YYYY"
                            const timePart = parts[1] || ''; // "HH:MM" ou vazio
                            
                            const dateComponents = datePart.split('/');
                            if (dateComponents.length === 3) {
                              const day = parseInt(dateComponents[0], 10);
                              const month = parseInt(dateComponents[1], 10) - 1; // Mês é 0-indexed no JavaScript
                              const year = parseInt(dateComponents[2], 10);
                              
                              if (timePart && timePart.includes(':')) {
                                // Tem hora: "DD/MM/YYYY HH:MM"
                                const timeComponents = timePart.split(':');
                                const hour = parseInt(timeComponents[0], 10);
                                const minute = parseInt(timeComponents[1], 10);
                                date = new Date(year, month, day, hour, minute);
                              } else {
                                // Só tem data: "DD/MM/YYYY"
                                date = new Date(year, month, day);
                              }
                            }
                          } else {
                            // Tentar parsear como ISO ou outro formato padrão
                            date = new Date(dateStr);
                          }
                          
                          // Verificar se a data é válida
                          if (date && !isNaN(date.getTime())) {
                            // Formatar data e hora usando locale brasileiro (timezone local do navegador)
                            const formattedDate = date.toLocaleDateString('pt-BR', {
                              day: '2-digit',
                              month: '2-digit',
                              year: 'numeric'
                            });
                            const formattedTime = date.toLocaleTimeString('pt-BR', {
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false
                            });
                            return `${formattedDate} - ${formattedTime}`;
                          }
                          
                          // Se não conseguir parsear, retornar original
                          return dateStr;
                        } catch (err) {
                          console.error('Erro ao formatar data do VI ALA:', err);
                          return String(viAla.data_geracao || '');
                        }
                      })()}
                    </span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
        <div class="vi-ala-download-section">
          <button 
            class="download-vi-ala-btn" 
            on:click={downloadViAlaBase}
            title="Baixar base de dados completa do VI ALA"
          >
            Baixar Base de Dados VI ALA
          </button>
        </div>
      </div>

      <div class="settings-section">
        <h3>Base de Dados</h3>
        <div class="upload-section">
          <div class="upload-button-container">
            <label for="baseFileInput" class="upload-label">
              <span>Carregar Nova Base de Dados</span>
              <input 
                type="file" 
                id="baseFileInput"
                accept=".xlsx,.xls"
                on:change={(e) => handleBaseUpload(e)}
                disabled={uploadingBase}
                style="display: none;"
              />
            </label>
          </div>
          
          {#if userTipo === 'admin'}
            <div class="delete-base-container" style="margin-top: 1rem;">
              <button 
                class="btn-delete-base" 
                on:click={() => showDeleteBaseModal = true}
                disabled={deletingBase || uploadingBase}
                title="Deletar todos os dados da base de dados CTO"
              >
                🗑️ Deletar Base Atual
              </button>
            </div>
          {/if}
          
          <!-- Botão para criar mancha de cobertura -->
          <div style="margin-top: 1.5rem;">
            <button 
              on:click={handleCreateCoverage}
              disabled={calculatingCoverage || uploadingBase || !baseDataExists}
              title={!baseDataExists ? 'É necessário carregar uma base de dados primeiro' : 'Criar nova mancha de cobertura baseada nas CTOs atuais'}
              style="width: 100%; padding: 0.75rem; background: {calculatingCoverage || uploadingBase || !baseDataExists ? '#ccc' : 'linear-gradient(135deg, #7B68EE 0%, #6495ED 100%)'}; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: {calculatingCoverage || uploadingBase || !baseDataExists ? 'not-allowed' : 'pointer'}; transition: all 0.3s; box-shadow: {calculatingCoverage || uploadingBase || !baseDataExists ? 'none' : '0 4px 6px rgba(123, 104, 238, 0.3)'}; opacity: {calculatingCoverage || uploadingBase || !baseDataExists ? '0.6' : '1'};"
              on:mouseenter={(e) => {
                if (!calculatingCoverage && !uploadingBase && baseDataExists) {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 6px 12px rgba(123, 104, 238, 0.4)';
                }
              }}
              on:mouseleave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = calculatingCoverage || uploadingBase || !baseDataExists ? 'none' : '0 4px 6px rgba(123, 104, 238, 0.3)';
              }}
            >
              {#if calculatingCoverage}
                ⏳ Criando Mancha de Cobertura...
              {:else}
                🗺️ Criar Nova Mancha de Cobertura
              {/if}
            </button>
          </div>
          
          {#if calculatingCoverage}
            <div class="progress-container" style="margin-top: 1rem;">
              <div class="progress-bar-wrapper">
                <div class="progress-label">
                  Calculando área de cobertura<span class="loading-dots">
                    <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
                  </span> {Math.round(uploadProgress.calculationPercent || 0)}%
                </div>
                <div class="progress-bar">
                  <div class="progress-fill" style="width: {uploadProgress.calculationPercent || 0}%;"></div>
                </div>
              </div>
            </div>
          {/if}
          
          {#if coverageMessage && !calculatingCoverage}
            <div class="upload-message" class:success={coverageSuccess} class:error={!coverageSuccess} style="margin-top: 1rem;">
              {coverageMessage}
            </div>
          {/if}
          
          {#if baseDataExists}
            {#if baseLastModified}
              <p class="last-modified-text">
                Última atualização: {baseLastModified.toLocaleDateString('pt-BR', { 
                  day: '2-digit', 
                  month: '2-digit', 
                  year: 'numeric'
                })} - {baseLastModified.toLocaleTimeString('pt-BR', {
                  hour: '2-digit', 
                  minute: '2-digit'
                })}
              </p>
            {:else}
              <p class="last-modified-text" style="color: #7B68EE;">
                Base de dados carregada (data de atualização não disponível)
              </p>
            {/if}
          {:else}
            <p class="last-modified-text" style="color: #7B68EE;">
              Não consta nenhuma base de dados
            </p>
          {/if}
          
          {#if coverageLastModified}
            <p class="last-modified-text" style="margin-top: 0.5rem;">
              Última atualização da Mancha de Cobertura: {coverageLastModified.toLocaleDateString('pt-BR', { 
                day: '2-digit', 
                month: '2-digit', 
                year: 'numeric'
              })} - {coverageLastModified.toLocaleTimeString('pt-BR', {
                hour: '2-digit', 
                minute: '2-digit'
              })}
            </p>
          {/if}
          
          {#if uploadingBase}
            <div class="progress-container" style="margin-top: 1rem;">
              <div class="progress-bar-wrapper">
                <div class="progress-label">
                  Carregando<span class="loading-dots">
                    <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
                  </span> {Math.round(displayedPercent)}%
                </div>
                <div class="progress-bar">
                  <div class="progress-fill" style="width: {displayedPercent}%;"></div>
                </div>
              </div>
            </div>
          {/if}

          {#if uploadMessage && !uploadingBase}
            <div class="upload-message" class:success={uploadSuccess} class:error={!uploadSuccess}>
              {@html uploadMessage}
            </div>
          {/if}
        </div>
      </div>

    </div>
  </div>
</div>

<!-- Modal de Confirmação de Exclusão de Projetista -->
{#if showDeleteConfirmModal}
  <div 
    class="modal-overlay confirm-overlay" 
    on:click={closeDeleteConfirmModal}
    on:keydown={(e) => e.key === 'Escape' && closeDeleteConfirmModal()}
    role="button"
    tabindex="-1"
    aria-label="Fechar modal"
  >
    <div 
      class="modal-content confirm-modal" 
      on:click|stopPropagation
      on:keydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div class="modal-header">
        <h2 id="confirm-title">Confirmar Exclusão</h2>
        <button class="modal-close" on:click={closeDeleteConfirmModal} aria-label="Fechar modal">×</button>
      </div>

      <div class="modal-body">
        <div class="confirm-message">
          <p>Deseja realmente excluir o projetista <strong>"{projetistaToDelete}"</strong>?</p>
          <p class="confirm-warning">Esta ação não pode ser desfeita.</p>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn-cancel" on:click={closeDeleteConfirmModal}>Cancelar</button>
          <button type="button" class="btn-delete-confirm" on:click={deleteProjetista}>
            Excluir
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Modal de Confirmação de Exclusão de Tabulação -->
{#if showDeleteTabulacaoModal}
  <div 
    class="modal-overlay confirm-overlay" 
    on:click={closeDeleteTabulacaoModal}
    on:keydown={(e) => e.key === 'Escape' && closeDeleteTabulacaoModal()}
    role="button"
    tabindex="-1"
    aria-label="Fechar modal"
  >
    <div 
      class="modal-content confirm-modal" 
      on:click|stopPropagation
      on:keydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="confirm-tabulacao-title"
    >
      <div class="modal-header">
        <h2 id="confirm-tabulacao-title">Confirmar Exclusão</h2>
        <button class="modal-close" on:click={closeDeleteTabulacaoModal} aria-label="Fechar modal">×</button>
      </div>

      <div class="modal-body">
        <div class="confirm-message">
          <p>Deseja realmente excluir a tabulação <strong>"{tabulacaoToDelete}"</strong>?</p>
          <p class="confirm-warning">Esta ação não pode ser desfeita.</p>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn-cancel" on:click={closeDeleteTabulacaoModal}>Cancelar</button>
          <button type="button" class="btn-delete-confirm" on:click={deleteTabulacao}>
            Excluir
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Modal de Adicionar Projetista -->
{#if showAddProjetistaModal}
  <div 
    class="modal-overlay confirm-overlay" 
    on:click={closeAddProjetistaModal}
    on:keydown={(e) => e.key === 'Escape' && closeAddProjetistaModal()}
    role="button"
    tabindex="-1"
    aria-label="Fechar modal"
  >
    <div 
      class="modal-content confirm-modal" 
      on:click|stopPropagation
      on:keydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="add-projetista-title"
    >
      <div class="modal-header">
        <h2 id="add-projetista-title">Adicionar Novo Projetista</h2>
        <button class="modal-close" on:click={closeAddProjetistaModal} aria-label="Fechar modal">×</button>
      </div>

      <div class="modal-body">
        <form on:submit|preventDefault={addProjetista}>
          <div class="form-group">
            <label for="projetistaNome">Nome de usuário <span class="required">*</span></label>
            <input 
              type="text" 
              id="projetistaNome"
              bind:value={newProjetistaName}
              placeholder="Digite o nome do projetista"
              required
              class:error={projetistaError && !newProjetistaName.trim()}
            />
          </div>

          <div class="form-group">
            <label for="projetistaSenha">Senha <span class="required">*</span></label>
            <div class="password-input-wrapper">
              {#if showProjetistaPassword}
                <input 
                  type="text"
                  id="projetistaSenha"
                  bind:value={newProjetistaSenha}
                  placeholder="Digite a senha"
                  required
                  class:error={projetistaError && !newProjetistaSenha.trim()}
                />
              {:else}
                <input 
                  type="password"
                  id="projetistaSenha"
                  bind:value={newProjetistaSenha}
                  placeholder="Digite a senha"
                  required
                  class:error={projetistaError && !newProjetistaSenha.trim()}
                />
              {/if}
              <button 
                type="button"
                class="password-toggle"
                on:click={() => showProjetistaPassword = !showProjetistaPassword}
                aria-label={showProjetistaPassword ? 'Ocultar senha' : 'Mostrar senha'}
                title={showProjetistaPassword ? 'Ocultar senha' : 'Mostrar senha'}
              >
                {#if showProjetistaPassword}
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

          {#if projetistaError}
            <div class="error-message-modal">
              {projetistaError}
            </div>
          {/if}

          <div class="modal-actions">
            <button type="button" class="btn-cancel" on:click={closeAddProjetistaModal}>Cancelar</button>
            <button type="submit" class="btn-add-confirm">
              Adicionar
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
{/if}

<!-- Modal de Alterar Tipo de Usuário -->
{#if showChangeRoleModal}
  <div 
    class="modal-overlay" 
    on:click={closeChangeRoleModal}
    on:keydown={(e) => e.key === 'Escape' && closeChangeRoleModal()}
    role="button"
    tabindex="-1"
    aria-label="Fechar modal"
  >
    <div 
      class="modal-content" 
      on:click|stopPropagation
      on:keydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="change-role-title"
    >
      <div class="modal-header">
        <h2 id="change-role-title">Alterar Tipo de Usuário</h2>
        <button class="modal-close" on:click={closeChangeRoleModal} aria-label="Fechar modal">×</button>
      </div>

      <div class="modal-body">
        {#if loadingChangeRole}
          <div class="change-role-loading">
            <div class="spinner"></div>
          </div>
        {:else}
          <form on:submit|preventDefault={changeUserRole}>
            <div class="form-group">
              <label for="projetistaNomeRole">Usuário</label>
              <input 
                type="text" 
                id="projetistaNomeRole"
                value={projetistaToChangeRole}
                disabled
                readonly
              />
            </div>

            <div class="form-group">
              <label for="projetistaSenhaRole">Senha</label>
              <input 
                type="text" 
                id="projetistaSenhaRole"
                value={projetistaSenha}
                disabled
                readonly
              />
            </div>

            <div class="form-group">
              <label for="userRole">Tipo de Usuário</label>
              <select 
                id="userRole"
                bind:value={newRole}
                required
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <div class="form-group">
              <label for="toolsPermissions">Permissões de Ferramentas</label>
              <div class="tools-permissions-grid">
                {#each getToolsForPermissions() as tool (tool.id)}
                  <div class="tool-permission-card" class:active={toolPermissions[tool.id] === true}>
                    <label class="tool-permission-label">
                      <input 
                        type="checkbox" 
                        id="tool-{tool.id}"
                        checked={toolPermissions[tool.id] || false}
                        on:change={() => toggleToolPermission(tool.id)}
                        class="tool-checkbox-hidden"
                      />
                      <div class="tool-checkbox-custom"></div>
                      <span class="tool-title">{tool.title}</span>
                    </label>
                  </div>
                {/each}
              </div>
            </div>

            {#if changeRoleError}
              <div class="error-message-modal">
                {changeRoleError}
              </div>
            {/if}

            <div class="modal-actions">
              <button type="button" class="btn-cancel" on:click={closeChangeRoleModal}>Cancelar</button>
              <button type="submit" class="btn-add-confirm">
                Alterar Tipo
              </button>
            </div>
          </form>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- Modal de Confirmação de Exclusão de Base -->
{#if showDeleteBaseModal}
  <div 
    class="modal-overlay confirm-overlay" 
    on:click={closeDeleteBaseModal}
    on:keydown={(e) => e.key === 'Escape' && closeDeleteBaseModal()}
    role="button"
    tabindex="-1"
    aria-label="Fechar modal"
  >
    <div 
      class="modal-content confirm-modal" 
      on:click|stopPropagation
      on:keydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="confirm-delete-base-title"
    >
      <div class="modal-header">
        <h2 id="confirm-delete-base-title">Confirmar Exclusão</h2>
        <button class="modal-close" on:click={closeDeleteBaseModal} aria-label="Fechar modal">×</button>
      </div>

      <div class="modal-body">
        <div class="confirm-message">
          <p>Deseja realmente <strong>deletar TODOS os dados</strong> da base de dados CTO?</p>
          <p class="confirm-warning">⚠️ Esta ação é IRREVERSÍVEL e irá apagar todos os dados da tabela <strong>ctos</strong> no Supabase.</p>
          <p class="confirm-warning">Você precisará fazer upload de uma nova base para restaurar os dados.</p>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn-cancel" on:click={closeDeleteBaseModal} disabled={deletingBase}>
            Cancelar
          </button>
          <button type="button" class="btn-delete-confirm" on:click={deleteBase} disabled={deletingBase}>
            {deletingBase ? 'Deletando...' : 'Sim, Deletar Base'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Modal de Adicionar Tabulação -->
{#if showAddTabulacaoModal}
  <div 
    class="modal-overlay confirm-overlay" 
    on:click={closeAddTabulacaoModal}
    on:keydown={(e) => e.key === 'Escape' && closeAddTabulacaoModal()}
    role="button"
    tabindex="-1"
    aria-label="Fechar modal"
  >
    <div 
      class="modal-content confirm-modal" 
      on:click|stopPropagation
      on:keydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-labelledby="add-tabulacao-title"
    >
      <div class="modal-header">
        <h2 id="add-tabulacao-title">Adicionar Nova Tabulação</h2>
        <button class="modal-close" on:click={closeAddTabulacaoModal} aria-label="Fechar modal">×</button>
      </div>

      <div class="modal-body">
        <form on:submit|preventDefault={addTabulacao}>
          <div class="form-group">
            <label for="newTabulacaoName">Nome da Tabulação <span class="required">*</span></label>
            <input 
              type="text" 
              id="newTabulacaoName"
              bind:value={newTabulacaoName}
              placeholder="Digite o nome da tabulação"
              required
              class:error={tabulacaoError && !newTabulacaoName.trim()}
            />
          </div>

          {#if tabulacaoError}
            <div class="error-message-modal">
              {tabulacaoError}
            </div>
          {/if}

          <div class="modal-actions">
            <button type="button" class="btn-cancel" on:click={closeAddTabulacaoModal}>Cancelar</button>
            <button type="submit" class="btn-add-confirm">
              Adicionar
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
{/if}


<style>
  /* Tela de Configurações - Fullscreen */
  .settings-screen {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    background: linear-gradient(135deg, rgba(123, 104, 238, 0.7) 0%, rgba(100, 149, 237, 0.7) 100%) !important;
    z-index: 10002 !important;
    display: flex !important;
    flex-direction: column;
    overflow-y: auto;
    animation: slideInSettings 0.3s ease-out;
  }

  @keyframes slideInSettings {
    from {
      opacity: 0;
      transform: translateX(100%);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .settings-screen-content {
    width: 100%;
    max-width: 1400px;
    margin: 0 auto;
    padding: 0;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    position: relative;
  }

  .settings-screen-content::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 0;
  }

  .settings-screen-content > * {
    position: relative;
    z-index: 1;
  }

  .settings-header {
    background: linear-gradient(135deg, rgba(123, 104, 238, 0.95) 0%, rgba(100, 149, 237, 0.95) 100%);
    color: white;
    padding: 1rem 2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    box-shadow: 0 4px 6px rgba(0,0,0,0.2);
    backdrop-filter: blur(10px);
    width: 100vw;
    margin-left: calc(-50vw + 50%);
    position: relative;
    z-index: 10;
    box-sizing: border-box;
  }

  .settings-header h2 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
    color: white;
  }

  .settings-close {
    background: rgba(255, 255, 255, 0.2);
    border: none;
    color: white;
    font-size: 1.75rem;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    line-height: 1;
    padding: 0;
    position: relative;
    z-index: 11;
    flex-shrink: 0;
    margin-left: auto;
  }

  .settings-close:hover {
    background: rgba(255, 255, 255, 0.3);
    transform: rotate(90deg);
  }

  .settings-body {
    flex: 1;
    padding: 2rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    gap: 2rem;
    align-content: start;
  }

  .settings-section {
    background: rgba(255, 255, 255, 0.95);
    padding: 1.5rem;
    border-radius: 12px;
    box-shadow: 2px 0 8px rgba(0,0,0,0.15);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.5);
  }

  @media (max-width: 900px) {
    .settings-body {
      grid-template-columns: 1fr;
    }
  }

  .settings-section h3 {
    color: #7B68EE;
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0 0 1.5rem 0;
    padding-bottom: 0.75rem;
    border-bottom: 2px solid #7B68EE;
  }

  .empty-message {
    color: #666;
    font-size: 0.9rem;
    margin: 1rem 0;
    text-align: center;
    padding: 1rem;
    background: rgba(123, 104, 238, 0.05);
    border-radius: 8px;
    border: 1px dashed rgba(123, 104, 238, 0.2);
  }

  .projetistas-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-height: 500px;
    overflow-y: auto;
    padding-right: 0.5rem;
  }

  .projetistas-list::-webkit-scrollbar {
    width: 6px;
  }

  .projetistas-list::-webkit-scrollbar-track {
    background: #f1f1f1;
    border-radius: 3px;
  }

  .projetistas-list::-webkit-scrollbar-thumb {
    background: #7B68EE;
    border-radius: 3px;
  }

  .projetista-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    background: #ffffff;
    border: 1px solid #E0E0E0;
    border-radius: 8px;
    transition: all 0.2s ease;
  }

  .projetista-item.vi-ala-item {
    align-items: flex-start;
  }

  .projetista-item:hover {
    background: #f8f9ff;
    border-color: #7B68EE;
    box-shadow: 0 2px 8px rgba(123, 104, 238, 0.1);
  }

  .projetista-name {
    font-size: 0.95rem;
    color: #333;
    font-weight: 500;
    flex: 1;
  }
  
  .online-indicator {
    font-size: 0.75rem;
    display: inline-block;
    animation: pulse 2s ease-in-out infinite;
  }
  
  .offline-indicator {
    font-size: 0.75rem;
    display: inline-block;
    opacity: 0.7;
  }
  
  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.6;
    }
  }


  .vi-ala-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1;
    width: 100%;
  }

  .vi-ala-info .projetista-name {
    font-weight: 600;
    color: #7B68EE;
    font-size: 1rem;
  }

  .vi-ala-details {
    font-size: 0.85rem;
    color: #666;
    font-weight: 400;
  }

  .vi-ala-date {
    font-size: 0.75rem;
    color: #999;
    font-weight: 400;
    margin-top: 0.25rem;
  }

  .vi-ala-download-section {
    margin-top: 1rem;
    display: flex;
    justify-content: center;
  }

  .download-vi-ala-btn {
    width: 100%;
    padding: 0.875rem 1.5rem;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.95rem;
    transition: all 0.3s ease;
    box-shadow: 0 4px 6px rgba(123, 104, 238, 0.3);
    font-family: 'Inter', sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }

  .download-vi-ala-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 12px rgba(123, 104, 238, 0.4);
  }

  .download-vi-ala-btn:active {
    transform: translateY(0);
  }

  .download-vi-ala-btn:focus {
    outline: none;
    box-shadow: 
      0 0 0 3px rgba(123, 104, 238, 0.2),
      0 4px 6px rgba(123, 104, 238, 0.3);
  }

  .btn-delete {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    font-size: 0.9rem;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 36px;
    height: 36px;
  }

  .btn-delete:hover {
    background: linear-gradient(135deg, #8B7AE8 0%, #7499F0 100%);
    transform: translateY(-1px);
    box-shadow: 0 2px 6px rgba(123, 104, 238, 0.3);
  }

  .btn-delete:active {
    transform: translateY(0);
  }

  .projetista-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .btn-change-role {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    font-size: 1rem;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .btn-change-role:hover {
    background: linear-gradient(135deg, #8B7AE8 0%, #7499F0 100%);
    transform: translateY(-1px);
    box-shadow: 0 2px 6px rgba(123, 104, 238, 0.3);
  }

  .btn-change-role:active {
    transform: translateY(0);
  }

  /* Modal Styles */
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
    z-index: 10003;
    padding: 20px;
  }

  .confirm-overlay {
    z-index: 10003 !important;
    background: rgba(0, 0, 0, 0.7);
  }

  .modal-content {
    background: white;
    border-radius: 12px;
    max-width: 700px;
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
    position: relative;
    min-height: 200px;
  }

  .change-role-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 300px;
    width: 100%;
  }

  .change-role-loading .spinner {
    width: 48px;
    height: 48px;
    border: 4px solid rgba(123, 104, 238, 0.2);
    border-top-color: #7B68EE;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .modal-actions {
    display: flex;
    gap: 1rem;
    justify-content: flex-end;
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid #ddd;
  }

  .btn-cancel {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s;
    font-family: 'Inter', sans-serif;
    background: #e0e0e0;
    color: #333;
  }

  .btn-cancel:hover {
    background: #d0d0d0;
  }

  .confirm-modal {
    max-width: 450px;
  }

  .confirm-message {
    text-align: center;
    padding: 1rem 0;
  }

  .confirm-message p {
    margin: 0.75rem 0;
    font-size: 1rem;
    color: #333;
    line-height: 1.6;
  }

  .confirm-message strong {
    color: #7B68EE;
    font-weight: 600;
  }

  .confirm-warning {
    color: #F44336 !important;
    font-size: 0.9rem !important;
    font-weight: 500;
    margin-top: 1rem !important;
  }

  .btn-delete-confirm {
    background: linear-gradient(135deg, #F44336 0%, #E53935 100%);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.75rem 1.5rem;
    cursor: pointer;
    font-size: 1rem;
    font-weight: 600;
    transition: all 0.3s ease;
    margin-left: 0.5rem;
    box-shadow: 0 4px 6px rgba(244, 67, 54, 0.3);
  }

  .btn-delete-confirm:hover:not(:disabled) {
    background: linear-gradient(135deg, #EF5350 0%, #E53935 100%);
    transform: translateY(-2px);
    box-shadow: 0 6px 12px rgba(244, 67, 54, 0.4);
  }

  .btn-delete-confirm:active:not(:disabled) {
    transform: translateY(0);
  }

  .btn-delete-confirm:disabled {
    background: #ccc;
    cursor: not-allowed;
    opacity: 0.6;
    box-shadow: none;
  }

  .add-projetista-section {
    margin-top: 1rem;
    display: flex;
    justify-content: center;
  }

  .btn-add {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: 'Inter', sans-serif;
  }

  .btn-add:hover {
    background: linear-gradient(135deg, #8B7AE8 0%, #7499F0 100%);
    transform: translateY(-1px);
    box-shadow: 0 4px 8px rgba(123, 104, 238, 0.3);
  }

  .form-group {
    margin-bottom: 1.5rem;
  }

  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 600;
    color: #333;
    font-size: 0.9375rem;
  }

  .required {
    color: #F44336;
  }

  .form-group input {
    width: 100%;
    padding: 0.75rem;
    border: 2px solid #E2E8F0;
    border-radius: 8px;
    font-size: 0.9375rem;
    font-family: 'Inter', sans-serif;
    transition: all 0.2s ease;
    box-sizing: border-box;
  }

  .form-group input:focus {
    outline: none;
    border-color: #7B68EE;
    box-shadow: 0 0 0 3px rgba(123, 104, 238, 0.1);
  }

  .form-group select {
    width: 100%;
    padding: 0.75rem;
    border: 2px solid #E2E8F0;
    border-radius: 8px;
    font-size: 0.9375rem;
    font-family: 'Inter', sans-serif;
    transition: all 0.2s ease;
    box-sizing: border-box;
    background: #FFFFFF;
    color: #333;
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%237B68EE' d='M6 9L1 4h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    padding-right: 2.5rem;
  }

  .form-group select:focus {
    outline: none;
    border-color: #7B68EE;
    box-shadow: 0 0 0 3px rgba(123, 104, 238, 0.1);
  }

  .form-group select:hover {
    border-color: #7B68EE;
  }

  /* Estilos para permissões de ferramentas - Cards com checkbox à esquerda */

  .tools-permissions-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }

  .tool-permission-card {
    position: relative;
    border: 2px solid #E2E8F0;
    border-radius: 12px;
    background: #FFFFFF;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    overflow: visible;
    cursor: pointer;
    width: 100%;
    min-width: 0;
    display: block;
  }
  
  .tool-permission-card > * {
    display: flex !important;
    flex-direction: row !important;
    flex-wrap: nowrap !important;
  }

  .tool-permission-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    transform: scaleX(0);
    transition: transform 0.3s ease;
  }

  .tool-permission-card:hover {
    border-color: #7B68EE;
    box-shadow: 0 4px 12px rgba(123, 104, 238, 0.15);
    transform: translateY(-2px);
  }

  .tool-permission-card.active {
    border-color: #7B68EE;
    background: linear-gradient(135deg, rgba(123, 104, 238, 0.05) 0%, rgba(100, 149, 237, 0.05) 100%);
    box-shadow: 0 4px 12px rgba(123, 104, 238, 0.2);
  }

  .tool-permission-card.active::before {
    transform: scaleX(1);
  }

  .tool-permission-label {
    display: flex !important;
    flex-direction: row !important;
    flex-wrap: nowrap !important;
    align-items: center !important;
    gap: 1rem;
    padding: 1.25rem;
    cursor: pointer;
    user-select: none;
    position: relative;
    width: 100%;
    box-sizing: border-box;
  }

  .tool-checkbox-hidden {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }

  .tool-checkbox-custom {
    width: 24px !important;
    height: 24px !important;
    min-width: 24px !important;
    max-width: 24px !important;
    border: 2px solid #CBD5E0;
    border-radius: 6px;
    background: #FFFFFF;
    display: inline-flex !important;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    flex-shrink: 0 !important;
    flex-grow: 0 !important;
    position: relative;
    vertical-align: middle;
  }

  .tool-permission-card.active .tool-checkbox-custom {
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    border-color: #7B68EE;
    box-shadow: 0 2px 8px rgba(123, 104, 238, 0.3);
  }

  .tool-permission-card.active .tool-checkbox-custom::after {
    content: '';
    position: absolute;
    width: 6px;
    height: 10px;
    border: solid white;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
    top: 4px;
    left: 7px;
  }

  .tool-permission-card:hover .tool-checkbox-custom {
    border-color: #7B68EE;
  }

  .tool-title {
    font-size: 0.9375rem;
    font-weight: 600;
    color: #2D3748;
    line-height: 1.2;
    flex: 1;
    margin: 0;
    padding: 0;
    white-space: nowrap !important;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    display: inline-block !important;
    vertical-align: middle;
  }

  .tool-permission-card.active .tool-title {
    color: #7B68EE;
  }

  /* Responsividade */
  @media (max-width: 768px) {
    .tools-permissions-grid {
      grid-template-columns: 1fr;
    }
  }

  .form-group input.error {
    border-color: #F44336;
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

  .upload-section {
    margin-top: 0.5rem;
    text-align: center;
  }

  .upload-button-container {
    display: flex;
    justify-content: center;
    margin-bottom: 1rem;
  }

  .upload-label {
    display: inline-block;
    padding: 0.875rem 1.5rem;
    background: linear-gradient(135deg, #7B68EE 0%, #6495ED 100%);
    color: white;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.95rem;
    transition: all 0.3s ease;
    box-shadow: 0 4px 6px rgba(123, 104, 238, 0.3);
  }

  .upload-label:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 12px rgba(123, 104, 238, 0.4);
  }

  .upload-label:active {
    transform: translateY(0);
  }

  .upload-hint {
    font-size: 0.875rem;
    color: #666;
    margin: 0.75rem 0;
    line-height: 1.5;
  }

  .last-modified-text {
    font-size: 0.875rem;
    color: #7B68EE;
    margin: 1rem 0 0.5rem 0;
    font-weight: 600;
  }

  .upload-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    margin: 1rem 0;
    padding: 1rem;
    background: rgba(123, 104, 238, 0.1);
    border-radius: 8px;
    color: #7B68EE;
    font-size: 0.9rem;
    font-weight: 500;
    border: 1px solid rgba(123, 104, 238, 0.2);
  }

  .loading-spinner {
    width: 20px;
    height: 20px;
    border: 3px solid rgba(123, 104, 238, 0.2);
    border-top-color: #7B68EE;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .upload-message {
    margin: 1rem 0;
    padding: 1rem;
    border-radius: 8px;
    font-size: 0.9rem;
    line-height: 1.5;
    white-space: pre-line;
    font-weight: 500;
  }

  .upload-message.success {
    background: rgba(76, 175, 80, 0.1);
    border: 1px solid #4CAF50;
    color: #2e7d32;
  }

  .upload-message.error {
    background: rgba(244, 67, 54, 0.1);
    border: 1px solid #F44336;
    color: #c62828;
  }

  .progress-container {
    margin-top: 1rem;
  }

  .progress-bar-wrapper {
    margin-bottom: 0.5rem;
  }

  .progress-label {
    font-size: 0.85rem;
    color: #7B68EE;
    margin-bottom: 0.5rem;
    font-weight: 500;
  }

  .loading-dots {
    display: inline-block;
  }

  .loading-dots .dot {
    display: inline-block;
    animation: loading-dot 1.4s infinite;
    animation-fill-mode: both;
  }

  .loading-dots .dot:nth-child(1) {
    animation-delay: 0s;
  }

  .loading-dots .dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .loading-dots .dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes loading-dot {
    0%, 80%, 100% {
      opacity: 0.3;
    }
    40% {
      opacity: 1;
    }
  }

  .progress-bar {
    width: 100%;
    height: 24px;
    background: rgba(123, 104, 238, 0.1);
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid rgba(123, 104, 238, 0.2);
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #7B68EE 0%, #9C88FF 100%);
    border-radius: 12px;
    transition: width 0.3s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .delete-base-container {
    display: flex;
    justify-content: center;
    margin-top: 1rem;
  }

  .btn-delete-base {
    width: 100%;
    padding: 0.75rem 1.5rem;
    background: linear-gradient(135deg, #F44336 0%, #E53935 100%);
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    transition: all 0.3s ease;
    box-shadow: 0 4px 6px rgba(244, 67, 54, 0.3);
    font-family: 'Inter', sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }

  .btn-delete-base:hover:not(:disabled) {
    background: linear-gradient(135deg, #EF5350 0%, #E53935 100%);
    transform: translateY(-2px);
    box-shadow: 0 6px 12px rgba(244, 67, 54, 0.4);
  }

  .btn-delete-base:active:not(:disabled) {
    transform: translateY(0);
  }

  .btn-delete-base:disabled {
    background: #ccc;
    cursor: not-allowed;
    opacity: 0.6;
  }

  .btn-delete-base:focus {
    outline: none;
    box-shadow: 
      0 0 0 3px rgba(244, 67, 54, 0.2),
      0 4px 6px rgba(244, 67, 54, 0.3);
  }
</style>

