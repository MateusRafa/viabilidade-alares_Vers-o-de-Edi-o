// ============================================
// Registry de Ferramentas do Portal
// ============================================
// Metadados: manter em sync com backend/portal-tools.json
// ============================================

/** Metadados das ferramentas (embutidos para o build não depender de JSON externo). */
const portalToolsMeta = [
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
  }
];

/** Carrega apenas arquivos .svelte presentes no build (evita falha se um componente não foi enviado). */
const toolSvelteModules = import.meta.glob('./*.svelte', { eager: true });

const TOOL_COMPONENT_FILES = {
  'viabilidade-alares': './ViabilidadeAlares.svelte',
  'analise-cobertura': './AnaliseCobertura.svelte',
  'calculadora-orcamento': './CalculadoraOrcamento.svelte',
  'mapa-consulta': './MapaConsulta.svelte',
  'dashboard-censup': './DashboardCensup.svelte',
  'formulario-engenharia': './FormularioEngenharia.svelte',
  'formulario-engenharia-implantacao': './FormularioEngenhariaImplantacao.svelte',
  'relatorio-de-construcao': './RelatorioDeConstrucao.svelte',
  'dashboard-projetos': './DashboardProjetos.svelte',
  'dashboard-implantacao': './DashboardImplantacao.svelte',
  'ia-auditoria-diagramacao': './IaAuditoriaDiagramacao.svelte'
};

const FAVICON_BY_TOOL = {
  'viabilidade-alares': '/favicons/alares.png'
};

function resolveToolComponent(toolId) {
  const file = TOOL_COMPONENT_FILES[toolId];
  if (!file) return null;
  return toolSvelteModules[file]?.default ?? null;
}

/**
 * Registry completo (metadados + componente Svelte)
 */
export const toolsRegistry = portalToolsMeta.map((meta) => ({
  ...meta,
  faviconImage: FAVICON_BY_TOOL[meta.id],
  component: resolveToolComponent(meta.id)
}));

/**
 * Mescla permissões salvas com todas as ferramentas do registry.
 * Ferramentas novas (sem chave salva) ficam habilitadas por padrão.
 */
export function mergePermissionsWithRegistry(permissions = {}) {
  const merged = { ...(permissions || {}) };
  toolsRegistry.forEach((tool) => {
    if (merged[tool.id] === undefined) {
      merged[tool.id] = true;
    }
  });
  return merged;
}

/**
 * Payload completo para salvar no backend (todas as ferramentas com true/false)
 */
export function buildPermissionsPayload(currentPermissions = {}) {
  const merged = mergePermissionsWithRegistry(currentPermissions);
  const payload = {};
  toolsRegistry.forEach((tool) => {
    payload[tool.id] = merged[tool.id] === true;
  });
  return payload;
}

/** IDs de todas as ferramentas (para sincronizar com backend) */
export const PORTAL_TOOL_IDS = toolsRegistry.map((t) => t.id);

/**
 * Busca uma ferramenta pelo ID
 */
export function getToolById(toolId) {
  return toolsRegistry.find((tool) => tool.id === toolId) || null;
}

/**
 * Retorna todas as ferramentas disponíveis
 */
export function getAvailableTools() {
  return toolsRegistry.filter(
    (tool) => tool.available && tool.component && tool.portalVisible !== false
  );
}

/**
 * Lista para UI de permissões (Config / admin)
 */
export function getToolsForPermissions() {
  return toolsRegistry;
}

/**
 * Verifica se uma ferramenta existe e está disponível
 */
export function isToolAvailable(toolId) {
  const tool = getToolById(toolId);
  return tool && tool.available && tool.component;
}
