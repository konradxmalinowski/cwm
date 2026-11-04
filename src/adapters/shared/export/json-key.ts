/**
 * Edycja jednego klucza najwyzszego poziomu w pliku JSON z zachowaniem reszty tekstu (hooki w
 * `settings.json` i `hooks.json`). Reszta pliku zostaje bajt w bajt; po edycji wynik jest
 * parsowany i porownywany z wejsciem poza edytowanym kluczem.
 */

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Member {
  readonly key: string;
  readonly keyStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface RootScan {
  readonly open: number;
  readonly close: number;
  readonly members: readonly Member[];
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i] ?? '')) i++;
  return i;
}

function skipString(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

function skipValue(text: string, from: number): number {
  const c = text[from];
  if (c === '"') return skipString(text, from);
  if (c === '{' || c === '[') {
    let depth = 0;
    let i = from;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        i = skipString(text, i);
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return text.length;
  }
  let i = from;
  while (i < text.length && !/[\s,}\]]/.test(text[i] ?? '')) i++;
  return i;
}

function scanRoot(text: string): RootScan | null {
  const open = skipSpace(text, text.startsWith('﻿') ? 1 : 0);
  if (text[open] !== '{') return null;
  const members: Member[] = [];
  let i = open + 1;
  for (;;) {
    i = skipSpace(text, i);
    if (text[i] === '}') return { open, close: i, members };
    if (text[i] !== '"') return null;
    const keyStart = i;
    const keyEnd = skipString(text, i);
    let key: string;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    } catch {
      return null;
    }
    i = skipSpace(text, keyEnd);
    if (text[i] !== ':') return null;
    const valueStart = skipSpace(text, i + 1);
    const valueEnd = skipValue(text, valueStart);
    members.push({ key, keyStart, valueStart, valueEnd });
    i = skipSpace(text, valueEnd);
    if (text[i] === ',') i++;
    else if (text[i] !== '}') return null;
  }
}

export type JsonEditResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/** Wciecie: spacje lub tab przed pierwszym kluczem, inaczej dwie spacje. */
function detectIndent(text: string, root: RootScan): string {
  const first = root.members[0];
  if (first === undefined) return '  ';
  const lineStart = text.lastIndexOf('\n', first.keyStart) + 1;
  const indent = text.slice(lineStart, first.keyStart);
  return /^[ \t]+$/.test(indent) ? indent : '  ';
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Podmienia (albo dopisuje) wartosc klucza najwyzszego poziomu; reszta tekstu zostaje. */
export function setTopLevelKey(text: string, key: string, value: unknown): JsonEditResult {
  const root = scanRoot(text);
  if (root === null) {
    return {
      ok: false,
      message: 'Plik nie ma postaci obiektu JSON, którą edytor potrafi zmienić.',
    };
  }
  const indent = detectIndent(text, root);
  const eol = eolOf(text);
  // Kolejne linie wartosci dostaja wciecie klucza, bo klucz stoi na pierwszym poziomie.
  const rendered = JSON.stringify(value, null, indent).split('\n').join(`${eol}${indent}`);
  const member = root.members.find((m) => m.key === key);
  let result: string;
  if (member !== undefined) {
    result = text.slice(0, member.valueStart) + rendered + text.slice(member.valueEnd);
  } else {
    const last = root.members[root.members.length - 1];
    const entry = `${JSON.stringify(key)}: ${rendered}`;
    if (last === undefined) {
      result = `${text.slice(0, root.open + 1)}${eol}${indent}${entry}${eol}${text.slice(root.close)}`;
    } else {
      result = `${text.slice(0, last.valueEnd)},${eol}${indent}${entry}${text.slice(last.valueEnd)}`;
    }
  }
  try {
    const parsed: unknown = JSON.parse(result.startsWith('﻿') ? result.slice(1) : result);
    if (!isJsonRecord(parsed)) throw new Error('not-object');
  } catch {
    return {
      ok: false,
      message: 'Wynik edycji nie jest poprawnym JSON-em. Plik zostaje bez zmian.',
    };
  }
  return { ok: true, text: result };
}

/** Porownanie drzew JSON niezalezne od kolejnosci kluczy. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => jsonEqual(v, b[i]))
    );
  }
  if (isJsonRecord(a) && isJsonRecord(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && jsonEqual(a[k], b[k]));
  }
  return a === b;
}
