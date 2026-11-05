import { NOT_RECOVERABLE_FROM_FILES, type IndexStartupInfo } from '../../core/model/index-health';
import type { LibraryService } from '../../core/services/library/library-service';

const MAX_NOT_RESTORED_LINES = 50;

/** Lista "czego nie odzyskano": elementy z powodem, potem to, co nie wraca z plikow z definicji. */
export function notRestoredLines(failed: readonly { id: string; reason: string }[]): string[] {
  const lines = failed.slice(0, MAX_NOT_RESTORED_LINES).map((f) => `element ${f.id}: ${f.reason}`);
  if (failed.length > MAX_NOT_RESTORED_LINES) {
    lines.push(`oraz ${failed.length - MAX_NOT_RESTORED_LINES} kolejnych elementow`);
  }
  return [...lines, ...NOT_RECOVERABLE_FROM_FILES];
}

/**
 * Wypelnienie indeksu biblioteki przy starcie (ADR 0014, kryterium 2 Etapu 2).
 *
 * Indeks wypelnia sie z plikow, gdy jest swiezy po odbudowie albo gdy liczba elementow w nim
 * nie zgadza sie z liczba katalogow w `library/items` (nowy indeks, migracja, reczne skasowanie).
 * Zwraca informacje o starcie z prawdziwa liczba wczytanych elementow i lista tego, czego nie
 * wczytano. Indeks odmowiony zostaje bez zmian: nie ma do czego pisac.
 */
export async function restoreLibraryIndex(
  service: LibraryService | null,
  info: IndexStartupInfo,
  logUnexpected: (error: unknown) => void,
): Promise<IndexStartupInfo> {
  if (service === null || info.outcome === 'refused') return info;

  try {
    const report = await service.syncIndex({ force: info.outcome === 'rebuilt' });
    if (info.outcome !== 'rebuilt' || report.status === 'unavailable') return info;

    return {
      ...info,
      restoredItems: report.restored,
      notRestored: notRestoredLines(report.failed),
    };
  } catch (error: unknown) {
    logUnexpected(error);
    if (info.outcome !== 'rebuilt') return info;
    return {
      ...info,
      restoredItems: 0,
      notRestored: [
        'zawartosc biblioteki (nie udalo sie wypelnic indeksu z plikow)',
        ...NOT_RECOVERABLE_FROM_FILES,
      ],
    };
  }
}
