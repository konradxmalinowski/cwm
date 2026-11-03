import type { JsonValue } from '../../core/model/item';

/**
 * Parser podzbioru YAML, ktory faktycznie wystepuje we frontmatterze skilli, agentow i komend:
 * skalary, lancuchy w cudzyslowach, listy proste (blokowe i `[a, b]`) oraz bloki `|` i `>`.
 * Wszystko inne (mapy zagniezdzone, kotwice, tagi, mapy w klamrach) nie wywala parsera, tylko
 * laduje w `unsupported` z surowym tekstem, zeby adapter mogl go oddac do `unmappedKeys`.
 */

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | readonly YamlScalar[];

export interface FrontmatterIssue {
  readonly code: 'frontmatter-unclosed' | 'frontmatter-duplicate-key' | 'frontmatter-line-ignored';
  readonly message: string;
}

export interface UnsupportedEntry {
  readonly key: string;
  readonly raw: string;
}

export interface FrontmatterResult {
  readonly present: boolean;
  /** `Map`, bo klucze pochodza z niezaufanego pliku (`__proto__`). */
  readonly data: ReadonlyMap<string, YamlValue>;
  readonly unsupported: readonly UnsupportedEntry[];
  readonly issues: readonly FrontmatterIssue[];
  readonly body: string;
}

const KEY_PATTERN = /^([A-Za-z0-9_][A-Za-z0-9_.-]*|"[^"]*"|'[^']*')\s*:(?:\s+(.*)|\s*)$/;
const FENCE = /^---[ \t]*$/;
const FENCE_END = /^(?:---|\.\.\.)[ \t]*$/;

export function parseFrontmatter(text: string): FrontmatterResult {
  const lines = text.split('\n');
  if (lines.length === 0 || !FENCE.test(lines[0] ?? '')) {
    return empty(text, []);
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE_END.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // Do pierwszej pustej linii to niedomkniety blok metadanych, a nie tresc: opis wyliczamy z tego, co po nim.
    const blank = lines.findIndex((l, i) => i > 0 && l.trim() === '');
    const rest = blank === -1 ? '' : lines.slice(blank + 1).join('\n');
    return empty(rest, [
      {
        code: 'frontmatter-unclosed',
        message:
          'Frontmatter zaczyna się od "---", ale nie ma linii zamykającej. Pominięto go; tytuł pochodzi z nazwy, a opis z pierwszego akapitu po nim.',
      },
    ]);
  }
  const block = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n');
  const data = new Map<string, YamlValue>();
  const unsupported: UnsupportedEntry[] = [];
  const issues: FrontmatterIssue[] = [];

  let i = 0;
  while (i < block.length) {
    const line = block[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const match = /^\S/.test(line) ? KEY_PATTERN.exec(line) : null;
    if (match === null) {
      issues.push({
        code: 'frontmatter-line-ignored',
        message: `Pominięto linię ${i + 2} frontmattera, bo nie jest parą "klucz: wartość".`,
      });
      unsupported.push({ key: `line-${i + 2}`, raw: line });
      i++;
      continue;
    }
    const key = unquoteKey(match[1] ?? '');
    const rest = stripComment(match[2] ?? '').trim();
    // Linie nalezace do wartosci: wciete albo puste, a dla listy tez "- x" w kolumnie 0.
    let j = i + 1;
    while (j < block.length) {
      const next = block[j] ?? '';
      const isIndented = /^[ \t]/.test(next) || next === '';
      const isDashList = rest === '' && /^-(\s|$)/.test(next);
      if (!isIndented && !isDashList) break;
      j++;
    }
    // Puste linie na koncu wchodza do bloku `|+`, w pozostalych wartosciach sa tylko odstepem.
    const isBlock = /^[|>][+-]?[1-9]?[+-]?$/.test(rest);
    let k = j;
    while (!isBlock && k > i + 1 && (block[k - 1] ?? '').trim() === '') k--;
    const continuation = block.slice(i + 1, k);
    const parsed = parseValue(rest, continuation, match[2] ?? '');
    if (data.has(key) || unsupported.some((u) => u.key === key)) {
      issues.push({
        code: 'frontmatter-duplicate-key',
        message: `Klucz "${key}" występuje we frontmatterze więcej niż raz. Obowiązuje ostatnie wystąpienie.`,
      });
      data.delete(key);
    }
    if (parsed.kind === 'ok') {
      data.set(key, parsed.value);
    } else {
      unsupported.push({ key, raw: [match[2] ?? '', ...continuation].join('\n').trim() });
    }
    i = Math.max(k, i + 1);
  }
  return { present: true, data, unsupported, issues, body };
}

function empty(text: string, issues: readonly FrontmatterIssue[]): FrontmatterResult {
  return { present: false, data: new Map(), unsupported: [], issues, body: text };
}

function unquoteKey(raw: string): string {
  if (raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'"))) return raw.slice(1, -1);
  return raw;
}

type Parsed = { kind: 'ok'; value: YamlValue } | { kind: 'unsupported' };

function parseValue(rest: string, continuation: readonly string[], rawRest: string): Parsed {
  if (/^[|>][+-]?[1-9]?[+-]?$/.test(rest)) {
    return { kind: 'ok', value: parseBlockScalar(rest, continuation) };
  }
  if (rest === '') {
    if (continuation.length === 0) return { kind: 'ok', value: null };
    const items = parseBlockList(continuation);
    return items === null ? { kind: 'unsupported' } : { kind: 'ok', value: items };
  }
  if (/^[&*!?]/.test(rest) || rest.startsWith('{')) return { kind: 'unsupported' };
  if (rest.startsWith('[')) {
    const joined = [rawRest, ...continuation].join(' ').trim();
    const list = parseFlowList(stripComment(joined).trim());
    return list === null ? { kind: 'unsupported' } : { kind: 'ok', value: list };
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const joined = [rawRest.trim(), ...continuation.map((c) => c.trim())].join(' ');
    const scalar = parseQuoted(joined);
    return scalar === null ? { kind: 'unsupported' } : { kind: 'ok', value: scalar };
  }
  // Skalar zwykly moze byc zawijany na kolejne wciete linie.
  const folded = [rest, ...continuation.map((c) => stripComment(c).trim())]
    .filter((p) => p !== '')
    .join(' ');
  if (continuation.some((c) => /^\s+[A-Za-z0-9_-]+:(\s|$)/.test(c))) return { kind: 'unsupported' };
  return { kind: 'ok', value: resolvePlain(folded) };
}

function parseBlockScalar(header: string, lines: readonly string[]): string {
  const folded = header.startsWith('>');
  const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
  const explicit = /[1-9]/.exec(header);
  const indent =
    explicit !== null
      ? Number(explicit[0])
      : Math.min(
          ...lines.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0),
        );
  const width = Number.isFinite(indent) ? indent : 0;
  const content = lines.map((l) => (l.trim() === '' ? '' : l.slice(width)));
  let text: string;
  if (!folded) {
    text = content.length > 0 ? `${content.join('\n')}\n` : '';
  } else {
    // Linie wciete glebiej niz podstawa zachowuja koniec linii, jak w YAML.
    let out = '';
    for (let n = 0; n < content.length; n++) {
      const cur = content[n] ?? '';
      const prev = n > 0 ? (content[n - 1] ?? '') : null;
      if (prev === null) out += cur;
      else if (cur === '') out += '\n';
      else if (prev === '') out += cur;
      else if (/^[ \t]/.test(cur) || /^[ \t]/.test(prev)) out += `\n${cur}`;
      else out += ` ${cur}`;
    }
    text = content.length > 0 ? `${out}\n` : '';
  }
  const body = text.replace(/\n+$/, '');
  const trailing = text.length - body.length;
  if (chomp === 'strip') return body;
  if (chomp === 'keep') return body + '\n'.repeat(Math.max(trailing, 1));
  return body === '' ? '' : `${body}\n`;
}

function parseBlockList(lines: readonly string[]): YamlScalar[] | null {
  const items: YamlScalar[] = [];
  for (const raw of lines) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const m = /^\s*-(?:\s+(.*))?$/.exec(raw);
    if (m === null) return null;
    const text = stripComment(m[1] ?? '').trim();
    if (text === '' || /^[&*!?{[]/.test(text) || /^[A-Za-z0-9_-]+:(\s|$)/.test(text)) return null;
    if (text.startsWith('"') || text.startsWith("'")) {
      const q = parseQuoted(text);
      if (q === null) return null;
      items.push(q);
    } else {
      items.push(resolvePlain(text));
    }
  }
  return items;
}

function parseFlowList(text: string): YamlScalar[] | null {
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.slice(1, -1);
  const items: YamlScalar[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i] ?? '')) i++;
    if (i >= inner.length) break;
    const ch = inner[i];
    if (ch === '"' || ch === "'") {
      const end = findQuoteEnd(inner, i);
      if (end === -1) return null;
      const q = parseQuoted(inner.slice(i, end + 1));
      if (q === null) return null;
      items.push(q);
      i = end + 1;
    } else {
      let end = inner.indexOf(',', i);
      if (end === -1) end = inner.length;
      const piece = inner.slice(i, end).trim();
      if (/[[\]{}]/.test(piece) || /^[&*!]/.test(piece)) return null;
      items.push(resolvePlain(piece));
      i = end;
    }
    while (i < inner.length && /\s/.test(inner[i] ?? '')) i++;
    if (i < inner.length) {
      if (inner[i] !== ',') return null;
      i++;
    }
  }
  return items;
}

function findQuoteEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote === '"' && c === '\\') {
      i++;
      continue;
    }
    if (c === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function parseQuoted(text: string): string | null {
  const quote = text[0];
  const end = findQuoteEnd(text, 0);
  if (end === -1) return null;
  // Po zamknieciu moze stac tylko komentarz.
  const tail = text.slice(end + 1).trim();
  if (tail !== '' && !tail.startsWith('#')) return null;
  const inner = text.slice(1, end);
  if (quote === "'") return inner.replace(/''/g, "'");
  return unescapeDouble(inner);
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '"': '"',
  '\\': '\\',
  '/': '/',
  ' ': ' ',
};

function unescapeDouble(inner: string): string {
  return inner.replace(
    /\\(?:u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|(.))/gs,
    (_m: string, u: string | undefined, x: string | undefined, c: string | undefined) => {
      if (u !== undefined) return String.fromCharCode(parseInt(u, 16));
      if (x !== undefined) return String.fromCharCode(parseInt(x, 16));
      const simple = SIMPLE_ESCAPES[c ?? ''];
      return simple ?? `\\${c ?? ''}`;
    },
  );
}

function stripComment(text: string): string {
  if (text.startsWith('"') || text.startsWith("'")) return text;
  const m = /(^|\s)#/.exec(text);
  return m === null ? text : text.slice(0, m.index);
}

function resolvePlain(text: string): YamlScalar {
  if (text === '~' || /^null$/i.test(text)) return null;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^[-+]?(0|[1-9][0-9]*)\.[0-9]+$/.test(text)) return Number(text);
  return text;
}

export function yamlToJson(value: YamlValue): JsonValue {
  return value;
}

/** Wartosc tekstowa niepusta albo `null`; liczby i listy nie sa nazwa ani opisem. */
export function asText(value: YamlValue | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
