import type { ToolAdapter } from '../../core/ports/tool-adapter';

/**
 * Rejestr adapterow narzedzi. Jedyne miejsce, w ktorym main dowiazuje konkretne adaptery;
 * serwis importu dostaje liste i nie wie, ktore narzedzia istnieja.
 */
export function createAdapters(): readonly ToolAdapter[] {
  // Adaptery Claude Code i Codeksa powstaja rownolegle w src/adapters; wpisz je tutaj po ich zmergowaniu.
  return [];
}
