import type {
  CompatibilityLevelDto,
  ConflictResolutionDto,
  ExportApplyDto,
  ExportPlanDto,
  MaterializationModeDto,
  PlanEntryDto,
} from '../../../../shared/ipc/export-contract';
import type { ToolIdDto } from '../../../../shared/ipc/import-contract';

export const TOOLS: readonly { readonly value: ToolIdDto; readonly label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
];

/** Miejscownik do zdan: "w Claude Code", "w Codeksie". */
export function toolLocative(tool: ToolIdDto): string {
  return tool === 'codex' ? 'Codeksie' : 'Claude Code';
}

export const LEVELS: Readonly<
  Record<CompatibilityLevelDto, { readonly label: string; readonly segments: number }>
> = {
  full: { label: 'Pełna', segments: 4 },
  partial: { label: 'Częściowa', segments: 3 },
  lossy: { label: 'Z ostrzeżeniami', segments: 2 },
  unsupported: { label: 'Brak konwersji', segments: 0 },
};

export const SEGMENT_SLOTS: readonly number[] = [0, 1, 2, 3];

/**
 * Rodzaj wpisu planu do wyswietlenia. `delete` (cofniecie operacji, ktora plik utworzyla) to
 * usuniecie z dysku i jako jedyne dostaje czerwien. Nieznana akcja z nowszego main jest
 * pokazana neutralnie, zamiast wywracac widok.
 */
export type EntryKind = PlanEntryDto['action'];

export function entryKind(entry: PlanEntryDto): EntryKind {
  return entry.action;
}

/** Para tekstow do diffu albo null, gdy podgladu nie ma (plik binarny albo za duzy). */
export function diffPair(entry: PlanEntryDto): { before: string; after: string } | null {
  const before = entry.before ?? (entry.action === 'create' ? '' : null);
  const after = entry.after ?? (entry.action === 'delete' ? '' : null);
  return before === null || after === null ? null : { before, after };
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
  create: 'Utworzy',
  modify: 'Nadpisze',
  link: 'Dowiązanie',
  unchanged: 'Bez zmian',
  delete: 'Usunie',
  'restore-link': 'Przywróci dowiązanie',
};

/** Znak w marginesie. Tekst, nie ikona: DESIGN.md nie przewiduje ikon w rejestrze planu. */
const ACTION_MARKS: Readonly<Record<string, string>> = {
  create: '+',
  modify: '⇄',
  link: '~',
  unchanged: '=',
  delete: '−',
  'restore-link': '~',
};

export function actionLabel(kind: string): string {
  return ACTION_LABELS[kind] ?? 'Zmiana';
}

export function actionMark(kind: string): string {
  return ACTION_MARKS[kind] ?? '·';
}

export const HIDDEN_SECRET_MARKER = '[ukryty sekret:';
export const HIDDEN_SECRET_NOTE =
  'Część wartości jest ukryta. Zmiana ukrytej wartości nie jest widoczna w podglądzie.';

export function hasHiddenSecret(before: string | null, after: string | null): boolean {
  return (
    (before?.includes(HIDDEN_SECRET_MARKER) ?? false) ||
    (after?.includes(HIDDEN_SECRET_MARKER) ?? false)
  );
}

export const SCOPE_LABEL: Readonly<Record<PlanEntryDto['scope'], string>> = {
  'whole-file': 'Cały plik. Aplikacja zapisuje go w całości.',
  'marker-block': 'Tylko blok między znacznikami aplikacji. Reszta pliku zostaje nietknięta.',
  'toml-segment':
    'Tylko fragment TOML zarządzany przez aplikację. Reszta pliku zostaje nietknięta.',
  'json-key': 'Tylko klucze JSON zarządzane przez aplikację. Pozostałe klucze zostają nietknięte.',
};

export interface MaterializationInfo {
  readonly label: string;
  readonly effect: string;
}

