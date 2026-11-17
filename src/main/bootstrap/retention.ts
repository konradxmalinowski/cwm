import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { systemClock } from '../../core/ports/clock';
import type { IndexStore } from '../../core/ports/index-store';
import type { RetentionLog } from '../../core/ports/retention';
import type { LibraryService } from '../../core/services/library/library-service';
import { RetentionService } from '../../core/services/retention/retention-service';
import { SqliteIndexStore } from '../../infra/db/index-store';
import { FsBackupStore } from '../../infra/store/backup';
import { fsBackupReader } from '../../infra/store/backup-reader';
import { FsObjectInventory } from '../../infra/store/object-inventory';
import { FsObjectStore } from '../../infra/store/object-store';
import { FsRetentionSettingsStore } from '../../infra/store/retention-settings';
import { indexBackedOperationLog } from './library';
import { libraryRoot, objectsRoot } from './paths';

export interface RetentionBootstrapDeps {
  readonly userDataDir: string;
  readonly library: () => LibraryService | null;
  /** Log operacji zyje w indeksie, ktory moze byc odmowiony; dlatego dostep leniwy. */
  readonly indexStore: () => IndexStore | null;
  readonly onUnexpected: (error: unknown) => void;
}

/**
 * Log dla retencji z indeksu otwartego w danej chwili. Gdy indeks jest odmowiony albo zamkniety,
 * odczyt odrzuca, a przebieg konczy sie bledem zamiast liczyc osiagalnosc z pustej historii.
 */
function indexBackedRetentionLog(indexStore: () => IndexStore | null): RetentionLog {
  const current = (): RetentionLog => {
    const store = indexStore();
    if (!(store instanceof SqliteIndexStore)) {
      throw new Error('indeks jest niedostepny, historia nie moze byc przycieta');
    }
    return store.retentionLog();
  };
  return {
    rows: () => {
      try {
        return current().rows();
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    deleteRows: (seqs) => {
      try {
        return current().deleteRows(seqs);
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

export function createRetentionSettings(userDataDir: string): FsRetentionSettingsStore {
  return new FsRetentionSettingsStore(userDataDir);
}

/** Sklada serwis retencji na tych samych katalogach co biblioteka i brama zapisu. */
export function createRetentionService(
  deps: RetentionBootstrapDeps,
  settings: FsRetentionSettingsStore,
): RetentionService {
  const objectsDir = objectsRoot(deps.userDataDir);
  return new RetentionService({
    log: indexBackedRetentionLog(deps.indexStore),
    objects: new FsObjectStore(objectsDir),
    inventory: new FsObjectInventory(objectsDir),
    backups: fsBackupReader(new FsBackupStore(join(deps.userDataDir, 'backups'))),
    library: {
      roots: () => {
        const library = deps.library();
        if (library === null) return Promise.reject(new Error('biblioteka jest niedostepna'));
        // Brak `library/items` to nie pusta biblioteka: start tworzy ten katalog, wiec jego brak
        // znaczy, ze ktos go usunal, a wtedy nie wiadomo, co jest potrzebne.
        if (!existsSync(join(libraryRoot(deps.userDataDir), 'items'))) {
          return Promise.resolve({ hashes: [], unreadable: 0, rootMissing: true });
        }
        return library.retentionRoots();
      },
    },
    settings,
    audit: () => indexBackedOperationLog(deps.indexStore),
    clock: systemClock,
    onUnexpected: deps.onUnexpected,
  });
}
