/**
 * Rotas de rua pelo arquivo local (até 1 km).
 * Acima disso, ou sem rua no arquivo, a tela usa o Google Routes.
 * O mapa de satélite continua no Google.
 */
import { routeOnGraph, StreetRouteError } from './lib/routing/streetGraph.js';
import {
  initStreetGraph,
  scheduleStreetGraphRefresh,
  streetGraphPrepared,
  streetGraphStatus
} from './lib/routing/streetGraphBuild.js';

function sendRoutingError(res, err) {
  const code = err instanceof StreetRouteError ? err.code : 'ROUTER_ERROR';
  const status = err instanceof StreetRouteError ? err.statusCode : 500;
  if (code === 'ZERO_RESULTS' || code === 'ROUTE_LONG') {
    return res.status(200).json({
      success: false,
      code,
      error: err.message || 'Sem traçado local'
    });
  }
  return res.status(status >= 400 ? status : 500).json({
    success: false,
    code,
    error: err.message || 'Erro ao calcular rota'
  });
}

/**
 * @param {import('express').Express} app
 * @param {{ dataDir?: string }} [opts]
 */
export function registerRoutingRoutes(app, { dataDir } = {}) {
  initStreetGraph(dataDir);
  const status = streetGraphStatus();
  if (!status.available) {
    scheduleStreetGraphRefresh('arquivo-ausente');
  }

  app.get('/api/routes/status', (_req, res) => {
    const current = streetGraphStatus();
    res.json({
      success: true,
      engine: 'ruas',
      available: current.available,
      builtAt: current.builtAt,
      radiusMeters: current.radiusMeters,
      running: current.running,
      reason: current.available ? null : 'Arquivo de ruas ainda não está pronto'
    });
  });

  app.post('/api/routes/path', (req, res) => {
    const started = Date.now();
    try {
      const prep = streetGraphPrepared();
      const result = routeOnGraph(prep, req.body?.origin, req.body?.destination);
      console.log(
        `🛣️ [Rotas] local ${Math.round(result.distanceMeters)} m em ${Date.now() - started} ms ` +
          `(${result.path.length} pontos)`
      );
      return res.json({
        success: true,
        engine: 'ruas',
        mode: 'walking',
        distanceMeters: result.distanceMeters,
        path: result.path
      });
    } catch (err) {
      if (!(err instanceof StreetRouteError) || (err.code !== 'ZERO_RESULTS' && err.code !== 'ROUTE_LONG')) {
        console.warn(`⚠️ [Rotas] ${err.code || 'ERRO'}: ${err.message}`);
      }
      return sendRoutingError(res, err);
    }
  });
}
