import { constants } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { HASH16, HASH64, validateCleanupPath } from '../../core/cwm';
import { isPathInside } from '../../core/model/path-containment';
import { writeFileAtomic } from '../fs/atomic';
import { readChecked } from '../fs/bounded-read';
import { errnoCode } from '../fs/store-error';
import { isSafeSegment, type CwmLayout } from './layout';
import { lstatLoose, protectedSegment, realpathLoose } from './paths';
import { WriteDeniedError } from './writer';

/**
 * Jedyne miejsce, ktore zapisuje i usuwa pliki w `~/.cwm/runtime/<firma>` (PRF-04). Zapis tylko
 * pod korzeniem firmy, tylko po sciezkach z listy dozwolonych (`validateCleanupPath`), bez
 * dowiazan na calej sciezce, z wlascicielem rownym biezacemu uzytkownikowi i trybami 0700/0600.
 * Usuwanie to `lstat` + `unlink` zwyklych plikow i `rmdir` pustych katalogow, nigdy `rm -r`.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const posix = process.platform !== 'win32';

export interface RuntimeRoot {
  readonly company: string;
  /** `runtime/<firma>` po `realpath`. */
  readonly dir: string;
}

/** Stale nazwy poza lista manifestu: manifest, kopie, blokada, znaczniki sesji, katalog tymczasowy. */
const INTERNAL = {
  manifest: 'generated/manifest.json',
  prev: 'generated/prev',
  mutex: '.lock',
  active: 'active',
  tmp: 'tmp',
} as const;

export function runtimeCompanyDir(layout: CwmLayout, company: string): string {
  if (!isSafeSegment(company)) throw new WriteDeniedError('Niedozwolone id firmy.');
  return join(layout.runtimeDir, company);
}

function ownedByUser(uid: number): boolean {
  return !posix || typeof process.getuid !== 'function' || uid === process.getuid();
}

async function ensureOwnedDir(dir: string): Promise<void> {
  const info = await lstatLoose(dir);
  if (info === null) {
    await mkdir(dir, { mode: DIR_MODE });
    if (posix) await chmod(dir, DIR_MODE);
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new WriteDeniedError(`To nie jest zwykly katalog: ${dir}`);
  }
  if (!ownedByUser(info.uid)) throw new WriteDeniedError(`Katalog ma innego wlasciciela: ${dir}`);
  if (posix && (info.mode & 0o077) !== 0) {
    throw new WriteDeniedError(`Katalog ma zbyt szerokie uprawnienia (wymagane 0700): ${dir}`);
  }
}

/** Tworzy `runtime/` i `runtime/<firma>` i sprawdza wlasciciela oraz tryb 0700 (PRF-06). */
export async function openRuntimeRoot(layout: CwmLayout, company: string): Promise<RuntimeRoot> {
  const wanted = runtimeCompanyDir(layout, company);
  const homeReal = await realpathLoose(layout.home);
  const lexical = protectedSegment(wanted) ?? protectedSegment(homeReal);
  if (lexical !== null) throw new WriteDeniedError(`Katalog runtime lezy w "${lexical}".`);
  await ensureOwnedDir(layout.runtimeDir);
  await ensureOwnedDir(wanted);
  const dir = await realpath(wanted);
  if (!isPathInside(dir, homeReal))
    throw new WriteDeniedError('Katalog runtime wychodzi poza dane CWM.');
  return { company, dir };
}

/** Odczyt stanu bez tworzenia czegokolwiek: null, gdy katalogu firmy jeszcze nie ma. */
export async function peekRuntimeRoot(
  layout: CwmLayout,
  company: string,
): Promise<RuntimeRoot | null> {
  const wanted = runtimeCompanyDir(layout, company);
  const info = await lstatLoose(wanted);
  if (info === null) return null;
  if (info.isSymbolicLink() || !info.isDirectory() || !ownedByUser(info.uid)) {
    throw new WriteDeniedError(`Niebezpieczny katalog runtime: ${wanted}`);
  }
  return { company, dir: await realpath(wanted) };
}

