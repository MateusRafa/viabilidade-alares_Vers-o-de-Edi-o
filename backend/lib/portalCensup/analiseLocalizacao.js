import supabase, { isSupabaseAvailable } from '../../supabase.js';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

function getMapsApiKey() {
  return (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  ).trim();
}

function buildAddressQuery(endereco = {}, chamado = {}) {
  const parts = [
    endereco.logradouro || '',
    endereco.numero && !/^s\.?\s*n\.?$/i.test(String(endereco.numero))
      ? String(endereco.numero)
      : '',
    endereco.bairro || '',
    endereco.cidade || chamado.cidade || '',
    endereco.uf || chamado.uf || '',
    endereco.cep ? `CEP ${endereco.cep}` : '',
    'Brasil'
  ]
    .map((p) => String(p || '').trim())
    .filter(Boolean);

  if (endereco.completo && parts.length < 3) {
    return `${endereco.completo}, ${chamado.cidade || ''} ${chamado.uf || ''}, Brasil`
      .replace(/\s+/g, ' ')
      .trim();
  }

  return parts.join(', ');
}

function addressLooksWeak(endereco = {}) {
  const numero = String(endereco.numero || '');
  const logradouro = String(endereco.logradouro || endereco.completo || '');
  if (!logradouro.trim()) return true;
  if (/^s\.?\s*n\.?$/i.test(numero) || /,\s*SN\b/i.test(logradouro)) return true;
  if (!endereco.cidade && !endereco.cep) return true;
  return false;
}

function scoreGeocodeResult(result) {
  const locType = result?.geometry?.location_type || '';
  if (locType === 'ROOFTOP') return 100;
  if (locType === 'RANGE_INTERPOLATED') return 80;
  if (locType === 'GEOMETRIC_CENTER') return 50;
  if (locType === 'APPROXIMATE') return 30;
  return 20;
}

async function geocodeQuery(query, { cidade, uf } = {}) {
  const key = getMapsApiKey();
  if (!key) {
    const err = new Error(
      'GOOGLE_MAPS_API_KEY (ou VITE_GOOGLE_MAPS_API_KEY) não configurada no backend'
    );
    err.statusCode = 503;
    throw err;
  }

  const components = [];
  if (uf) components.push(`administrative_area:${uf}`);
  components.push('country:BR');

  const url = new URL(GEOCODE_URL);
  url.searchParams.set('address', query);
  url.searchParams.set('key', key);
  url.searchParams.set('language', 'pt-BR');
  url.searchParams.set('region', 'br');
  if (components.length) url.searchParams.set('components', components.join('|'));

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (data.status === 'ZERO_RESULTS') {
    return null;
  }

  if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) {
    const err = new Error(`Geocoding falhou: ${data.status || response.status}`);
    err.statusCode = 502;
    err.details = data.error_message || null;
    throw err;
  }

  let best = data.results[0];
  let bestScore = scoreGeocodeResult(best);
  for (const item of data.results) {
    const score = scoreGeocodeResult(item);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }

  const location = best.geometry?.location;
  if (!location) return null;

  return {
    lat: Number(location.lat),
    lng: Number(location.lng),
    formattedAddress: best.formatted_address || query,
    locationType: best.geometry?.location_type || null,
    score: bestScore,
    query
  };
}

