import type { ItemKindDto } from '../../../shared/ipc/library-contract';

export const ITEM_KINDS: readonly { readonly value: ItemKindDto; readonly label: string }[] = [
  { value: 'skill', label: 'Skill' },
  { value: 'agent', label: 'Agent' },
  { value: 'command', label: 'Komenda' },
  { value: 'global-instruction', label: 'Instrukcja globalna' },
  { value: 'project-instruction', label: 'Instrukcja projektu' },
  { value: 'rule', label: 'Reguła' },
  { value: 'hook', label: 'Hook' },
  { value: 'tool-setting', label: 'Ustawienie narzędzia' },
  { value: 'reference-asset', label: 'Zasób referencyjny' },
];

export function kindLabel(kind: ItemKindDto | null): string {
  if (kind === null) return 'Nieznany typ';
  return ITEM_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

export const SCOPES: readonly {
  readonly value: 'public' | 'private' | 'project';
  readonly label: string;
}[] = [
  { value: 'private', label: 'Prywatny' },
  { value: 'public', label: 'Publiczny' },
  { value: 'project', label: 'Projektowy' },
];

export function scopeLabel(scope: string): string {
  return SCOPES.find((s) => s.value === scope)?.label ?? scope;
}

/** Polska odmiana liczebnika: 1 element, 2 elementy, 5 elementow, 22 elementy. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const lastTwo = n % 100;
  const last = n % 10;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

const DATE_FORMAT = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_FORMAT.format(date);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

const FILE_PROBLEMS: Readonly<Record<string, string>> = {
  'hash-differs': 'zawartość na dysku różni się od zapisanej w bibliotece',
  missing: 'brakuje pliku na dysku',
};

export function fileProblemLabel(problem: string): string {
  return FILE_PROBLEMS[problem] ?? problem;
}
