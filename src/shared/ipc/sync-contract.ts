import type { ConflictResolutionDto, ExportApplyDto, ExportPlanDto } from './export-contract';
import type { ToolIdDto } from './import-contract';
import type { ItemKindDto, Result } from './library-contract';

/**
 * Kontrakt Sync Center i historii (ARCHITECTURE 3.5, Etap 5). Plan synchronizacji to plan
 * eksportu per narzedzie, rozszerzony o stan elementu wzgledem ostatniej synchronizacji.
 */

export type SyncStateDto =
  /** Nigdy nie synchronizowany z tym narzedziem. */
  | 'never'
  /** Biblioteka i narzedzie zgodne z ostatnia synchronizacja. */
  | 'in-sync'
  /** Element zmienil sie w bibliotece, narzedzie nie. */
  | 'library-changed'
  /** Plik w narzedziu zmienil sie od ostatniej synchronizacji, biblioteka nie. */
  | 'tool-changed'
  /** Zmiana po obu stronach: wymaga decyzji, nic nie dzieje sie samo. */
  | 'conflict'
  /** Plik zsynchronizowany wczesniej zniknal z narzedzia. */
  | 'missing-in-tool'
  /** Element nie ma odpowiednika w tym narzedziu (unsupported). */
  | 'unsupported';

export interface SyncItemStatusDto {
  itemId: string;
  kind: ItemKindDto;
  slug: string;
  title: string;
  tool: ToolIdDto;
  status: SyncStateDto;
  lastSyncedAt: string | null;
  /** Tryb materializacji ostatniej synchronizacji, jesli byla. */
  materialization: 'symlink' | 'junction' | 'copy' | null;
}

export interface SyncStatusRequest {
  tools?: ToolIdDto[];
}

export interface SyncStatusDto {
  /** Narzedzia, ktorych katalogu glownego nie ma na tym komputerze. */
  missingTools: ToolIdDto[];
  items: SyncItemStatusDto[];
  /** Pliki w narzedziu rozpoznane jako sieroty; tylko raport (decyzja 2026-11-03). */
  orphans: { tool: ToolIdDto; rootLabel: string; relPath: string; reason: string }[];
}

/** Co zrobic z elementem w konflikcie albo zmienionym w narzedziu. */
export type SyncResolutionDto =
  /** Nadpisz narzedzie wersja z biblioteki (z kopia, jak kazdy zapis). */
  | 'library-wins'
  /** Przyjmij zmiane z narzedzia do biblioteki (nowa rewizja elementu, przez import). */
  | 'tool-wins'
  /** Nic nie rob w tym przebiegu. */
  | 'skip';

export interface SyncPlanRequest {
  tools: ToolIdDto[];
  itemIds: string[];
  /** Decyzja dla elementow w stanie `conflict` i `tool-changed`; bez niej sa pomijane. */
  resolutions?: { itemId: string; tool: ToolIdDto; resolution: SyncResolutionDto }[];
  /** Decyzje dla konfliktow planu eksportu (instrukcja globalna); te same co w `export:plan`. */
  exportResolutions?: { itemId: string; relPath: string; resolution: ConflictResolutionDto }[];
}

export interface SyncPlanDto {
  syncId: string;
  /** Plan eksportu per narzedzie; `library-wins` i zmiany biblioteki sa jego wpisami. */
  plans: ExportPlanDto[];
  /** Elementy, ktore przebieg przyjmie z narzedzia do biblioteki (`tool-wins`). */
  adoptions: {
    itemId: string;
    tool: ToolIdDto;
    title: string;
    before: string | null;
    after: string | null;
  }[];
  /** Pominiete z powodem: konflikt bez decyzji, unsupported, `skip`. */
  skipped: { itemId: string; tool: ToolIdDto; reason: string }[];
  applicable: boolean;
}

export interface SyncApplyRequest {
  syncId: string;
  approved: true;
}

export interface SyncApplyDto {
  syncId: string;
  results: ExportApplyDto[];
  adopted: { itemId: string; tool: ToolIdDto; ok: boolean; message: string | null }[];
}

/** Wpis historii: jedna operacja z logu, z mozliwoscia cofniecia, jesli ma kopie. */
export interface HistoryEntryDto {
  operationId: string;
  at: string;
  /** Typ operacji z logu, np. create, update, delete, adopt-disk, restore, export, sync, rollback. */
  kind: string;
  tool: ToolIdDto | null;
  /** Krotki opis po polsku, bez sciezek bezwzglednych. */
  summary: string;
  itemIds: string[];
  /** Cofniecie mozliwe: zapis do narzedzia z kopia w `backups/`. */
  revertible: boolean;
  revertedBy: string | null;
}

export interface HistoryListRequest {
  limit?: number;
  before?: string;
}

export interface HistoryListDto {
  entries: HistoryEntryDto[];
}

export interface HistoryRollbackRequest {
  operationId: string;
}

/**
 * Cofniecie to zwykla operacja zapisu z planem i zatwierdzeniem (ADR 0019): najpierw plan
 * przywrocenia stanu z kopii, potem `export.apply` z jego `planId`.
 */
export type HistoryRollbackDto = ExportPlanDto;

export type SyncStatusResult = Result<SyncStatusDto>;
export type SyncPlanResult = Result<SyncPlanDto>;
export type SyncApplyResult = Result<SyncApplyDto>;
export type HistoryListResult = Result<HistoryListDto>;
export type HistoryRollbackResult = Result<HistoryRollbackDto>;
