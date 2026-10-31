import path from 'node:path';

/**
 * Minimalny kontrakt na modul `path`, zeby test mogl podstawic `path.win32`
 * i sprawdzic semantyke Windowsa na dowolnym systemie.
 */
export interface PathApi {
  resolve(...segments: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(value: string): boolean;
  readonly sep: string;
}

/**
 * Czy `child` lezy w `parent`, albo nim jest.
 *
 * Wartownik `isAbsolute` jest tu krytyczny. Na Windowsie `path.relative`
 * miedzy sciezkami na roznych dyskach nie zwraca `..`, tylko gotowa sciezke
 * absolutna do celu - bez tego sprawdzenia `D:\\evil\\plik` wychodziloby jako
 * lezace w `C:\\app\\dist\\renderer`. Ta funkcja stoi na granicy zapisu
 * i odczytu (ADR 0008, ADR 0012), wiec blad w niej jest bledem
 * bezpieczenstwa, nie kosmetyka.
 */
export function isPathInsideWith(
  pathApi: PathApi,
  child: string,
  parent: string,
  { allowSame = false }: { allowSame?: boolean } = {},
): boolean {
  const resolvedParent = pathApi.resolve(parent);
  const resolvedChild = pathApi.resolve(child);

  if (resolvedChild === resolvedParent) return allowSame;

  const rel = pathApi.relative(resolvedParent, resolvedChild);
  // Wyjscie to segment `..`, a nie prefiks nazwy: `..chunk.js` jest poprawnym plikiem w korzeniu.
  const escapes = rel === '..' || rel.startsWith(`..${pathApi.sep}`);
  return rel !== '' && !escapes && !pathApi.isAbsolute(rel);
}

export function isPathInside(
  child: string,
  parent: string,
  options?: { allowSame?: boolean },
): boolean {
  return isPathInsideWith(path, child, parent, options ?? {});
}
