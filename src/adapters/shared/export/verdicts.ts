import type { LibraryItem, ToolId } from '../../../core/model/item';
import type { CompatibilityLevel, CompatibilityVerdict } from '../../../core/model/plan';
import { isMcpServerItem } from '../../../core/services/mcp/mcp-server';

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

/**
 * Pola, ktore cel wymaga, a element ich nie ma: brak `name` dopisuje sie jako slug, opis
 * wyliczony trafia do pliku i przy ponownym imporcie jest juz opisem ze zrodla.
 */
export function requiredFieldAdditions(item: LibraryItem): string[] {
  const added: string[] = [];
  if (item.identity.declaredName === null) added.push('name');
  if (item.content.descriptionOrigin === 'derived') added.push('description');
  return added;
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
  'Eksport serwerów MCP do tego narzędzia nie jest jeszcze dostępny. Dziś serwer MCP trafia jawnie, z potwierdzeniem, tylko do Claude Code i Codeksa (ADR 0061).';

const SETTING_REASON =
  'Ustawienia narzędzia inne niż serwery MCP nie są eksportowane (ADR 0020, 0061).';

/** Powody dla typow, ktorych adapter nie eksportuje w tej wersji. */
export function unsupportedKind(item: LibraryItem): CompatibilityVerdict {
  switch (item.kind) {
    case 'tool-setting':
      return unsupported(isMcpServerItem(item) ? MCP_REASON : SETTING_REASON);
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
