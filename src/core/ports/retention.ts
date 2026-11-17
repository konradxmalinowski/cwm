import type { Sha256 } from '../model/item';
import type { RetentionSettings } from '../model/retention';

/** Lekki widok wiersza logu operacji, tylko to, czego potrzebuje retencja. */
export interface RetentionLogRow {
  readonly seq: number;
  readonly operation: string;
  readonly at: string;
  readonly backupId: string | null;
  readonly reverts: string | null;
  /** Hashe `before` i `after` wiersza (rekordy wersji albo manifesty stanu z dysku). */
  readonly versionHashes: readonly Sha256[];
}

/** Dostep do logu operacji z `index.db` w zakresie potrzebnym do przycinania historii. */
export interface RetentionLog {
  /** Wszystkie wiersze rosnaco po `seq`. */
  rows(): Promise<readonly RetentionLogRow[]>;
  /** Usuwa wiersze o podanych `seq` w jednej transakcji i zwraca liczbe usunietych. */
  deleteRows(seqs: readonly number[]): Promise<number>;
}

export interface ObjectListing {
  /** Hash obiektu i jego rozmiar w bajtach. */
  readonly objects: ReadonlyMap<Sha256, number>;
  /** Wpisy w store, ktorych nie traktujemy jako obiektow (dowiazania, katalogi, obce nazwy). */
  readonly skipped: number;
}

/**
 * Spis i usuwanie obiektow content store. Spis nie idzie za dowiazaniami, a usuniecie dotyczy
 * wylacznie zwyklego pliku pod `objects/<aa>/<hash>`. `remove` zwraca `false`, gdy obiektu nie bylo.
 */
export interface ObjectInventory {
  list(): Promise<ObjectListing>;
  remove(hash: Sha256): Promise<boolean>;
}

export interface RetentionSettingsStore {
  /** Brak pliku albo plik nieczytelny daje komplet `null`: domyslnie nic nie jest przycinane. */
  load(): Promise<RetentionSettings>;
  save(settings: RetentionSettings): Promise<void>;
}

export interface RetentionRoots {
  readonly hashes: readonly Sha256[];
  /** Elementy, ktorych wskaznika na rekord wersji nie da sie ustalic. */
  readonly unreadable: number;
}

/** Korzenie osiagalnosci z biblioteki: rekordy wersji wskazywane przez `item.json` elementow. */
export interface RetentionLibrary {
  roots(): Promise<RetentionRoots>;
}
