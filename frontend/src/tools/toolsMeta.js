// ============================================
// Metadados das ferramentas (sem componentes Svelte)
// ============================================
// Separado do registry para evitar dependência circular:
// ViabilidadeAlares → Config → toolsRegistry → ViabilidadeAlares
// ============================================

/** Metadados das ferramentas (embutidos para o build não depender de JSON externo). */
export const portalToolsMeta = [
  {
    id: 'viabilidade-alares',
    title: 'Viabilidade Alares - Engenharia',
    description:
      'Análise de viabilidade técnica para identificação de CTOs próximas a endereços de clientes',
    icon: '🔍',
    color: '#7B68EE',
    available: true
  },
  {
    id: 'analise-cobertura',
    title: 'Consulta de Alívio de Rede',
    description: 'Consulta de CTOs para análise de alívio de rede e infraestrutura',
    icon: '📡',
    color: '#6495ED',
    available: true
  },
  {
    id: 'calculadora-orcamento',
    title: 'Calculadora de Orçamento',
    description: 'Cálculo de orçamentos para projetos de engenharia',
    icon: '🧮',
    color: '#10B981',
    available: true
  },
  {
    id: 'mapa-consulta',
    title: 'Mapa de Consulta',
    description: 'Visualização e consulta de informações em mapa interativo',
    icon: '🗺️',
    color: '#F59E0B',
    available: true
  },
  {
    id: 'dashboard-censup',
    title: 'Dashboard CENSUP',
    description: 'Dashboard para visualização e análise de dados CENSUP',
    icon: '📊',
    color: '#6366F1',
    available: true
  },
  {
    id: 'formulario-engenharia',
    title: 'Relatório Técnico de Projeto B2B',
    description: 'Relatório técnico B2B com prévia em tempo real e geração de PDF no padrão Alares',
    icon: '📋',
    color: '#7B68EE',
    available: true
  },
  {
    id: 'formulario-engenharia-implantacao',
    title: 'Relatório de Construção - Implantação',
    description:
      'Formulário de relatório de construção para o setor de Implantação (cópia independente do formulário de Projetos)',
    icon: '🏗️',
    color: '#0D9488',
    available: true,
    portalVisible: false
  },
  {
    id: 'relatorio-de-construcao',
    title: 'Relatório de Construção',
    description:
      'Formulário do relatório de construção vinculado ao projeto em implantação (prévia PDF e impressão)',
    icon: '🏗️',
    color: '#0D9488',
    available: true,
    portalVisible: false
  },
  {
    id: 'dashboard-projetos',
    title: 'Dashboard Projetos',
    description: 'Gerenciar relatórios técnicos B2B do setor de Projetos',
    icon: '📁',
    color: '#7B68EE',
    available: true
  },
  {
    id: 'dashboard-implantacao',
    title: 'Dashboard Implantação',
    description: 'Gerenciar relatórios enviados por Projetos e Relatório de Construção',
    icon: '🏗️',
    color: '#0D9488',
    available: true
  },
  {
    id: 'ia-auditoria-diagramacao',
    title: 'IA de Auditoria de Diagramação',
    description:
      'Auditoria em lote de PDFs CEO/CTO: classifica sem diagramação, incompleta ou diagramada',
    icon: '📐',
    color: '#0D9488',
    available: true
  },
  {
    id: 'portal-censup',
    title: 'Portal CENSUP',
    description:
      'Arquivo de relatórios finalizados da extensão — prévia e impressão dos ALAs salvos',
    icon: '📥',
    color: '#6366F1',
    available: true
  },
  {
    id: 'comite-intencao-ampliacao',
    title: 'Comitê de Intenção de Ampliação',
    description:
      'Portal de apresentação dos projetos do comitê com status, imagens e indicadores técnicos',
    icon: '🏛️',
    color: '#4c1d95',
    available: true
  }
];

export const FAVICON_BY_TOOL = {
  'viabilidade-alares': '/favicons/alares.png'
};

/** Ferramentas internas acessíveis quando o dashboard pai está habilitado */
const TOOL_ACCESS_VIA_PARENT = {
  'relatorio-de-construcao': ['dashboard-implantacao'],
  'formulario-engenharia-implantacao': ['dashboard-implantacao'],
  'formulario-engenharia': ['dashboard-projetos']
};

/** Lista de metadados para UI de permissões (sem componentes). */
export function getToolsForPermissions() {
  return portalToolsMeta.map((meta) => ({
    ...meta,
    faviconImage: FAVICON_BY_TOOL[meta.id]
  }));
}

/**
 * Mescla permissões salvas com todas as ferramentas do registry.
 * Ferramentas novas (sem chave salva) ficam habilitadas por padrão.
 */
export function mergePermissionsWithRegistry(permissions = {}) {
  const merged = { ...(permissions || {}) };
  portalToolsMeta.forEach((tool) => {
    if (merged[tool.id] === undefined) {
      merged[tool.id] = true;
    }
  });
  return merged;
}

/**
 * Verifica se o usuário pode acessar uma ferramenta.
 * Admin: sempre. Demais: flag explícita ou acesso via dashboard pai.
 */
export function canAccessTool(toolId, permissions = {}, { userTipo = 'user' } = {}) {
  if ((userTipo || '').toLowerCase() === 'admin') return true;

  const merged = mergePermissionsWithRegistry(permissions);

  if (merged[toolId] === true) return true;

  const parentIds = TOOL_ACCESS_VIA_PARENT[toolId];
  if (parentIds?.some((parentId) => merged[parentId] === true)) {
    return true;
  }

  return false;
}

/**
 * Payload completo para salvar no backend (todas as ferramentas com true/false)
 */
export function buildPermissionsPayload(currentPermissions = {}) {
  const merged = mergePermissionsWithRegistry(currentPermissions);
  const payload = {};
  portalToolsMeta.forEach((tool) => {
    payload[tool.id] = merged[tool.id] === true;
  });
  return payload;
}

/** IDs de todas as ferramentas (para sincronizar com backend) */
export const PORTAL_TOOL_IDS = portalToolsMeta.map((t) => t.id);
