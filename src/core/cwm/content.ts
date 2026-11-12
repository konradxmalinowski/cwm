import { childPath } from './check';
import { fail, ok, type Result, type ValidationError } from './errors';
import type { ContentFlags } from './resource';
import { hasForbiddenKey, nullObject } from './safe-keys';

/** Frontmatter i tresc plikow `.md` skilli, agentow i komend: niezaufane wejscie z natywnej konfiguracji. */
export const MAX_FRONTMATTER_UNITS = 64 * 1024;

export type ContentKind = 'skill' | 'agent' | 'command';

/** Klucze, ktore frontmatter wykonuje albo ktorymi rozszerza uprawnienia (IMP-05). */
export const FRONTMATTER_REJECTED_KEYS = ['hooks', 'mcpServers', 'permissionMode'] as const;

const ALLOWED_KEYS: Record<ContentKind, readonly string[]> = {
  skill: [
    'name',
    'description',
    'allowed-tools',
    'argument-hint',
    'disable-model-invocation',
    'user-invocable',
    'model',
    'license',
    'metadata',
    'when_to_use',
    'version',
  ],
  agent: ['name', 'description', 'tools', 'model', 'color', 'memory'],
  command: [
    'name',
    'description',
    'allowed-tools',
    'argument-hint',
    'model',
    'disable-model-invocation',
  ],
};

/** Wartosci klucza `memory` agenta (pamiec trwala silnika): tylko te trafiaja do zasobu. */
export const AGENT_MEMORY_VALUES = ['user', 'project', 'local'] as const;

export type SplitResult =
  | { readonly ok: true; readonly frontmatter: string | null; readonly body: string }
  | { readonly ok: false; readonly message: string };

function lineAt(text: string, start: number): { line: string; next: number } {
  const end = text.indexOf('\n', start);
  const stop = end === -1 ? text.length : end;
  const line = text.slice(start, stop);
  return {
    line: line.endsWith('\r') ? line.slice(0, -1) : line,
    next: end === -1 ? text.length : end + 1,
  };
}

/**
 * Frontmatter tylko na poczatku pliku (po dopuszczonym BOM): linia `---`, tresc YAML, linia `---`.
 * Dluzszy niz `MAX_FRONTMATTER_UNITS` albo niezamkniety jest bledem, a plik bez niego ma sama tresc.
 */
export function splitFrontmatter(raw: string): SplitResult {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const opening = lineAt(text, 0);
  if (opening.line.trimEnd() !== '---') return { ok: true, frontmatter: null, body: text };
  let position = opening.next;
  while (position < text.length) {
    if (position - opening.next > MAX_FRONTMATTER_UNITS) {
      return {
        ok: false,
        message: `Frontmatter jest wiekszy niz ${MAX_FRONTMATTER_UNITS} znakow.`,
      };
    }
    const { line, next } = lineAt(text, position);
    const trimmed = line.trimEnd();
    if (trimmed === '---' || trimmed === '...') {
      return { ok: true, frontmatter: text.slice(opening.next, position), body: text.slice(next) };
    }
    position = next;
  }
  return { ok: false, message: 'Frontmatter nie jest zamkniety linia ---.' };
}

const LINE_SEPARATORS = /\r\n|[\r\n\u2028\u2029]/;
const LEADING_BLANK = /^[\s\uFEFF\u00A0\u2028\u2029\u200B-\u200D\u2060]+/;
const PRELUDE_WINDOW = 64 * 1024;
/** Linia wygladajaca na YAML: `klucz: wartosc`, `- element`, wciecie, mapa/lista przeplywowa. */
const YAMLISH = /^(?:["']?[\w ./-]+["']?\s*:(?:\s|$)|-(?:\s|$)|[{[]|\s+\S)/;

/** Obcina biale znaki, znaki zerowej szerokosci i komentarze HTML sprzed pierwszej tresci. */
function stripLead(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(LEADING_BLANK, '');
    if (!next.startsWith('<!--')) return next;
    const end = next.indexOf('-->');
    if (end < 0) return next;
    current = next.slice(end + 3);
  }
}

const DELIMITER_MESSAGE =
  'tresc zaczyna sie od linii --- albo ... (mozliwy drugi frontmatter silnika)';

/** Wspolne reguly dla tresci, ktora parser CWM uznaje za body (po frontmatterze albo caly plik). */
function bodyFrameProblem(body: string): string | null {
  const stripped = stripLead(body);
  const first = (stripped.split(LINE_SEPARATORS, 1)[0] ?? '').trim();
  if (first === '---' || first === '...') return DELIMITER_MESSAGE;
  if (stripped.startsWith('---') || stripped.startsWith('+++')) {
    return 'pierwsza linia tresci zaczyna sie od --- albo +++, ale nie jest dokladnie ---';
  }
  // Prolog w ksztalcie YAML zakonczony linia ogranicznika: parser konczacy blok na `---` zobaczylby go
  // jako frontmatter, mimo ze CWM go nie analizowal.
  let yamlLines = 0;
  for (const line of stripped.slice(0, PRELUDE_WINDOW).split(LINE_SEPARATORS)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === '---' || trimmed === '...') {
      return yamlLines > 0
        ? 'tresc zaczyna sie od prologu w ksztalcie YAML zakonczonego ---'
        : null;
    }
    if (!YAMLISH.test(line)) return null;
    yamlLines += 1;
  }
  return null;
}

