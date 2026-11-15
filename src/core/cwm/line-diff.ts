import { canonicalJson } from './canonical-json';

/**
 * Czyste funkcje dla `cwm diff`: roznica wierszy w formie ujednoliconej oraz ukrywanie zawartosci
 * `env` w plikach JSON. Bez wejscia i wyjscia, bez zaleznosci.
 */

export interface LineDiffResult {
  readonly added: number;
  readonly removed: number;
  /** Wiersze ujednoliconego diffu (`@@ ... @@`, ` `, `-`, `+`); `null`, gdy nie ma o co prosic. */
  readonly hunks: readonly string[] | null;
  /** Plik ma tyle zmian, ze liczniki sa przyblizone (para -/+ zamiast dopasowania). */
  readonly approximate: boolean;
}

export interface LineDiffOptions {
  /** Ile wierszy kontekstu wokol zmiany. */
  readonly context: number;
  /** Czy budowac wiersze diffu, czy tylko liczniki. */
  readonly hunks: boolean;
  /** Gorny limit komorek tablicy LCS; powyzej niego liczniki sa przyblizone. */
  readonly maxCells?: number;
}

const DEFAULT_MAX_CELLS = 4_000_000;

/** Wiersze tekstu bez koncowego pustego wiersza po ostatnim `\n`. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type Op = readonly [kind: ' ' | '-' | '+', line: string];

function lcsOps(a: readonly string[], b: readonly string[], maxCells: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ['+', line] as const);
  if (m === 0) return a.map((line) => ['-', line] as const);
  if ((n + 1) * (m + 1) > maxCells) return null;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i] ?? '']);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push(['-', a[i] ?? '']);
      i += 1;
    } else {
      ops.push(['+', b[j] ?? '']);
      j += 1;
    }
  }
  while (i < n) ops.push(['-', a[i++] ?? '']);
  while (j < m) ops.push(['+', b[j++] ?? '']);
  return ops;
}

function buildHunks(ops: readonly Op[], context: number): string[] {
  const out: string[] = [];
  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op[0] !== ' ') changed.push(index);
  });
  if (changed.length === 0) return out;
  // Zakresy [od, do) wokol zmian, scalane, gdy kontekst sie zazebia.
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  for (const [from, to] of ranges) {
    let oldStart = 1;
    let newStart = 1;
    for (let k = 0; k < from; k += 1) {
      if (ops[k]?.[0] !== '+') oldStart += 1;
      if (ops[k]?.[0] !== '-') newStart += 1;
    }
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let k = from; k < to; k += 1) {
      const [kind, line] = ops[k] ?? [' ', ''];
      if (kind !== '+') oldCount += 1;
      if (kind !== '-') newCount += 1;
      body.push(`${kind}${line}`);
    }
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
  }
  return out;
}

/**
 * Roznica wierszy `before` -> `after`. Wspolny poczatek i koniec sa odcinane, srodek idzie przez
 * LCS; gdy srodek jest za duzy, liczniki sa przyblizone (`approximate`) i nie ma wierszy diffu.
 */
export function diffLines(before: string, after: string, options: LineDiffOptions): LineDiffResult {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const middle = lcsOps(midA, midB, options.maxCells ?? DEFAULT_MAX_CELLS);
  if (middle === null) {
    return { added: midB.length, removed: midA.length, hunks: null, approximate: true };
  }
  let added = 0;
  let removed = 0;
  for (const [kind] of middle) {
    if (kind === '+') added += 1;
    else if (kind === '-') removed += 1;
  }
  if (!options.hunks) return { added, removed, hunks: null, approximate: false };
  const ops: Op[] = [
    ...a.slice(0, head).map((line) => [' ', line] as const),
    ...middle,
    ...a.slice(a.length - tail).map((line) => [' ', line] as const),
  ];
  return { added, removed, hunks: buildHunks(ops, options.context), approximate: false };
}

export interface RedactedJson {
  /** Ten sam dokument z wartoscia kazdego klucza `env` zastapiona napisem z liczba kluczy. */
  readonly text: string;
  /** Kanoniczny zapis wartosci `env` (sciezka -> wartosc): porownanie mowi, czy `env` sie zmienilo. */
  readonly envSignature: string;
}

const HIDDEN_ENV = (count: number): string => `(ukryte, kluczy: ${count})`;

/**
 * Zawartosc `env` nie trafia na ekran (moze zawierac dane), wiec przed porownaniem jest zastepowana
 * znacznikiem; o zmianie mowi tylko `envSignature`. Zwraca `null` dla tekstu, ktory nie jest JSON-em.
 */
export function redactJsonEnv(text: string): RedactedJson | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const found: Record<string, unknown> = {};
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`));
    if (typeof node !== 'object' || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const here = `${path}/${key}`;
      if (key === 'env' && typeof child === 'object' && child !== null && !Array.isArray(child)) {
        found[here] = child;
        out[key] = HIDDEN_ENV(Object.keys(child).length);
      } else if (key === 'env') {
        found[here] = child;
        out[key] = '(ukryte)';
      } else out[key] = walk(child, here);
    }
    return out;
  };
  const redacted = walk(value, '');
  return {
    text: `${JSON.stringify(redacted, null, 2)}\n`,
    envSignature: canonicalJson(found),
  };
}
