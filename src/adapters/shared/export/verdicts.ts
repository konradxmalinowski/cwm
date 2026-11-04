import type { LibraryItem, ToolId } from '../../../core/model/item';
import type { CompatibilityLevel, CompatibilityVerdict } from '../../../core/model/plan';

/** Wspolne skladanie werdyktow zgodnosci (ARCHITECTURE 4.3). Czyste, bez I/O. */

const ORDER: Readonly<Record<CompatibilityLevel, number>> = {
  full: 0,
  partial: 1,
  lossy: 2,
  unsupported: 3,
};

export function worst(a: CompatibilityLevel, b: CompatibilityLevel): CompatibilityLevel {
  return ORDER[a] >= ORDER[b] ? a : b;
}

export function verdict(
  level: CompatibilityLevel,
  reasons: readonly string[] = [],
  lostAttributes: readonly string[] = [],
  addedAttributes: readonly string[] = [],
): CompatibilityVerdict {
  return { level, reasons, lostAttributes, addedAttributes };
}

export function unsupported(reason: string): CompatibilityVerdict {
  return verdict('unsupported', [reason]);
}

/** Klucze ze snapshotow innych narzedzi: nie maja obrazu w pliku, ktory tu piszemy. */
export function foreignUnmapped(item: LibraryItem, tool: ToolId, prefix?: string): string[] {
  const out: string[] = [];
  for (const snapshot of item.source.snapshots) {
    if (snapshot.tool === tool) continue;
    for (const key of snapshot.unmappedKeys) {
      if (prefix === undefined || key.path.startsWith(prefix)) out.push(key.path);
    }
  }
  return out;
}

export const MCP_REASON =
  'Ustawienia narzędzia, w tym serwery MCP, nie są eksportowane. Przeniesienie zmieniłoby zakres z projektowego na globalny i nie przeniosłoby zmiennych środowiskowych (ADR 0020).';

/** Powody dla typow, ktorych zaden z dwoch adapterow nie eksportuje w tej wersji. */
export function unsupportedKind(item: LibraryItem): CompatibilityVerdict {
  switch (item.kind) {
    case 'tool-setting':
      return unsupported(MCP_REASON);
    case 'project-instruction':
      return unsupported(
        'Instrukcje projektowe leżą w katalogu projektu, a eksport obejmuje wyłącznie konfigurację globalną narzędzia.',
      );
    case 'reference-asset':
      return unsupported('Pliki pomocnicze są eksportowane razem ze skillem, nie osobno.');
    default:
      return unsupported(`Typ elementu "${item.kind}" nie jest eksportowany w tej wersji.`);
  }
}
