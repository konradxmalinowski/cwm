import { compareStrings } from './errors';
import { foldName } from './names';
import type { WorkflowRouting } from './resource';

/**
 * Routing workflow z opisu zadania (ADR 0049): deterministyczny, offline, bez modelu jezykowego.
 * Wynik zalezy tylko od tekstu zadania i regul `routing` workflow, wiec ten sam opis daje ten sam wybor.
 */

/** Punkty za slowo kluczowe; fraza wielowyrazowa dostaje dodatek za kazde kolejne slowo. */
export const KEYWORD_POINTS = 4;
export const PHRASE_EXTRA_POINTS = 2;
/** Najwiecej punktow za najlepszy przyklad (pokrycie wszystkich jego znaczacych slow). */
export const EXAMPLE_POINTS = 6;
/** `priority` ponad ten pulap nie daje wiecej; dodatek liczy sie tylko przy istniejacym trafieniu. */
export const PRIORITY_CAP = 100;
export const PRIORITY_POINTS = 2;
/** Prog automatycznego wyboru: jedno slowo kluczowe wystarcza, pojedyncze wspolne slowo przykladu nie. */
export const MIN_ROUTING_SCORE = 4;
/** Roznica wyniku, od ktorej lider jest wyrazny; mniejsza to remis. */
export const ROUTING_MARGIN = 1;
export const MIN_TOKEN_LENGTH = 3;
export const MAX_TASK_LENGTH = 4000;

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'are',
  'was',
  'not',
  'you',
  'your',
  'our',
  'can',
  'how',
  'what',
  'need',
  'want',
  'please',
  'jak',
  'nie',
  'dla',
  'czy',
  'oraz',
  'jest',
  'mam',
  'chce',
  'prosze',
  'trzeba',
]);

const EXTRA_FOLDS: Readonly<Record<string, string>> = {
  ł: 'l',
  đ: 'd',
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
};

/** Slowa po `foldName` (NFKC, male litery, bez znakow laczacych) i zwinieciu liter bez rozkladu (np. polskie l z kreska). */
export function routingTokens(text: string): string[] {
  const folded = foldName(text).replace(/[łđøæœß]/gu, (ch) => EXTRA_FOLDS[ch] ?? ch);
  return folded.split(/[^\p{L}\p{N}]+/u).filter((token) => token !== '');
}

const significant = (text: string): Set<string> =>
  new Set(routingTokens(text).filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t)));

/** Czy ciag `needle` wystepuje w `haystack` jako spojny podciag (granice slow wynikaja z tokenow). */
function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return true;
  }
  return false;
}

export interface RoutingCandidate {
  readonly id: string;
  readonly type: 'instructional' | 'orchestrated';
  readonly routing: WorkflowRouting | null;
}

