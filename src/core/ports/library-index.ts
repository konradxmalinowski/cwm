import type { ItemId, ItemKind, Sha256 } from '../model/item';

/**
 * Wiersz indeksu biblioteki. Indeks jest kopia metadanych i tekstu elementu, nigdy zrodlem
 * prawdy: pliki w `library/items` wygrywaja, a indeks da sie odbudowac (ADR 0014).
 */
export interface LibraryIndexEntry {
  readonly id: ItemId;
  readonly kind: ItemKind;
  readonly slug: string;
  /** Klucz unikalnosci z ADR 0017 (`collisionKey`); baza pilnuje go obok walidatora. */
  readonly slugKey: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly revision: number;
  readonly contentHash: Sha256;
  readonly updatedAt: string;
}

export interface IndexedSlug {
  readonly id: ItemId;
  readonly kind: ItemKind;
  readonly slug: string;
}

export interface RejectedEntry {
  readonly id: ItemId;
  readonly reason: string;
}

/**
 * Port indeksu biblioteki (ADR 0014). Metody sa synchroniczne, bo sterownik jest synchroniczny;
 * implementacja siedzi w `infra/db` i tylko ona zna SQL.
 */
export interface LibraryIndex {
  /** Dodaje albo podmienia element. Rzuca, gdy `(kind, slugKey)` zajmuje inny element. */
  upsert(entry: LibraryIndexEntry): void;
  /** Idempotentne: brak elementu nie jest bledem. */
  remove(id: ItemId): void;
  /**
   * Dopasowanie prefiksowe na tokenach, wszystkie slowa zapytania naraz, od najlepszego trafienia.
   * `null`, gdy zapytanie nie ma zadnego slowa do dopasowania (same znaki specjalne).
   */
  search(query: string, kind?: ItemKind): readonly ItemId[] | null;
  slugs(): readonly IndexedSlug[];
  count(): number;
  /** Zastepuje cala zawartosc w jednej transakcji. Wpisy kolidujace po `slugKey` wracaja w `rejected`. */
  replaceAll(entries: readonly LibraryIndexEntry[]): {
    readonly rejected: readonly RejectedEntry[];
  };
}
