import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { MaterializationMode } from '../../core/model/plan';
import type { ToolId } from '../../core/model/item';
import type { LinkCapability } from '../../core/ports/write-gate';

import { errnoCode, writeFileAtomic } from './atomic';
import { readBounded } from './bounded-read';
import { lstatOrNull } from './stat';

/**
 * Zdolnosc dowiazan i materializacja (ADR 0015). Zdolnosc jest wykrywana proba, nie zgadywana
 * z wersji systemu; wynik jest zapamietany, a `recheck` pozwala sprawdzic ponownie (Diagnostics).
 */

export type LinkType = 'file' | 'dir' | 'junction';

/** Szew dla testow: pozwala zasymulowac system bez prawa do dowiazan. */
export interface LinkOps {
  symlink(target: string, path: string, type: LinkType): Promise<void>;
}

const DEFAULT_LINK_OPS: LinkOps = {
  symlink: (target, path, type) => symlink(target, path, type),
};

export interface LinkDetectorOptions {
  readonly platform?: NodeJS.Platform;
  readonly ops?: Partial<LinkOps>;
}

export class LinkCapabilityDetector {
  private cached: Promise<LinkCapability> | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly ops: LinkOps;

  constructor(
    private readonly userDataDir: string,
    options: LinkDetectorOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.ops = { ...DEFAULT_LINK_OPS, ...options.ops };
  }

  /** Wynik pierwszej proby; kolejne wywolania nie dotykaja dysku. */
  capability(): Promise<LinkCapability> {
    this.cached ??= this.detect();
    return this.cached;
  }

  /** Ponowna proba, np. po wlaczeniu trybu dewelopera na Windowsie. */
  recheck(): Promise<LinkCapability> {
    this.cached = this.detect();
    return this.cached;
  }

  private async detect(): Promise<LinkCapability> {
    const none: LinkCapability = { fileSymlink: false, directorySymlink: false, junction: false };
    let dir: string;
    try {
      const base = join(this.userDataDir, 'tmp');
      await mkdir(base, { recursive: true, mode: 0o700 });
      dir = await mkdtemp(join(base, 'link-probe-'));
    } catch {
      // Bez katalogu na probe nie da sie niczego stwierdzic, wiec bezpiecznie: kopia.
      return none;
    }
    try {
      const file = join(dir, 'target.txt');
      const folder = join(dir, 'target-dir');
      await writeFile(file, 'x');
      await mkdir(folder);
      await writeFile(join(folder, 'inside.txt'), 'y');

      const fileSymlink = await this.attempt(file, join(dir, 'link-file'), 'file', async (link) => {
        return (await readFile(link, 'utf8')) === 'x';
      });
      const directorySymlink = await this.attempt(
        folder,
        join(dir, 'link-dir'),
        'dir',
        async (link) => (await readdir(link)).includes('inside.txt'),
      );
      // Junction istnieje tylko na Windowsie; Node na POSIX zignorowalby typ i zrobil zwykly symlink.
      const junction =
        this.platform === 'win32' &&
        (await this.attempt(folder, join(dir, 'link-junction'), 'junction', async (link) =>
          (await readdir(link)).includes('inside.txt'),
        ));
      return { fileSymlink, directorySymlink, junction };
    } catch {
      return none;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async attempt(
    target: string,
    link: string,
    type: LinkType,
    verify: (link: string) => Promise<boolean>,
  ): Promise<boolean> {
    try {
      await this.ops.symlink(target, link, type);
      // Junction nie jest symlinkiem z punktu widzenia lstat na wszystkich wersjach Node, wiec tu liczy sie odczyt.
      if (type !== 'junction' && !(await lstat(link)).isSymbolicLink()) return false;
      return await verify(link);
    } catch {
      return false;
    }
  }
}

export interface MaterializationChoice {
  readonly mode: MaterializationMode;
  /** Tekst dla uzytkownika, gdy tryb jest gorszy od symlinku; `null`, gdy to tryb docelowy. */
  readonly degradedReason: string | null;
}

/** Tabela degradacji z ADR 0015. `requested === 'copy'` to swiadomy wybor adaptera, nie degradacja. */
export function chooseMaterialization(
  capability: LinkCapability,
  kind: 'file' | 'directory',
  requested: MaterializationMode | null,
): MaterializationChoice {
  if (requested === 'copy') {
    // Probe zapisuje w planie tryb efektywny, wiec 'copy' moze wrocic jako wynik wlasnej degradacji:
    // powod zostaje, o ile system i tak nie pozwala na dowiazanie.
    const automatic = chooseMaterialization(capability, kind, null);
    return {
      mode: 'copy',
      degradedReason: automatic.mode === 'copy' ? automatic.degradedReason : null,
    };
  }
  if (kind === 'file') {
    return capability.fileSymlink
      ? { mode: 'symlink', degradedReason: null }
      : {
          mode: 'copy',
          degradedReason:
            'Dowiązania symboliczne plików są w tym systemie niedostępne, więc zapisano kopię. Zmiany w bibliotece wymagają ponownej synchronizacji.',
        };
  }
  if (capability.directorySymlink) return { mode: 'symlink', degradedReason: null };
  if (capability.junction) {
    return {
      mode: 'junction',
      degradedReason: 'Dowiązania symboliczne są niedostępne, użyto złącza (junction) katalogu.',
    };
  }
  return {
    mode: 'copy',
    degradedReason:
      'Dowiązania do katalogów są w tym systemie niedostępne, więc zapisano kopię. Zmiany w bibliotece wymagają ponownej synchronizacji.',
  };
}

/** `userData/materialized/<tool>/<relPath>`: dane wlasne aplikacji, do ktorych wskazuja dowiazania. */
export function materializedRoot(userDataDir: string): string {
  return join(userDataDir, 'materialized');
}

export function materializedPath(userDataDir: string, tool: ToolId, relPath: string): string {
  return join(materializedRoot(userDataDir), tool, ...relPath.split('/'));
}

export interface MaterialFile {
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

/** Tresc zmaterializowana: plik albo drzewo katalogu. `null`, gdy nic tam jeszcze nie ma. */
export type MaterialContent =
  | { readonly kind: 'file'; readonly bytes: Uint8Array }
  | { readonly kind: 'directory'; readonly files: readonly MaterialFile[] };

const MATERIAL_READ_LIMIT = 16 * 1024 * 1024;

export async function readMaterialized(
  path: string,
  kind: 'file' | 'directory',
): Promise<MaterialContent | null> {
  const info = await lstatOrNull(path);
  if (info === null) return null;
  if (kind === 'file') {
    if (!info.isFile()) return null;
    return { kind: 'file', bytes: (await readBounded(path, MATERIAL_READ_LIMIT)).bytes };
  }
  if (!info.isDirectory()) return null;
  const files: MaterialFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (entry.isFile()) {
        files.push({
          relPath: rel,
          bytes: (await readBounded(join(dir, entry.name), MATERIAL_READ_LIMIT)).bytes,
        });
      }
    }
  };
  await walk(path, '');
  return { kind: 'directory', files };
}

export function sameMaterial(a: MaterialContent | null, b: MaterialContent | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'file' && b.kind === 'file') return Buffer.from(a.bytes).equals(b.bytes);
  if (a.kind === 'directory' && b.kind === 'directory') {
    if (a.files.length !== b.files.length) return false;
    const other = new Map(b.files.map((f) => [f.relPath, f.bytes]));
    return a.files.every((f) => {
      const match = other.get(f.relPath);
      return match !== undefined && Buffer.from(match).equals(f.bytes);
    });
  }
  return false;
}

