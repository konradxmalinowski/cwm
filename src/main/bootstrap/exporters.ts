import type { ToolAdapter, ToolExporter } from '../../core/ports/tool-adapter';

/** Adapter, ktory poza importem implementuje tez czesc eksportowa (Etap 4). */
function isToolExporter(adapter: ToolAdapter): adapter is ToolAdapter & ToolExporter {
  const candidate = adapter as Partial<ToolExporter>;
  return typeof candidate.plan === 'function' && typeof candidate.capabilities === 'function';
}

/**
 * Rejestr eksporterow: bierze z adapterow te, ktore implementuja `ToolExporter`. Dopoki adapter
 * nie ma czesci eksportowej, jego narzedzie odpowiada "eksport niedostepny", bez zmian tutaj.
 */
export function createExporters(adapters: readonly ToolAdapter[]): readonly ToolExporter[] {
  return adapters.filter(isToolExporter);
}
