import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { RootId } from '../../core/model/item';
import { MAX_FILE_BYTES, MAX_TREE_DEPTH } from '../../core/model/library-limits';
import { isPathInside } from '../../core/model/path-containment';
import {
  SourceReadError,
  type SourceEntry,
  type SourceEntryType,
  type SourceReadFailure,
  type SourceReader,
  type SymlinkTarget,
} from '../../core/ports/source-reader';
import { NotRegularFileError, readBounded } from '../fs/bounded-read';
import { errnoCode } from '../fs/store-error';

/** Katalog z wiecej wpisami to nie skill ani agent, tylko smietnik albo atak na pamiec. */
const MAX_LIST_ENTRIES = 5000;

type RootResolver = (rootId: RootId) => string | null;

interface Located {
  readonly rootReal: string;
  /** Segmenty wzgledem roota; puste to sam root. */
  readonly segments: readonly string[];
  readonly rootIsFile: boolean;
}

/**
 * Czytnik zrodla tylko do odczytu (ADR 0022). Nie importuje nic, co pisze: `node:fs/promises`
 * jest uzyty wylacznie przez `lstat`, `stat`, `readdir`, `realpath` i `readBounded`.
 * Komunikaty bledow niosa sciezke wzgledna roota, nigdy bezwzgledna (ARCHITECTURE 7.2, regula 4).
 */
export class FsSourceReader implements SourceReader {
  constructor(private readonly resolveRoot: RootResolver) {}

  async list(root: RootId, relPath: string): Promise<readonly SourceEntry[]> {
    return this.guard(relPath, async () => {
      const located = await this.locate(root, relPath);
      if (located.rootIsFile) {
        if (located.segments.length > 0) throw notFound(relPath);
        const info = await stat(located.rootReal);
        return [{ name: path.basename(located.rootReal), type: 'file', size: info.size }];
      }
      const dir = path.join(located.rootReal, ...located.segments);
      await this.requireNoSymlinkPrefix(located.rootReal, located.segments, relPath, true);
      const names = await readdir(dir, { withFileTypes: true });
      if (names.length > MAX_LIST_ENTRIES) {
        throw new SourceReadError(
          'too-large',
          relPath,
          `Katalog "${displayPath(relPath)}" ma zbyt wiele wpisow.`,
        );
      }
      const entries: SourceEntry[] = [];
      for (const dirent of names) {
        const type = direntType(dirent);
        let size: number | null = null;
        if (type === 'file') {
          try {
            size = (await lstat(path.join(dir, dirent.name))).size;
          } catch {
            // Plik zniknal miedzy readdir a lstat: rozmiar nieznany, wpis zostaje.
          }
        }
        entries.push({ name: dirent.name, type, size });
      }
      return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    });
  }

  async read(root: RootId, relPath: string, maxBytes: number): Promise<Uint8Array> {
    return this.guard(relPath, async () => {
      const located = await this.locate(root, relPath);
      const target = await this.fileTarget(located, relPath);
      const limit = Math.min(Math.max(0, Math.floor(maxBytes)), MAX_FILE_BYTES);
      const { bytes, truncated } = await readBounded(target, limit);
      if (truncated) {
        throw new SourceReadError(
          'too-large',
          relPath,
          `Plik "${displayPath(relPath)}" przekracza limit rozmiaru.`,
        );
      }
      return bytes;
    });
  }

  async resolveSymlink(root: RootId, relPath: string): Promise<SymlinkTarget> {
    return this.guard(relPath, async () => {
      const located = await this.locate(root, relPath);
      if (located.rootIsFile || located.segments.length === 0) throw notAFile(relPath);
      await this.requireNoSymlinkPrefix(located.rootReal, located.segments.slice(0, -1), relPath);
      const full = path.join(located.rootReal, ...located.segments);
      const info = await lstat(full);
      if (!info.isSymbolicLink()) throw notAFile(relPath);

      const real = await realpath(full);
      if (!isPathInside(real, located.rootReal, { allowSame: true })) {
        // Nie dotykamy celu poza rootem, nawet zeby policzyc identity.
        return { relPath: null, identity: null };
      }
      const targetInfo = await stat(real, { bigint: true });
      const rel = path
        .relative(located.rootReal, real)
        .split(path.sep)
        .filter((s) => s !== '')
        .join('/');
      return { relPath: rel, identity: `${targetInfo.dev}:${targetInfo.ino}` };
    });
  }

  async mode(root: RootId, relPath: string): Promise<number | null> {
    return this.guard(relPath, async () => {
      if (process.platform === 'win32') return null;
      const located = await this.locate(root, relPath);
      const target = located.rootIsFile
        ? located.rootReal
        : path.join(located.rootReal, ...located.segments);
      await this.requireNoSymlinkPrefix(located.rootReal, located.segments, relPath);
      return (await lstat(target)).mode & 0o777;
    });
  }

