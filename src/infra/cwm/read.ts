import type { Dirent } from 'node:fs';
import { opendir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { isNode, LineCounter, parseDocument } from 'yaml';

import type { Result } from '../../core/cwm';
import { isPathInside } from '../../core/model/path-containment';
import { readChecked } from '../fs/bounded-read';
import { errnoCode } from '../fs/store-error';
import { MAX_MANIFEST_UTF16_UNITS, parseManifestYaml } from './yaml-manifest';

/** Najgorszy przypadek UTF-8: 3 bajty na jednostke UTF-16. Limit bajtow dziala przed dekodowaniem. */
export const MAX_MANIFEST_BYTES = MAX_MANIFEST_UTF16_UNITS * 3;
export const MAX_DIR_ENTRIES = 5000;

/** Blad z plikiem i pozycja. `line` i `col` rowne 0 znacza, ze pozycji nie da sie ustalic. */
export interface Problem {
  readonly file: string;
  readonly path: string;
  readonly message: string;
  readonly line: number;
  readonly col: number;
}

export type ReadFailure = 'missing' | 'unsafe' | 'too-large' | 'not-file' | 'encoding' | 'io';

export type TextRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: ReadFailure; readonly message: string };

export type Loaded<T> =
  | { readonly ok: true; readonly value: T; readonly file: string; readonly text: string }
  | {
      readonly ok: false;
      readonly file: string;
      readonly reason: ReadFailure | 'invalid';
      readonly problems: readonly Problem[];
    };

/** Czy `candidate` lezy w `root` albo nim jest (obie sciezki po rozwiazaniu dowiazan). */
export function isInside(root: string, candidate: string): boolean {
  return isPathInside(candidate, root, { allowSame: true });
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Odczyt tekstu z pliku regularnego pod `root`. Katalog nadrzedny po rozwiazaniu dowiazan musi
 * lezec w `root` (dowiazanie wychodzace jest odmowa), sam plik nie moze byc dowiazaniem, a rozmiar
 * jest sprawdzany przed odczytem i dekodowaniem.
 */
export async function readTextWithin(
  root: string,
  file: string,
  maxBytes = MAX_MANIFEST_BYTES,
): Promise<TextRead> {
  try {
    const rootReal = await realpathOrNull(root);
    const parentReal = rootReal === null ? null : await realpathOrNull(dirname(file));
    if (rootReal === null || parentReal === null) {
      return { ok: false, reason: 'missing', message: 'Plik nie istnieje.' };
    }
    if (!isInside(rootReal, parentReal)) {
      return {
        ok: false,
        reason: 'unsafe',
        message: 'Katalog pliku wychodzi dowiazaniem poza katalog danych.',
      };
    }
    const read = await readChecked(join(parentReal, basename(file)), maxBytes, { strict: true });
    switch (read.kind) {
      case 'missing':
        return { ok: false, reason: 'missing', message: 'Plik nie istnieje.' };
      case 'symlink':
        return { ok: false, reason: 'unsafe', message: 'Plik jest dowiazaniem symbolicznym.' };
      case 'not-file':
        return { ok: false, reason: 'not-file', message: 'To nie jest zwykly plik.' };
      case 'too-large':
      case 'other-size':
        return {
          ok: false,
          reason: 'too-large',
          message: `Plik jest wiekszy niz ${maxBytes} bajtow.`,
        };
      case 'ok':
        break;
    }
    try {
      return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) };
    } catch {
      return { ok: false, reason: 'encoding', message: 'Plik nie jest poprawnym UTF-8.' };
    }
  } catch (error: unknown) {
    return {
      ok: false,
      reason: 'io',
      message: `Blad odczytu (${errnoCode(error) ?? 'nieznany'}).`,
    };
  }
}

function pathToKeys(path: string): (string | number)[] {
  if (path === '$') return [];
  return [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) =>
    m[2] === undefined ? (m[1] ?? '') : Number(m[2]),
  );
}

