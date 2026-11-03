import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import type { RootId } from '../../../src/core/model/item';
import {
  SourceReadError,
  type SourceEntry,
  type SourceEntryType,
  type SourceReader,
  type SymlinkTarget,
} from '../../../src/core/ports/source-reader';

/**
 * Prosty czytnik testowy na prawdziwym dysku. Adaptery nie importuja `node:fs`, ale testy moga,
 * a prawdziwy czytnik (src/infra/source) ma te same obowiazki: nie idzie za dowiazaniem w `read`,
 * a `resolveSymlink` ucina wszystko, co laduje poza rootem.
 */
export class FsSourceReader implements SourceReader {
  constructor(private readonly roots: ReadonlyMap<RootId, string>) {}

  private base(root: RootId): string {
    const base = this.roots.get(root);
    if (base === undefined) throw new Error(`Nieznany root testowy: ${root}`);
    return base;
  }

  private abs(root: RootId, relPath: string): string {
    if (relPath === '') return this.base(root);
    const segments = relPath.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..') || relPath.includes('\\')) {
      throw new SourceReadError('outside-root', relPath, 'Sciezka poza rootem.');
    }
    return join(this.base(root), ...segments);
  }

  list(root: RootId, relPath: string): Promise<readonly SourceEntry[]> {
    return Promise.resolve().then(() => {
      const dir = this.abs(root, relPath);
      try {
        // Root bedacy plikiem (CLAUDE.md, config.toml) listuje sie jako jeden wpis, jak w prawdziwym czytniku.
        const own = lstatSync(dir);
        if (relPath === '' && own.isFile()) {
          return [{ name: basename(dir), type: 'file' as const, size: own.size }];
        }
        return readdirSync(dir, { withFileTypes: true }).map((d): SourceEntry => {
          const type: SourceEntryType = d.isSymbolicLink()
            ? 'symlink'
            : d.isDirectory()
              ? 'directory'
              : d.isFile()
                ? 'file'
                : 'other';
          return {
            name: d.name,
            type,
            size: type === 'file' ? lstatSync(join(dir, d.name)).size : null,
          };
        });
      } catch (error) {
        throw translate(error, relPath);
      }
    });
  }

  read(root: RootId, relPath: string, maxBytes: number): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      const file = this.abs(root, relPath);
      try {
        const stat = lstatSync(file);
        if (!stat.isFile())
          throw new SourceReadError('not-a-file', relPath, 'Nie jest zwyklym plikiem.');
        if (stat.size > maxBytes) throw new SourceReadError('too-large', relPath, 'Za duzy.');
        return new Uint8Array(readFileSync(file));
      } catch (error) {
        throw translate(error, relPath);
      }
    });
  }

  resolveSymlink(root: RootId, relPath: string): Promise<SymlinkTarget> {
    return Promise.resolve().then(() => {
      const file = this.abs(root, relPath);
      try {
        // Jak prawdziwy czytnik: zwykly plik nie jest dowiazaniem.
        if (!lstatSync(file).isSymbolicLink()) {
          throw new SourceReadError('not-a-file', relPath, 'Nie jest dowiazaniem.');
        }
        const real = realpathSync(file);
        const rootReal = realpathSync(this.base(root));
        if (real !== rootReal && !real.startsWith(rootReal + sep)) {
          return { relPath: null, identity: null };
        }
        const stat = statSync(real, { bigint: true });
        const identity = `${stat.dev}:${stat.ino}`;
        return { relPath: relative(rootReal, real).split(sep).join('/'), identity };
      } catch (error) {
        throw translate(error, relPath);
      }
    });
  }

  mode(root: RootId, relPath: string): Promise<number | null> {
    return Promise.resolve().then(() => {
      if (process.platform === 'win32') return null;
      try {
        return lstatSync(this.abs(root, relPath)).mode & 0o777;
      } catch (error) {
        throw translate(error, relPath);
      }
    });
  }
}

function translate(error: unknown, relPath: string): Error {
  if (error instanceof SourceReadError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new SourceReadError('not-found', relPath, 'Nie istnieje.');
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new SourceReadError('permission-denied', relPath, 'Brak uprawnien.');
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface Fault {
  readonly failure: 'permission-denied' | 'too-large' | 'not-found' | 'unknown';
}

/**
 * Opakowanie, ktore zapisuje wywolania i wstrzykuje bledy odczytu. Kontrakt `SourceReader` ma
 * tylko cztery metody odczytu, wiec "skan nic nie zapisuje" sprawdzamy dwojako: lista wywolan
 * nie wychodzi poza te cztery, a odciski plikow na dysku sa takie same przed i po.
 */
export class InstrumentedReader implements SourceReader {
  readonly calls: string[] = [];

  constructor(
    private readonly inner: SourceReader,
    private readonly fault: (relPath: string) => Fault | null = () => null,
  ) {}

  list(root: RootId, relPath: string): Promise<readonly SourceEntry[]> {
    this.calls.push('list');
    return this.inner.list(root, relPath);
  }

  read(root: RootId, relPath: string, maxBytes: number): Promise<Uint8Array> {
    this.calls.push('read');
    const fault = this.fault(relPath);
    if (fault !== null) {
      return Promise.reject(new SourceReadError(fault.failure, relPath, 'Wstrzyknieto blad.'));
    }
    return this.inner.read(root, relPath, maxBytes);
  }

  resolveSymlink(root: RootId, relPath: string): Promise<SymlinkTarget> {
    this.calls.push('resolveSymlink');
    return this.inner.resolveSymlink(root, relPath);
  }

  mode(root: RootId, relPath: string): Promise<number | null> {
    this.calls.push('mode');
    return this.inner.mode(root, relPath);
  }
}

/** Odcisk calego drzewa: sciezka, tryb i hash bajtow kazdego pliku. */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join('/');
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) out[rel] = 'symlink';
      else {
        const mode = lstatSync(full).mode & 0o777;
        out[rel] =
          `${mode.toString(8)}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
      }
    }
  };
  walk(dir);
  return out;
}

export function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

export function writeTreeFile(root: string, relPath: string, content: string | Uint8Array): void {
  const full = join(root, ...relPath.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Symlink na Windowsie wymaga uprawnien albo trybu dewelopera; bez nich test sie pomija. */
export function symlinksAvailable(probeDir: string): boolean {
  try {
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(join(probeDir, 'target'), 'x');
    symlinkSync('target', join(probeDir, 'link'));
    return true;
  } catch {
    return false;
  }
}

/** Serializacja wyniku skanu do porownan: bajty jako hash, zeby roznica w koncach linii byla widoczna. */
export function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) =>
      v instanceof Uint8Array ? `bytes:${createHash('sha256').update(v).digest('hex')}` : v,
    ),
  );
}