/** Segmenty katalogow od korzenia do `rel` (bez pliku), kazdy sprawdzony i w razie potrzeby utworzony. */
async function ensureParents(root: RuntimeRoot, rel: string, create: boolean): Promise<boolean> {
  const parts = rel.split('/').slice(0, -1);
  let current = root.dir;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstatLoose(current);
    if (info === null) {
      if (!create) return false;
      await mkdir(current, { mode: DIR_MODE });
      if (posix) await chmod(current, DIR_MODE);
    } else if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new WriteDeniedError(`Dowiazanie lub nie-katalog na sciezce runtime: ${part}`);
    }
  }
  return true;
}

function checkedRel(rel: string): string {
  const check = validateCleanupPath(rel);
  if (!check.ok) throw new WriteDeniedError(`Sciezka runtime odrzucona (${check.reason}).`);
  return rel;
}

function absolute(root: RuntimeRoot, rel: string): string {
  const abs = resolve(root.dir, ...rel.split('/'));
  if (!isPathInside(abs, root.dir))
    throw new WriteDeniedError('Sciezka wychodzi poza katalog firmy.');
  return abs;
}

export async function ensureRuntimeDirs(root: RuntimeRoot, dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) await ensureParents(root, `${dir}/x`, true);
}

export async function writeRuntimeFile(
  root: RuntimeRoot,
  rel: string,
  bytes: Uint8Array,
  executable = false,
): Promise<void> {
  checkedRel(rel);
  await ensureParents(root, rel, true);
  const target = absolute(root, rel);
  const info = await lstatLoose(target);
  if (info !== null && !info.isFile()) {
    throw new WriteDeniedError(`Cel zapisu nie jest zwyklym plikiem: ${rel}`);
  }
  await writeFileAtomic(target, bytes, { mode: executable ? 0o700 : FILE_MODE });
}

export type RuntimeRead =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array; readonly mode: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsafe' };

async function readAt(root: RuntimeRoot, rel: string, create: false): Promise<RuntimeRead> {
  try {
    if (!(await ensureParents(root, rel, create))) return { kind: 'missing' };
  } catch (error: unknown) {
    if (error instanceof WriteDeniedError) return { kind: 'unsafe' };
    throw error;
  }
  const target = absolute(root, rel);
  const read = await readChecked(target, MAX_FILE_BYTES, { strict: true });
  switch (read.kind) {
    case 'missing':
      return { kind: 'missing' };
    case 'ok': {
      const info = await lstatLoose(target);
      return info === null
        ? { kind: 'missing' }
        : { kind: 'ok', bytes: read.bytes, mode: info.mode & 0o777 };
    }
    default:
      return { kind: 'unsafe' };
  }
}

export function readRuntimeFile(root: RuntimeRoot, rel: string): Promise<RuntimeRead> {
  return readAt(root, checkedRel(rel), false);
}

/** `lstat` + `unlink` zwyklego pliku; brak pliku to sukces, dowiazanie albo katalog to odmowa. */
export async function removeRuntimeFile(root: RuntimeRoot, rel: string): Promise<boolean> {
  checkedRel(rel);
  if (!(await ensureParents(root, rel, false))) return false;
  const target = absolute(root, rel);
  const info = await lstatLoose(target);
  if (info === null) return false;
  if (!info.isFile()) throw new WriteDeniedError(`Nie usuwam: to nie jest zwykly plik (${rel}).`);
  await unlink(target);
  return true;
}

/** `rmdir` pustych katalogow od `rel` w gore, do (bez) katalogu `stopAt` wlacznie z nazwami nadrzednymi. */
export async function pruneEmptyDirs(root: RuntimeRoot, rel: string): Promise<void> {
  const parts = rel.split('/').slice(0, -1);
  // `claude/<rodzaj>` i `sessions/<skrot>` zostaja; pusta migawka `plugins/<slug>` znika razem z plikami.
  const floor = parts[0] === 'plugins' ? 1 : 2;
  while (parts.length > floor) {
    const current = join(root.dir, ...parts);
    try {
      if ((await readdir(current)).length > 0) return;
      await rmdir(current);
    } catch {
      return;
    }
    parts.pop();
  }
}

