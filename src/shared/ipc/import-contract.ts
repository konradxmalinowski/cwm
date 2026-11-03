import type { ItemKindDto, Result, WarningDto } from './library-contract';

/**
 * Kontrakt kanalow `import:*` (ARCHITECTURE 3.4). Renderer dostaje `rootId` i etykiete,
 * nigdy sciezki bezwzglednej. Odpowiedzi zawsze jako `Result`.
 */
export type ToolIdDto = 'claude-code' | 'codex';

export interface DetectedRootDto {
  rootId: string;
  tool: ToolIdDto;
  kind: string;
  /** Np. "~/.claude/skills"; bez katalogu domowego wprost. */
  label: string;
  exists: boolean;
  active: boolean;
}

export interface ImportDetectDto {
  roots: DetectedRootDto[];
}

export interface ImportScanRequest {
  rootIds: string[];
}

export type CandidateStatus =
  /** Nie ma w bibliotece. */
  | 'new'
  /** Jest w bibliotece z ta sama trescia; powtorny import nic nie zmieni. */
  | 'unchanged'
  /** Jest w bibliotece pod tym samym typem i slugiem, ale tresc sie rozni. */
  | 'changed'
  /** Ten sam element w dwoch rootach jednego narzedzia albo alias (ADR 0024, 0026). */
  | 'duplicate'
  /**
   * Kolizja `lower(slug)` z elementem biblioteki (ADR 0017) albo z innym kandydatem tego skanu,
   * ktory ma pierwszenstwo (`duplicateOf`); glowny pozostaje do zaimportowania.
   */
  | 'conflict';

export interface SecretHitDto {
  rule: string;
  /** Sciezka wzgledem elementu, np. "SKILL.md". */
  file: string;
  line: number | null;
  /** Dlaczego to trafienie, po polsku. Nigdy wartosc sekretu. */
  reason: string;
}

export interface CandidateDto {
  /** Identyfikator kandydata w obrebie jednego skanu. */
  candidateId: string;
  tool: ToolIdDto;
  rootLabel: string;
  /** Sciezka wzgledem roota, np. "acme-review/SKILL.md". */
  relPath: string;
  kind: ItemKindDto;
  slug: string;
  title: string;
  description: string;
  status: CandidateStatus;
  /** Id elementu biblioteki dla `unchanged`, `changed` i `conflict`. */
  existingItemId: string | null;
  /** Dla `duplicate` i `conflict` w obrebie skanu: kandydat z pierwszenstwem. */
  duplicateOf: string | null;
  secrets: SecretHitDto[];
  warnings: WarningDto[];
  /** Domyslny wybor w kreatorze: false dla sekretow, duplikatow, unchanged i conflict. */
  selectedByDefault: boolean;
}

export interface SkippedDto {
  tool: ToolIdDto;
  rootLabel: string;
  relPath: string;
  reason: string;
  message: string;
}

export interface ImportScanDto {
  /** Token skanu; `apply` dziala tylko na kandydatach z tego skanu. */
  scanToken: string;
  candidates: CandidateDto[];
  skipped: SkippedDto[];
}

export interface ImportApplyRequest {
  scanToken: string;
  /** Wybrane kandydaty. Kandydat z sekretem wymaga tez wpisu w `confirmedSecrets`. */
  candidateIds: string[];
  confirmedSecrets?: string[];
  /** Dla `changed`: zastap istniejacy element (nowa rewizja) zamiast pominac. */
  replaceChanged?: string[];
}

export interface ImportedDto {
  candidateId: string;
  itemId: string;
  action: 'created' | 'updated';
}

export interface ImportFailedDto {
  candidateId: string;
  code: string;
  message: string;
}

export interface ImportApplyDto {
  imported: ImportedDto[];
  skipped: { candidateId: string; reason: string }[];
  failed: ImportFailedDto[];
}

export type ImportDetectResult = Result<ImportDetectDto>;
export type ImportScanResult = Result<ImportScanDto>;
export type ImportApplyResult = Result<ImportApplyDto>;