/** Wyjasnienia z ADR 0015: tryb jest widoczny razem z tym, co oznacza dla edycji w bibliotece. */
export const MATERIALIZATION: Readonly<Record<MaterializationModeDto, MaterializationInfo>> = {
  symlink: {
    label: 'Dowiązanie symboliczne',
    effect: 'Zmiany propagują się automatycznie.',
  },
  junction: {
    label: 'Junction',
    effect: 'Zmiany propagują się automatycznie.',
  },
  copy: {
    label: 'Kopia',
    effect: 'Wymaga ponownej synchronizacji po zmianie w bibliotece.',
  },
};

export const OUTCOME_LABEL: Readonly<Record<ExportApplyDto['entries'][number]['outcome'], string>> =
  {
    written: 'Zapisano',
    unchanged: 'Bez zmian',
    'rolled-back': 'Wycofano',
    failed: 'Błąd',
  };

export interface PlanCounts {
  readonly create: number;
  readonly modify: number;
  readonly link: number;
  readonly unchanged: number;
  /** Pliki, ktore zapis usunie z dysku. Nie wchodza do `modify`. */
  readonly remove: number;
  readonly blocked: number;
  /** Pliki, ktore zapis faktycznie zmieni. */
  readonly changes: number;
}

export function countPlan(plan: ExportPlanDto): PlanCounts {
  let create = 0;
  let modify = 0;
  let link = 0;
  let unchanged = 0;
  let remove = 0;
  let blocked = 0;
  for (const entry of plan.entries) {
    if (entry.recoverability === 'blocked') blocked++;
    switch (entryKind(entry)) {
      case 'create':
        create++;
        break;
      case 'modify':
        modify++;
        break;
      case 'link':
      case 'restore-link':
        link++;
        break;
      case 'unchanged':
        unchanged++;
        break;
      case 'delete':
        remove++;
        break;
    }
  }
  return {
    create,
    modify,
    link,
    unchanged,
    remove,
    blocked,
    changes: create + modify + link + remove,
  };
}

export function addCounts(a: PlanCounts, b: PlanCounts): PlanCounts {
  return {
    create: a.create + b.create,
    modify: a.modify + b.modify,
    link: a.link + b.link,
    unchanged: a.unchanged + b.unchanged,
    remove: a.remove + b.remove,
    blocked: a.blocked + b.blocked,
    changes: a.changes + b.changes,
  };
}

export const EMPTY_COUNTS: PlanCounts = {
  create: 0,
  modify: 0,
  link: 0,
  unchanged: 0,
  remove: 0,
  blocked: 0,
  changes: 0,
};

type ConflictDto = ExportPlanDto['conflicts'][number];

/** Konflikt z decyzjami do wyboru. Bez `options` albo z pustym `options` zostaje informacja. */
export function hasOptions(conflict: ConflictDto): boolean {
  return (conflict.options?.length ?? 0) > 0;
}

/** Klucz decyzji: ten sam `itemId` i `relPath`, ktore wracaja w `ExportPlanRequest.resolutions`. */
export function decisionKey(itemId: string, relPath: string): string {
  return `${itemId}\u0000${relPath}`;
}

export function conflictKey(conflict: ConflictDto): string {
  return decisionKey(conflict.itemIds[0] ?? '', conflict.relPath);
}

/** Konflikt z decyzja do podjecia i wybor uzytkownika; `null`, dopoki nic nie wybrano. */
export interface DecisionView {
  readonly key: string;
  readonly itemId: string;
  readonly relPath: string;
  readonly itemIds: readonly string[];
  readonly reason: string;
  readonly options: readonly { readonly id: ConflictResolutionDto; readonly label: string }[];
  readonly chosen: ConflictResolutionDto | null;
  /** Konflikt nie wrocil w ostatnim planie, bo wybor go rozstrzygnal; grupa zostaje do zmiany zdania. */
  readonly settled: boolean;
}