/**
 * Drugi frontmatter (IMP-04, IMP-05): po odtworzeniu pierwszego bloku silnik moglby uznac za
 * frontmatter blok z tresci, ktorego CWM nie analizowal (`hooks`, `permissionMode`, `allowed-tools`).
 * Powod odrzucenia, gdy tresc (po frontmatterze albo caly plik bez frontmattera wg parsera CWM), po
 * obcieciu bialych znakow, BOM, NBSP, U+2028/2029, znakow zerowej szerokosci i komentarzy HTML:
 * zaczyna sie od linii `---` albo `...`, od linii zaczynajacej sie `---` lub `+++` (ale nie
 * dokladnie `---`), albo od prologu w ksztalcie YAML zakonczonego linia ogranicznika (w pierwszych
 * 64 KiB). Plik bez frontmattera, ktory zaczyna sie od bialych znakow i `---`, jest niewidoczny dla CWM.
 */
export function frontmatterFrameProblem(rawText: string, split: SplitResult): string | null {
  if (!split.ok) return null;
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  if (split.frontmatter === null) {
    const problem = bodyFrameProblem(text);
    if (problem === null) return null;
    return stripLead(text) === text
      ? `${problem} (niewidoczne dla parsera CWM)`
      : `${problem} (po bialych znakach lub komentarzu: frontmatter niewidoczny dla CWM)`;
  }
  return bodyFrameProblem(split.body);
}