/**
 * Zapisuje zmaterializowana tresc przez `writeFileAtomic`. Katalog jest doprowadzany do dokladnie
 * zadanego stanu (pliki spoza listy znikaja), bo dowiazanie pokazuje narzedziu caly katalog.
 * `null` usuwa to, co zmaterializowano; uzywane przy cofaniu.
 */
export async function writeMaterialized(
  path: string,
  content: MaterialContent | null,
): Promise<void> {
  if (content === null) {
    await rm(path, { recursive: true, force: true });
    return;
  }
  if (content.kind === 'file') {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, content.bytes);
    return;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const keep = new Set<string>();
  for (const file of content.files) {
    const target = join(path, ...file.relPath.split('/'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFileAtomic(target, file.bytes);
    keep.add(file.relPath);
  }
  const current = await readMaterialized(path, 'directory');
  if (current?.kind === 'directory') {
    for (const file of current.files) {
      if (!keep.has(file.relPath))
        await rm(join(path, ...file.relPath.split('/')), { force: true });
    }
  }
  await pruneEmptyDirectories(path);
}

async function pruneEmptyDirectories(root: string): Promise<void> {
  const visit = async (dir: string): Promise<boolean> => {
    let empty = true;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (await visit(join(dir, entry.name)))) {
        await rmdir(join(dir, entry.name)).catch(() => undefined);
      } else {
        empty = false;
      }
    }
    return empty;
  };
  await visit(root);
}

/** Windows zwraca cel junction z prefiksem `\\?\`; do porownan go zdejmujemy. */
function stripExtendedPrefix(value: string): string {
  return value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

/** Czy dowiazanie `linkPath` wskazuje na `expected` (bez podazania za kolejnymi dowiazaniami w lancuchu). */
export async function linkPointsTo(linkPath: string, expected: string): Promise<boolean> {
  try {
    const raw = stripExtendedPrefix(await readlink(linkPath));
    const absolute = resolve(dirname(linkPath), raw);
    if (absolute === resolve(expected)) return true;
    return (await realpath(linkPath)) === (await realpath(expected));
  } catch {
    return false;
  }
}

/** Usuwa samo dowiazanie (nigdy cel). Junction na Windowsie znika przez `rmdir`, nie `unlink`. */
export async function removeLink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (code === 'ENOENT') return;
    if (code === 'EPERM' || code === 'EISDIR' || code === 'EACCES') {
      await rmdir(path);
      return;
    }
    throw error;
  }
}

export interface CreateLinkOptions {
  readonly platform?: NodeJS.Platform;
  readonly ops?: Partial<LinkOps>;
}

/**
 * Tworzy dowiazanie `path` -> `target`, zastepujac to, co tam jest (plik albo inne dowiazanie).
 * Na POSIX dowiazanie powstaje pod nazwa tymczasowa i wchodzi przez `rename`, wiec nie ma chwili
 * bez celu; na Windowsie rename na dowiazanie jest zawodny, wiec usuwamy i tworzymy.
 */
export async function createLink(
  target: string,
  path: string,
  kind: 'file' | 'directory',
  mode: 'symlink' | 'junction',
  options: CreateLinkOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const ops = { ...DEFAULT_LINK_OPS, ...options.ops };
  const type: LinkType = mode === 'junction' ? 'junction' : kind === 'directory' ? 'dir' : 'file';
  if (platform === 'win32') {
    const existing = await lstatOrNull(path);
    if (existing !== null) {
      if (existing.isSymbolicLink() || existing.isDirectory()) await removeLink(path);
      else await rm(path, { force: true });
    }
    await ops.symlink(target, path, type);
    return;
  }
  const tmp = join(dirname(path), `.link-${process.pid}-${randomBytes(6).toString('hex')}.lnk`);
  try {
    await ops.symlink(target, tmp, type);
    await rename(tmp, path);
  } catch (error: unknown) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
