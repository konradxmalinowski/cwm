import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { isPathInside } from '../../core/model/path-containment';
import { readChecked } from '../fs/bounded-read';
import { lstatLoose } from './paths';
import { readDirLimited } from './read';

/** Odczyt zrodel zasobow do generowania profilu. Tylko odczyt: zadnych zapisow i procesow. */

export const TREE_LIMITS = {
  fileBytes: 1024 * 1024,
  files: 500,
  bytes: 10 * 1024 * 1024,
  depth: 16,
} as const;

export interface TreeFile {
  readonly rel: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

export type TreeRead =
  | { readonly ok: true; readonly files: TreeFile[] }
  | { readonly ok: false; readonly message: string };

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

const byRel = (a: { readonly rel: string }, b: { readonly rel: string }): number =>
  a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;

/** Skrot drzewa: sciezka, bit wykonywania i skrot tresci, w kolejnosci sciezek (APR-03). */
export function treeSha256(files: readonly TreeFile[]): string {
  const lines = [...files]
    .sort(byRel)
    .map((file) => `${file.rel}\0${file.executable ? 1 : 0}\0${sha256Hex(file.bytes)}\n`);
  return sha256Hex(lines.join(''));
}

/**
 * Drzewo plikow katalogu: tylko zwykle pliki. Dowiazanie, plik specjalny, nazwa rozniaca sie od
 * innej tylko wielkoscia liter albo przekroczony limit to blad, nie pominiecie (APR-03).
 */
export async function readTree(
  root: string,
  skip: (rel: string) => boolean = () => false,
): Promise<TreeRead> {
  const files: TreeFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  const stack = [{ dir: root, rel: '', depth: 0 }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    let listing: Awaited<ReturnType<typeof readDirLimited>>;
    try {
      listing = await readDirLimited(frame.dir);
    } catch {
      return { ok: false, message: 'katalog nieczytelny' };
    }
    if (listing.truncated) return { ok: false, message: 'za duzo wpisow w jednym katalogu' };
    for (const entry of listing.entries) {
      const rel = frame.rel === '' ? entry.name : `${frame.rel}/${entry.name}`;
      if (skip(rel)) continue;
      if (entry.isSymbolicLink()) return { ok: false, message: `dowiazanie w drzewie: ${rel}` };
      if (entry.isDirectory()) {
        if (frame.depth + 1 > TREE_LIMITS.depth)
          return { ok: false, message: 'drzewo zbyt gleboke' };
        stack.push({ dir: join(frame.dir, entry.name), rel, depth: frame.depth + 1 });
        continue;
      }
      if (!entry.isFile()) return { ok: false, message: `nie jest zwyklym plikiem: ${rel}` };
      const folded = rel.normalize('NFC').toLowerCase();
      if (seen.has(folded)) return { ok: false, message: `kolizja wielkosci liter: ${rel}` };
      seen.add(folded);
      if (files.length >= TREE_LIMITS.files) return { ok: false, message: 'wiecej niz 500 plikow' };
      const path = join(frame.dir, entry.name);
      const info = await lstatLoose(path);
      const read = await readChecked(path, TREE_LIMITS.fileBytes, { strict: true });
      if (info === null || read.kind !== 'ok')
        return { ok: false, message: `nieczytelny plik: ${rel}` };
      total += read.bytes.length;
      if (total > TREE_LIMITS.bytes) return { ok: false, message: 'drzewo wieksze niz 10 MiB' };
      files.push({ rel, bytes: read.bytes, executable: (info.mode & 0o100) !== 0 });
    }
  }
  return { ok: true, files: files.sort(byRel) };
}

/** `sha256` zwyklego pliku albo null (brak, dowiazanie, za duzy). */
export async function fileSha256(path: string, limit = 1024 * 1024): Promise<string | null> {
  try {
    const read = await readChecked(path, limit, { strict: true });
    return read.kind === 'ok' ? sha256Hex(read.bytes) : null;
  } catch {
    return null;
  }
}

/** Plik zrodlowy zasobu (do 1 MiB) pod `base`: sciezka po `realpath` musi lezec w `base`. Null, gdy go nie ma. */
export async function readSourceFile(base: string, relative: string): Promise<Uint8Array | null> {
  const real = await realInside(base, relative);
  if (real === null) return null;
  const read = await readChecked(real, TREE_LIMITS.fileBytes, { strict: true }).catch(() => null);
  return read?.kind === 'ok' ? read.bytes : null;
}

/** Katalog wewnatrz `base` po `realpath`; null, gdy nie istnieje albo wychodzi dowiazaniem. */
export async function realInside(base: string, relative: string): Promise<string | null> {
  try {
    const target = await realpath(resolve(base, relative));
    const root = await realpath(base);
    return isPathInside(target, root, { allowSame: true }) ? target : null;
  } catch {
    return null;
  }
}

const IGNORED_CHILDREN = new Set(['node_modules', '.git', 'dist', 'target', 'build']);
const MAX_CHILD_DIRS = 200;

/** Wartosci `--add-dir` z argumentow uzytkownika (forma `=` i lista wartosci do nastepnej opcji). */
export function addDirsFromArgs(args: readonly string[], cwd: string): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg.startsWith('--add-dir=')) dirs.push(arg.slice('--add-dir='.length));
    else if (arg === '--add-dir') {
      for (let j = i + 1; j < args.length && !(args[j] ?? '').startsWith('-'); j += 1) {
        dirs.push(args[j] ?? '');
      }
    }
  }
  return dirs.filter((d) => d !== '').map((d) => (isAbsolute(d) ? d : resolve(cwd, d)));
}

