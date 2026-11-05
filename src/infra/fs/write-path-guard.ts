import { access, constants, lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { isPathInside } from '../../core/model/path-containment';
import { isWindowsReservedName } from '../../core/services/library/validate';

import { errnoCode } from './atomic';

/**
 * Kontrola sciezek `WriteGate` (ADR 0012 krok 1, ARCHITECTURE 8.3 i 12.5). Wynik "zablokowane"
 * niesie tekst dla uzytkownika bez sciezki bezwzglednej.
 */

export class Blocked extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'Blocked';
  }
}

// eslint-disable-next-line no-control-regex -- kontrolujemy dokladnie znaki sterujace
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;
const SEGMENT_MAX_BYTES = 255;

/**
 * Sprawdza `relPath` leksykalnie, na kazdym systemie tak samo: biblioteka jest przenosna miedzy
 * systemami, wiec nazwa niedozwolona na Windowsie jest odrzucana takze na macOS. Zwraca powod
 * albo `null`. Pusty `relPath` oznacza plik bedacy samym rootem i musi byc dopuszczony osobno.
 */
export function checkRelPath(relPath: unknown): string | null {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return 'Ścieżka pliku jest pusta.';
  }
  if (CONTROL_CHARS.test(relPath)) {
    return 'Ścieżka pliku zawiera znak sterujący (w tym NUL).';
  }
  if (relPath.includes('\\')) {
    return 'Ścieżka pliku zawiera znak \\ (w tym ścieżki UNC i \\\\?\\). Katalogi rozdziela /.';
  }
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
    return 'Ścieżka pliku jest bezwzględna, a powinna leżeć wewnątrz lokalizacji narzędzia.';
  }
  for (const segment of relPath.split('/')) {
    if (segment.length === 0) return 'Ścieżka pliku ma pustą część (podwójny lub końcowy ukośnik).';
    if (segment === '.' || segment === '..') {
      return 'Ścieżka pliku wychodzi poza lokalizację narzędzia (. lub ..).';
    }
    if (new TextEncoder().encode(segment).length > SEGMENT_MAX_BYTES) {
      return 'Nazwa w ścieżce pliku jest za długa dla systemu plików.';
    }
    if (WINDOWS_FORBIDDEN.test(segment)) {
      return 'Ścieżka pliku zawiera znak niedozwolony w nazwach plików na Windowsie.';
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return 'Nazwa pliku kończy się kropką lub spacją, czego Windows nie zachowuje.';
    }
    if (isWindowsReservedName(segment)) {
      return 'Nazwa pliku jest zarezerwowana przez Windows.';
    }
  }
  return null;
}

/** Root przychodzi z naszej tabeli, ale obrona w glab: na Windowsie odrzucamy UNC i `\\?\`. */
export function checkRootPath(root: string, platform: NodeJS.Platform): string | null {
  if (root.includes('\0')) return 'Lokalizacja docelowa ma niepoprawną ścieżkę.';
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (!api.isAbsolute(root)) return 'Lokalizacja docelowa nie ma ścieżki bezwzględnej.';
  if (platform === 'win32' && /^[\\/]{2}/.test(root)) {
    return 'Ścieżki sieciowe (UNC) i w postaci \\\\?\\ nie są dozwolone jako cel zapisu.';
  }
  return null;
}

/**
 * `realpath` dla sciezki, ktorej koncowka moze jeszcze nie istniec: rozwiazuje najblizszego
 * istniejacego przodka i dokleja reszte. Dowiazanie wiszace w srodku sciezki jest odmowa, bo
 * zapis poszedlby za nim do miejsca, ktorego nie sprawdzilismy.
 */