/** Pozycja pola w tekscie YAML. Gdy pola nie ma, pozycja najblizszego istniejacego rodzica. */
export function locateInYaml(text: string, path: string): { line: number; col: number } {
  try {
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { lineCounter, schema: 'core', merge: false });
    const keys = pathToKeys(path);
    for (let length = keys.length; length >= 0; length--) {
      const node = length === 0 ? doc.contents : doc.getIn(keys.slice(0, length), true);
      if (isNode(node) && node.range) {
        const { line, col } = lineCounter.linePos(node.range[0]);
        return { line, col };
      }
    }
  } catch {
    // Pozycja jest dodatkiem do komunikatu, jej brak nie moze ukryc bledu.
  }
  return { line: 1, col: 1 };
}

export function problemAt(file: string, text: string, path: string, message: string): Problem {
  return { file, path, message, ...locateInYaml(text, path) };
}

export function problemWithoutPosition(file: string, path: string, message: string): Problem {
  return { file, path, message, line: 0, col: 0 };
}

/** Wczytuje plik, parsuje YAML i sprawdza go walidatorem z rdzenia. */
export async function readManifest<T>(
  root: string,
  file: string,
  validate: (input: unknown) => Result<T>,
): Promise<Loaded<T>> {
  const read = await readTextWithin(root, file);
  if (!read.ok) {
    return {
      ok: false,
      file,
      reason: read.reason,
      problems: [problemWithoutPosition(file, '$', read.message)],
    };
  }
  const parsed = parseManifestYaml(read.text);
  if (!parsed.ok) {
    return {
      ok: false,
      file,
      reason: 'invalid',
      problems: parsed.errors.map((e) => ({
        file,
        path: e.path,
        message: e.message,
        line: e.line,
        col: e.col,
      })),
    };
  }
  const result = validate(parsed.value);
  if (!result.ok) {
    return {
      ok: false,
      file,
      reason: 'invalid',
      problems: result.errors.map((e) => problemAt(file, read.text, e.path, e.message)),
    };
  }
  return { ok: true, value: result.value, file, text: read.text };
}

export interface DirEntry {
  readonly name: string;
  readonly kind: 'dir' | 'file' | 'symlink' | 'other';
}

export type DirListing =
  | { readonly ok: true; readonly entries: readonly DirEntry[]; readonly truncated: boolean }
  | { readonly ok: false; readonly message: string };

export const SCAN_LIMIT_MESSAGE = 'Limit skanowania osiagniety, reszta wpisow pominieta.';

/**
 * Czyta katalog iteratorem i staje na `limit` wpisach (alokacja nie zalezy od wielkosci katalogu na
 * dysku). `truncated` mowi, ze wpisow bylo wiecej. Kolejnosc wpisow przy obcieciu jest dowolna.
 */
export async function readDirLimited(
  dir: string,
  limit = MAX_DIR_ENTRIES,
): Promise<{ entries: Dirent[]; truncated: boolean }> {
  const handle = await opendir(dir);
  const entries: Dirent[] = [];
  let truncated = false;
  try {
    for await (const entry of handle) {
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { entries, truncated };
}

function kindOf(entry: Dirent): DirEntry['kind'] {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'dir';
  return entry.isFile() ? 'file' : 'other';
}

/** Lista katalogu pod `root`; brak katalogu daje pusta liste. Wpisy posortowane po punktach kodowych. */
export async function listDirectory(root: string, dir: string): Promise<DirListing> {
  try {
    const rootReal = await realpathOrNull(root);
    const dirReal = rootReal === null ? null : await realpathOrNull(dir);
    if (rootReal === null || dirReal === null) return { ok: true, entries: [], truncated: false };
    if (!isInside(rootReal, dirReal)) {
      return { ok: false, message: 'Katalog wychodzi dowiazaniem poza katalog danych.' };
    }
    const { entries, truncated } = await readDirLimited(dirReal);
    return {
      ok: true,
      entries: entries
        .map((entry): DirEntry => ({ name: entry.name, kind: kindOf(entry) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      truncated,
    };
  } catch (error: unknown) {
    return { ok: false, message: `Blad odczytu katalogu (${errnoCode(error) ?? 'nieznany'}).` };
  }
}
