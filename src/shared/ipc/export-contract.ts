import type { ItemKindDto, Result } from './library-contract';
import type { ToolIdDto } from './import-contract';

/**
 * Kontrakt kanalow `export:*` (ARCHITECTURE 3.5, Etap 4). Renderer dostaje `planId`, etykiety
 * rootow i sciezki wzgledne; nigdy sciezki bezwzglednej ani bajtow plikow binarnych.
 */
export type CompatibilityLevelDto = 'full' | 'partial' | 'lossy' | 'unsupported';
export type MaterializationModeDto = 'symlink' | 'junction' | 'copy';

/**
 * Decyzja dla konfliktu instrukcji globalnej bez znacznikow (ADR 0025, regula 3) albo dla serwera MCP
 * o zajetej nazwie (`replace-server`, ADR 0061; tylko eksport, nie synchronizacja).
 */
export type ConflictResolutionDto = 'replace-fragment' | 'append-block' | 'replace-server';

export interface ExportPlanRequest {
  tool: ToolIdDto;
  itemIds: string[];
  /**
   * Decyzje dla konfliktow z poprzedniego planu: ten sam `itemId` i `relPath`, co w konflikcie.
   * Brak pola albo konflikt bez decyzji: plan zostaje niewykonywalny.
   */
  resolutions?: { itemId: string; relPath: string; resolution: ConflictResolutionDto }[];
  /**
   * Cel "projekt" (ADR 0059): eksport do rootow projektu z rejestru zamiast do katalogu globalnego.
   * Elementy innych projektow sa odmowione; globalne wchodza tylko z `includeGlobal: true`.
   */
  projectId?: string;
  includeGlobal?: boolean;
}

export interface ItemVerdictDto {
  itemId: string;
  kind: ItemKindDto;
  slug: string;
  title: string;
  level: CompatibilityLevelDto;
  reasons: string[];
  lostAttributes: string[];
  addedAttributes: string[];
}

export interface PlanEntryDto {
  entryId: string;
  rootLabel: string;
  /** Sciezka wzgledem roota, np. "skills/acme-review/SKILL.md". */
  relPath: string;
  /**
   * `delete` i `restore-link` pojawiaja sie wylacznie w planie cofniecia operacji (history:rollback):
   * `delete` usuwa plik albo dowiazanie, ktore zapis aplikacji utworzyl; `restore-link` zamienia to,
   * co jest pod sciezka, z powrotem w dowiazanie do celu sprzed operacji.
   */
  action: 'create' | 'modify' | 'link' | 'unchanged' | 'delete' | 'restore-link';
  scope: 'whole-file' | 'marker-block' | 'toml-segment' | 'json-key';
  materialization: MaterializationModeDto | null;
  itemIds: string[];
  /** Tekst przed i po dla podgladu diffu; null dla plikow binarnych albo zbyt duzych. */
  before: string | null;
  after: string | null;
  /** Lista plikow wpisu katalogowego, sciezki wzgledem `relPath`. */
  files: string[];
  recoverability: 'recoverable' | 'blocked';
  blockedReason: string | null;
  warnings: string[];
}

/** Serwer MCP, ktory plan zapisze: polecenie albo adres i nazwy zmiennych, nigdy wartosci (ADR 0061). */
export interface McpServerPreviewDto {
  itemId: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  /** Polecenie z argumentami (stdio) albo adres (http, sse), w calosci. */
  launch: string;
  /** Zmienne, ktore serwer wezmie ze srodowiska uzytkownika. */
  env: string[];
  warnings: string[];
}

export interface ExportPlanDto {
  planId: string;
  tool: ToolIdDto;
  /** Brak katalogu glownego narzedzia: eksport odmowiony w calosci (decyzja 2026-11-03). */
  toolMissing: boolean;
  /** Cel "projekt": identyfikator i nazwa projektu. Brak pola to katalog globalny narzedzia. */
  project?: { projectId: string; name: string };
  verdicts: ItemVerdictDto[];
  entries: PlanEntryDto[];
  refusals: { itemId: string; kind: ItemKindDto; slug: string; reason: string }[];
  conflicts: {
    itemIds: string[];
    relPath: string;
    reason: string;
    /** Decyzje do wyboru; brak pola: konflikt nie ma rozstrzygniecia w interfejsie. */
    options?: { id: ConflictResolutionDto; label: string }[];
  }[];
  /** Tylko raport: aplikacja nigdy sama nie usuwa plikow w narzedziu (decyzja 2026-11-03). */
  orphans: { rootLabel: string; relPath: string; reason: string }[];
  applicable: boolean;
  /**
   * Plan zapisuje serwery MCP (ADR 0061). `confirmation` to jednorazowy znacznik tego planu: zapis bez
   * niego (`export:apply` z `mcpConfirmation`) konczy sie bledem `mcp-confirmation-required`.
   */
  mcp?: { confirmation: string; servers: McpServerPreviewDto[] };
}

export interface ExportApplyRequest {
  planId: string;
  /** Jawne zatwierdzenie tego planu przez uzytkownika. */
  approved: true;
  /** Znacznik `mcp.confirmation` z planu: uzytkownik potwierdzil podglad serwerow MCP (ADR 0061). */
  mcpConfirmation?: string;
}

export interface ExportApplyDto {
  planId: string;
  backupId: string;
  entries: {
    entryId: string;
    outcome: 'written' | 'unchanged' | 'rolled-back' | 'failed';
    message: string | null;
  }[];
  verified: boolean;
  rolledBack: boolean;
}

export type ExportPlanResult = Result<ExportPlanDto>;
export type ExportApplyResult = Result<ExportApplyDto>;

/**
 * Eksport do archiwum ZIP (ADR 0054). Plan ma ksztalt planu eksportu do narzedzia (`entries` to pliki
 * archiwum w ukladzie wybranego narzedzia), a zapis przyjmuje wylacznie `planId`: sciezke pliku
 * wybiera main systemowym oknem zapisu i nigdy jej nie zwraca.
 */
export type ZipHoldReasonDto = 'private' | 'secret' | 'path' | 'project';

export interface ExportZipPlanRequest {
  /** Uklad plikow w archiwum: wedlug tego narzedzia. */
  tool: ToolIdDto;
  itemIds: string[];
  /** Zgoda na elementy prywatne i z trafieniem klasyfikatora sekretow. Elementow `project` nie dotyczy. */
  confirmedItemIds?: string[];
}

export interface ZipHeldItemDto {
  itemId: string;
  kind: ItemKindDto;
  slug: string;
  title: string;
  reason: ZipHoldReasonDto;
  confirmed: boolean;
}

export interface ExportZipPlanDto extends ExportPlanDto {
  zip: {
    /** Proponowana nazwa pliku, bez katalogu. */
    fileName: string;
    /** Pliki w archiwum razem z manifestem `cwm-export.json`. */
    fileCount: number;
    sizeBytes: number;
    /** Elementy, ktore nie weszly do archiwum bez zgody albo wcale. */
    held: ZipHeldItemDto[];
  };
}

export interface ExportZipSaveRequest {
  planId: string;
  approved: true;
}

export type ExportZipSaveDto =
  { status: 'saved'; fileName: string; fileCount: number } | { status: 'cancelled' };

export type ExportZipPlanResult = Result<ExportZipPlanDto>;
export type ExportZipSaveResult = Result<ExportZipSaveDto>;
