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
  let isLoading = false;
  let loadingMessage = '';
  let showSettingsModal = false;
  let loadingCTOs = false;
  let baseDataExists = true;
  
  // Estados de cálculo de cobertura (removido - cálculo agora é feito apenas em Config.svelte)
  
  // Google Maps
  let map;
  let mapElement;
  let googleMapsLoaded = false;
  let mapInitialized = false;
  const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  let coveragePolygons = []; // Array para armazenar polígonos de cobertura do backend
  let searchMarkers = []; // Array para armazenar marcadores de busca
  let coverageData = null; // Dados do polígono de cobertura (metadados)
  let coveragePolygonGeoJSON = null; // GeoJSON do polígono de cobertura
  
  // Campos de busca
  let enderecoInput = '';
  let coordenadasInput = '';
  let searchMode = 'endereco'; // 'endereco' ou 'coordenadas'
  
  // Resultados
  let error = null;
  
  // Redimensionamento de boxes
  let sidebarWidth = 400;
  // mapHeightPixels removido - mapa agora usa toda altura disponível
  let isResizingSidebar = false;
  let isResizingMap = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartSidebarWidth = 0;
  let resizeStartMapHeight = 0;
  
  // Estados de minimização
  let isSearchPanelMinimized = false;
  // isMapMinimized removido - mapa não pode ser minimizado nesta ferramenta
  
  // Controles de visualização
  let coverageOpacity = 0.4; // Opacidade das manchas (0-1)
  
  // Reactive statements
  $: sidebarWidthStyle = `${sidebarWidth}px`;
  // mapHeightStyle removido - mapa agora usa toda altura disponível
  $: coverageOpacityPercent = Math.round(coverageOpacity * 100);

  // Função para abrir configurações
  function openSettings() {
    showSettingsModal = true;
  }

  // Função para pré-carregar configurações no hover
  function preloadSettingsData() {
    // Pré-carregar dados se necessário
  }

  // Carregar biblioteca do Google Maps
  async function loadGoogleMaps() {
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
      
      const loader = new Loader({
        apiKey: GOOGLE_MAPS_API_KEY,
        version: 'weekly',
        libraries: ['places', 'geometry']
      });
      
      await loader.load();
      googleMapsLoaded = true;
      console.log('✅ Google Maps carregado');
    } catch (err) {
      if (err.message && err.message.includes('Loader must not be called again')) {
        console.warn('Google Maps Loader já foi chamado, verificando disponibilidade global...');
        if (typeof google !== 'undefined' && google.maps) {
          console.log('✅ Google Maps disponível globalmente');
          googleMapsLoaded = true;
          return;
        }
      }
      console.error('Erro ao carregar Google Maps:', err);
      throw err;
    }
  }

  // Inicializar o mapa
  function initMap() {
    if (!googleMapsLoaded) {
      console.warn('⚠️ Google Maps não está carregado');
      return;
    }

    const mapElement = document.getElementById('map-consulta');
    if (!mapElement) {
      console.warn('⚠️ Elemento do mapa não encontrado no DOM');
      return;
    }

    try {
      // Centralizar no Brasil (Fortaleza como padrão, mas ajustará para mostrar todas as CTOs)
      map = new google.maps.Map(mapElement, {
        center: { lat: -3.7172, lng: -38.5433 }, // Fortaleza
        zoom: 12,
        mapTypeControl: true,
        streetViewControl: true,
        fullscreenControl: true,
        scrollwheel: true,
        gestureHandling: 'greedy'
      });
      
      mapInitialized = true;
      console.log('✅ Mapa inicializado com sucesso');
    } catch (err) {
      console.error('❌ Erro ao inicializar mapa:', err);
      map = null;
    }
  }

  // Carregar polígono de cobertura do backend (versão otimizada)
  async function loadCoveragePolygon() {
    try {
      loadingMessage = 'Carregando polígonos de cobertura...';
      console.log('📥 Carregando polígono de cobertura do backend...');
      
      const response = await fetch(getApiUrl('/api/coverage/polygon?simplified=true'));
      
      if (!response.ok) {
        console.warn('⚠️ Não foi possível carregar polígonos de cobertura:', response.status);
        return false; // Não lançar erro, apenas retornar false
      }
      
      const data = await response.json();
      
      if (!data.success) {
        console.warn('⚠️ Nenhum polígono de cobertura encontrado. Execute o cálculo primeiro.');
        return false; // Não lançar erro, apenas retornar false
      }
      
      coverageData = data;
      coveragePolygonGeoJSON = data.geometry;
      
      console.log(`✅ Polígono de cobertura carregado: ${data.total_ctos} CTOs, ${data.area_km2?.toFixed(2)} km²`);
      
      return true;
    } catch (err) {
      console.warn('⚠️ Erro ao carregar polígono de cobertura:', err);
      return false; // Não lançar erro, apenas retornar false
    }
  }

  // Funções de cálculo removidas - cálculo agora é feito apenas em Config.svelte

  // Função antiga removida - não é mais usada (substituída por loadCoveragePolygon)
  // Mantida apenas como placeholder para evitar erros de referência
  async function loadAllCTOs() {
    // Função não é mais usada - polígonos são carregados via loadCoveragePolygon()
    console.warn('⚠️ loadAllCTOs() não é mais usada. Use loadCoveragePolygon() em vez disso.');
    return [];
  }
  
  // Código antigo removido - não é mais necessário (comentado para evitar erros)
  /*
  async function loadAllCTOs_OLD() {
    try {
      loadingMessage = 'Criando grade de cobertura completa...';
      console.log('📥 Carregando TODAS as CTOs da base de dados usando grade otimizada...');
      
      // Estratégia: Dividir o Brasil em uma grade de células menores
      // Isso garante que pegamos TODAS as CTOs, mesmo que a API tenha limite de 1000 resultados
      // Limites aproximados do Brasil: Lat: -33.7 a 5.2, Lng: -73.9 a -34.7
      const BRAZIL_BOUNDS = {
        minLat: -33.7,
        maxLat: 5.2,
        minLng: -73.9,
        maxLng: -34.7
      };
      
      // Tamanho da célula OTIMIZADO: 300km x 300km (raio de 150km por célula)
      // Células MUITO maiores = MUITO menos requisições = carregamento MUITO mais rápido
      // IMPORTANTE: Usar raio maior que metade da célula para garantir sobreposição
      const CELL_SIZE_KM = 300; // Aumentado de 200km para 300km para reduzir requisições
      const CELL_RADIUS_M = (CELL_SIZE_KM / 2) * 1000 * 1.2; // Raio 20% maior para sobreposição (180km)
      const CELL_SIZE_DEG = CELL_SIZE_KM / 111; // Aproximação: 1 grau ≈ 111km
      
      // Calcular número de células necessárias
      const latRange = BRAZIL_BOUNDS.maxLat - BRAZIL_BOUNDS.minLat;
      const lngRange = BRAZIL_BOUNDS.maxLng - BRAZIL_BOUNDS.minLng;
      const cellsLat = Math.ceil(latRange / CELL_SIZE_DEG);
      const cellsLng = Math.ceil(lngRange / CELL_SIZE_DEG);
      
      console.log(`📊 Criando grade de ${cellsLat}x${cellsLng} células (${cellsLat * cellsLng} células total)`);
      
      // Gerar todas as células da grade
      const cells = [];
      for (let i = 0; i < cellsLat; i++) {
        for (let j = 0; j < cellsLng; j++) {
          const cellLat = BRAZIL_BOUNDS.minLat + (i * CELL_SIZE_DEG) + (CELL_SIZE_DEG / 2);
          const cellLng = BRAZIL_BOUNDS.minLng + (j * CELL_SIZE_DEG) + (CELL_SIZE_DEG / 2);
          cells.push({ lat: cellLat, lng: cellLng, radius: CELL_RADIUS_M, index: i * cellsLng + j });
        }
      }
      
      console.log(`📊 ${cells.length} células criadas, iniciando buscas...`);
      
      // Atualizar estatísticas de loading
      loadingStats.totalCells = cells.length;
      loadingStats.cellsProcessed = 0;
      loadingStats.totalRequests = 0;
      loadingStats.cellsWithLimit = 0;
      loadingStats.cellsWithErrors = 0;
      loadingStats.ctoCount = 0;
      
      const allCTOsMap = new Map(); // Usar Map para evitar duplicatas por coordenadas
      let cellsProcessed = 0;
      let totalRequests = 0;
      const cellsWithLimit = []; // Células que retornaram 1000+ CTOs (possível limite)
      const cellsWithErrors = []; // Células que tiveram erros
      let totalCTOsLoaded = 0;
      
      // Processar células em lotes MÁXIMOS para velocidade extrema
      // Paralelismo TOTAL = carregamento ULTRA-rápido
      const BATCH_SIZE = 100; // Aumentado para 100 células por vez (paralelismo máximo)
      for (let batchStart = 0; batchStart < cells.length; batchStart += BATCH_SIZE) {
        const batch = cells.slice(batchStart, batchStart + BATCH_SIZE);
        loadingMessage = `Carregando CTOs... ${cellsProcessed}/${cells.length} células processadas (${totalCTOsLoaded.toLocaleString('pt-BR')} CTOs carregadas)`;
        
        // Atualizar estatísticas
        loadingStats.cellsProcessed = cellsProcessed;
        loadingStats.ctoCount = totalCTOsLoaded;
        loadingStats.totalRequests = totalRequests;
        
        // Buscar CTOs em paralelo para o lote atual (máximo paralelismo)
        const batchPromises = batch.map(async (cell) => {
          try {
            totalRequests++;
            const response = await fetch(getApiUrl(`/api/ctos/nearby?lat=${cell.lat}&lng=${cell.lng}&radius=${cell.radius}`));
            if (!response.ok) {
              cellsWithErrors.push(cell);
              loadingStats.cellsWithErrors = cellsWithErrors.length;
              return { cell: cell.index, ctos: [], cellData: cell };
            }
            const data = await response.json();
            if (data.success && data.ctos) {
              // SINALIZADOR: Se retornou 1000 CTOs, pode haver mais (limite da API)
              if (data.ctos.length >= 1000) {
                cellsWithLimit.push({ ...cell, count: data.ctos.length });
                loadingStats.cellsWithLimit = cellsWithLimit.length;
              }
              return { cell: cell.index, ctos: data.ctos, cellData: cell };
            }
            return { cell: cell.index, ctos: [], cellData: cell };
          } catch (err) {
            cellsWithErrors.push(cell);
            loadingStats.cellsWithErrors = cellsWithErrors.length;
            return { cell: cell.index, ctos: [], cellData: cell };
          }
        });
        
        const batchResults = await Promise.all(batchPromises);
        
        // Consolidar CTOs do lote (evitando duplicatas) - otimizado
        for (const { cell, ctos, cellData } of batchResults) {
          cellsProcessed++;
          let newCTOsInCell = 0;
          for (const cto of ctos) {
            if (!cto.latitude || !cto.longitude) continue;
            
            // Usar ID da CTO como chave única (se disponível), senão usar coordenadas
            const key = cto.id ? `id_${cto.id}` : `${parseFloat(cto.latitude).toFixed(6)},${parseFloat(cto.longitude).toFixed(6)}`;
            if (!allCTOsMap.has(key)) {
              allCTOsMap.set(key, cto);
              newCTOsInCell++;
              totalCTOsLoaded++;
            }
          }
          // Log apenas a cada 10 células para não sobrecarregar console
          if (newCTOsInCell > 0 && cellData && cellsProcessed % 10 === 0) {
            console.log(`✅ ${cellsProcessed} células: ${totalCTOsLoaded.toLocaleString('pt-BR')} CTOs carregadas`);
          }
        }
        
        // SEM DELAY entre lotes - processamento contínuo e máximo paralelismo
        // Apenas yield ao navegador se necessário (praticamente zero delay)
        if (batchStart + BATCH_SIZE < cells.length && batchStart % (BATCH_SIZE * 2) === 0) {
          // Yield apenas a cada 2 lotes para não bloquear completamente
          await new Promise(resolve => {
            if (window.requestIdleCallback) {
              window.requestIdleCallback(resolve, { timeout: 1 });
            } else {
              setTimeout(resolve, 0); // Zero delay - apenas yield ao event loop
            }
          });
        }
      }
      
      // ETAPA 2: Processar células que atingiram o limite (subdividir em paralelo TOTAL)
      if (cellsWithLimit.length > 0) {
        console.log(`\n🚨 PROCESSANDO ${cellsWithLimit.length} CÉLULAS QUE ATINGIRAM O LIMITE DA API (EM PARALELO TOTAL)`);
        loadingMessage = `Processando células com muitas CTOs... ${cellsWithLimit.length} células para subdividir`;
        
        // Processar TODAS as subdivisões em paralelo para máxima velocidade
        const allSubCellPromises = [];
        
        for (const limitedCell of cellsWithLimit) {
          // Subdividir a célula em 4 células menores (150km x 150km cada)
          const subCellSize = CELL_SIZE_KM / 2;
          const subCellRadius = (subCellSize / 2) * 1000 * 1.2; // 20% maior para sobreposição
          const subCellSizeDeg = subCellSize / 111;
          
          const subCells = [
            { lat: limitedCell.lat - subCellSizeDeg/2, lng: limitedCell.lng - subCellSizeDeg/2, radius: subCellRadius },
            { lat: limitedCell.lat - subCellSizeDeg/2, lng: limitedCell.lng + subCellSizeDeg/2, radius: subCellRadius },
            { lat: limitedCell.lat + subCellSizeDeg/2, lng: limitedCell.lng - subCellSizeDeg/2, radius: subCellRadius },
            { lat: limitedCell.lat + subCellSizeDeg/2, lng: limitedCell.lng + subCellSizeDeg/2, radius: subCellRadius }
          ];
          
          // Processar todas as subcélulas em paralelo
          for (const subCell of subCells) {
            allSubCellPromises.push(
              (async () => {
                try {
                  totalRequests++;
                  const response = await fetch(getApiUrl(`/api/ctos/nearby?lat=${subCell.lat}&lng=${subCell.lng}&radius=${subCell.radius}`));
                  if (response.ok) {
                    const data = await response.json();
                    if (data.success && data.ctos) {
                      let newCTOs = 0;
                      for (const cto of data.ctos) {
                        if (!cto.latitude || !cto.longitude) continue;
                        const key = cto.id ? `id_${cto.id}` : `${parseFloat(cto.latitude).toFixed(6)},${parseFloat(cto.longitude).toFixed(6)}`;
                        if (!allCTOsMap.has(key)) {
                          allCTOsMap.set(key, cto);
                          newCTOs++;
                          totalCTOsLoaded++;
                        }
                      }
                      return newCTOs;
                    }
                  }
                } catch (err) {
                  // Silenciar erros
                }
                return 0;
              })()
            );
          }
        }
        
        // Aguardar TODAS as subdivisões em paralelo
        await Promise.all(allSubCellPromises);
      }
      
      // ETAPA 3: Retry de células com erros (em paralelo para velocidade)
      if (cellsWithErrors.length > 0) {
        console.log(`\n🔄 REPROCESSANDO ${cellsWithErrors.length} CÉLULAS COM ERROS`);
        loadingMessage = `Reprocessando células com erros... ${cellsWithErrors.length} células`;
        
        // Processar retries em paralelo também
        const retryPromises = cellsWithErrors.map(async (errorCell) => {
          try {
            totalRequests++;
            const response = await fetch(getApiUrl(`/api/ctos/nearby?lat=${errorCell.lat}&lng=${errorCell.lng}&radius=${errorCell.radius}`));
            if (response.ok) {
              const data = await response.json();
              if (data.success && data.ctos) {
                let newCTOs = 0;
                for (const cto of data.ctos) {
                  if (!cto.latitude || !cto.longitude) continue;
                  const key = cto.id ? `id_${cto.id}` : `${parseFloat(cto.latitude).toFixed(6)},${parseFloat(cto.longitude).toFixed(6)}`;
                  if (!allCTOsMap.has(key)) {
                    allCTOsMap.set(key, cto);
                    newCTOs++;
                    totalCTOsLoaded++;
                  }
                }
                return newCTOs;
              }
            }
          } catch (err) {
            // Silenciar erros para não sobrecarregar
          }
          return 0;
        });
        
        await Promise.all(retryPromises);
      }

      allCTOs = Array.from(allCTOsMap.values());
      
      // Atualizar estatísticas finais
      loadingStats.cellsProcessed = cellsProcessed;
      loadingStats.ctoCount = allCTOs.length;
      loadingStats.totalRequests = totalRequests;
      loadingStats.cellsWithLimit = cellsWithLimit.length;
      loadingStats.cellsWithErrors = cellsWithErrors.length;
      
      // ETAPA 4: Relatório final com sinalizadores
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📊 RELATÓRIO FINAL DE CARREGAMENTO DE CTOs`);
      console.log(`${'='.repeat(60)}`);
      console.log(`✅ Total de CTOs únicas carregadas: ${allCTOs.length}`);
      console.log(`📊 Total de células processadas: ${cellsProcessed}`);
      console.log(`📊 Total de requisições à API: ${totalRequests}`);
      
      if (cellsWithLimit.length > 0) {
        console.log(`\n🚨 SINALIZADORES DE ATENÇÃO:`);
        console.log(`   ⚠️ ${cellsWithLimit.length} células atingiram o limite da API (1000 CTOs)`);
        console.log(`   ✅ Essas células foram subdivididas e reprocessadas`);
        console.log(`   📍 Células afetadas:`);
        cellsWithLimit.forEach(cell => {
          console.log(`      - Célula ${cell.index}: (${cell.lat.toFixed(4)}, ${cell.lng.toFixed(4)}) - ${cell.count} CTOs`);
        });
      } else {
        console.log(`\n✅ SINALIZADOR: Nenhuma célula atingiu o limite da API`);
        console.log(`   ✅ Todas as células retornaram menos de 1000 CTOs`);
      }
      
      if (cellsWithErrors.length > 0) {
        console.log(`\n⚠️ ${cellsWithErrors.length} células tiveram erros e foram reprocessadas`);
      } else {
        console.log(`\n✅ SINALIZADOR: Nenhuma célula teve erros permanentes`);
      }
      
      // Verificação final de qualidade
      const ctoWithCoords = allCTOs.filter(cto => cto.latitude && cto.longitude);
      const ctoWithoutCoords = allCTOs.length - ctoWithCoords.length;
      
      if (ctoWithoutCoords > 0) {
        console.log(`\n⚠️ ${ctoWithoutCoords} CTOs sem coordenadas válidas foram ignoradas`);
      }
      
      console.log(`\n✅ SINALIZADOR FINAL: ${ctoWithCoords.length} CTOs válidas prontas para análise`);
      console.log(`${'='.repeat(60)}\n`);
      
      loadingMessage = `✅ ${ctoWithCoords.length} CTOs carregadas com sucesso!`;
      
      return [];
    } catch (err) {
      console.error('Erro ao carregar CTOs:', err);
      return [];
    }
  }
  */

  // Função auxiliar para calcular distância entre duas coordenadas
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

  // Função para criar polígono que representa a união de círculos próximos
  // Usa uma abordagem mais precisa: cria um polígono que representa a união real dos círculos
  function createUnionPolygon(ctos) {
    if (ctos.length === 0) return null;
    
    // Se for apenas uma CTO, criar círculo individual
    if (ctos.length === 1) {
      const cto = ctos[0];
      const lat = parseFloat(cto.latitude);
      const lng = parseFloat(cto.longitude);
      
      const circle = new google.maps.Circle({
        strokeColor: '#8B7AE8', // Roxo mais suave
        strokeOpacity: 0.8,
        strokeWeight: 1.2,
        fillColor: '#6B8DD6', // Azul mais suave
        fillOpacity: coverageOpacity || 0.4, // Fallback para garantir inicialização
        map: map,
        center: { lat, lng },
        radius: 250,
        zIndex: 1,
        optimized: false
      });
      
      return circle;
    }
    
    const RADIUS_M = 250; // Raio em metros
    const RADIUS_DEG = RADIUS_M / 111000; // Raio em graus (aproximação)
    
    // Para múltiplas CTOs, criar um polígono que representa a união real dos círculos
    // Estratégia melhorada: usar convex hull refinado + pontos de interseção entre círculos
    // Isso cria uma forma muito mais precisa que representa a verdadeira área de cobertura
    
    // Coletar todos os pontos dos círculos (perímetro de cada círculo)
    const allPoints = [];
    const circleCenters = [];
    const circles = [];
    
    for (const cto of ctos) {
      const lat = parseFloat(cto.latitude);
      const lng = parseFloat(cto.longitude);
      circleCenters.push({ lat, lng });
      circles.push({ lat, lng, radius: RADIUS_DEG });
      
      // Criar pontos ao redor do círculo (otimizado: menos pontos para grupos menores)
      // Ajustar dinamicamente baseado no tamanho do grupo para performance
      const pointsPerCircle = ctos.length > 50 ? 64 : ctos.length > 20 ? 48 : 32; // Menos pontos = mais rápido
      const latRadius = RADIUS_DEG;
      const lngRadius = RADIUS_DEG / Math.cos(lat * Math.PI / 180);
      
      for (let i = 0; i < pointsPerCircle; i++) {
        const angle = (i * 2 * Math.PI) / pointsPerCircle;
        const pointLat = lat + (latRadius * Math.cos(angle));
        const pointLng = lng + (lngRadius * Math.sin(angle));
        allPoints.push({ lat: pointLat, lng: pointLng });
      }
    }
    
    // Para grupos muito grandes, usar uma abordagem otimizada
    // Calcular pontos de interseção entre círculos próximos para maior precisão
    if (ctos.length > 20) {
      // Para grupos grandes, adicionar pontos de interseção entre círculos próximos
      for (let i = 0; i < circles.length; i++) {
        for (let j = i + 1; j < circles.length; j++) {
          const dist = calculateDistance(circles[i].lat, circles[i].lng, circles[j].lat, circles[j].lng);
          const distDeg = dist / 111000; // Converter para graus
          
          // Se os círculos se sobrepõem, adicionar pontos de interseção
          if (distDeg < (RADIUS_DEG * 2)) {
            const intersections = getCircleIntersections(
              circles[i].lat, circles[i].lng, RADIUS_DEG,
              circles[j].lat, circles[j].lng, RADIUS_DEG
            );
            allPoints.push(...intersections);
          }
        }
      }
    }
    
    // Filtrar pontos que estão dentro de outros círculos (não são parte da borda externa)
    // Isso cria formas não-convexas mais naturais
    const boundaryPoints = allPoints.filter(point => {
      // Verificar se este ponto está na borda externa (não dentro de todos os círculos)
      let isInsideAll = true;
      for (const circle of circles) {
        const dist = calculateDistance(point.lat, point.lng, circle.lat, circle.lng);
        const distDeg = dist / 111000;
        const circleRadius = RADIUS_DEG / Math.cos(circle.lat * Math.PI / 180);
        
        // Se o ponto está fora deste círculo, não está dentro de todos
        if (distDeg > circleRadius * 1.05) { // 5% de margem
          isInsideAll = false;
          break;
        }
      }
      // Manter pontos que NÃO estão dentro de todos os círculos (são parte da borda)
      return !isInsideAll;
    });
    
    // Se não temos pontos suficientes na borda, usar todos os pontos
    const pointsToUse = boundaryPoints.length >= 3 ? boundaryPoints : allPoints;
    
    // Calcular o convex hull (envoltória convexa) dos pontos da borda
    // Isso cria um polígono que envolve todos os círculos de forma natural e precisa
    const hull = computeConvexHull(pointsToUse);
    
    // Se o convex hull falhar ou tiver poucos pontos, usar bounding box expandido
    if (!hull || hull.length < 3) {
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      for (const cto of ctos) {
        const lat = parseFloat(cto.latitude);
        const lng = parseFloat(cto.longitude);
        const latRadius = RADIUS_DEG;
        const lngRadius = RADIUS_DEG / Math.cos(lat * Math.PI / 180);
        minLat = Math.min(minLat, lat - latRadius);
        maxLat = Math.max(maxLat, lat + latRadius);
        minLng = Math.min(minLng, lng - lngRadius);
        maxLng = Math.max(maxLng, lng + lngRadius);
      }
      const polygonPath = [
        { lat: minLat, lng: minLng },
        { lat: maxLat, lng: minLng },
        { lat: maxLat, lng: maxLng },
        { lat: minLat, lng: maxLng }
      ];
      
      return new google.maps.Polygon({
        paths: polygonPath,
        strokeColor: '#8B7AE8', // Roxo mais suave
        strokeOpacity: 0.8,
        strokeWeight: 1.2,
        fillColor: '#6B8DD6', // Azul mais suave
        fillOpacity: coverageOpacity || 0.4, // Fallback para garantir inicialização
        map: map,
        zIndex: 1,
        geodesic: true
      });
    }
    
    // Suavizar o polígono adicionando pontos intermediários para bordas mais suaves
    let smoothedHull;
    try {
      smoothedHull = smoothPolygonEdges(hull);
      if (!smoothedHull || smoothedHull.length < 3) {
        smoothedHull = hull; // Fallback para hull original se suavização falhar
      }
    } catch (smoothErr) {
      console.warn('⚠️ Erro ao suavizar polígono, usando hull original:', smoothErr);
      smoothedHull = hull; // Fallback para hull original
    }
    
    // Criar polígono com forma suave e natural
    try {
      const polygon = new google.maps.Polygon({
        paths: smoothedHull,
        strokeColor: '#8B7AE8', // Roxo mais suave e profissional
        strokeOpacity: 0.8,
        strokeWeight: 1.2,
        fillColor: '#6B8DD6', // Azul mais suave e profissional
        fillOpacity: coverageOpacity || 0.4, // Fallback para garantir inicialização
        map: map,
        zIndex: 1,
        geodesic: true
      });
      
      return polygon;
    } catch (polyErr) {
      console.error('❌ Erro ao criar polígono:', polyErr);
      // Retornar null em caso de erro
      return null;
    }
  }
  
  // Função auxiliar para calcular o convex hull (Graham scan)
  function computeConvexHull(points) {
    if (points.length < 3) return points;
    
    // Encontrar o ponto mais baixo (menor lat, em caso de empate menor lng)
    let bottomPoint = points[0];
    let bottomIndex = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i].lat < bottomPoint.lat || 
          (points[i].lat === bottomPoint.lat && points[i].lng < bottomPoint.lng)) {
        bottomPoint = points[i];
        bottomIndex = i;
      }
    }
    
    // Trocar o ponto mais baixo para a primeira posição
    [points[0], points[bottomIndex]] = [points[bottomIndex], points[0]];
    
    // Ordenar pontos por ângulo polar em relação ao ponto mais baixo
    const sortedPoints = [points[0], ...points.slice(1).sort((a, b) => {
      const angleA = Math.atan2(a.lat - points[0].lat, a.lng - points[0].lng);
      const angleB = Math.atan2(b.lat - points[0].lat, b.lng - points[0].lng);
      if (Math.abs(angleA - angleB) < 0.0001) {
        // Se os ângulos são iguais, ordenar por distância
        const distA = Math.pow(a.lat - points[0].lat, 2) + Math.pow(a.lng - points[0].lng, 2);
        const distB = Math.pow(b.lat - points[0].lat, 2) + Math.pow(b.lng - points[0].lng, 2);
        return distA - distB;
      }
      return angleA - angleB;
    })];
    
    // Graham scan
    const hull = [sortedPoints[0], sortedPoints[1]];
    
    for (let i = 2; i < sortedPoints.length; i++) {
      while (hull.length > 1 && 
             crossProduct(hull[hull.length - 2], hull[hull.length - 1], sortedPoints[i]) <= 0) {
        hull.pop();
      }
      hull.push(sortedPoints[i]);
    }
    
    return hull;
  }
  
  // Função auxiliar para calcular o produto vetorial (cross product)
  function crossProduct(o, a, b) {
    return (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);
  }
  
  // Função para suavizar bordas do polígono adicionando pontos intermediários
  function smoothPolygonEdges(points) {
    if (points.length < 3) return points;
    
    const smoothed = [];
    const smoothingSteps = 2; // Número de pontos intermediários por aresta
    
    for (let i = 0; i < points.length; i++) {
      const current = points[i];
      const next = points[(i + 1) % points.length];
      
      // Adicionar ponto atual
      smoothed.push(current);
      
      // Adicionar pontos intermediários suavizados
      for (let step = 1; step <= smoothingSteps; step++) {
        const t = step / (smoothingSteps + 1);
        // Interpolação linear com suavização
        const smoothT = t * t * (3 - 2 * t); // Função de suavização (smoothstep)
        const midLat = current.lat + (next.lat - current.lat) * smoothT;
        const midLng = current.lng + (next.lng - current.lng) * smoothT;
        smoothed.push({ lat: midLat, lng: midLng });
      }
    }
    
    return smoothed;
  }
  
  // Função auxiliar para calcular pontos de interseção entre dois círculos
  function getCircleIntersections(lat1, lng1, r1, lat2, lng2, r2) {
    const intersections = [];
    
    // Converter para coordenadas planas aproximadas (para cálculo de interseção)
    const d = Math.sqrt(Math.pow(lat2 - lat1, 2) + Math.pow(lng2 - lng1, 2));
    
    // Se os círculos não se tocam, não há interseção
    if (d > r1 + r2 || d < Math.abs(r1 - r2)) {
      return intersections;
    }
    
    // Calcular pontos de interseção
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const h = Math.sqrt(r1 * r1 - a * a);
    
    const lat3 = lat1 + a * (lat2 - lat1) / d;
    const lng3 = lng1 + a * (lng2 - lng1) / d;
    
    // Dois pontos de interseção
    const lat4a = lat3 + h * (lng2 - lng1) / d;
    const lng4a = lng3 - h * (lat2 - lat1) / d;
    
    const lat4b = lat3 - h * (lng2 - lng1) / d;
    const lng4b = lng3 + h * (lat2 - lat1) / d;
    
    intersections.push({ lat: lat4a, lng: lng4a });
    intersections.push({ lat: lat4b, lng: lng4b });
    
    return intersections;
  }

  // Carregar CTOs com ocupação para mapa de calor

  // Desenhar polígono de cobertura no mapa (versão otimizada usando dados do backend)
  async function drawCoverageArea() {
    // Verificar se tudo está pronto
    if (!map) {
      console.error('❌ Mapa não está inicializado');
      return;
    }
    
    if (!google || !google.maps) {
      console.error('❌ Google Maps não está carregado');
      return;
    }
    
    if (!coveragePolygonGeoJSON) {
      console.warn('⚠️ Nenhum polígono de cobertura carregado');
      return;
    }

    // Verificar se o mapa está realmente visível no DOM
    const mapElement = document.getElementById('map-consulta');
    if (!mapElement) {
      console.error('❌ Elemento do mapa não encontrado no DOM');
      return;
    }
    
    // Verificar se o mapa tem dimensões válidas
    const mapRect = mapElement.getBoundingClientRect();
    if (mapRect.width === 0 || mapRect.height === 0) {
      console.warn('⚠️ Mapa não tem dimensões válidas, aguardando...');
      await new Promise(resolve => setTimeout(resolve, 500));
      google.maps.event.trigger(map, 'resize');
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Modo uniforme (padrão)
    console.log(`🗺️ Desenhando polígono de cobertura (${coverageData?.total_ctos || 0} CTOs)...`);
    console.log(`📐 Dimensões do mapa: ${mapRect.width}x${mapRect.height}`);

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
        console.error('❌ Formato GeoJSON não suportado:', coveragePolygonGeoJSON.type);
        return;
      }
      
      console.log(`🎨 Renderizando ${polygonsToRender.length} polígono(s) de cobertura...`);
      
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
          zIndex: 1,
          geodesic: true
        });
        
        coveragePolygons.push(polygon);
        
        // Adicionar ao bounds para ajustar zoom
        for (const path of paths) {
          bounds.extend(path);
        }
      }
      
      console.log(`✅ ${coveragePolygons.length} polígono(s) renderizado(s) com sucesso!`);
      
    } catch (err) {
      console.error('❌ Erro ao renderizar polígono:', err);
      return;
    }

    // Ajustar zoom para mostrar toda a área coberta
    if (coveragePolygons.length > 0) {
      try {
        // Forçar redimensionamento do mapa
        google.maps.event.trigger(map, 'resize');
        
        await new Promise(resolve => setTimeout(resolve, 300));
        
        if (map && bounds && !bounds.isEmpty()) {
          // Ajustar zoom para mostrar TODA a área coberta por todas as CTOs
          map.fitBounds(bounds, {
            top: 50,
            right: 50,
            bottom: 50,
            left: 50
          });
          console.log(`✅ Zoom ajustado para mostrar toda a área de cobertura`);
        } else {
          // Fallback: centralizar no Brasil se bounds estiver vazio
          map.setCenter({ lat: -14.2350, lng: -51.9253 }); // Centro geográfico do Brasil
          map.setZoom(5);
          console.log('✅ Zoom ajustado para centro do Brasil (fallback)');
        }
      } catch (err) {
        console.error('❌ Erro ao ajustar zoom:', err);
        // Fallback: centralizar no Brasil
        try {
          map.setCenter({ lat: -14.2350, lng: -51.9253 });
          map.setZoom(5);
        } catch (fallbackErr) {
          console.error('❌ Erro no fallback de zoom:', fallbackErr);
        }
      }
    } else {
      console.warn('⚠️ Nenhum polígono foi renderizado!');
    }
  }

  // Limpar círculos e polígonos de cobertura
  // Função para atualizar opacidade das manchas
  function updateCoverageOpacity() {
    // Garantir que coverageOpacity está definido
    if (coverageOpacity === undefined || coverageOpacity === null) {
      coverageOpacity = 0.4;
    }
    
    // Atualizar opacidade de todos os polígonos uniformes
    coveragePolygons.forEach(polygon => {
      if (polygon && polygon.setOptions) {
        polygon.setOptions({ fillOpacity: coverageOpacity });
      }
    });
  }
  
  function clearCoverageCircles() {
    // Limpar polígonos de cobertura uniforme
    coveragePolygons.forEach(polygon => {
      if (polygon && polygon.setMap) {
        polygon.setMap(null);
      }
    });
    coveragePolygons = [];
  }

  // Limpar marcadores de busca
  function clearSearchMarkers() {
    if (searchMarkers && searchMarkers.length > 0) {
      console.log(`🧹 Limpando ${searchMarkers.length} marcador(es) anterior(es)...`);
      searchMarkers.forEach(marker => {
        if (marker && marker.setMap) {
          marker.setMap(null);
        }
      });
      searchMarkers = [];
      console.log('✅ Marcadores anteriores removidos');
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

  // Função para detectar se o input é coordenadas
  function parseCoordinates(input) {
    const trimmed = input.trim();
    const coordPattern = /^-?\d+\.?\d*\s*,\s*-?\d+\.?\d*$/;
    
    if (coordPattern.test(trimmed)) {
      const parts = trimmed.split(',').map(p => p.trim());
      const lat = parseFloat(parts[0]);
      const lng = parseFloat(parts[1]);
      
      if (!isNaN(lat) && !isNaN(lng) && 
          lat >= -90 && lat <= 90 && 
          lng >= -180 && lng <= 180) {
        return { isCoordinates: true, lat, lng };
      }
    }
    
    return { isCoordinates: false };
  }

  // Função de inicialização da ferramenta
  async function initializeTool() {
    isLoading = true;
    error = null; // Limpar erros anteriores
    
    // Garantir que todas as variáveis estão inicializadas
    if (coverageOpacity === undefined || coverageOpacity === null) {
      coverageOpacity = 0.4;
    }
    if (!coveragePolygons) {
      coveragePolygons = [];
    }
    if (!coverageData) {
      coverageData = null;
    }
    if (!coveragePolygonGeoJSON) {
      coveragePolygonGeoJSON = null;
    }
    
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
        // Verificar se há CTOs na base fazendo uma busca de teste
        const testResponse = await fetch(getApiUrl('/api/ctos/nearby?lat=-23.5505&lng=-46.6333&radius=1000&probe=1'));
        if (testResponse.ok) {
          const testData = await testResponse.json();
          baseDataExists = testData.success && testData.ctos && testData.ctos.length > 0;
        }
      } catch (err) {
        console.warn('Aviso: Não foi possível verificar base de dados:', err.message);
        baseDataExists = false;
      }
      
      // Pequeno delay para visualização
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Etapa 3: Carregando Polígonos de Cobertura
      loadingMessage = 'Carregando Polígonos de Cobertura';
      let polygonLoaded = await loadCoveragePolygon();
      
      if (polygonLoaded) {
        console.log(`✅ Polígono de cobertura carregado`);
      } else {
        console.warn('⚠️ Nenhum polígono de cobertura encontrado. Use a aba Configurações para calcular a mancha de cobertura.');
      }
      
      // Pequeno delay para visualização
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Etapa 4: Ajuste Finais
      loadingMessage = 'Ajuste Finais';
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Etapa 5: Abrindo Ferramenta
      loadingMessage = 'Abrindo Ferramenta';
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Só agora terminar o loading - o elemento do mapa vai aparecer no DOM
      isLoading = false;
      console.log('✅ Loading finalizado, elemento do mapa agora está no DOM');
      
      // Aguardar DOM atualizar completamente e elemento do mapa estar disponível
      await tick();
      
      // Tentar encontrar o elemento do mapa (pode levar alguns ciclos)
      let mapElement = null;
      let attempts = 0;
      while (!mapElement && attempts < 10) {
        mapElement = document.getElementById('map-consulta');
        if (!mapElement) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
        }
      }
      
      if (!mapElement) {
        console.error('❌ Elemento do mapa não encontrado após múltiplas tentativas');
        return;
      }
      
      console.log('✅ Elemento do mapa encontrado no DOM');
      
      // AGORA inicializar o mapa (elemento já existe no DOM)
      console.log('🗺️ Inicializando mapa...');
      initMap();
      
      // Se não conseguiu inicializar, tentar novamente
      if (!map) {
        console.warn('⚠️ Primeira tentativa falhou, tentando novamente...');
        await new Promise(resolve => setTimeout(resolve, 500));
        await tick();
        initMap();
      }
      
      // Aguardar mapa estar pronto
      if (map) {
        await new Promise((resolve) => {
          google.maps.event.addListenerOnce(map, 'idle', () => {
            console.log('✅ Mapa totalmente carregado');
            resolve();
          });
        });
      } else {
        console.error('❌ Não foi possível inicializar o mapa após múltiplas tentativas');
        return;
      }
      
      // Aguardar um pouco para garantir que o mapa está renderizado
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Desenhar polígono de cobertura (se disponível)
      if (coveragePolygonGeoJSON && map) {
        console.log(`🎨 Desenhando polígono de cobertura...`);
        
        // Forçar redimensionamento do mapa
        google.maps.event.trigger(map, 'resize');
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Desenhar polígono de cobertura
        await drawCoverageArea();
        console.log(`✅ ${coveragePolygons.length} polígono(s) renderizado(s) - mancha de cobertura visível`);
        
        // Aguardar um pouco para garantir que tudo foi renderizado
        await new Promise(resolve => setTimeout(resolve, 500));
      } else if (!coveragePolygonGeoJSON) {
        console.warn('⚠️ Nenhum polígono de cobertura disponível. A ferramenta funcionará normalmente, mas sem visualização de cobertura.');
        // Centralizar no Brasil mesmo sem polígonos
        if (map) {
          map.setCenter({ lat: -14.2350, lng: -51.9253 });
          map.setZoom(5);
        }
      } else if (!map) {
        console.error('❌ Mapa não foi inicializado, não é possível desenhar polígono');
      }
      
      console.log('✅ Ferramenta totalmente carregada e pronta para uso');
      
    } catch (err) {
      console.error('❌ Erro ao inicializar ferramenta:', err);
      console.error('Stack trace:', err.stack);
      // Não mostrar erro crítico se for apenas falta de polígonos
      if (err.message && err.message.includes('polígono')) {
        error = `Aviso: Nenhum polígono de cobertura encontrado. Execute o cálculo primeiro. A ferramenta funcionará normalmente para pesquisas.`;
      } else {
      error = 'Erro ao inicializar ferramenta: ' + (err.message || 'Erro desconhecido');
      }
      isLoading = false;
      
      // Tentar inicializar o mapa mesmo com erro
      try {
        await tick();
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Tentar encontrar elemento e inicializar
        let mapElement = document.getElementById('map-consulta');
        if (mapElement && !map) {
          console.log('🔄 Tentando inicializar mapa após erro...');
          initMap();
          
          // Se conseguiu inicializar, tentar desenhar polígono
          if (map && coveragePolygonGeoJSON) {
            await new Promise(resolve => setTimeout(resolve, 500));
            try {
              await drawCoverageArea();
            } catch (drawErr) {
              console.error('❌ Erro ao desenhar polígono após erro:', drawErr);
            }
          }
        }
      } catch (recoveryErr) {
        console.error('❌ Erro ao tentar recuperar:', recoveryErr);
      }
    }
  }

  // Função para buscar por endereço
  async function searchByEndereco() {
    // Limpar pesquisa anterior automaticamente (substituir marcadores) - SEMPRE primeiro
    clearSearchMarkers();
    
    if (!enderecoInput.trim()) {
      error = 'Por favor, insira um endereço';
      return;
    }

    if (!map || !googleMapsLoaded || !google.maps || !google.maps.Geocoder) {
      error = 'Google Maps não está carregado. Aguarde alguns instantes e tente novamente.';
      return;
    }
    
    loadingCTOs = true;
    error = null;

    try {
      const result = await geocodeAddress(enderecoInput);
      const location = result.geometry.location;
      const lat = location.lat();
      const lng = location.lng();

      // Verificar se ponto está dentro da cobertura
      let isCovered = false;
      let distanceToCoverage = null;
      
      try {
        const coverageCheckResponse = await fetch(getApiUrl(`/api/coverage/check-point?lat=${lat}&lng=${lng}`));
        if (coverageCheckResponse.ok) {
          const coverageCheckData = await coverageCheckResponse.json();
          if (coverageCheckData.success) {
            isCovered = coverageCheckData.is_covered;
            distanceToCoverage = coverageCheckData.distance_to_coverage_meters;
          }
        }
      } catch (coverageErr) {
        console.warn('⚠️ Erro ao verificar cobertura:', coverageErr);
      }

      // Criar marcador azul no ponto pesquisado
      const marker = new google.maps.Marker({
        position: { lat, lng },
        map: map,
        title: `Endereço: ${enderecoInput}${isCovered ? ' (DENTRO da cobertura)' : ' (FORA da cobertura)'}`,
        icon: {
          url: isCovered 
            ? 'https://maps.google.com/mapfiles/ms/icons/green-dot.png' 
            : 'https://maps.google.com/mapfiles/ms/icons/red-dot.png',
          scaledSize: new google.maps.Size(32, 32)
        },
        zIndex: 999
      });

      searchMarkers.push(marker);

      // Centralizar mapa no ponto pesquisado
      map.setCenter({ lat, lng });
      map.setZoom(16);

      // Mostrar mensagem de status
      if (isCovered) {
        error = null;
        console.log('✅ Endereço está DENTRO da área de cobertura');
      } else {
        const distanceKm = distanceToCoverage ? (distanceToCoverage / 1000).toFixed(2) : null;
        error = distanceKm 
          ? `⚠️ Endereço está FORA da área de cobertura (${distanceKm} km da cobertura mais próxima)`
          : '⚠️ Endereço está FORA da área de cobertura';
        console.log('⚠️ Endereço está FORA da área de cobertura');
      }

      console.log('✅ Marcador adicionado para endereço:', enderecoInput);
    } catch (err) {
      console.error('Erro ao buscar endereço:', err);
      error = 'Erro ao processar endereço. Verifique se o endereço está correto.';
    } finally {
      loadingCTOs = false;
    }
  }

  // Função para buscar por coordenadas
  async function searchByCoordenadas() {
    // Limpar pesquisa anterior automaticamente (substituir marcadores) - SEMPRE primeiro
    clearSearchMarkers();
    
    if (!coordenadasInput.trim()) {
      error = 'Por favor, insira coordenadas (lat, lng)';
      return;
    }

    if (!map || !googleMapsLoaded) {
      error = 'Mapa não está carregado. Aguarde alguns instantes e tente novamente.';
      return;
    }
    
    loadingCTOs = true;
    error = null;

    try {
      const parsed = parseCoordinates(coordenadasInput);
      
      if (!parsed.isCoordinates) {
        error = 'Formato de coordenadas inválido. Use: lat, lng (ex: -3.7172, -38.5433)';
        loadingCTOs = false;
        return;
      }

      const { lat, lng } = parsed;

      // Verificar se ponto está dentro da cobertura
      let isCovered = false;
      let distanceToCoverage = null;
      
      try {
        const coverageCheckResponse = await fetch(getApiUrl(`/api/coverage/check-point?lat=${lat}&lng=${lng}`));
        if (coverageCheckResponse.ok) {
          const coverageCheckData = await coverageCheckResponse.json();
          if (coverageCheckData.success) {
            isCovered = coverageCheckData.is_covered;
            distanceToCoverage = coverageCheckData.distance_to_coverage_meters;
          }
        }
      } catch (coverageErr) {
        console.warn('⚠️ Erro ao verificar cobertura:', coverageErr);
      }

      // Criar marcador no ponto pesquisado (verde se coberto, vermelho se não)
      const marker = new google.maps.Marker({
        position: { lat, lng },
        map: map,
        title: `Coordenadas: ${lat}, ${lng}${isCovered ? ' (DENTRO da cobertura)' : ' (FORA da cobertura)'}`,
        icon: {
          url: isCovered 
            ? 'https://maps.google.com/mapfiles/ms/icons/green-dot.png' 
            : 'https://maps.google.com/mapfiles/ms/icons/red-dot.png',
          scaledSize: new google.maps.Size(32, 32)
        },
        zIndex: 999
      });

      searchMarkers.push(marker);

      // Centralizar mapa no ponto pesquisado
      map.setCenter({ lat, lng });
      map.setZoom(16);

      // Mostrar mensagem de status
      if (isCovered) {
        error = null;
        console.log('✅ Coordenadas estão DENTRO da área de cobertura');
      } else {
        const distanceKm = distanceToCoverage ? (distanceToCoverage / 1000).toFixed(2) : null;
        error = distanceKm 
          ? `⚠️ Coordenadas estão FORA da área de cobertura (${distanceKm} km da cobertura mais próxima)`
          : '⚠️ Coordenadas estão FORA da área de cobertura';
        console.log('⚠️ Coordenadas estão FORA da área de cobertura');
      }

      console.log('✅ Marcador adicionado para coordenadas:', lat, lng);
    } catch (err) {
      console.error('Erro ao processar coordenadas:', err);
      error = 'Erro ao processar coordenadas. Verifique se estão corretas.';
    } finally {
      loadingCTOs = false;
    }
  }

  // Função principal de busca
  async function handleSearch() {
    if (searchMode === 'endereco') {
      await searchByEndereco();
    } else if (searchMode === 'coordenadas') {
      await searchByCoordenadas();
    }
  }

  // Função clearSearch removida - cada nova pesquisa agora substitui automaticamente a anterior

  // Funções de redimensionamento
  function startResizeSidebar(e) {
    e.preventDefault();
    e.stopPropagation();
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
    
    try {
      localStorage.setItem('mapaConsulta_sidebarWidth', clampedWidth.toString());
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

  // Funções de redimensionamento do mapa desabilitadas - mapa agora usa toda altura disponível
  function startResizeMap(e) {
    // Desabilitado - mapa usa toda altura disponível
    return false;
  }

  function handleResizeMap(e) {
    // Desabilitado - mapa usa toda altura disponível
    return;
  }

  function stopResizeMap() {
    isResizingMap = false;
    document.removeEventListener('mousemove', handleResizeMap, { capture: true });
    document.removeEventListener('mouseup', stopResizeMap, { capture: true });
    document.removeEventListener('touchmove', handleResizeMap, { capture: true });
    document.removeEventListener('touchend', stopResizeMap, { capture: true });
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }


  // Carregar preferências salvas
  function loadResizePreferences() {
    try {
      const savedSidebarWidth = localStorage.getItem('mapaConsulta_sidebarWidth');
      if (savedSidebarWidth) {
        sidebarWidth = parseInt(savedSidebarWidth, 10);
        if (isNaN(sidebarWidth) || sidebarWidth < 250 || sidebarWidth > 600) {
          sidebarWidth = 400;
        }
      }
      // Altura do mapa removida - agora usa toda altura disponível
    } catch (err) {
      console.warn('Erro ao carregar preferências de redimensionamento:', err);
    }
  }

  // Inicializar ferramenta
  onMount(async () => {
    try {
      // Garantir inicialização de todas as variáveis críticas
      if (coverageOpacity === undefined || coverageOpacity === null) {
        coverageOpacity = 0.4;
      }
      if (!coveragePolygons) {
        coveragePolygons = [];
      }
      if (!coverageData) {
        coverageData = null;
      }
      if (!coveragePolygonGeoJSON) {
        coveragePolygonGeoJSON = null;
      }
      
      loadResizePreferences();
      
      if (onSettingsRequest && typeof onSettingsRequest === 'function') {
        onSettingsRequest(openSettings);
      }
      
      if (onSettingsHover && typeof onSettingsHover === 'function') {
        onSettingsHover(preloadSettingsData);
      }
      
      await initializeTool();
    } catch (err) {
      console.error('❌ Erro crítico ao inicializar ferramenta:', err);
      console.error('Stack trace:', err.stack);
      error = 'Erro ao inicializar ferramenta: ' + (err.message || 'Erro desconhecido');
      isLoading = false;
    }
  });

  // Cleanup ao desmontar
  onDestroy(() => {
    clearCoverageCircles();
    clearSearchMarkers();
  });
</script>

<!-- Conteúdo da Ferramenta Mapa de Consulta -->
<div class="mapa-consulta-content">
  {#if isLoading}
    <Loading currentMessage={loadingMessage} />
  {:else}
    <div class="main-layout">
      <!-- Painel de Busca -->
      <aside class="search-panel" class:minimized={isSearchPanelMinimized} style="width: {isSearchPanelMinimized ? '60px' : sidebarWidthStyle} !important; flex: 0 0 auto;">
        <div class="panel-header">
          <div class="panel-header-content">
            {#if !isSearchPanelMinimized}
              <h2>Mapa de Consulta</h2>
            {:else}
              <h2 class="vertical-title"></h2>
            {/if}
            <button 
              class="minimize-button" 
              disabled={isResizingSidebar}
              on:click={() => isSearchPanelMinimized = !isSearchPanelMinimized}
              aria-label={isSearchPanelMinimized ? 'Expandir painel de busca' : 'Minimizar painel de busca'}
              title={isSearchPanelMinimized ? 'Expandir' : 'Minimizar'}
            >
              {isSearchPanelMinimized ? '➡️' : '⬅️'}
            </button>
          </div>
          {#if !isSearchPanelMinimized}
            <p>Busque por endereço ou coordenadas</p>
          {/if}
        </div>

        {#if !isSearchPanelMinimized}
        <div class="search-mode-selector">
          <button 
            class="mode-button" 
            class:active={searchMode === 'endereco'}
            on:click={() => searchMode = 'endereco'}
          >
            Endereço
          </button>
          <button 
            class="mode-button" 
            class:active={searchMode === 'coordenadas'}
            on:click={() => searchMode = 'coordenadas'}
          >
            Coordenadas
          </button>
        </div>

        <div class="search-form">
          {#if searchMode === 'endereco'}
            <div class="form-group">
              <label for="endereco">Endereço</label>
              <input 
                type="text" 
                id="endereco"
                bind:value={enderecoInput}
                placeholder="Ex: Rua Exemplo, 123, Fortaleza-CE"
                on:keydown={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
          {:else if searchMode === 'coordenadas'}
            <div class="form-group">
              <label for="coordenadas">Coordenadas (lat, lng)</label>
              <input 
                type="text" 
                id="coordenadas"
                bind:value={coordenadasInput}
                placeholder="Ex: -3.7172, -38.5433"
                on:keydown={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
          {/if}

          <div class="button-group">
            <button class="search-button" on:click={handleSearch} disabled={loadingCTOs}>
              {#if loadingCTOs}
                ⏳ Buscando...
              {:else}
                Buscar
              {/if}
            </button>
          </div>

          {#if loadingCTOs}
            <div class="loading-inline">
              <p>Buscando localização...</p>
            </div>
          {/if}

          {#if error}
            <div class="error-message">
              ⚠️ {error}
            </div>
          {/if}

          {#if coverageData}
            <!-- Controles de Visualização -->
            <div class="visualization-controls">
              <div class="control-group">
                <label for="opacity-slider" class="control-label">
                  <span>Opacidade das Manchas</span>
                  <span class="control-value">{coverageOpacityPercent}%</span>
                </label>
                <input 
                  type="range" 
                  id="opacity-slider"
                  min="0.1" 
                  max="0.8" 
                  step="0.05"
                  bind:value={coverageOpacity}
                  on:input={updateCoverageOpacity}
                  class="opacity-slider"
                />
              </div>
            </div>
          {:else}
            <!-- Card para calcular polígonos quando não há cobertura -->
            <div class="results-summary">
              <div class="stats-card" style="background: #fff3cd; border-color: #ffc107;">
                <div class="stats-header">
                  <span class="stats-icon">⚠️</span>
                  <div class="stats-content">
                    <div class="stats-title">
                      Nenhuma Mancha de Cobertura
                    </div>
                    <div class="stats-subtitle">Calcule os polígonos para visualizar</div>
                  </div>
                </div>
                <div class="stats-detail" style="margin-top: 10px; padding: 10px; background: #f8f9fa; border-radius: 5px;">
                  <p style="margin: 0; font-size: 0.9em; color: #666;">
                    Para visualizar a mancha de cobertura no mapa, vá até a aba <strong>Configurações</strong> e clique em <strong>"Criar Nova Mancha de Cobertura"</strong>.
                  </p>
                </div>
              </div>
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

      <!-- Área Principal (Mapa) -->
      <main class="main-area">
        <!-- Mapa -->
        <div class="map-container" style="height: 100%; min-height: 0;">
          <div class="map-header">
            <h3>Mapa de Cobertura</h3>
          </div>
          <div id="map-consulta" class="map" bind:this={mapElement}></div>
        </div>
      </main>
    </div>
  {/if}
</div>

<style>
  .mapa-consulta-content {
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

  .form-group input {
    padding: 0.75rem;
    border: 2px solid #e5e7eb;
    border-radius: 8px;
    font-size: 0.9375rem;
    transition: border-color 0.2s;
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
  }

  .form-group input:focus {
    outline: none;
    border-color: #6495ED;
  }

  .button-group {
    display: flex;
    gap: 0.5rem;
  }

  .search-button {
    flex: 1;
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

  /* CSS do botão "Limpar" removido - não é mais usado */

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
    margin-top: 1rem;
  }
  
  .stats-card {
    background: linear-gradient(135deg, #f8f9ff 0%, #f0f4ff 100%);
    border: 2px solid #e0e7ff;
    border-radius: 12px;
    padding: 1.25rem;
    box-shadow: 0 2px 8px rgba(123, 104, 238, 0.1);
  }
  
  .stats-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 0.75rem;
  }
  
  .stats-icon {
    font-size: 2rem;
    line-height: 1;
  }
  
  .stats-content {
    flex: 1;
  }
  
  .stats-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #4c1d95;
    line-height: 1.2;
  }
  
  .stats-subtitle {
    font-size: 0.875rem;
    color: #6b7280;
    margin-top: 0.25rem;
  }
  
  .stats-detail {
    font-size: 0.8125rem;
    color: #6b7280;
    padding-top: 0.75rem;
    border-top: 1px solid #e5e7eb;
    margin-top: 0.75rem;
  }
  
  .visualization-controls {
    margin-top: 1.5rem;
    padding: 1.25rem;
    background: white;
    border: 2px solid #e5e7eb;
    border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  }
  
  .control-group {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  
  .control-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: 600;
    color: #374151;
    font-size: 0.9375rem;
  }
  
  .control-value {
    color: #7B68EE;
    font-weight: 700;
    font-size: 1rem;
  }
  
  .opacity-slider {
    width: 100%;
    height: 8px;
    border-radius: 4px;
    background: #e5e7eb;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
  }
  
  .opacity-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: linear-gradient(135deg, #6495ED 0%, #7B68EE 100%);
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(123, 104, 238, 0.4);
    transition: all 0.2s;
  }
  
  .opacity-slider::-webkit-slider-thumb:hover {
    transform: scale(1.1);
    box-shadow: 0 3px 8px rgba(123, 104, 238, 0.5);
  }
  
  .opacity-slider::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: linear-gradient(135deg, #6495ED 0%, #7B68EE 100%);
    cursor: pointer;
    border: none;
    box-shadow: 0 2px 6px rgba(123, 104, 238, 0.4);
    transition: all 0.2s;
  }
  
  .opacity-slider::-moz-range-thumb:hover {
    transform: scale(1.1);
    box-shadow: 0 3px 8px rgba(123, 104, 238, 0.5);
  }
  
  .map-legend {
    position: absolute;
    top: 80px;
    right: 20px;
    background: white;
    border-radius: 12px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    padding: 1.25rem;
    min-width: 240px;
    z-index: 1000;
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.8);
  }
  
  .legend-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 2px solid #e5e7eb;
  }
  
  .legend-header h4 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 700;
    color: #1f2937;
  }
  
  .legend-toggle {
    background: transparent;
    border: none;
    color: #6b7280;
    cursor: pointer;
    font-size: 1.125rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    transition: all 0.2s;
  }
  
  .legend-toggle:hover {
    background: #f3f4f6;
    color: #374151;
  }
  
  .legend-content {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  
  .legend-item {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }
  
  .legend-color {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    flex-shrink: 0;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }
  
  .legend-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .legend-text strong {
    font-size: 0.9375rem;
    color: #1f2937;
    font-weight: 600;
  }
  
  .legend-text span {
    font-size: 0.8125rem;
    color: #6b7280;
  }
  
  .legend-footer {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 2px solid #e5e7eb;
  }
  
  .legend-stats {
    display: flex;
    gap: 1rem;
    justify-content: space-around;
  }
  
  .legend-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }
  
  .stat-number {
    font-size: 1.5rem;
    font-weight: 700;
    color: #7B68EE;
    line-height: 1;
  }
  
  .stat-label {
    font-size: 0.75rem;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  .legend-toggle-button {
    position: absolute;
    top: 80px;
    right: 20px;
    background: white;
    border: 2px solid #e5e7eb;
    border-radius: 8px;
    padding: 0.75rem;
    cursor: pointer;
    font-size: 1.25rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    transition: all 0.2s;
    z-index: 1000;
  }
  
  .legend-toggle-button:hover {
    background: #f9fafb;
    border-color: #7B68EE;
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(123, 104, 238, 0.2);
  }

  .main-area {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    overflow: hidden;
    width: 100%;
    position: relative;
    min-height: 0;
    box-sizing: border-box;
    height: calc(100% - 2.75rem);
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
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
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
    pointer-events: none;
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
    width: 20px;
    cursor: col-resize !important;
    z-index: 10000 !important;
    pointer-events: auto !important;
    margin: 0 -8px;
    background: transparent;
    position: relative;
    flex-shrink: 0;
    flex-grow: 0;
    align-self: stretch;
  }

  .resize-handle-vertical::before {
    width: 2px;
    height: 100%;
    left: 50%;
    transform: translateX(-50%);
    pointer-events: none;
    background: rgba(100, 149, 237, 0.08);
  }

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

  @media (max-width: 768px) {
    .main-layout {
      padding: 0.75rem;
    }

    .search-panel {
      padding: 1rem;
    }
  }
</style>
