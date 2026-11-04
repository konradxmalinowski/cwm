import type { ItemId, ItemKind, Sha256, Timestamp, ToolId } from '../model/item';

export type OperationType =
  | 'create'
  | 'update'
  | 'delete'
  | 'adopt-disk'
  | 'restore'
  /** Eksport do konfiguracji narzedzia przez WriteGate (ADR 0012). */
  | 'export'
  /** Synchronizacja z narzedziem (eksport albo przyjecie zmian z narzedzia, Etap 5). */
  | 'sync'
  /** Cofniecie wczesniejszego zapisu do narzedzia z jego kopii (ADR 0019). */
  | 'rollback';

export interface OperationState {
  readonly revision: number;
  readonly contentHash: Sha256;
  /**
   * Hash rekordu wersji (cala tresc elementu), a dla niespojnego stanu z dysku hash manifestu
   * surowych plikow. W obu przypadkach obiekt o tym hashu lezy w `ObjectStore`.
   */
  readonly versionHash: Sha256;
}

/** Wpis logu operacji (ADR 0019). Log w `index.sqlite` powstaje w kolejnym kawalku. */
export interface OperationRecord {
  readonly operation: OperationType;
  readonly itemId: ItemId;
  /** `null`, gdy `item.json` bylo nieczytelne (usuniecie takiego elementu). */
  readonly itemKind: ItemKind | null;
  readonly slug: string | null;
  readonly at: Timestamp;
  /** `null` przy `create`. */
  readonly before: OperationState | null;
  /** `null` przy `delete`. */
  readonly after: OperationState | null;
  /** Narzedzie, do ktorego zapisano (operacje zapisu do konfiguracji). */
  readonly tool?: ToolId;
  /** Kopia `backups/<id>` zrobiona przed zapisem; pusta lub brak, gdy nic nie zapisano. */
  readonly backupId?: string;
  /** `backupId` operacji, ktora ten zapis cofa. */
  readonly reverts?: string;
}

export interface OperationLog {
  append(record: OperationRecord): Promise<void>;
}

/** Wiersz logu razem z numerem kolejnym; nowsze operacje maja wiekszy `seq`. */
export interface OperationRow extends OperationRecord {
  readonly seq: number;
}

/**
 * Wiersze jednej operacji zapisu: wszystkie z tym samym `backupId` (eksport zapisuje wiersz na
 * element, synchronizacja dodaje swoje). Operacja bez kopii to grupa z jednego wiersza.
 */
export interface OperationGroup {
  /** `backup:<id>` albo `seq:<n>`; stabilny identyfikator operacji w historii. */
  readonly key: string;
  readonly rows: readonly OperationRow[];
}

export interface OperationLogReader {
  /** Grupy od najnowszej; `before` to klucz grupy, od ktorej (wylacznie) czytamy dalej. */
  groups(limit: number, before?: string): Promise<readonly OperationGroup[]>;
  group(key: string): Promise<OperationGroup | null>;
  /** Klucz grupy, ktora cofnela kopie `backupId`, albo null. */
  revertedBy(backupId: string): Promise<string | null>;
}
