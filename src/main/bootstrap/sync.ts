import type { IndexStore } from '../../core/ports/index-store';
import type { OperationLogReader } from '../../core/ports/operation-log';
import type { SyncStateStore } from '../../core/ports/sync-state';
import { SqliteIndexStore } from '../../infra/db/index-store';

const UNAVAILABLE = 'indeks jest niedostepny';

function sqlite(indexStore: () => IndexStore | null): SqliteIndexStore | null {
  const store = indexStore();
  return store instanceof SqliteIndexStore ? store : null;
}

/**
 * Stan synchronizacji w indeksie, dostep leniwy jak w logu operacji. Bez indeksu odczyt jest
 * pusty (kazdy element wyglada na niezsynchronizowany, ADR 0014), a zapis odrzuca.
 */
export function indexBackedSyncState(indexStore: () => IndexStore | null): SyncStateStore {
  const failing = (): Promise<never> => Promise.reject(new Error(UNAVAILABLE));
  return {
    get: (itemId, tool) =>
      sqlite(indexStore)?.syncState().get(itemId, tool) ?? Promise.resolve(null),
    list: (tool) => sqlite(indexStore)?.syncState().list(tool) ?? Promise.resolve([]),
    put: (record) => sqlite(indexStore)?.syncState().put(record) ?? failing(),
    remove: (itemId, tool) => sqlite(indexStore)?.syncState().remove(itemId, tool) ?? failing(),
  };
}

export function indexBackedLogReader(indexStore: () => IndexStore | null): OperationLogReader {
  const failing = (): Promise<never> => Promise.reject(new Error(UNAVAILABLE));
  return {
    groups: (limit, before) =>
      sqlite(indexStore)?.operationLogReader().groups(limit, before) ?? failing(),
    group: (key) => sqlite(indexStore)?.operationLogReader().group(key) ?? failing(),
    revertedBy: (id) => sqlite(indexStore)?.operationLogReader().revertedBy(id) ?? failing(),
  };
}
