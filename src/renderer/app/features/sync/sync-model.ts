import type { ToolIdDto } from '../../../../shared/ipc/import-contract';
import type { ItemKindDto } from '../../../../shared/ipc/library-contract';
import type {
  SyncItemStatusDto,
  SyncResolutionDto,
  SyncStateDto,
} from '../../../../shared/ipc/sync-contract';
import { TOOLS } from '../export/export-model';

export interface StateInfo {
  readonly label: string;
  /** Krotkie wyjasnienie pod slowem: co to znaczy dla uzytkownika i co zrobi synchronizacja. */
  readonly meaning: string;
  /** Stan wymaga decyzji uzytkownika: bez niej synchronizacja go pomija. */
  readonly needsDecision: boolean;
  /** Synchronizacja cos tu zapisze bez dodatkowej decyzji. */
  readonly pending: boolean;
}

/**
 * Stany bez koloru: slowo i wyjasnienie. Kolor ma w tym systemie sygnal "nadpisze" i usuniecie,
 * a one pojawiaja sie dopiero po wyborze uzytkownika, nie jako cecha stanu.
 */
export const STATES: Readonly<Record<SyncStateDto, StateInfo>> = {
  never: {
    label: 'Niesynchronizowany',
    meaning: 'Ten element nigdy nie trafił do tego narzędzia. Synchronizacja go utworzy.',
    needsDecision: false,
    pending: true,
  },
  'in-sync': {
    label: 'Zgodny',
    meaning: 'Biblioteka i narzędzie zgadzają się z ostatnią synchronizacją.',
    needsDecision: false,
    pending: false,
  },
  'library-changed': {
    label: 'Zmieniony w bibliotece',
    meaning:
      'Element zmienił się w bibliotece, plik w narzędziu nie. Synchronizacja go zaktualizuje.',
    needsDecision: false,
    pending: true,
  },
  'tool-changed': {
    label: 'Zmieniony w narzędziu',
    meaning:
      'Plik w narzędziu zmienił się od ostatniej synchronizacji, biblioteka nie. Wybierz, czyja wersja zostaje.',
    needsDecision: true,
    pending: false,
  },
  conflict: {
    label: 'Konflikt',
    meaning: 'Zmiana po obu stronach. Nic nie dzieje się samo: wybierz, czyja wersja zostaje.',
    needsDecision: true,
    pending: false,
  },
  'missing-in-tool': {
    label: 'Zniknął z narzędzia',
    meaning:
      'Plik zsynchronizowany wcześniej zniknął z narzędzia. Synchronizacja utworzy go na nowo.',
    needsDecision: false,
    pending: true,
  },
  unsupported: {
    label: 'Brak odpowiednika',
    meaning: 'To narzędzie nie ma odpowiednika tego elementu, więc synchronizacja go pomija.',
    needsDecision: false,
    pending: false,
  },
};

export const STATE_ORDER: readonly SyncStateDto[] = [
  'conflict',
  'tool-changed',
  'library-changed',
  'never',
  'missing-in-tool',
  'in-sync',
  'unsupported',
];

export interface ResolutionInfo {
  readonly value: SyncResolutionDto;
  readonly label: string;
  readonly effect: string;
}

export const RESOLUTIONS: readonly ResolutionInfo[] = [
  {
    value: 'library-wins',
    label: 'Zachowaj wersję z biblioteki',
    effect: 'Plik w narzędziu zostanie zastąpiony wersją z biblioteki.',
  },
  {
    value: 'tool-wins',
    label: 'Przyjmij zmianę z narzędzia',
    effect: 'Zmiana z narzędzia stanie się nową wersją elementu w bibliotece.',
  },
  {
    value: 'skip',
    label: 'Pomiń',
    effect: 'Nic się nie zmieni w tym przebiegu.',
  },
];

export function resolutionKey(itemId: string, tool: ToolIdDto): string {
  return `${itemId}|${tool}`;
}

export interface MatrixRow {
  readonly itemId: string;
  readonly kind: ItemKindDto;
  readonly slug: string;
  readonly title: string;
  readonly cells: ReadonlyMap<ToolIdDto, SyncItemStatusDto>;
}

/** Plaska lista (element, narzedzie) zamienia sie w macierz: wiersz na element, kolumna na narzedzie. */
export function buildMatrix(items: readonly SyncItemStatusDto[]): MatrixRow[] {
  const rows = new Map<
    string,
    { row: Omit<MatrixRow, 'cells'>; cells: Map<ToolIdDto, SyncItemStatusDto> }
  >();
  for (const item of items) {
    let entry = rows.get(item.itemId);
    if (entry === undefined) {
      entry = {
        row: { itemId: item.itemId, kind: item.kind, slug: item.slug, title: item.title },
        cells: new Map(),
      };
      rows.set(item.itemId, entry);
    }
    entry.cells.set(item.tool, item);
  }
  return Array.from(rows.values())
    .map(({ row, cells }) => ({ ...row, cells }))
    .sort((a, b) => a.title.localeCompare(b.title, 'pl'));
}

/** Narzedzia, ktore wystepuja w danych, w stalej kolejnosci produktu. */
export function toolsInUse(items: readonly SyncItemStatusDto[]): ToolIdDto[] {
  const present = new Set(items.map((i) => i.tool));
  return TOOLS.map((t) => t.value).filter((t) => present.has(t));
}

/** Wiersz wymaga uwagi, gdy w dowolnej kolumnie jest stan do zapisu albo do decyzji. */
export function rowMatchesState(row: MatrixRow, state: SyncStateDto | ''): boolean {
  if (state === '') return true;
  for (const cell of row.cells.values()) if (cell.status === state) return true;
  return false;
}

export interface StatusTotals {
  readonly pending: number;
  readonly decisions: number;
  readonly inSync: number;
}

/** Liczby liczone z widocznych komorek (element x narzedzie), nie z elementow. */
export function totals(rows: readonly MatrixRow[]): StatusTotals {
  let pending = 0;
  let decisions = 0;
  let inSync = 0;
  for (const row of rows) {
    for (const cell of row.cells.values()) {
      const info = STATES[cell.status];
      if (info.pending) pending++;
      else if (info.needsDecision) decisions++;
      else if (cell.status === 'in-sync') inSync++;
    }
  }
  return { pending, decisions, inSync };
}

export const MATERIALIZATION_NAME: Readonly<Record<'symlink' | 'junction' | 'copy', string>> = {
  symlink: 'dowiązanie symboliczne',
  junction: 'junction',
  copy: 'kopia',
};
