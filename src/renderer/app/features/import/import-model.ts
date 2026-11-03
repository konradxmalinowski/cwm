import type {
  CandidateDto,
  CandidateStatus,
  DetectedRootDto,
  ToolIdDto,
} from '../../../../shared/ipc/import-contract';

export const TOOL_LABEL: Readonly<Record<ToolIdDto, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

const TOOL_ORDER: readonly ToolIdDto[] = ['claude-code', 'codex'];

export function toolLabel(tool: string): string {
  return TOOL_LABEL[tool as ToolIdDto] ?? tool;
}

const ROOT_KIND_LABEL: Readonly<Record<string, string>> = {
  skills: 'Skille',
  agents: 'Agenci',
  commands: 'Komendy',
  rules: 'Reguły',
  'global-instructions': 'Instrukcje globalne',
  hooks: 'Hooki',
  'agent-registry': 'Rejestr agentów',
};

export function rootKindLabel(kind: string): string {
  return ROOT_KIND_LABEL[kind] ?? kind;
}

export interface ToolRoots {
  readonly tool: ToolIdDto;
  readonly label: string;
  readonly roots: readonly DetectedRootDto[];
}

/** Rooty pogrupowane po narzedziu, w stalej kolejnosci; narzedzie bez rootow nie dostaje grupy. */
export function groupRootsByTool(roots: readonly DetectedRootDto[]): ToolRoots[] {
  const known = TOOL_ORDER.map((tool) => ({
    tool,
    label: toolLabel(tool),
    roots: roots.filter((r) => r.tool === tool),
  }));
  return known.filter((group) => group.roots.length > 0);
}

/** Domyslnie zaznaczone sa rooty, ktore istnieja i ktore narzedzie czyta. */
export function defaultRootSelection(roots: readonly DetectedRootDto[]): Set<string> {
  return new Set(roots.filter((r) => r.exists && r.active).map((r) => r.rootId));
}

export interface StatusGroupMeta {
  readonly status: CandidateStatus;
  readonly title: string;
  readonly note: string;
}

/** Kolejnosc grup to kolejnosc wagi decyzji: najpierw to, co zwykle sie importuje. */
export const STATUS_GROUPS: readonly StatusGroupMeta[] = [
  {
    status: 'new',
    title: 'Nowe',
    note: 'Nie ma ich jeszcze w bibliotece.',
  },
  {
    status: 'changed',
    title: 'Zmienione',
    note: 'Są w bibliotece pod tym samym typem i nazwą, ale treść jest inna. Domyślnie pominięte.',
  },
  {
    status: 'unchanged',
    title: 'Już w bibliotece',
    note: 'Treść jest taka sama jak w bibliotece, więc ponowny import niczego nie zmieni.',
  },
  {
    status: 'duplicate',
    title: 'Duplikaty',
    note: 'Ten sam element leży w dwóch lokalizacjach albo pod dwoma nazwami. Narzędzie czyta tylko jeden egzemplarz.',
  },
  {
    status: 'conflict',
    title: 'Konflikty nazw',
    note: 'Nazwa zderza się z innym elementem biblioteki. Takiego elementu nie da się zaznaczyć.',
  },
];

/** Czy kandydata w ogole mozna zaznaczyc. `unchanged` nic by nie zmienilo, `conflict` jest zablokowany. */
export function isSelectable(candidate: CandidateDto): boolean {
  return candidate.status !== 'conflict' && candidate.status !== 'unchanged';
}

export function pathLabel(candidate: CandidateDto): string {
  return `${candidate.rootLabel}/${candidate.relPath}`;
}

/** Tekst reguly sekretu: nazwa reguly, plik i linia, bez wartosci (ta nigdy nie przychodzi). */
export function hitLocation(hit: { file: string; line: number | null; rule: string }): string {
  const line = hit.line === null ? '' : `, linia ${hit.line}`;
  return `${hit.file}${line}`;
}
