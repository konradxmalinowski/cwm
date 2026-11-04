import type { ItemKindDto, Result } from './library-contract';
import type { ToolIdDto } from './import-contract';

/**
 * Kontrakt kanalow `export:*` (ARCHITECTURE 3.5, Etap 4). Renderer dostaje `planId`, etykiety
 * rootow i sciezki wzgledne; nigdy sciezki bezwzglednej ani bajtow plikow binarnych.
 */
export type CompatibilityLevelDto = 'full' | 'partial' | 'lossy' | 'unsupported';
export type MaterializationModeDto = 'symlink' | 'junction' | 'copy';

export interface ExportPlanRequest {
  tool: ToolIdDto;
  itemIds: string[];
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

export interface ExportPlanDto {
  planId: string;
  tool: ToolIdDto;
  /** Brak katalogu glownego narzedzia: eksport odmowiony w calosci (decyzja 2026-11-03). */
  toolMissing: boolean;
  verdicts: ItemVerdictDto[];
  entries: PlanEntryDto[];
  refusals: { itemId: string; kind: ItemKindDto; slug: string; reason: string }[];
  conflicts: { itemIds: string[]; relPath: string; reason: string }[];
  /** Tylko raport: aplikacja nigdy sama nie usuwa plikow w narzedziu (decyzja 2026-11-03). */
  orphans: { rootLabel: string; relPath: string; reason: string }[];
  applicable: boolean;
}

export interface ExportApplyRequest {
  planId: string;
  /** Jawne zatwierdzenie tego planu przez uzytkownika. */
  approved: true;
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
