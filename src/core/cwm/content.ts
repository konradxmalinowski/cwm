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
  agent: ['name', 'description', 'tools', 'model', 'color'],
  command: [
    'name',
    'description',
    'allowed-tools',
    'argument-hint',
    'model',
    'disable-model-invocation',
  ],
};

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

/** Wstawka polecenia wykonywana przy wczytaniu: `!` z poleceniem w odwrotnych apostrofach albo blok ```!. */
export function hasInlineCommands(text: string): boolean {
  return text.includes('!`') || /^\s*(?:`{3,}|~{3,})!/m.test(text);
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
  return ok({
    kept,
    name: text(map['name']),
    description: text(map['description']),
    tools,
    model: text(map['model']),
    flags: flagsOnly(allowedTools),
    unknownKeys: keys.filter((key) => !allowed.includes(key)).sort(),
  });
}