export const MANIFEST_REL = INTERNAL.manifest;

export async function writeManifestText(root: RuntimeRoot, text: string): Promise<void> {
  await ensureParents(root, INTERNAL.manifest, true);
  await writeFileAtomic(absolute(root, INTERNAL.manifest), new TextEncoder().encode(text), {
    mode: FILE_MODE,
  });
}

export async function readManifestText(root: RuntimeRoot): Promise<string | null> {
  const read = await readAt(root, INTERNAL.manifest, false);
  if (read.kind === 'missing') return null;
  if (read.kind === 'unsafe')
    throw new WriteDeniedError('Manifest generowania jest niebezpieczny.');
  return new TextDecoder('utf-8', { fatal: false }).decode(read.bytes);
}

export async function removeManifest(root: RuntimeRoot): Promise<void> {
  const target = absolute(root, INTERNAL.manifest);
  if ((await lstatLoose(target)) !== null) await unlink(target);
}

/** Kopia przed zmiana (PRF-03): `generated/prev/<rel>`. Jedna kopia, wymieniana przy kazdym generowaniu. */
export async function backupFile(root: RuntimeRoot, rel: string, bytes: Uint8Array): Promise<void> {
  const target = `${INTERNAL.prev}/${rel}`;
  await ensureParents(root, target, true);
  await writeFileAtomic(absolute(root, target), bytes, { mode: FILE_MODE });
}

/** Kopia pliku, ktorego tresc CWM zmienia przy odwolaniu: `generated/revoked/<rel>` (nie jest czyszczona przy generowaniu). */
export async function backupRevoked(
  root: RuntimeRoot,
  rel: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = `generated/revoked/${rel}`;
  await ensureParents(root, target, true);
  await writeFileAtomic(absolute(root, target), bytes, { mode: FILE_MODE });
}

export async function readBackup(root: RuntimeRoot, rel: string): Promise<RuntimeRead> {
  return readAt(root, `${INTERNAL.prev}/${rel}`, false);
}

/** Czysci `generated/prev`: tylko zwykle pliki i puste katalogi, bez podazania za dowiazaniami. */
export async function clearBackups(root: RuntimeRoot): Promise<void> {
  const base = absolute(root, INTERNAL.prev);
  const walk = async (dir: string): Promise<void> => {
    const info = await lstatLoose(dir);
    if (info === null) return;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new WriteDeniedError('Katalog kopii zawiera dowiazanie lub nie-katalog.');
    }
    for (const name of await readdir(dir)) {
      const child = join(dir, name);
      const childInfo = await lstatLoose(child);
      if (childInfo === null) continue;
      if (childInfo.isDirectory() && !childInfo.isSymbolicLink()) await walk(child);
      else await unlink(child);
    }
    if (dir !== base) await rmdir(dir);
  };
  await walk(base);
}

/** Pusty katalog tymczasowy 0700 (mkdtemp) na probe `claude --version`; `parent` musi byc katalogiem uzytkownika. */
export async function makeScratchDir(parent: string): Promise<string> {
  const dir = await mkdtemp(join(parent, 'cwm-probe-'));
  if (posix) await chmod(dir, DIR_MODE);
  return dir;
}

export async function removeScratchDir(dir: string): Promise<void> {
  if (!dir.includes('cwm-probe-')) throw new WriteDeniedError('To nie jest katalog proby.');
  await rm(dir, { recursive: true, force: true });
}

export async function tmpDirFor(root: RuntimeRoot): Promise<string> {
  await ensureRuntimeDirs(root, [INTERNAL.tmp]);
  return absolute(root, INTERNAL.tmp);
}

export function absoluteIn(root: RuntimeRoot, rel: string): string {
  return absolute(root, checkedRel(rel));
}

