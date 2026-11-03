import type {
  CompatibilityLevelDto,
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

export const ACTION_LABEL: Readonly<Record<PlanEntryDto['action'], string>> = {
  create: 'Utworzy',
  modify: 'Nadpisze',
  link: 'Dowiązanie',
  unchanged: 'Bez zmian',
};

/** Znak w marginesie. Tekst, nie ikona: DESIGN.md nie przewiduje ikon w rejestrze planu. */
export const ACTION_MARK: Readonly<Record<PlanEntryDto['action'], string>> = {
  create: '+',
  modify: '⇄',
  link: '~',
  unchanged: '=',
};

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
  readonly blocked: number;
  /** Pliki, ktore zapis faktycznie zmieni. */
  readonly changes: number;
}

export function countPlan(plan: ExportPlanDto): PlanCounts {
  let create = 0;
  let modify = 0;
  let link = 0;
  let unchanged = 0;
  let blocked = 0;
  for (const entry of plan.entries) {
    if (entry.recoverability === 'blocked') blocked++;
    switch (entry.action) {
      case 'create':
        create++;
        break;
      case 'modify':
        modify++;
        break;
      case 'link':
        link++;
        break;
      case 'unchanged':
        unchanged++;
        break;
    }
  }
  return { create, modify, link, unchanged, blocked, changes: create + modify + link };
}

/** Powody, dla ktorych plan nie nadaje sie do zapisu. Puste, gdy `applicable`. */
export function blockers(plan: ExportPlanDto, counts: PlanCounts): string[] {
  if (plan.applicable) return [];
  const reasons: string[] = [];
  if (plan.toolMissing) {
    reasons.push('Narzędzia nie ma na tym komputerze.');
  }
  if (plan.conflicts.length > 0) {
    reasons.push(
      'Plan ma konflikty. Odznacz jeden z elementów w każdym konflikcie i przygotuj plan od nowa.',
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
