/**
 * Skaner liniowy TOML dla segmentera (ADR 0011). Nie interpretuje wartosci: wie tylko, ktore linie
 * sa naglowkami tabel, kluczami, komentarzami i kontynuacja wielolinijkowego napisu albo tablicy.
 * Wejscie jest juz sprawdzone niezaleznym parserem, wiec skaner nie musi odrzucac skladni.
 */

export type LineKind = 'blank' | 'comment' | 'table' | 'array-table' | 'key' | 'cont';

export interface ScannedLine {
  readonly index: number;
  /** Tresc linii bez znaku konca linii. */
  readonly text: string;
  readonly kind: LineKind;
  /** Dla naglowka: sciezka tabeli; dla klucza: sciezka klucza w obrebie tabeli. */
  readonly path: readonly string[];
  /** Dla klucza: sciezka tabeli, w ktorej stoi. */
  readonly table: readonly string[];
}

interface ValueState {
  ml: null | 'basic' | 'literal';
  depth: number;
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Przesuwa po wartosci, aktualizujac stan wielolinijkowych napisow i nawiasow. */
function advance(text: string, from: number, state: ValueState): void {
  let i = from;
  while (i < text.length) {
    if (state.ml === 'basic') {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (text.startsWith('"""', i)) {
        state.ml = null;
        i += 3;
      } else i++;
      continue;
    }
    if (state.ml === 'literal') {
      if (text.startsWith("'''", i)) {
        state.ml = null;
        i += 3;
      } else i++;
      continue;
    }
    const c = text[i];
    if (c === '#') return;
    if (c === '"') {
      if (text.startsWith('"""', i)) {
        state.ml = 'basic';
        i += 3;
      } else {
        i++;
        while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
        i++;
      }
    } else if (c === "'") {
      if (text.startsWith("'''", i)) {
        state.ml = 'literal';
        i += 3;
      } else {
        const end = text.indexOf("'", i + 1);
        i = end === -1 ? text.length : end + 1;
      }
    } else {
      if (c === '[' || c === '{') state.depth++;
      else if (c === ']' || c === '}') state.depth--;
      i++;
    }
  }
}

/** Czyta sciezke klucza (gole i cytowane segmenty rozdzielone kropka). Zwraca tez pozycje za nia. */
export function parseKeyPath(text: string, from: number): { path: string[]; end: number } {
  const path: string[] = [];
  let i = from;
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          const n = text[j + 1] ?? '';
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
        } else out += text[j++];
      }
      path.push(out);
      i = j + 1;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      path.push(text.slice(i + 1, stop));
      i = stop + 1;
    } else {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_-]/.test(text[i] ?? '')) i++;
      path.push(text.slice(start, i));
    }
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] === '.') i++;
    else return { path, end: i };
  }
}

export function scanToml(source: string): ScannedLine[] {
  const raw = source.split('\n');
  const out: ScannedLine[] = [];
  const state: ValueState = { ml: null, depth: 0 };
  let table: readonly string[] = [];
  raw.forEach((rawLine, index) => {
    const text = stripCr(rawLine);
    if (state.ml !== null || state.depth > 0) {
      advance(text, 0, state);
      out.push({ index, text, kind: 'cont', path: [], table });
      return;
    }
    const trimmed = text.trim();
    if (trimmed === '') {
      out.push({ index, text, kind: 'blank', path: [], table });
    } else if (trimmed.startsWith('#')) {
      out.push({ index, text, kind: 'comment', path: [], table });
    } else if (trimmed.startsWith('[')) {
      const array = trimmed.startsWith('[[');
      const start = text.indexOf('[') + (array ? 2 : 1);
      const { path } = parseKeyPath(text, start);
      table = path;
      out.push({ index, text, kind: array ? 'array-table' : 'table', path, table });
    } else {
      const { path, end } = parseKeyPath(text, 0);
      const eq = text.indexOf('=', end);
      advance(text, eq === -1 ? text.length : eq + 1, state);
      out.push({ index, text, kind: 'key', path, table });
    }
  });
  return out;
}