function rankReferencias(referencias = [], { cidade } = {}) {
  const city = String(cidade || '').toLowerCase();
  const scored = [...new Set(referencias.map((r) => String(r || '').trim()).filter(Boolean))]
    .filter((name) => name.length >= 4 && name.length <= 80)
    .filter((name) => !/^(rua|av\.|avenida|mapa|zoom|analisar|voltar)\b/i.test(name))
    .map((name) => {
      let score = 0;
      if (/(fazenda|pesqueiro|restaurante|mercado|condom[ií]nio|galv|ve[ií]culos|distribuidora|igreja|escola|hotel)/i.test(name)) {
        score += 30;
      }
      if (city && name.toLowerCase().includes(city)) score += 10;
      if (/\d/.test(name)) score -= 5;
      return { name, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.map((s) => s.name);
}

async function checkCoverage(lat, lng) {
  if (!isSupabaseAvailable() || !supabase) {
    return {
      success: false,
      is_covered: null,
      distance_to_coverage_meters: null,
      message: 'Supabase/cobertura indisponível'
    };
  }

  const { data, error } = await supabase.rpc('check_point_in_coverage', {
    p_latitude: lat,
    p_longitude: lng
  });

  if (error) {
    return {
      success: false,
      is_covered: null,
      distance_to_coverage_meters: null,
      message: error.message
    };
  }

  if (!data || data.length === 0) {
    return {
      success: false,
      is_covered: false,
      distance_to_coverage_meters: null,
      message: 'Nenhum polígono de cobertura encontrado'
    };
  }

  const result = data[0];
  return {
    success: true,
    is_covered: !!result.is_covered,
    distance_to_coverage_meters:
      result.distance_to_coverage_meters != null
        ? Number(result.distance_to_coverage_meters)
        : null,
    polygon_id: result.polygon_id || null
  };
}

function suggestTabulacao(coverage, learned = null, chamado = null) {
  if (learned?.tabulacaoFinal) {
    return {
      tabulacaoFinal: learned.tabulacaoFinal,
      tabulacaoConfianca: learned.confianca ?? 0.78,
      tabulacaoStatus: 'pendente_revisao',
      motivo:
        learned.motivo ||
        `Sugestão ajustada com base em correção anterior semelhante (${learned.tabulacaoFinal}).`
    };
  }

  if (!coverage?.success) {
    return {
      tabulacaoFinal: null,
      tabulacaoConfianca: 0.2,
      tabulacaoStatus: 'aguardando_analise',
      motivo:
        coverage?.message ||
        'Não foi possível consultar a mancha de cobertura. Revise manualmente.'
    };
  }

  if (coverage.is_covered === false) {
    const dist = coverage.distance_to_coverage_meters;
    const distTxt =
      dist != null && !Number.isNaN(dist)
        ? dist >= 1000
          ? `${(dist / 1000).toFixed(2)} km`
          : `${Math.round(dist)} m`
        : null;

    return {
      tabulacaoFinal: 'Fora da Área de Cobertura',
      tabulacaoConfianca: dist != null && dist <= 30 ? 0.9 : 0.82,
      tabulacaoStatus: 'pendente_revisao',
      motivo: distTxt
        ? `Local fora da área de cobertura (cerca de ${distTxt} até a mancha mais próxima), no mesmo critério da Viabilidade Alares.`
        : 'Local fora da área de cobertura da rede.'
    };
  }

  // Motivo Análise de complemento (CTOs finas no Workbench/mapa)
  const motivoNorm = String(chamado?.motivo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (motivoNorm.includes('analise de complemento')) {
    return {
      tabulacaoFinal: 'Aprovado / Sem Estrutura Atendimento Externo',
      tabulacaoConfianca: 0.72,
      tabulacaoStatus: 'pendente_revisao',
      motivo:
        'Motivo Análise de complemento — Atendimento Externo (confirme equipamentos no mapa).'
    };
  }

  return {
    tabulacaoFinal: 'Aprovado Com Portas',
    tabulacaoConfianca: 0.7,
    tabulacaoStatus: 'pendente_revisao',
    motivo:
      'Local dentro da mancha de cobertura. Confirme CTOs/portas na Viabilidade Alares se necessário.'
  };
}

/**
 * Cascata:
 * 1) coordenadas já capturadas
 * 2) geocode do endereço
 * 3) geocode de referências do mapa (ex.: Fazenda Nova Era + cidade)
 * 4) check cobertura → tabulação sugerida
 */
export async function analisarLocalizacaoChamado(chamado, { learned = null } = {}) {
  const passos = [];
  const endereco = chamado.endereco || {};
  const cidade = endereco.cidade || chamado.cidade || '';
  const uf = endereco.uf || chamado.uf || '';
  let resolved = null;

  if (chamado.mapaCoords?.lat != null && chamado.mapaCoords?.lng != null) {
    resolved = {
      lat: Number(chamado.mapaCoords.lat),
      lng: Number(chamado.mapaCoords.lng),
      formattedAddress: endereco.completo || null,
      locationType: 'MAP_COORDS',
      score: 95,
      query: 'coordenadas da Agenda',
      metodo: 'coords_agenda'
    };
    passos.push({ etapa: 'coords_agenda', ok: true, detalhe: resolved.query });
  }

  const addressQuery = buildAddressQuery(endereco, chamado);
  const weakAddress = addressLooksWeak(endereco);

  if (!resolved && addressQuery) {
    try {
      const geo = await geocodeQuery(addressQuery, { cidade, uf });
      if (geo && (!weakAddress || geo.score >= 80)) {
        resolved = { ...geo, metodo: 'endereco' };
        passos.push({
          etapa: 'geocode_endereco',
          ok: true,
          query: addressQuery,
          score: geo.score,
          locationType: geo.locationType
        });
      } else if (geo) {
        passos.push({
          etapa: 'geocode_endereco',
          ok: false,
          query: addressQuery,
          score: geo.score,
          motivo: 'Baixa precisão — tentando referências do mapa'
        });
        // keep as fallback candidate
        if (!resolved) resolved = { ...geo, metodo: 'endereco_baixa_precisao' };
      } else {
        passos.push({ etapa: 'geocode_endereco', ok: false, query: addressQuery, motivo: 'ZERO_RESULTS' });
      }
    } catch (err) {
      passos.push({
        etapa: 'geocode_endereco',
        ok: false,
        query: addressQuery,
        motivo: err.message
      });
      if (err.statusCode === 503) throw err;
    }
  }

  const refs = rankReferencias(chamado.mapaReferencias || [], { cidade });
  const precisaRef =
    !resolved ||
    resolved.metodo === 'endereco_baixa_precisao' ||
    weakAddress ||
    (resolved.score != null && resolved.score < 80);

  if (precisaRef && refs.length) {
    for (const ref of refs.slice(0, 5)) {
      const query = `${ref}, ${cidade || ''} ${uf || ''}, Brasil`.replace(/\s+/g, ' ').trim();
      try {
        const geo = await geocodeQuery(query, { cidade, uf });
        if (geo && geo.score >= 50) {
          // Prefer landmark if previous was weak
          if (
            !resolved ||
            resolved.metodo === 'endereco_baixa_precisao' ||
            (resolved.score || 0) < geo.score ||
            weakAddress
          ) {
            resolved = { ...geo, metodo: 'referencia_mapa', referencia: ref };
          }
          passos.push({
            etapa: 'geocode_referencia',
            ok: true,
            referencia: ref,
            query,
            score: geo.score
          });
          if (resolved.metodo === 'referencia_mapa') break;
        } else {
          passos.push({ etapa: 'geocode_referencia', ok: false, referencia: ref, query });
        }
      } catch (err) {
        passos.push({
          etapa: 'geocode_referencia',
          ok: false,
          referencia: ref,
          motivo: err.message
        });
      }
    }
  }

  if (!resolved?.lat || !resolved?.lng) {
    return {
      analiseStatus: 'falhou',
      localizacao: null,
      viabilidadeResumo: null,
      tabulacaoFinal: null,
      tabulacaoConfianca: 0,
      tabulacaoStatus: 'aguardando_analise',
      analiseIa: {
        modelo: 'cascata-localizacao-v1',
        motivoSugestao:
          'Não foi possível resolver o local (endereço nem referências do mapa). Revise manualmente na Viabilidade.'
      },
      passos
    };
  }

  const coverage = await checkCoverage(resolved.lat, resolved.lng);
  passos.push({
    etapa: 'cobertura',
    ok: !!coverage.success,
    is_covered: coverage.is_covered,
    distance_to_coverage_meters: coverage.distance_to_coverage_meters,
    message: coverage.message || null
  });

  const suggestion = suggestTabulacao(coverage, learned, chamado);
  const metodoLabel =
    resolved.metodo === 'referencia_mapa'
      ? `referência do mapa (“${resolved.referencia}”)`
      : resolved.metodo === 'coords_agenda'
        ? 'coordenadas da Agenda'
        : 'endereço geocodificado';

  return {
    analiseStatus: 'concluida',
    localizacao: {
      lat: resolved.lat,
      lng: resolved.lng,
      metodo: resolved.metodo,
      referencia: resolved.referencia || null,
      formattedAddress: resolved.formattedAddress || null,
      locationType: resolved.locationType || null,
      query: resolved.query || null
    },
    viabilidadeResumo: {
      dentroCobertura: coverage.is_covered,
      distanciaCoberturaMetros: coverage.distance_to_coverage_meters,
      ctosEncontradas: null,
      portasDisponiveis: null,
      distanciaCtoMetros: null,
      projetista: 'Cascata CENSUP v1',
      coberturaOk: !!coverage.success
    },
    tabulacaoFinal: suggestion.tabulacaoFinal,
    tabulacaoConfianca: suggestion.tabulacaoConfianca,
    tabulacaoStatus: suggestion.tabulacaoStatus,
    analiseIa: {
      modelo: 'cascata-localizacao-v1',
      motivoSugestao: `${suggestion.motivo} Local resolvido via ${metodoLabel}.`
    },
    passos
  };
}
