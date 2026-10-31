import type { ItemId, ItemKind, Sha256, Timestamp } from '../model/item';

export type OperationType = 'create' | 'update' | 'delete' | 'adopt-disk' | 'restore';

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
}

export interface OperationLog {
  append(record: OperationRecord): Promise<void>;
}
