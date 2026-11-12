/** Blad walidacji z sciezka do pola, np. `spec.plugins.enable[1]`. Korzen dokumentu to `$`. */
export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export type ValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly errors: readonly ValidationError[] };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(errors: readonly ValidationError[]): { ok: false; errors: ValidationError[] } {
  return { ok: false, errors: sortErrors(errors) };
}

/** Porownanie po punktach kodowych, nie `localeCompare`: wynik ma byc taki sam na kazdej maszynie. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Gorny limit listy bledow: wiecej to juz szum, a niezaufany manifest nie moze puchnac wyniku. */
export const MAX_ERRORS = 100;

/** Sortuje, usuwa powtorzenia i obcina do `MAX_ERRORS` z koncowym wpisem "+N wiecej". */
export function sortErrors(errors: readonly ValidationError[]): ValidationError[] {
  const unique = new Map<string, ValidationError>();
  for (const error of errors) unique.set(`${error.path}\u0000${error.message}`, error);
  const sorted = [...unique.values()].sort(
    (a, b) => compareStrings(a.path, b.path) || compareStrings(a.message, b.message),
  );
  if (sorted.length <= MAX_ERRORS) return sorted;
  const rest = sorted.length - MAX_ERRORS;
  return [
    ...sorted.slice(0, MAX_ERRORS),
    { path: '$', message: `Co najmniej ${rest} wiecej bledow.` },
  ];
}

/**
 * Zamienia znaki sterujace (Cc) i formatujace (Cf: RLO, zero-width) na zapis `\xNN` / `\uNNNN`.
 * `keep` to znaki, ktore zostaja (np. "\n" przy wieloliniowym wyniku). Tekst z dysku nie moze
 * sterowac terminalem ani ukrywac tresci przed czlowiekiem.
 */
export function escapeControlChars(text: string, keep = ''): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => {
    if (keep.includes(char)) return char;
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`;
    return code <= 0xffff
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : `\\u{${code.toString(16)}}`;
  });
}
