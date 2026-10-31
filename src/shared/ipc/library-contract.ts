/**
 * Kontrakt kanalow `library:*` (ARCHITECTURE 7.2). Typy sa samodzielne: renderer importuje
 * ten plik, a nie moze ciagnac `core`. Handler w main buduje kazda odpowiedz jawnie z tych
 * pol, wiec nic spoza kontraktu (`cause`, `importedFrom.path`, sciezki) nie wychodzi z main.
 */

/** Handler nigdy nie rzuca do renderera. `message` jest po polsku i bez sciezek bezwzglednych. */
export type Result<T> =
  { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export type ItemKindDto =
  | 'skill'
  | 'agent'
  | 'command'
  | 'global-instruction'
  | 'project-instruction'
  | 'rule'
  | 'hook'
  | 'tool-setting'
  | 'reference-asset';

export interface ItemSummaryDto {
  id: string;
  kind: ItemKindDto;
  slug: string;
  title: string;
  description: string;
  revision: number;
  updatedAt: string;
}

export interface ProblemDto {
  id: string;
  reason: string;
  message: string;
}

export interface InconsistentDto {
  id: string;
  slug: string | null;
  kind: ItemKindDto | null;
  /** `path` jest wzgledna wewnatrz elementu (np. `body.md`, `assets/x.md`). `problem`: `hash-differs`, `missing`, `invalid-utf8` lub inny. */
  files: { path: string; problem: string }[];
}

export interface LibraryListRequest {
  query?: string;
  kind?: ItemKindDto;
}

export interface LibraryListDto {
  items: ItemSummaryDto[];
  problems: ProblemDto[];
  inconsistent: InconsistentDto[];
}

export interface ItemDetailDto {
  id: string;
  kind: ItemKindDto;
  identity: { slug: string; declaredName: string | null; aliases: string[] };
  content: {
    title: string;
    description: string;
    descriptionOrigin: 'source' | 'derived';
    body: string;
  };
  scope: 'public' | 'private' | 'project';
  assets: { relPath: string; size: number }[];
  /** Tylko nazwa narzedzia, nigdy sciezka zrodla importu. */
  importedFromTool: string | null;
  revision: number;
  updatedAt: string;
}

export interface LibraryGetRequest {
  id: string;
}

export interface ItemDraftDto {
  kind: ItemKindDto;
  slug: string;
  declaredName?: string | null;
  title: string;
  description: string;
  body: string;
  scope?: 'public' | 'private' | 'project';
}

/** Bez `id` to utworzenie, z `id` to aktualizacja. */
export interface LibrarySaveRequest {
  id?: string;
  draft: ItemDraftDto;
}

export interface WarningDto {
  code: string;
  message: string;
}

export interface LibrarySaveDto {
  item: ItemDetailDto;
  warnings: WarningDto[];
}

export interface DeletePlanDto {
  token: string;
  itemId: string;
  kind: ItemKindDto | null;
  slug: string | null;
  title: string | null;
  recoverability: 'recoverable' | 'partial' | 'blocked';
  /** `path` jest wzgledna wewnatrz elementu, `reason` po polsku. */
  unrecoverable: { path: string; reason: string }[];
  blockedReason: string | null;
}

export interface LibraryDeletePlanRequest {
  id: string;
}

export interface LibraryDeleteApplyRequest {
  token: string;
  acknowledgeUnrecoverable?: boolean;
}

export interface LibraryDeleteApplyDto {
  warnings: WarningDto[];
}

export type RepairAction = 'adopt-disk' | 'restore-version';

/** Odpowiedz: `Result<LibrarySaveDto>`. */
export interface LibraryRepairRequest {
  id: string;
  action: RepairAction;
}
