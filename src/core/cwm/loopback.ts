/**
 * Czy nazwa hosta to petla zwrotna. Osobny plik bez zaleznosci: adres http na petli jest jedynym
 * wyjatkiem od https (ADR 0048), a ten sam kod sprawdza `check.ts` i `git-source.ts`, ktory trafia tez do
 * renderera przez `core/services/import/git-input.ts`, wiec nie moze ciagnac reszty walidatorow manifestu.
 */
export function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
