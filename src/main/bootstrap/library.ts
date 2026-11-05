import { systemClock } from '../../core/ports/clock';
import { createUlidGenerator, cryptoRandomBytes } from '../../core/ports/id-generator';
import type { IndexStore } from '../../core/ports/index-store';
import type { OperationLog, OperationRecord } from '../../core/ports/operation-log';
import { LibraryService } from '../../core/services/library/library-service';
import { SqliteIndexStore } from '../../infra/db/index-store';
import { ensureLibraryDirs } from '../../infra/library/ensure-dirs';
import { FsLibraryStore } from '../../infra/library/library-store';
import { FsObjectStore } from '../../infra/store/object-store';
import { libraryRoot, objectsRoot } from './paths';

/**
 * Log operacji zyje w indeksie, a indeks moze byc odmowiony albo zamkniety. Wtedy `append`
 * odrzuca, a `LibraryService` zamienia to na ostrzezenie `operation-log-failed` (biblioteka dziala dalej).
 */
export function indexBackedOperationLog(indexStore: () => IndexStore | null): OperationLog {
  return {
    append(record: OperationRecord): Promise<void> {
      const store = indexStore();
      if (!(store instanceof SqliteIndexStore)) {
        return Promise.reject(
          new Error('indeks jest niedostepny, log operacji nie zostal zapisany'),
        );
      }
      return store.operationLog().append(record);
    },
  };
}

export interface LibraryStartup {
  readonly service: LibraryService | null;
  /** Powod bez sciezki bezwzgledna, do stderr. */
  readonly failure?: string;
}

/**
 * Tworzy katalogi biblioteki i serwis. Nie rzuca: gdy katalogu nie da sie utworzyc, zwraca
 * `service: null`, a kanaly `library:*` odpowiadaja bledem, nie blokujac startu aplikacji.
 */
export function startLibrary(
  userDataDir: string,
  indexStore: () => IndexStore | null,
): LibraryStartup {
  const library = libraryRoot(userDataDir);
  const objects = objectsRoot(userDataDir);
  try {
    ensureLibraryDirs(library, objects);
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : 'unknown';
    return { service: null, failure: `katalog biblioteki nie jest zapisywalny (${code})` };
  }

  const service = new LibraryService({
    store: new FsLibraryStore(library),
    objects: new FsObjectStore(objects),
    log: indexBackedOperationLog(indexStore),
    ids: createUlidGenerator(systemClock, cryptoRandomBytes),
    clock: systemClock,
    index: () => {
      const store = indexStore();
      return store instanceof SqliteIndexStore ? store.libraryIndex() : null;
    },
  });
  return { service };
}
