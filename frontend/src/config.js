// Configuração da API
// Em desenvolvimento, usa proxy do Vite
// Em produção, usa VITE_API_URL se definida ou detecta automaticamente
export const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export function getApiUrl(path) {
  // Validar path
  if (!path || typeof path !== 'string') {
    console.error('❌ [API] Path inválido:', path);
    throw new Error('Path da API inválido');
  }
  
  // Se path já é uma URL completa, retorna como está
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  
  // Se temos uma URL base configurada, usa ela
  if (API_BASE_URL && API_BASE_URL.trim() !== '') {
    const base = API_BASE_URL.replace(/\/$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const fullUrl = `${base}${cleanPath}`;
    console.log('🔗 [API] VITE_API_URL configurada:', API_BASE_URL);
    console.log('🔗 [API] URL final construída:', fullUrl);
    
    // Validar URL construída
    if (!fullUrl || fullUrl.trim() === '') {
      console.error('❌ [API] URL construída inválida:', fullUrl);
      throw new Error('URL da API inválida após construção');
    }
    
    return fullUrl;
  }
  
  // Detectar automaticamente a URL do backend
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    const currentPort = window.location.port;
    
    // Se estiver em localhost, assume que o backend está na porta 3001
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      if (import.meta.env.DEV) {
        // Modo desenvolvimento - proxy do Vite deve funcionar
        return path;
      } else {
        // Modo produção - precisa da URL completa
        return `http://${hostname}:3001${path}`;
      }
    }
    
    // Detectar Railway
    const isRailway = hostname.includes('.railway.app') || hostname.includes('.up.railway.app');
    
    if (isRailway) {
      // Em Railway, tenta substituir "frontend" por "backend" no hostname
      // Ex: viabilidade-alares-frontend-production.up.railway.app -> viabilidade-alares-backend-production.up.railway.app
      const backendHostname = hostname.replace(/frontend/i, 'backend');
      const cleanPath = path.startsWith('/') ? path : `/${path}`;
      const fullUrl = `${protocol}//${backendHostname}${cleanPath}`;
      console.log('🔗 [API] Detectado Railway, usando:', fullUrl);
      
      // Validar URL construída
      if (!fullUrl || fullUrl.trim() === '' || !fullUrl.startsWith('http')) {
        console.error('❌ [API] URL Railway inválida:', fullUrl);
        throw new Error('URL da API Railway inválida');
      }
      
      return fullUrl;
    }
    
    // Em Replit ou outros ambientes de produção
    // Detecta se está em Replit (janeway, kirk, etc)
    const isReplit = hostname.includes('.replit.dev') || hostname.includes('.repl.co') || hostname.includes('.janeway.');
    
    if (isReplit) {
      // Em Replit, o backend geralmente está na porta 3000
      const backendPort = '3000';
      return `${protocol}//${hostname}:${backendPort}${path}`;
    }
    
    // Para outros ambientes de produção
    const frontendPorts = ['5174', '5173', '5175', '8080'];
    if (currentPort && frontendPorts.includes(currentPort)) {
      const backendPort = '3000';
      return `${protocol}//${hostname}:${backendPort}${path}`;
    }
    
    // Se não detectou porta específica, tenta porta 3000 (padrão comum)
    if (!currentPort || currentPort === '80' || currentPort === '443' || currentPort === '') {
      return `${protocol}//${hostname}:3000${path}`;
    }
  }
  
  // Fallback: usa path relativo (pode funcionar se backend estiver na mesma origem)
  console.warn('⚠️ [API] Não foi possível determinar URL do backend, usando path relativo:', path);
  
  // Garantir que sempre retorna uma string válida
  const fallbackPath = path && typeof path === 'string' ? path : '/api';
  if (!fallbackPath.startsWith('/')) {
    return `/${fallbackPath}`;
  }
  return fallbackPath;
}