export function profileDir(root: RuntimeRoot): string {
  return join(root.dir, 'claude');
}

export async function ensureProfileDir(root: RuntimeRoot): Promise<string> {
  await ensureRuntimeDirs(root, ['claude']);
  return profileDir(root);
}

// ---------------------------------------------------------------------------------------------
// Blokada (PRF-01, wariant minimalny): krotkotrwaly mutex na czas generowania oraz znaczniki zywych
// sesji. Mutex to plik O_EXCL z PID; martwy PID (ESRCH) oznacza przejety zamek.

export interface MutexBody {
  readonly pid: number;
  readonly startedAt: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errnoCode(error) === 'EPERM';
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function asBody(value: unknown): MutexBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const { pid, startedAt } = value as Record<string, unknown>;
  return Number.isInteger(pid) && typeof startedAt === 'string'
    ? { pid: pid as number, startedAt }
    : null;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
/** Pusty albo nieczytelny zamek mlodszy niz to jest trzymany (ktos wlasnie go tworzy). */
const FRESH_LOCK_MS = 10_000;

type LockState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'held' }
  | { readonly kind: 'stale'; readonly pid: number | null };

async function lockState(file: string): Promise<LockState> {
  const info = await lstatLoose(file);
  if (info === null) return { kind: 'missing' };
  if (!info.isFile()) throw new WriteDeniedError('Plik blokady nie jest zwyklym plikiem.');
  const read = await readChecked(file, 4096).catch(() => null);
  if (read?.kind === 'missing') return { kind: 'missing' };
  const body = read?.kind === 'ok' ? asBody(parseJson(read.bytes)) : null;
  if (body === null) {
    return Date.now() - info.mtimeMs < FRESH_LOCK_MS
      ? { kind: 'held' }
      : { kind: 'stale', pid: null };
  }
  return pidAlive(body.pid) ? { kind: 'held' } : { kind: 'stale', pid: body.pid };
}

/**
 * Tworzy zamek atomowo (SEC-08): tresc trafia do pliku tymczasowego, a `link()` publikuje go pod
 * nazwa zamka tylko wtedy, gdy ta nie istnieje. Zamek nigdy nie jest widoczny pusty.
 */
