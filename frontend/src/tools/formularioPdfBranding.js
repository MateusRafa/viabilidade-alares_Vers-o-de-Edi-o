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
  /**
   * Assinatura na Lista de Material — tenta PNG (fundo transparente) e depois SVG.
   * Coloque o arquivo em: frontend/public/images/assinatura-supervisor.png
   */
  assinaturaSupervisorPaths: [
    '/images/assinatura-supervisor.png',
    '/images/assinatura-supervisor.svg'
  ],
  /** Assinatura na Lista de Material Implantado (Relatório de Construção) */
  assinaturaImplantacaoSupervisorPaths: [
    '/images/assinatura-supervisor-implantacao.png',
    '/images/assinatura-supervisor-implantacao.svg'
  ],
  /** Pixels RGB acima deste valor viram transparentes (0–255; maior = remove mais cinza) */
  assinaturaFundoClaroLimite: 238,
  /** Nome abaixo da linha de assinatura na Lista de Material */
  assinaturaCoordenadorNome: 'Adônis Pimentel de Araújo',
  /** Cargo abaixo do nome (negrito) na Lista de Material */
  assinaturaCoordenadorCargo: 'Coordenador de Planejamento e Projetos - Engenharia Alares',
  /** Nome na Lista de Material Implantado */
  assinaturaImplantacaoCoordenadorNome: 'Jose Rudson Melo Da Silva',
  /** Cargo na Lista de Material Implantado */
  assinaturaImplantacaoCoordenadorCargo: 'Coordenador de Implantação',
  /** Nome padrão do campo Coordenador de Projetos (Informações do projeto) */
  coordenadorProjetosNomePadrao: 'Adônis Pimentel de Araújo',
  cores: {
    primaria: '#1a4a7a',
    secundaria: '#8a9bb5',
    accent: '#7B68EE',
    texto: '#1f2937'
  }
};

/** @deprecated Use getPdfPageCount(formData) — total dinâmico conforme passos */
export const TOTAL_PDF_PAGES = 3;
