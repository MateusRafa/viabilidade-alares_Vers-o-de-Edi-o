/** Tabelas espelhadas B1 → B2 (ordem de cópia: dependências primeiro). */
export const CLUSTER_TABLES = [
  'coverage_calculation_progress',
  'coverage_polygons',
  'condominios',
  'condominios_mdu',
  'ctos',
  'projetistas',
  'tabulacoes',
  'vi_ala',
  'upload_history'
];

/** Coluna estável para ORDER BY na paginação. */
export function getTableOrderColumn(table) {
  if (table === 'coverage_calculation_progress') return 'calculation_id';
  if (table === 'upload_history') return 'uploaded_at';
  if (table === 'vi_ala') return 'created_at';
  return 'id';
}

/** Estratégia de delete-all na réplica antes do insert. */
export function buildDeleteQuery(client, table) {
  const strategies = {
    ctos: () => client.from(table).delete({ count: 'exact' }).gte('id', 0),
    condominios: () => client.from(table).delete({ count: 'exact' }).gte('id', 0),
    condominios_mdu: () => client.from(table).delete({ count: 'exact' }).gte('id', 0),
    coverage_polygons: () => client.from(table).delete({ count: 'exact' }).gte('id', 0),
    coverage_calculation_progress: () =>
      client.from(table).delete({ count: 'exact' }).neq('calculation_id', ''),
    projetistas: () => client.from(table).delete({ count: 'exact' }).gte('id', 0),
    tabulacoes: () => client.from(table).delete({ count: 'exact' }).gte('id', 0),
    vi_ala: () => client.from(table).delete({ count: 'exact' }).gte('id', 0),
    upload_history: () => client.from(table).delete({ count: 'exact' }).gte('id', 0)
  };
  return strategies[table] || (() => client.from(table).delete({ count: 'exact' }).gte('id', 0));
}

/** Remove PK serial na réplica para evitar conflito (réplica gera id próprio). */
export function stripReplicaPrimaryKey(table, row) {
  const copy = { ...row };
  if (table !== 'coverage_calculation_progress') {
    delete copy.id;
  }
  return copy;
}

export const CLUSTER_APP_RPCS = [
  'get_next_vi_ala_number',
  'inserir_entrada_projetista',
  'atualizar_saida_projetista',
  'buscar_entrada_saida_projetistas'
];

export const CLUSTER_COVERAGE_RPCS = [
  'union_polygons_geojson',
  'simplify_polygon_geojson',
  'calculate_polygon_area_km2',
  'calculate_coverage_polygon_batch',
  'save_coverage_polygon_from_geojson',
  'get_active_coverage_polygon',
  'get_polygon_geojson',
  'check_point_in_coverage',
  'get_coverage_calculation_status',
  'calculate_polygon_for_specific_ctos',
  'exec_sql'
];

export const CLUSTER_ALL_RPCS = [...CLUSTER_COVERAGE_RPCS, ...CLUSTER_APP_RPCS];