export interface WorkflowScore {
  readonly id: string;
  readonly type: 'instructional' | 'orchestrated';
  /** Czy workflow bierze udzial w wyborze automatycznym (ma routing i tryb inny niz `manual`). */
  readonly auto: boolean;
  readonly score: number;
  readonly keywords: readonly { readonly text: string; readonly points: number }[];
  readonly example: {
    readonly text: string;
    readonly shared: readonly string[];
    readonly points: number;
  } | null;
  readonly priority: number;
  readonly priorityPoints: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function scoreOne(
  taskTokens: readonly string[],
  task: ReadonlySet<string>,
  c: RoutingCandidate,
): WorkflowScore {
  const routing = c.routing;
  const base = { id: c.id, type: c.type };
  if (routing === null || routing.mode === 'manual') {
    return {
      ...base,
      auto: false,
      score: 0,
      keywords: [],
      example: null,
      priority: routing?.priority ?? 0,
      priorityPoints: 0,
    };
  }
  const keywords: { text: string; points: number }[] = [];
  const seen = new Set<string>();
  for (const text of routing.keywords) {
    const words = routingTokens(text);
    const key = words.join(' ');
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    if (containsSequence(taskTokens, words)) {
      keywords.push({ text, points: KEYWORD_POINTS + PHRASE_EXTRA_POINTS * (words.length - 1) });
    }
  }
  let example: WorkflowScore['example'] = null;
  for (const text of routing.examples) {
    const words = significant(text);
    if (words.size === 0) continue;
    const shared = [...words].filter((word) => task.has(word)).sort();
    if (shared.length === 0) continue;
    // Jedno wspolne slowo liczy sie za pol: samo "test" nie ma wybierac workflow.
    const points = round(
      EXAMPLE_POINTS * (shared.length / words.size) * Math.min(1, shared.length / 2),
    );
    if (example === null || points > example.points) example = { text, shared, points };
  }
  const evidence =
    keywords.reduce((sum, hit) => sum + hit.points, 0) + (example === null ? 0 : example.points);
  const priorityPoints =
    evidence > 0
      ? round((Math.min(routing.priority, PRIORITY_CAP) / PRIORITY_CAP) * PRIORITY_POINTS)
      : 0;
  return {
    ...base,
    auto: true,
    score: round(evidence + priorityPoints),
    keywords,
    example,
    priority: routing.priority,
    priorityPoints,
  };
}

/** Wyniki wszystkich kandydatow: automatyczne przed recznymi, potem wynik, `priority` (malejaco) i id. */
export function scoreWorkflows(
  task: string,
  candidates: readonly RoutingCandidate[],
): WorkflowScore[] {
  const tokens = routingTokens(task);
  const words = significant(task);
  return candidates
    .map((candidate) => scoreOne(tokens, words, candidate))
    .sort(
      (a, b) =>
        Number(b.auto) - Number(a.auto) ||
        b.score - a.score ||
        b.priority - a.priority ||
        compareStrings(a.id, b.id),
    );
}

export type RoutingDecision =
  | {
      readonly state: 'selected';
      readonly id: string;
      /** `score`: wyrazny lider; `default`: brak trafienia; `default-tiebreak`: remis rozstrzygniety domyslnym. */
      readonly basis: 'score' | 'default' | 'default-tiebreak';
    }
  | { readonly state: 'tie'; readonly ids: readonly string[] }
  | { readonly state: 'none' };

/**
 * Wybor automatyczny. Domyslny workflow wygrywa tylko tam, gdzie nie ma wyraznego trafienia: gdy zaden
 * wynik nie osiaga progu albo gdy jest w grupie remisowej. Wyraznego lidera nie przebija nigdy.
 */
export function decideWorkflow(
  scores: readonly WorkflowScore[],
  defaultId: string | null,
): RoutingDecision {
  const hits = scores.filter((s) => s.auto && s.score >= MIN_ROUTING_SCORE);
  const top = hits[0];
  if (top === undefined) {
    return defaultId === null
      ? { state: 'none' }
      : { state: 'selected', id: defaultId, basis: 'default' };
  }
  const tied = hits.filter((s) => top.score - s.score < ROUTING_MARGIN);
  if (tied.length === 1) return { state: 'selected', id: top.id, basis: 'score' };
  if (defaultId !== null && tied.some((s) => s.id === defaultId)) {
    return { state: 'selected', id: defaultId, basis: 'default-tiebreak' };
  }
  return { state: 'tie', ids: tied.map((s) => s.id) };
}

export type TaskCheck =
  { readonly ok: true; readonly task: string } | { readonly ok: false; readonly reason: string };

/**
 * Zadanie z linii polecen idzie do silnika jako jeden argument. Odrzucamy puste, zbyt dlugie i zawierajace
 * znaki sterujace oraz formatujace (poza nowa linia i tabulatorem), zeby nic nie psulo terminala ani logow.
 */
export function validateTask(raw: string): TaskCheck {
  const task = raw.trim();
  if (task === '') return { ok: false, reason: 'Opis zadania jest pusty.' };
  if (task.length > MAX_TASK_LENGTH) {
    return { ok: false, reason: `Opis zadania ma ponad ${MAX_TASK_LENGTH} znakow.` };
  }
  for (const ch of task) {
    if (ch === '\n' || ch === '\t') continue;
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ch)) {
      return { ok: false, reason: 'Opis zadania zawiera znak sterujacy albo formatujacy.' };
    }
  }
  return { ok: true, task };
}

/** Nazwa polecenia, w ktore workflow zamienia sie w profilu: `cwm-<nazwa>` (czesc id po `/`). */
export const workflowCommandName = (id: string): string => `cwm-${id.slice(id.indexOf('/') + 1)}`;

/**
 * Pierwsze polecenie sesji: `/<polecenie> <zadanie>`. Zaczyna sie od `/`, wiec zadanie zaczynajace sie
 * od `-` nie moze stac sie flaga silnika, a calosc jest jednym argumentem (bez powloki).
 */
export const workflowPrompt = (slashName: string, task: string): string => `/${slashName} ${task}`;

/** Nadzbior wzorca silnika (`$ARGUMENTS[n]`, `$ARGUMENTS`, `$n`): bez granic slow, bo silnik podstawia tez w srodku slowa. */
const ARGUMENT_PLACEHOLDER = /\$ARGUMENTS|\$\d/;

export const usesTaskPlaceholder = (text: string): boolean => ARGUMENT_PLACEHOLDER.test(text);

/** Tresc workflow bez `$ARGUMENTS` dostaje na koncu wiersz z zadaniem, inaczej silnik nie dostalby opisu. */
export function withTaskPlaceholder(text: string): string {
  if (usesTaskPlaceholder(text)) return text;
  const gap = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${gap}Task: $ARGUMENTS\n`;
}

/**
 * Czy zadanie moze trafic do powloki: tresc ma placeholder i gdziekolwiek znacznik wstawki (`!` z odwrotnym
 * apostrofem, blok ```! albo ~~~!). Sprawdzenie na calym tekscie, bez wlasnego parsera wstawek, zeby nie rozjechac
 * sie z silnikiem (wielowierszowe, jednowierszowe bloki, wstawka w srodku wiersza).
 */
export const taskReachesShell = (text: string): boolean =>
  usesTaskPlaceholder(text) && (text.includes('!`') || /(?:`{3}|~{3})!/.test(text));