/** Katalogi, w ktorych natywne `.claude/` projektu moze zasloniec zasob z profilu (PRF-07). */
async function shadowRoots(projectDir: string, addDirs: readonly string[]): Promise<string[]> {
  const roots = new Set<string>();
  let current = projectDir;
  for (;;) {
    roots.add(current);
    const gitRoot = (await lstatLoose(join(current, '.git'))) !== null;
    const parent = dirname(current);
    if (gitRoot || parent === current) break;
    current = parent;
  }
  for (const dir of addDirs) roots.add(dir);
  const children: string[] = [];
  try {
    const top = await readDirLimited(projectDir, MAX_CHILD_DIRS);
    for (const entry of top.entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORED_CHILDREN.has(entry.name))
        continue;
      const child = join(projectDir, entry.name);
      children.push(child);
      const nested = await readDirLimited(child, MAX_CHILD_DIRS).catch(() => null);
      for (const sub of nested?.entries ?? []) {
        if (sub.isDirectory() && !sub.name.startsWith('.') && !IGNORED_CHILDREN.has(sub.name)) {
          children.push(join(child, sub.name));
        }
      }
    }
  } catch {
    // Brak odczytu katalogu projektu nie blokuje wykrywania w pozostalych miejscach.
  }
  for (const child of children.slice(0, MAX_CHILD_DIRS)) roots.add(child);
  return [...roots];
}

export interface ProfileNames {
  readonly skills: readonly string[];
  readonly agents: readonly string[];
  readonly commands: readonly string[];
}

/** Zasoby z profilu (zwykle nazwy) zaslaniane albo zaslaniajace wpisy z `.claude/` projektu. */
export async function findShadowing(
  projectDir: string,
  addDirs: readonly string[],
  names: ProfileNames,
): Promise<string[]> {
  const found: string[] = [];
  for (const root of await shadowRoots(projectDir, addDirs)) {
    const base = join(root, '.claude');
    if ((await lstatLoose(base).catch(() => null)) === null) continue;
    const checks: [string, string, string][] = [
      ...names.skills.map((n): [string, string, string] => ['skill', n, join(base, 'skills', n)]),
      ...names.agents.map((n): [string, string, string] => [
        'agent',
        n,
        join(base, 'agents', `${n}.md`),
      ]),
      ...names.commands.map((n): [string, string, string] => [
        'command',
        n,
        join(base, 'commands', `${n}.md`),
      ]),
    ];
    for (const [kind, name, path] of checks) {
      if ((await lstatLoose(path).catch(() => null)) !== null)
        found.push(`${kind} ${name} (${root})`);
    }
  }
  return found;
}

/** SHA-256 pliku czytanego strumieniowo, bez limitu rozmiaru (plik polecenia MCP bywa duzym binarium). */
export async function hashFileStreaming(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export type CommandPin =
  | { readonly ok: true; readonly path: string; readonly sha256: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Przypiecie pliku polecenia MCP (SEC-01). Polecenie wzgledne jest rozwiazywane wzgledem projektu,
 * a po `realpath` cel musi lezec w projekcie (dowiazanie na zewnatrz to odmowa); bezwzgledne moze
 * wskazywac gdziekolwiek, ale tez jest haszowane po `realpath`. Brak pliku, katalog albo blad odczytu
 * to odmowa: pole nigdy nie dostaje skrotu `null`.
 */
export async function pinMcpCommand(command: string, projectDir: string): Promise<CommandPin> {
  const absolutePath = isAbsolute(command);
  try {
    const target = await realpath(absolutePath ? command : resolve(projectDir, command));
    if (!absolutePath) {
      const root = await realpath(projectDir);
      if (!isPathInside(target, root)) {
        return { ok: false, reason: 'polecenie wzgledne wskazuje poza katalog projektu' };
      }
    }
    if (!(await stat(target)).isFile()) return { ok: false, reason: 'polecenie nie jest plikiem' };
    return { ok: true, path: target, sha256: await hashFileStreaming(target) };
  } catch {
    return { ok: false, reason: 'plik polecenia nie istnieje albo jest nieczytelny' };
  }
}
