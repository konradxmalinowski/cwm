import { SLUG_MAX_LENGTH, validateSlug } from '../../../../core/services/library/validate';
import type {
  CandidateDto,
  CandidateStatus,
  DetectedRootDto,
  LibrarySlugDto,
  ToolIdDto,
} from '../../../../shared/ipc/import-contract';

export const TOOL_LABEL: Readonly<Record<ToolIdDto, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
};

const TOOL_ORDER: readonly ToolIdDto[] = ['claude-code', 'codex', 'gemini-cli'];

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
    note: 'Nazwa zderza się z innym elementem biblioteki albo z tego skanu. Żeby go zaimportować, podaj nową nazwę. Nazwa ze źródła trafi do aliasów. Domyślnie pominięte.',
  },
];

/** Czy kandydata w ogole mozna zaznaczyc. `unchanged` nic by nie zmienilo, a `duplicate` narzedzie i tak czyta z innego miejsca. */
export function isSelectable(candidate: CandidateDto): boolean {
  return candidate.status !== 'duplicate' && candidate.status !== 'unchanged';
}

// ---- Nowa nazwa kandydata z konfliktem (ADR 0017, addendum) ----

/** Klucz unikalnosci z ADR 0017: `lower(slug)` plus typ. */
export function slugKey(kind: string, slug: string): string {
  return `${kind}\0${slug.toLowerCase()}`;
}

/**
 * Podpowiedz nowej nazwy: slug z kolejnym numerem (`slug-2`, `slug-3`), pierwszy wolny wzgledem
 * `taken`. Tylko propozycja w polu tekstowym: do biblioteki trafia dopiero po zaznaczeniu elementu.
 */
export function suggestSlug(kind: string, slug: string, taken: ReadonlySet<string>): string {
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const next = `${slug.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(slugKey(kind, next)) && validateSlug(next) === null) return next;
  }
  return slug;
}

/** Podpowiedzi dla wszystkich konfliktow skanu; kazda nastepna omija poprzednie i zajete nazwy. */
export function suggestRenames(
  candidates: readonly CandidateDto[],
  librarySlugs: readonly LibrarySlugDto[],
): Map<string, string> {
  const taken = new Set<string>([
    ...librarySlugs.map((l) => slugKey(l.kind, l.slug)),
    ...candidates.map((c) => slugKey(c.kind, c.slug)),
  ]);
  const out = new Map<string, string>();
  for (const c of candidates) {
    if (c.status !== 'conflict') continue;
    const next = suggestSlug(c.kind, c.slug, taken);
    taken.add(slugKey(c.kind, next));
    out.set(c.candidateId, next);
  }
  return out;
}

/**
 * Bledy pola "nowa nazwa" dla kazdego konfliktu, te same reguly co walidator biblioteki: ASCII,
 * dlugosc, nazwy zastrzezone Windowsa, brak kolizji z biblioteka i z innymi elementami tej partii
 * (wybranymi pod swoja nazwa albo pod nowa). Main sprawdza to jeszcze raz przy zapisie.
 */
export function renameErrors(
  candidates: readonly CandidateDto[],
  selected: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
  librarySlugs: readonly LibrarySlugDto[],
): Map<string, string> {
  const library = new Set(librarySlugs.map((l) => slugKey(l.kind, l.slug)));
  const claimed = new Set(
    candidates
      .filter((c) => c.status !== 'conflict' && selected.has(c.candidateId))
      .map((c) => slugKey(c.kind, c.slug)),
  );
  const errors = new Map<string, string>();
  for (const c of candidates) {
    if (c.status !== 'conflict') continue;
    const value = (values.get(c.candidateId) ?? '').trim();
    const invalid = validateSlug(value);
    if (invalid !== null) {
      errors.set(c.candidateId, invalid.message);
      continue;
    }
    const key = slugKey(c.kind, value);
    if (library.has(key)) {
      errors.set(
        c.candidateId,
        `Nazwa "${value}" jest już zajęta w bibliotece (wielkość liter nie ma znaczenia). Wybierz inną.`,
      );
    } else if (claimed.has(key)) {
      errors.set(
        c.candidateId,
        `Nazwa "${value}" jest już zajęta przez inny element tego importu (wielkość liter nie ma znaczenia). Wybierz inną.`,
      );
    } else if (selected.has(c.candidateId)) {
      claimed.add(key);
    }
  }
  return errors;
}

/**
 * Dla rootow bedacych plikiem (CLAUDE.md, settings.json, config.toml) `relPath` zaczyna sie
 * od nazwy tego samego pliku, wiec samo sklejenie dalo by "root/CLAUDE.md/CLAUDE.md".
 */
export function joinRootPath(rootLabel: string, relPath: string): string {
  const first = relPath.split(/[#/]/)[0] ?? '';
  if (first !== '' && rootLabel.endsWith(`/${first}`))
    return `${rootLabel}${relPath.slice(first.length)}`;
  return `${rootLabel}/${relPath}`;
}

export function pathLabel(candidate: { rootLabel: string; relPath: string }): string {
  return joinRootPath(candidate.rootLabel, candidate.relPath);
}

const SKIP_REASON_LABEL: Readonly<Record<string, string>> = {
  'not-an-element': 'to nie jest element',
  unsupported: 'nieobsługiwane',
  malformed: 'uszkodzony wpis',
};

export function skipReasonLabel(reason: string): string {
  return SKIP_REASON_LABEL[reason] ?? reason;
}

/** Tekst reguly sekretu: nazwa reguly, plik i linia, bez wartosci (ta nigdy nie przychodzi). */
export function hitLocation(hit: { file: string; line: number | null; rule: string }): string {
  const line = hit.line === null ? '' : `, linia ${hit.line}`;
  return `${hit.file}${line}`;
}

/**
 * Czy po przemianowaniu `declaredName` zostanie inny niz nowy slug. Wtedy narzedzia kluczujace po
 * nazwie (Codex, Gemini CLI) moga zobaczyc kolizje przy eksporcie (ADR 0057). Gdy `declaredName`
 * jest pusty albo rowny starej nazwie, aplikacja ustawia go na nowy slug i nie ma o czym ostrzegac.
 */
export function keepsForeignDeclaredName(candidate: {
  readonly slug: string;
  readonly declaredName: string | null;
}): boolean {
  const name = candidate.declaredName;
  return name !== null && name !== '' && name.toLowerCase() !== candidate.slug.toLowerCase();
}
