import type { HistoryEntryDto } from '../../../../shared/ipc/sync-contract';

/** Typy operacji z logu po polsku. Nieznany typ wraca bez zmian, zeby nic nie zniknelo z rejestru. */
const KIND_LABEL: Readonly<Record<string, string>> = {
  create: 'Utworzenie',
  update: 'Zmiana',
  delete: 'Usunięcie',
  'adopt-disk': 'Przyjęcie z dysku',
  restore: 'Przywrócenie wersji',
  import: 'Import',
  export: 'Eksport',
  sync: 'Synchronizacja',
  rollback: 'Cofnięcie',
};

export function historyKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** Przycisk nazywa to, co cofa: "Cofnij eksport", "Cofnij synchronizację". */
export function undoLabel(kind: string): string {
  switch (kind) {
    case 'export':
      return 'Cofnij eksport';
    case 'sync':
      return 'Cofnij synchronizację';
    case 'import':
      return 'Cofnij import';
    case 'rollback':
      return 'Cofnij cofnięcie';
    default:
      return 'Cofnij';
  }
}

/**
 * Kursor stronicowania: `before` dostaje czas ostatniego wpisu z biezacej strony. Wpisy sa
 * w odwrotnej chronologii, wiec nastepna strona to wpisy starsze od niego.
 */
export function nextCursor(entries: readonly HistoryEntryDto[]): string | null {
  const last = entries[entries.length - 1];
  return last === undefined ? null : last.at;
}

export const PAGE_SIZE = 25;
