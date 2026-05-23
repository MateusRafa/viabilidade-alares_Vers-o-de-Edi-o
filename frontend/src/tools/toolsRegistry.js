// ============================================
// Registry de Ferramentas do Portal
// ============================================
// Metadados centralizados em /shared/portal-tools.json
// ============================================

import portalToolsMeta from '../data/portal-tools.json';
import ViabilidadeAlares from './ViabilidadeAlares.svelte';
import AnaliseCobertura from './AnaliseCobertura.svelte';
import CalculadoraOrcamento from './CalculadoraOrcamento.svelte';
import MapaConsulta from './MapaConsulta.svelte';
import DashboardCensup from './DashboardCensup.svelte';
import FormularioEngenharia from './FormularioEngenharia.svelte';

const TOOL_COMPONENTS = {
  'viabilidade-alares': ViabilidadeAlares,
  'analise-cobertura': AnaliseCobertura,
  'calculadora-orcamento': CalculadoraOrcamento,
  'mapa-consulta': MapaConsulta,
  'dashboard-censup': DashboardCensup,
  'formulario-engenharia': FormularioEngenharia
};

const FAVICON_BY_TOOL = {
  'viabilidade-alares': '/favicons/alares.png'
};

/**
 * Registry completo (metadados + componente Svelte)
 */
export const toolsRegistry = portalToolsMeta.map((meta) => ({
  ...meta,
  faviconImage: FAVICON_BY_TOOL[meta.id],
  component: TOOL_COMPONENTS[meta.id] || null
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
  return toolsRegistry.filter((tool) => tool.available && tool.component);
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
