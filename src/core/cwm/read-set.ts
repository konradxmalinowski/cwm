import { Checker, childPath, field, type PlainObject } from './check';
import { RESOURCE_ID_PATTERN } from './kinds';

export function readIdList(c: Checker, value: unknown, path: string): string[] {
  return c.list(value, path, (el, p) =>
    c.string(el, p, RESOURCE_ID_PATTERN, '<przestrzen>/<nazwa>'),
  );
}

/** Czyta z obiektu `obj` listy id o podanych kluczach (reszte pol obiektu sprawdza wywolujacy). */
export function readFields<K extends string>(
  c: Checker,
  obj: PlainObject,
  path: string,
  keys: readonly K[],
): { readonly [P in K]: readonly string[] } {
  const block = {} as { [P in K]: readonly string[] };
  for (const key of keys) block[key] = readIdList(c, field(obj, key), childPath(path, key));
  return block;
}

/** Blok z listami id (np. `resources.enable`, `plugins`). Brak bloku oznacza same puste listy. */
export function readBlock<K extends string>(
  c: Checker,
  value: unknown,
  path: string,
  keys: readonly K[],
): { readonly [P in K]: readonly string[] } {
  const obj = value === undefined ? {} : c.object(value, path, keys);
  return readFields(c, obj ?? {}, path, keys);
}
