/** Aguarda no mínimo `ms` — útil para manter a tela de loading visível enquanto dados carregam. */
export function minTransitionDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Executa `work` em paralelo com o tempo mínimo de transição. */
export async function runDuringTransition(work, minMs = 2000) {
  const [result] = await Promise.all([work(), minTransitionDelay(minMs)]);
  return result;
}