  private async fileTarget(located: Located, relPath: string): Promise<string> {
    if (located.rootIsFile) {
      const name = path.basename(located.rootReal);
      const only =
        located.segments.length === 0 ||
        (located.segments.length === 1 && located.segments[0] === name);
      if (!only) throw notFound(relPath);
      return located.rootReal;
    }
    if (located.segments.length === 0) throw notAFile(relPath);
    await this.requireNoSymlinkPrefix(located.rootReal, located.segments, relPath);
    return path.join(located.rootReal, ...located.segments);
  }

  private async locate(root: RootId, relPath: string): Promise<Located> {
    const segments = splitRelPath(relPath);
    const rootPath = this.resolveRoot(root);
    if (rootPath === null) {
      throw new SourceReadError('not-found', relPath, 'Nieznana lokalizacja zrodla.');
    }
    // Sam root moze byc dowiazaniem (dotfiles), wiec go rozwiazujemy; wszystko pod nim nie.
    const rootReal = await realpath(rootPath);
    const info = await stat(rootReal);
    const full = path.join(rootReal, ...segments);
    if (!isPathInside(full, rootReal, { allowSame: true })) {
      throw outside(relPath);
    }
    return { rootReal, segments, rootIsFile: info.isFile() };
  }

  /**
   * Odrzuca dowiazanie w kazdym segmencie sciezki (z ostatnim wlacznie, gdy `includeLast`).
   * Dowiazania rozwiazuje wylacznie `resolveSymlink`, ktore pilnuje, ze cel jest pod rootem.
   */
  private async requireNoSymlinkPrefix(
    rootReal: string,
    segments: readonly string[],
    relPath: string,
    includeLast = true,
  ): Promise<void> {
    const count = includeLast ? segments.length : Math.max(0, segments.length - 1);
    let current = rootReal;
    for (let i = 0; i < count; i++) {
      current = path.join(current, segments[i] ?? '');
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new SourceReadError(
          'not-a-file',
          relPath,
          `"${displayPath(relPath)}" przechodzi przez dowiazanie symboliczne, ktorego nie podazamy.`,
        );
      }
    }
  }

  /** Zamienia kazdy blad systemu plikow na `SourceReadError` bez sciezki bezwzglednej. */
  private async guard<T>(relPath: string, task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error: unknown) {
      throw toReadError(error, relPath);
    }
  }
}

function displayPath(relPath: string): string {
  return relPath === '' ? '(root)' : relPath;
}

function splitRelPath(relPath: string): string[] {
  if (relPath === '') return [];
  const invalid =
    relPath.includes('\0') ||
    relPath.includes('\\') ||
    relPath.startsWith('/') ||
    /^[A-Za-z]:/.test(relPath);
  const segments = relPath.split('/');
  if (invalid || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw outside(relPath);
  }
  if (segments.length > MAX_TREE_DEPTH) {
    throw new SourceReadError('unknown', relPath, 'Sciezka jest zbyt gleboka.');
  }
  return segments;
}

function direntType(dirent: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): SourceEntryType {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory()) return 'directory';
  return dirent.isFile() ? 'file' : 'other';
}

function outside(relPath: string): SourceReadError {
  return new SourceReadError(
    'outside-root',
    relPath,
    'Sciezka wychodzi poza wybrana lokalizacje albo jest niepoprawna.',
  );
}

function notFound(relPath: string): SourceReadError {
  return new SourceReadError('not-found', relPath, `Nie znaleziono "${displayPath(relPath)}".`);
}

function notAFile(relPath: string): SourceReadError {
  return new SourceReadError(
    'not-a-file',
    relPath,
    `"${displayPath(relPath)}" nie jest zwyklym plikiem.`,
  );
}

function toReadError(error: unknown, relPath: string): SourceReadError {
  if (error instanceof SourceReadError) return error;
  if (error instanceof NotRegularFileError) return notAFile(relPath);
  const code = errnoCode(error);
  const name = displayPath(relPath);
  const failures: Record<string, [SourceReadFailure, string]> = {
    ENOENT: ['not-found', `Nie znaleziono "${name}".`],
    EACCES: ['permission-denied', `Brak uprawnien do odczytu "${name}".`],
    EPERM: ['permission-denied', `Brak uprawnien do odczytu "${name}".`],
    ELOOP: ['not-a-file', `"${name}" jest dowiazaniem symbolicznym, ktorego nie podazamy.`],
    ENOTDIR: ['not-a-file', `"${name}" nie jest katalogiem.`],
    EISDIR: ['not-a-file', `"${name}" jest katalogiem, nie plikiem.`],
  };
  const known = code === undefined ? undefined : failures[code];
  if (known !== undefined) return new SourceReadError(known[0], relPath, known[1]);
  return new SourceReadError('unknown', relPath, `Nie udalo sie odczytac "${name}".`);
}
