const MAX_DEPTH = 64;

/**
 * Kanoniczny JSON w stylu RFC 8785 (JCS): klucze obiektow posortowane po jednostkach UTF-16,
 * bez bialych znakow, liczby w zapisie ECMAScript, teksty jak w `JSON.stringify`. Wejscie z
 * `undefined`, funkcja, symbolem, bigintem albo liczba nieskonczona jest bledem, zeby dwa rozne
 * dokumenty nigdy nie dawaly tego samego skrotu przez ciche pominiecie pola.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, 0);
}

function encode(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new RangeError('Dokument jest zbyt gleboki.');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Liczba nieskonczona nie ma zapisu JSON.');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`Wartosc typu ${typeof value} nie ma zapisu JSON.`);
  }
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map((item) => encode(item, depth + 1)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`);
  return `{${parts.join(',')}}`;
}