/**
 * Sygnal przy opcji decyzji. Zamiana zmienia istniejacy tekst pliku, wiec dostaje sygnal
 * "nadpisze"; dopisanie bloku na koncu niczego, co w pliku jest, nie zmienia.
 */
export const OPTION_HINT: Readonly<
  Record<ConflictResolutionDto, { readonly overwrites: boolean; readonly text: string }>
> = {
  'replace-fragment': {
    overwrites: true,
    text: 'zmienia istniejący tekst pliku: ten fragment zniknie z pliku, a w jego miejscu stanie blok aplikacji. Poprzednia treść trafi najpierw do kopii zapasowej.',
  },
  'append-block': {
    overwrites: false,
    text: 'Istniejący tekst zostaje bez zmian. Blok aplikacji dochodzi na końcu pliku, więc treść będzie w pliku dwa razy.',
  },
};

const OVERWRITE_PREFIX = 'Nadpisze';
const VANISHING_MARK = 'Znikną z katalogu pliki, których nie ma w nowej wersji: ';

export interface OverwriteInfo {
  /** Zdanie ostrzezenia bez pierwszego slowa "Nadpisze" i bez listy plikow. */
  readonly lead: string;
  readonly vanishing: readonly string[];
  /** Liczba plikow ponad limit listy w ostrzezeniu, np. "i 3 innych". */
  readonly more: string | null;
}

/**
 * Ostrzezenie wpisu planu zaczynajace sie od "Nadpisze" (zastapienie katalogu skilla): sygnal
 * nadpisania z lista plikow, ktore znikna. Lista pochodzi z tresci ostrzezenia, plan nie ma
 * na nia osobnego pola.
 */
export function overwriteInfo(entry: PlanEntryDto): OverwriteInfo | null {
  const warning = entry.warnings.find((w) => w.startsWith(OVERWRITE_PREFIX));
  if (warning === undefined) return null;
  const at = warning.indexOf(VANISHING_MARK);
  const head = (at === -1 ? warning : warning.slice(0, at)).trim();
  const lead = head.slice(OVERWRITE_PREFIX.length).trim();
  if (at === -1) return { lead, vanishing: [], more: null };
  let list = warning.slice(at + VANISHING_MARK.length).trim();
  if (list.endsWith('.')) list = list.slice(0, -1);
  let more: string | null = null;
  const tail = /^(.*) i (\d+ innych)$/.exec(list);
  if (tail !== null) {
    list = tail[1] as string;
    more = `i ${tail[2] as string}`;
  }
  return { lead, vanishing: list.split(', ').filter((f) => f !== ''), more };
}

/** Ostrzezenia wpisu bez tego, ktore pokazuje sygnal nadpisania. */
export function otherWarnings(entry: PlanEntryDto): string[] {
  return entry.warnings.filter((w) => !w.startsWith(OVERWRITE_PREFIX));
}

/** Powody, dla ktorych plan nie nadaje sie do zapisu. Puste, gdy `applicable`. */
export function blockers(plan: ExportPlanDto, counts: PlanCounts): string[] {
  if (plan.applicable) return [];
  const reasons: string[] = [];
  if (plan.toolMissing) {
    reasons.push('Narzędzia nie ma na tym komputerze.');
  }
  const open = plan.conflicts.filter(hasOptions).length;
  if (open > 0) {
    reasons.push(
      'Plik w narzędziu wymaga decyzji. Wybierz jedną z opcji w sekcji Decyzje, a aplikacja przygotuje plan od nowa.',
    );
  }
  if (plan.conflicts.length > open) {
    reasons.push(
      'Plan ma konflikty bez rozstrzygnięcia. Odznacz jeden z elementów w każdym konflikcie i przygotuj plan od nowa.',
    );
  }
  if (counts.blocked > 0) {
    reasons.push('Przynajmniej jeden plik jest zablokowany, bo aplikacja nie zrobi jego kopii.');
  }
  if (!plan.toolMissing && plan.conflicts.length === 0 && counts.blocked === 0) {
    if (plan.entries.length > 0 && counts.changes === 0) {
      reasons.push('Nic nie wymaga zapisu: wszystkie pliki są już zgodne z biblioteką.');
    } else if (plan.entries.length === 0) {
      reasons.push('Żaden z wybranych elementów nie da plików do zapisania.');
    } else {
      reasons.push('Plan nie nadaje się do zapisu.');
    }
  }
  return reasons;
}

