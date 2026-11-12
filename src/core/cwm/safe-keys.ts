/**
 * Klucze, ktore w obiekcie z JSON-a lub YAML-a sa wektorem zanieczyszczenia prototypu (IMP-04):
 * `JSON.parse` tworzy wlasna wlasciwosc `__proto__`, a kopiowanie przez przypisanie zmienia wtedy
 * prototyp celu. Odrzucamy je wszedzie i scalamy tylko na obiektach bez prototypu.
 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const MAX_SCAN_DEPTH = 64;
const MAX_SCAN_NODES = 200_000;

/** Obiekt bez prototypu: klucz `__proto__` jest na nim zwyklym kluczem, nie dostepem do prototypu. */
export function nullObject<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Czy drzewo danych ma zabroniony klucz. Przeszukanie jest ograniczone glebokoscia i liczba wezlow;
 * przekroczenie limitu liczy sie jak trafienie, bo reszcie wrogiego dokumentu nie mozna ufac.
 */
export function hasForbiddenKey(value: unknown): boolean {
  let nodes = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (typeof node !== 'object' || node === null) return false;
    nodes += 1;
    if (depth > MAX_SCAN_DEPTH || nodes > MAX_SCAN_NODES) return true;
    if (Array.isArray(node)) return node.some((item: unknown) => walk(item, depth + 1));
    const record = node as Record<string, unknown>;
    return Object.keys(record).some(
      (key) => FORBIDDEN_KEYS.has(key) || walk(record[key], depth + 1),
    );
  };
  return walk(value, 0);
}
