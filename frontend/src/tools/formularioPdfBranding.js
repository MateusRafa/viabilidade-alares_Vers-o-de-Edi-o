/** Identidade visual do PDF B2B — Alares Engenharia */

export const BRAND = {
  nome: 'Alares',
  rodape: 'Planejamento e Projetos - Engenharia Alares',
  marcaAgua: 'ALARES',
  subtituloMarca: 'Engenharia de Redes',
  avisoConfidencial: 'Documento técnico • Uso restrito ao cliente',
  logoPath: '/images/Imagem1.svg',
  logoPathPngFallback: '/images/alares-logo.png',
  capaOndasPath: '/images/Imagem2.svg',
  /** SVG da assinatura digitalizada — substitua o arquivo em public/images/ */
  assinaturaSupervisorPath: '/images/assinatura-supervisor.svg',
  /** Texto exibido abaixo da linha de assinatura na Lista de Material */
  supervisorCargo: 'Coordenador de Projetos',
  /** Nome padrão do campo Coordenador de Projetos (Informações do projeto) */
  coordenadorProjetosNomePadrao: 'Adônis Pimentel',
  cores: {
    primaria: '#1a4a7a',
    secundaria: '#8a9bb5',
    accent: '#7B68EE',
    texto: '#1f2937'
  }
};

/** @deprecated Use getPdfPageCount(formData) — total dinâmico conforme passos */
export const TOTAL_PDF_PAGES = 3;