// ---- Diff liniowy (LCS) ----

export type DiffKind = 'same' | 'add' | 'del';

export interface DiffLine {
  readonly kind: DiffKind;
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

export interface DiffGap {
  readonly kind: 'gap';
  readonly hidden: number;
}

export type DiffRow = DiffLine | DiffGap;

export interface DiffResult {
  readonly rows: readonly DiffRow[];
  readonly added: number;
  readonly removed: number;
  /** Plik za duzy do dopasowania wierszy: pokazano calosc starej i calosc nowej tresci. */
  readonly coarse: boolean;
  /** Wiersze dalsze niz limit rysowania zostaly pominiete. */
  readonly truncated: number;
}

const MAX_LCS_CELLS = 4_000_000;
const CONTEXT = 3;
const MAX_ROWS = 2000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Prosty LCS na wierszach, po obcieciu wspolnego poczatku i konca. */
export function diffLines(before: string, after: string): DiffResult {
  const a = splitLines(before);
  const b = splitLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  const same = (text: string): void => {
    lines.push({ kind: 'same', text, oldNo: oldNo++, newNo: newNo++ });
  };
  const del = (text: string): void => {
    lines.push({ kind: 'del', text, oldNo: oldNo++, newNo: null });
  };
  const add = (text: string): void => {
    lines.push({ kind: 'add', text, oldNo: null, newNo: newNo++ });
  };

  for (let k = 0; k < start; k++) same(a[k] as string);

  const n = endA - start;
  const m = endB - start;
  let coarse = false;
  if (n > 0 || m > 0) {
    if (n * m > MAX_LCS_CELLS) {
      coarse = true;
      for (let k = start; k < endA; k++) del(a[k] as string);
      for (let k = start; k < endB; k++) add(b[k] as string);
    } else {
      // table[i][j]: dlugosc LCS sufiksow a[start+i..] i b[start+j..].
      const width = m + 1;
      const table = new Uint16Array((n + 1) * width);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          table[i * width + j] =
            a[start + i] === b[start + j]
              ? (table[(i + 1) * width + j + 1] as number) + 1
              : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[start + i] === b[start + j]) {
          same(a[start + i] as string);
          i++;
          j++;
        } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
          del(a[start + i] as string);
          i++;
        } else {
          add(b[start + j] as string);
          j++;
        }
      }
      while (i < n) del(a[start + i++] as string);
      while (j < m) add(b[start + j++] as string);
    }
  }

  for (let k = endA; k < a.length; k++) same(a[k] as string);

  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added++;
    else if (line.kind === 'del') removed++;
  }

  const rows = collapse(lines);
  if (rows.length > MAX_ROWS) {
    return {
      rows: rows.slice(0, MAX_ROWS),
      added,
      removed,
      coarse,
      truncated: rows.length - MAX_ROWS,
    };
  }
  return { rows, added, removed, coarse, truncated: 0 };
}

/** Niezmienione wiersze dalej niz `CONTEXT` od zmiany zwija sie do jednego separatora. */
function collapse(lines: readonly DiffLine[]): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    const from = Math.max(0, index - CONTEXT);
    const to = Math.min(lines.length - 1, index + CONTEXT);
    for (let k = from; k <= to; k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let hidden = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (hidden > 0) {
        rows.push({ kind: 'gap', hidden });
        hidden = 0;
      }
      rows.push(line);
    } else {
      hidden++;
    }
  });
  if (hidden > 0) rows.push({ kind: 'gap', hidden });
  return rows;
}