/** Wstawka polecenia wykonywana przy wczytaniu: `!` z poleceniem w odwrotnych apostrofach albo blok ```!. */
export function hasInlineCommands(text: string): boolean {
  return text.includes('!`') || /^\s*(?:`{3,}|~{3,})!/m.test(text);
}

/**
 * Wstawki wykonywane przy wczytaniu, w calosci i w kolejnosci wystapien: `!` z poleceniem w
 * odwrotnych apostrofach oraz bloki ogrodzone ```! (SEC-04). Ekran zatwierdzania pokazuje je bez skracania.
 */
export function extractInlineCommands(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:^|[^`])!`([^`\n]+)`/g)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  for (const match of text.matchAll(/^[ \t]*(`{3,}|~{3,})![^\n]*\n([\s\S]*?)\n[ \t]*\1/gm)) {
    if (match[2] !== undefined) out.push(match[2]);
  }
  return out;
}

/** Klucz bez rozroznienia wielkosci liter i bez `_` oraz `-`: `Allowed_Tools` to `allowedtools`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

const REJECTED_NORMALIZED: ReadonlySet<string> = new Set(
  FRONTMATTER_REJECTED_KEYS.map((key) => normalizeKey(key)),
);

export interface ContentAnalysis {
  readonly name: string | null;
  readonly description: string | null;
  /** Narzedzia agenta z pola `tools`; dla skilli i komend zawsze puste (liczy sie tylko flaga). */
  readonly tools: readonly string[];
  readonly model: string | null;
  readonly flags: ContentFlags;
  /** Pelna wartosc `allowed-tools` (skill, komenda) jako lista; dla agenta pusta. */
  readonly allowedToolsValue: readonly string[];
  /** Wstawki `!` w calosci (SEC-04). */
  readonly inlineSnippets: readonly string[];
  /** Klucze spoza listy dozwolonych: trafiaja do raportu, nie do zasobu. */
  readonly unknownKeys: readonly string[];
  /**
   * Frontmatter do zapisu (IMP-05 pkt 1): wylacznie dozwolone klucze, w kolejnosci listy. Surowych
   * bajtow frontmattera nie kopiujemy nigdy. Mapa bez prototypu.
   */
  readonly kept: Readonly<Record<string, unknown>>;
}

function nonEmpty(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Dzieli po przecinkach poza nawiasami, bo `Bash(git add:*, git status)` jest jednym narzedziem. */
function splitTools(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts.filter((part) => part !== '');
}

function toolList(value: unknown): string[] {
  if (typeof value === 'string') return splitTools(value);
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).flatMap((item) => (typeof item === 'string' ? splitTools(item) : []));
}

/**
 * Analiza zdekodowanego frontmattera (`null`, gdy pliku bez niego) i calej tresci pliku. Klucze
 * `hooks`, `mcpServers` i `permissionMode` oraz klucze prototypu sa bledem. Wynik niesie flagi
 * dla etapu zatwierdzania (IMP-05 pkt 3), a `rawText` to caly plik, bo wstawka moze byc gdziekolwiek.
 */
export function analyzeContent(
  kind: ContentKind,
  frontmatter: unknown,
  rawText: string,
): Result<ContentAnalysis> {
  const errors: ValidationError[] = [];
  const flagsOnly = (allowedTools: boolean): ContentFlags => ({
    allowedTools,
    inlineCommands: hasInlineCommands(rawText),
  });
  if (frontmatter === null || frontmatter === undefined) {
    return ok({
      name: null,
      description: null,
      tools: [],
      model: null,
      flags: flagsOnly(false),
      allowedToolsValue: [],
      inlineSnippets: extractInlineCommands(rawText),
      unknownKeys: [],
      kept: nullObject<unknown>(),
    });
  }
  if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return fail([{ path: 'frontmatter', message: 'Frontmatter ma byc mapa klucz-wartosc.' }]);
  }
  if (hasForbiddenKey(frontmatter)) {
    return fail([
      {
        path: 'frontmatter',
        message: 'Frontmatter zawiera zabroniony klucz (__proto__, constructor, prototype).',
      },
    ]);
  }
  const map = frontmatter as Record<string, unknown>;
  const keys = Object.keys(map);
  for (const key of keys) {
    if (REJECTED_NORMALIZED.has(normalizeKey(key))) {
      errors.push({
        path: childPath('frontmatter', key),
        message: 'Klucz uruchamia kod albo rozszerza uprawnienia: zasob jest odrzucany.',
      });
    }
  }
  if (errors.length > 0) return fail(errors);

  const toolsKey = kind === 'agent' ? 'tools' : 'allowed-tools';
  const toolsValue = map[toolsKey];
  // Warianty zapisu (`allowed_tools`, `Tools`) ustawiaja flage, chociaz klucz i tak nie trafi do zasobu.
  const allowedTools = keys.some((key) => {
    const normalized = normalizeKey(key);
    return (normalized === 'allowedtools' || normalized === 'tools') && nonEmpty(map[key]);
  });
  const tools: string[] = [];
  if (kind === 'agent') {
    if (typeof toolsValue === 'string') tools.push(...splitTools(toolsValue));
    else if (Array.isArray(toolsValue)) {
      for (const item of toolsValue as unknown[])
        if (typeof item === 'string') tools.push(...splitTools(item));
    }
  }
  const allowed = ALLOWED_KEYS[kind];
  const kept = nullObject<unknown>();
  for (const key of allowed) if (Object.hasOwn(map, key)) kept[key] = map[key];
  const droppedKeys = new Set(keys.filter((key) => !allowed.includes(key)));
  if (
    kind === 'agent' &&
    Object.hasOwn(kept, 'memory') &&
    !(AGENT_MEMORY_VALUES as readonly unknown[]).includes(kept['memory'])
  ) {
    delete kept['memory'];
    droppedKeys.add('memory');
  }
  return ok({
    kept,
    name: text(map['name']),
    description: text(map['description']),
    tools,
    model: text(map['model']),
    flags: flagsOnly(allowedTools),
    allowedToolsValue: kind === 'agent' ? [] : toolList(map['allowed-tools']),
    inlineSnippets: extractInlineCommands(rawText),
    unknownKeys: [...droppedKeys].sort(),
  });
}
