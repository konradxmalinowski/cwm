import type { ItemId, Sha256, Timestamp, ToolId } from '../model/item';

/**
 * Pamiec ostatniej udanej synchronizacji elementu z narzedziem (ARCHITECTURE 3.5, Etap 5).
 * Trzyma ja indeks, bo to stan, nie tresc: utrata kosztuje tylko to, ze kazdy element wyglada
 * na niezsynchronizowany, a nastepny plan pokaze roznice (ADR 0014).
 */
export interface SyncedFile {
  readonly rootId: string;
  readonly relPath: string;
  /** Hash bajtow, ktore aplikacja zapisala; podstawa wykrycia zmiany po stronie narzedzia. */
  readonly writtenHash: Sha256;
}

export interface SyncRecord {
  readonly itemId: ItemId;
  readonly tool: ToolId;
  /** `version.contentHash` i `revision` elementu w chwili synchronizacji. */
  readonly itemRevision: number;
  readonly itemContentHash: Sha256;
  readonly files: readonly SyncedFile[];
  readonly syncedAt: Timestamp;
  readonly backupId: string;
}

export interface SyncStateStore {
  get(itemId: ItemId, tool: ToolId): Promise<SyncRecord | null>;
  list(tool?: ToolId): Promise<readonly SyncRecord[]>;
  put(record: SyncRecord): Promise<void>;
  remove(itemId: ItemId, tool: ToolId): Promise<void>;
}