async function publishLock(dir: string, file: string, body: MutexBody): Promise<boolean> {
  const temp = join(dir, `.lock.${process.pid}.${Math.random().toString(16).slice(2, 10)}`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    FILE_MODE,
  );
  try {
    await handle.writeFile(JSON.stringify(body));
  } finally {
    await handle.close();
  }
  try {
    await link(temp, file);
    return true;
  } catch (error: unknown) {
    if (errnoCode(error) === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/**
 * Przejecie nieaktualnego zamka pod strazniczym plikiem O_EXCL: stan jest sprawdzany ponownie
 * juz po zdobyciu straznika, wiec dwaj czekajacy nie usuna po sobie swiezego zamka.
 */
async function takeOverStale(dir: string, file: string): Promise<void> {
  const guard = join(dir, '.lock.guard');
  try {
    const handle = await open(
      guard,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      FILE_MODE,
    );
    await handle.close();
  } catch (error: unknown) {
    if (errnoCode(error) !== 'EEXIST') throw error;
    const info = await lstatLoose(guard);
    if (info !== null && Date.now() - info.mtimeMs > FRESH_LOCK_MS)
      await unlink(guard).catch(() => undefined);
    return;
  }
  try {
    if ((await lockState(file)).kind === 'stale') await unlink(file).catch(() => undefined);
  } finally {
    await unlink(guard).catch(() => undefined);
  }
}

export async function acquireMutex(root: RuntimeRoot, waitMs = 5000): Promise<() => Promise<void>> {
  const file = join(root.dir, INTERNAL.mutex);
  const body: MutexBody = { pid: process.pid, startedAt: new Date().toISOString() };
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await publishLock(root.dir, file, body)) {
      return async () => {
        const read = await readChecked(file, 4096).catch(() => null);
        const held = read?.kind === 'ok' ? asBody(parseJson(read.bytes)) : null;
        if (held?.pid === process.pid && held.startedAt === body.startedAt) {
          await unlink(file).catch(() => undefined);
        }
      };
    }
    const state = await lockState(file);
    if (state.kind === 'stale') {
      await takeOverStale(root.dir, file);
      continue;
    }
    if (state.kind === 'missing') continue;
    if (Date.now() > deadline) {
      throw new WriteDeniedError('Inny proces cwm generuje profil tej firmy. Sprobuj za chwile.');
    }
    await sleep(100);
  }
}

export interface SessionMarker {
  readonly pid: number;
  readonly startedAt: string;
  readonly profileHash: string;
  readonly projectHash: string;
  readonly sessionHash: string;
  readonly project: string;
  /** PID procesu silnika (SEC-07): sesja zyje, dopoki zyje `pid` albo `childPid`. */
  readonly childPid?: number;
  /** Migawki pluginow uzywane przez sesje (`<slug>@<skrot>`), chronione przed sprzataniem (SEC-15). */
  readonly plugins?: readonly string[];
}

function asMarker(value: unknown): SessionMarker | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const keys = [
    'pid',
    'startedAt',
    'profileHash',
    'projectHash',
    'sessionHash',
    'project',
    'childPid',
    'plugins',
  ];
  if (Object.keys(v).some((key) => !keys.includes(key))) return null;
  if (
    !Number.isInteger(v['pid']) ||
    typeof v['startedAt'] !== 'string' ||
    typeof v['profileHash'] !== 'string' ||
    !HASH64.test(v['profileHash']) ||
    typeof v['sessionHash'] !== 'string' ||
    !HASH64.test(v['sessionHash']) ||
    typeof v['projectHash'] !== 'string' ||
    !HASH16.test(v['projectHash']) ||
    typeof v['project'] !== 'string' ||
    (v['childPid'] !== undefined && !Number.isInteger(v['childPid'])) ||
    (v['plugins'] !== undefined &&
      !(Array.isArray(v['plugins']) && v['plugins'].every((p) => typeof p === 'string')))
  ) {
    return null;
  }
  return v as unknown as SessionMarker;
}

function markerRel(pid: number): string {
  return `${INTERNAL.active}/${pid}.json`;
}

export async function writeSessionMarker(root: RuntimeRoot, marker: SessionMarker): Promise<void> {
  const rel = markerRel(marker.pid);
  await ensureParents(root, rel, true);
  await writeFileAtomic(absolute(root, rel), new TextEncoder().encode(JSON.stringify(marker)), {
    mode: FILE_MODE,
  });
}

export async function removeSessionMarker(root: RuntimeRoot, pid: number): Promise<void> {
  await unlink(absolute(root, markerRel(pid))).catch(() => undefined);
}

/** Zywe sesje firmy. Znaczniki martwych procesow i uszkodzone znaczniki sa usuwane, gdy `prune` jest true. */
export async function liveSessions(root: RuntimeRoot, prune: boolean): Promise<SessionMarker[]> {
  const dir = absolute(root, INTERNAL.active);
  const info = await lstatLoose(dir);
  if (info === null) return [];
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new WriteDeniedError('Katalog znacznikow sesji jest niebezpieczny.');
  }
  const live: SessionMarker[] = [];
  for (const name of (await readdir(dir)).slice(0, 1000)) {
    const file = join(dir, name);
    const read = await readChecked(file, 8192).catch(() => null);
    const marker = read?.kind === 'ok' ? asMarker(parseJson(read.bytes)) : null;
    if (
      marker !== null &&
      (pidAlive(marker.pid) || (marker.childPid !== undefined && pidAlive(marker.childPid)))
    ) {
      live.push(marker);
    } else if (prune) await unlink(file).catch(() => undefined);
  }
  return live.sort((a, b) => a.pid - b.pid);
}
