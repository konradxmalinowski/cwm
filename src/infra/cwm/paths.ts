import { realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { lstatOrNull } from '../fs/stat';
import { errnoCode } from '../fs/store-error';

/** Natywne pliki narzedzi, ktorych CWM nie rusza: zadna sciezka zapisu nie moze przez nie przechodzic. */
const PROTECTED_NAMES = new Set(['.claude', 'claude.md', '.mcp.json']);

export function isProtectedName(segment: string): boolean {
  return PROTECTED_NAMES.has(segment.toLowerCase());
}

/** Pierwszy segment sciezki rowny (bez wzgledu na wielkosc liter) chronionej nazwie albo null. */
export function protectedSegment(path: string): string | null {
  for (const segment of path.split(/[\\/]/)) {
    if (isProtectedName(segment)) return segment;
  }
  return null;
}

/**
 * Blad dostepu do sciezki z komunikatem bez sciezki i bez surowego tekstu errno: te zawieraja
 * nazwy plikow z dysku, a komunikat trafia na terminal.
 */
export class PathCheckError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PathCheckError';
  }
}

export function describeErrno(code: string | undefined): string {
  switch (code) {
    case 'ENOTDIR':
      return 'element sciezki nie jest katalogiem';
    case 'ENAMETOOLONG':
      return 'zbyt dluga sciezka';
    case 'EACCES':
    case 'EPERM':
      return 'brak uprawnien';
    case 'ELOOP':
      return 'zbyt wiele dowiazan symbolicznych';
    case 'EIO':
      return 'blad wejscia-wyjscia';
    default:
      return 'blad dostepu do systemu plikow';
  }
}

function toPathCheckError(error: unknown): PathCheckError {
  if (error instanceof PathCheckError) return error;
  const code = errnoCode(error);
  return new PathCheckError(code ?? 'UNKNOWN', describeErrno(code));
}

/**
 * `lstat`, ktory zwraca null takze dla ENOTDIR (czesc sciezki jest plikiem) i nigdy nie rzuca
 * surowego bledu systemowego: inne bledy wychodza jako `PathCheckError`.
 */
export async function lstatLoose(path: string) {
  try {
    return await lstatOrNull(path);
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOTDIR') return null;
    throw toPathCheckError(error);
  }
}

/**
 * `realpath` najglebszego istniejacego przodka plus nieistniejaca reszta. Dla sciezki, ktorej
 * jeszcze nie ma (nowy projekt, nowy CWM_HOME), daje sciezke, pod ktora faktycznie powstanie.
 */
export async function realpathLoose(path: string): Promise<string> {
  const abs = resolve(path);
  let ancestor = abs;
  for (;;) {
    try {
      return join(await realpath(ancestor), relative(ancestor, abs));
    } catch (error: unknown) {
      const code = errnoCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw toPathCheckError(error);
      const parent = dirname(ancestor);
      if (parent === ancestor) return abs;
      ancestor = parent;
    }
  }
}