export async function realpathDeep(target: string): Promise<string> {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    try {
      const resolved = await realpath(current);
      return rest.length === 0 ? resolved : path.join(resolved, ...rest);
    } catch (error: unknown) {
      const code = errnoCode(error);
      if (code === 'ENOTDIR') throw new Blocked('Element ścieżki docelowej nie jest katalogiem.');
      if (code !== 'ENOENT') throw error;
      let exists = true;
      try {
        await lstat(current);
      } catch (inner: unknown) {
        const innerCode = errnoCode(inner);
        if (innerCode === 'ENOTDIR') {
          throw new Blocked('Element ścieżki docelowej nie jest katalogiem.');
        }
        if (innerCode !== 'ENOENT') throw inner;
        exists = false;
      }
      if (exists) throw new Blocked('Na ścieżce docelowej jest wiszące dowiązanie symboliczne.');
      const parent = path.dirname(current);
      if (parent === current) throw error;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

export interface LocatedTarget {
  /** Sciezka bezwzgledna celu (bez rozwiazywania ostatniego elementu). */
  readonly abs: string;
  /** `realpath` katalogu nadrzednego, juz sprawdzony pod rootem. */
  readonly parentReal: string;
}

/**
 * Ustala cel i sprawdza, ze katalog nadrzedny po `realpath` lezy pod rootem. Ostatni element
 * celu nie jest rozwiazywany: dowiazanie w nim obsluguje wywolujacy.
 * `fileRoot`: root jest sam plikiem (CLAUDE.md, config.toml), wiec cel to ten plik.
 * `assumeReplaced`: katalog, ktorego dowiazanie za chwile zniknie; wpisy pod nim nie istnieja,
 * wiec ich nadrzedny jest liczony leksykalnie od `parentReal` tego katalogu.
 */
export async function locateTarget(
  rootPath: string,
  relPath: string,
  options: {
    readonly platform: NodeJS.Platform;
    readonly fileRoot: boolean;
    readonly assumeReplaced?: { readonly abs: string; readonly parentReal: string };
  },
): Promise<LocatedTarget> {
  const rootReason = checkRootPath(rootPath, options.platform);
  if (rootReason !== null) throw new Blocked(rootReason);

  if (options.fileRoot) {
    const parentReal = await realpathDeep(path.dirname(rootPath));
    return { abs: rootPath, parentReal };
  }

  const reason = checkRelPath(relPath);
  if (reason !== null) throw new Blocked(reason);
  const abs = path.join(rootPath, ...relPath.split('/'));

  const replaced = options.assumeReplaced;
  if (replaced !== undefined && isPathInside(abs, replaced.abs)) {
    const below = path.relative(replaced.abs, path.dirname(abs));
    return {
      abs,
      parentReal: path.join(replaced.parentReal, path.basename(replaced.abs), below),
    };
  }

  const rootReal = await realpathDeep(rootPath);
  const parentReal = await realpathDeep(path.dirname(abs));
  if (!isPathInside(parentReal, rootReal, { allowSame: true })) {
    throw new Blocked('Ścieżka po rozwiązaniu dowiązań wychodzi poza lokalizację narzędzia.');
  }
  return { abs, parentReal };
}

/** Czy do najblizszego istniejacego katalogu mozna zapisywac. Windows: `access` nie jest wiarygodne. */
export async function assertWritableAncestor(
  dir: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === 'win32') return;
  let current = dir;
  for (;;) {
    try {
      await lstat(current);
      break;
    } catch (error: unknown) {
      if (errnoCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
  try {
    await access(current, constants.W_OK | constants.X_OK);
  } catch {
    throw new Blocked('Katalog docelowy jest tylko do odczytu albo brak do niego uprawnień.');
  }
}

/**
 * Brakujacy root (katalog skilli, plik instrukcji) wolno utworzyc tylko wtedy, gdy istnieje jego
 * rodzic, czyli katalog glowny narzedzia (ADR 0033). Bez rodzica zapis tworzylby drzewo narzedzia
 * od zera.
 */
export async function assertRootAnchored(rootPath: string): Promise<void> {
  try {
    await lstat(rootPath);
    return;
  } catch (error: unknown) {
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
  try {
    if ((await stat(path.dirname(rootPath))).isDirectory()) return;
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  throw new Blocked(
    'Katalog główny narzędzia nie istnieje, więc aplikacja nie utworzy tej lokalizacji od zera.',
  );
}
