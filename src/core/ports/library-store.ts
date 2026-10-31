import type { AssetFile, SnapshotFile } from '../model/item';
import type { StoreFailureCode } from './store-failure';

/**
 * Pliki jednego elementu tak, jak leza na dysku (ARCHITECTURE 9). Port przenosi bajty:
 * format `item.json` i dekodowanie UTF-8 naleza do core (`item-codec.ts`), a dane z dysku
 * sa niezaufane. Dzieki temu archiwum stanu dysku jest bajt w bajt (ADR 0028).
 */
export interface StoredItemFiles {
  /** Zawartosc `item.json`. Zapisywany jako ostatni, wiec jest znacznikiem ukonczenia zapisu. */
  readonly itemJson: Uint8Array;
  /** Zawartosc `body.md`, bez zadnej zmiany. */
  readonly body: Uint8Array;
  /** `relPath` wzgledem `assets/`. Jedyne sciezki, jakie port zna. */
  readonly assets: readonly AssetFile[];
  /** `relPath` wzgledem `snapshots/<tool>/`. */
  readonly snapshotFiles: readonly SnapshotFile[];
}

/** Plik odczytany z katalogu elementu mimo awarii innych plikow. */
export interface SalvagedEntry {
  /** Wzgledem katalogu elementu: `item.json`, `body.md`, `assets/...`, `snapshots/<tool>/...`. */
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

/** Plik albo katalog, ktorego nie dalo sie odczytac; `relPath` jak w `SalvagedEntry`. */
export interface UnreadableEntry {
  readonly relPath: string;
  readonly failure: StoreFailureCode;
}

export interface SalvageResult {
  readonly entries: readonly SalvagedEntry[];
  readonly unreadable: readonly UnreadableEntry[];
}

/**
 * Utrwalanie elementow w `library/items/<id>/`. `id` to nazwa katalogu, nie sciezka.
 * Implementacja siedzi w `infra/library` i zapisuje przez prymityw atomowy. Bledy z przyczyna
 * z `store-failure.ts` niosa pole `failureCode`.
 */
export interface LibraryStore {
  /** Zastepuje caly element. Usuwa pliki, ktorych nowy stan juz nie zawiera. */
  write(id: string, files: StoredItemFiles): Promise<void>;
  /** `null`, gdy katalogu elementu nie ma. Nie waliduje zawartosci. */
  read(id: string): Promise<StoredItemFiles | null>;
  /** Tylko `item.json`, bez assetow. `null`, gdy brak katalogu lub pliku. Nie czyta wiecej niz `MAX_ITEM_JSON_BYTES + 1`. */
  readItemJson(id: string): Promise<Uint8Array | null>;
  /**
   * Odczyt tego, co sie da, gdy `read` rzuca: nie idzie za dowiazaniami i nie rzuca na pojedynczym pliku,
   * tylko wpisuje go do `unreadable`. `null`, gdy brak katalogu elementu.
   */
  readSalvage(id: string): Promise<SalvageResult | null>;
  /** Nazwy katalogow w `items/`, bez zakladania, ze sa poprawnymi `ItemId`. */
  list(): Promise<readonly string[]>;
  /** Idempotentne: brak elementu nie jest bledem. */
  remove(id: string): Promise<void>;
}
