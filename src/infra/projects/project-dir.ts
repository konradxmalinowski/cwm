import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { errnoCode } from '../fs/store-error';

/**
 * Walidacja katalogu projektu (ADR 0059). Katalog wybiera uzytkownik oknem systemowym w main, ale
 * wynik okna nie jest zaufany: main sprawdza go tu, zanim trafi do rejestru, i sprawdza zapisany
 * katalog od nowa przy kazdym uzyciu.
 */

export interface ProjectDirContext {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** Katalogi konfiguracji narzedzi i danych aplikacji, jak przy zapisie archiwum (ADR 0053). */
  readonly protectedDirs: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type ProjectDirCheck =
  { readonly ok: true; readonly dir: string } | { readonly ok: false; readonly message: string };

/** Katalogi systemowe: projekt nie moze lezec w nich ani byc nimi samymi. */
const POSIX_SYSTEM_TREES = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/snap',
  '/System',
  '/Library',
  '/Applications',
  '/cores',
  '/private/etc',
];

/** Katalogi zbiorcze: same nie sa projektem, ale projekt moze lezec pod nimi (np. katalog tymczasowy). */
const POSIX_SYSTEM_EXACT = [
  '/home',
  '/Users',
  '/root',
  '/var',
  '/var/tmp',
  '/var/folders',
  '/private',
  '/private/var',
  '/private/var/folders',
  '/private/tmp',
  '/tmp',
  '/opt',
  '/srv',
  '/mnt',
  '/media',
  '/Volumes',
];

function api(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function key(value: string, platform: NodeJS.Platform): string {
  const normalized = api(platform).resolve(value);
  // Windows i domyslny APFS nie rozrozniaja wielkosci liter.
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

function inside(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const c = key(candidate, platform);
  const r = key(root, platform);
  const sep = api(platform).sep;
  return c === r || c.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

export function systemDirectories(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>> = {},
): { readonly trees: readonly string[]; readonly exact: readonly string[] } {
  if (platform !== 'win32') return { trees: POSIX_SYSTEM_TREES, exact: POSIX_SYSTEM_EXACT };
  const drive = env['SystemDrive'] ?? 'C:';
  const trees = [
    env['SystemRoot'] ?? `${drive}\\Windows`,
    env['ProgramFiles'] ?? `${drive}\\Program Files`,
    env['ProgramFiles(x86)'] ?? `${drive}\\Program Files (x86)`,
    env['ProgramData'] ?? `${drive}\\ProgramData`,
  ];
  return { trees, exact: [`${drive}\\Users`] };
}

async function realOrSelf(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return value;
  }
}

/** Katalogi z kluczami i danymi logowania w katalogu domowym: projekt nie moze w nich lezec ani ich zawierac. */
export const SENSITIVE_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.config', '.kube'] as const;

/** Punkty montowania dyskow zewnetrznych i sieciowych: projekt pod nimi jest odrzucany. */
const POSIX_MOUNT_TREES = ['/Volumes', '/mnt', '/media'];

function unc(value: string): boolean {
  return /^[\\/]{2}/.test(value);
}

/**
 * Polityka katalogu projektu (ADR 0059) na sciezce juz po `realpath`. Wspolna dla okna wyboru,
 * wczytania rejestru i kazdego uzycia projektu, wiec recznie zmieniony `projects.json` nie omija
 * zadnej z regul. Zwraca powod po polsku, bez sciezki, albo `null`.
 */
export async function projectDirPolicyProblem(
  dir: string,
  ctx: ProjectDirContext,
): Promise<string | null> {
  const { platform } = ctx;
  const p = api(platform);
  if (dir.includes('\0') || !p.isAbsolute(dir))
    return 'Ścieżka katalogu projektu jest niepoprawna.';
  if (platform === 'win32' && unc(dir)) return 'Katalog sieciowy (UNC) nie może być projektem.';
  if (p.dirname(dir) === dir) return 'Katalog główny dysku nie może być projektem.';
  if (dir.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git')) {
    return 'Katalog wewnętrzny repozytorium Git (.git) nie może być projektem. Wskaż katalog roboczy repozytorium.';
  }
  const home = await realOrSelf(ctx.home);
  if (key(dir, platform) === key(home, platform)) {
    return 'Katalog domowy nie może być projektem. Wskaż katalog repozytorium.';
  }
  if (inside(home, dir, platform)) {
    return 'Katalog, w którym leży katalog domowy, nie może być projektem.';
  }
  if (platform !== 'win32' && POSIX_MOUNT_TREES.some((m) => inside(dir, m, platform))) {
    return 'Katalog leży na dysku zewnętrznym albo zamontowanym (/Volumes, /mnt, /media). Projekty są obsługiwane tylko na dysku, na którym jest katalog domowy.';
  }
  const system = systemDirectories(platform, ctx.env ?? {});
  if (
    system.exact.some((d) => key(d, platform) === key(dir, platform)) ||
    system.trees.some((d) => inside(dir, d, platform))
  ) {
    return 'Katalog systemowy nie może być projektem.';
  }
  for (const name of SENSITIVE_HOME_DIRS) {
    const guarded = await realOrSelf(p.join(home, name));
    if (inside(dir, guarded, platform) || inside(guarded, dir, platform)) {
      return 'Katalog z kluczami albo danymi logowania (np. .ssh, .aws, .config) nie może być projektem.';
    }
  }
  for (const raw of ctx.protectedDirs) {
    const guarded = await realOrSelf(raw);
    if (inside(dir, guarded, platform) || inside(guarded, dir, platform)) {
      return 'Katalog pokrywa się z konfiguracją narzędzia albo z danymi aplikacji, więc nie może być projektem.';
    }
  }
  return null;
}

/**
 * Sprawdza katalog z okna wyboru. Zwraca `realpath` do zapisania w rejestrze albo powod odmowy po
 * polsku, bez sciezki. Sam wybrany katalog nie moze byc dowiazaniem; dowiazania wyzej w sciezce
 * (np. `/var` na macOS) sa rozwiazywane, a polityka sprawdza katalog docelowy.
 */
export async function checkChosenProjectDir(
  chosen: string,
  ctx: ProjectDirContext,
): Promise<ProjectDirCheck> {
  const { platform } = ctx;
  if (chosen.includes('\0') || !api(platform).isAbsolute(chosen)) {
    return { ok: false, message: 'Okno wyboru zwróciło niepoprawną ścieżkę katalogu.' };
  }
  if (platform === 'win32' && unc(chosen)) {
    return { ok: false, message: 'Katalog sieciowy (UNC) nie może być projektem.' };
  }
  try {
    const info = await lstat(chosen);
    if (info.isSymbolicLink()) {
      return {
        ok: false,
        message:
          'Wybrany katalog jest dowiązaniem symbolicznym. Wskaż katalog, do którego prowadzi.',
      };
    }
    if (!info.isDirectory()) return { ok: false, message: 'Wybrana pozycja nie jest katalogiem.' };
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, message: 'Wybrany katalog nie istnieje.' };
    }
    return { ok: false, message: 'Nie udało się odczytać wybranego katalogu.' };
  }
  const dir = await realOrSelf(chosen);
  const problem = await projectDirPolicyProblem(dir, ctx);
  return problem === null ? { ok: true, dir } : { ok: false, message: problem };
}

/**
 * Stan sciezki `dir/segments` bez podazania za dowiazaniami. `linked`: ktorys element (takze
 * koncowy) jest dowiazaniem symbolicznym, wiec root nie jest uzywany.
 */
/** `error`: inny blad odczytu niz brak wpisu; projekt jest wtedy traktowany jako niewazny. */
export type SegmentState = 'directory' | 'file' | 'missing' | 'linked' | 'error';

export async function probeSegments(
  dir: string,
  segments: readonly string[],
): Promise<SegmentState> {
  let current = dir;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i] ?? '');
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error: unknown) {
      const code = errnoCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
      return 'error';
    }
    if (info.isSymbolicLink()) return 'linked';
    if (i === segments.length - 1) {
      return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'missing';
    }
    if (!info.isDirectory()) return 'missing';
  }
  return 'directory';
}

/** Zapisany katalog projektu nadal jest tym samym katalogiem: istnieje, nie jest dowiazaniem, realpath sie nie zmienil. */
export async function storedProjectDirIntact(dir: string): Promise<boolean> {
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    return (await realpath(dir)) === dir;
  } catch {
    return false;
  }
}

/**
 * Synchroniczna wersja obu kontroli dla rozwiazywania `rootId` (bramka zapisu i czytnik pytaja
 * synchronicznie). Element sciezki, ktorego jeszcze nie ma, jest dozwolony: bramka go utworzy.
 */
export function projectRootIntactSync(dir: string, segments: readonly string[]): boolean {
  try {
    const info = lstatSync(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    // `realpathSync.native`, bo tak samo liczy `fs/promises.realpath`, ktorym powstal zapis w rejestrze.
    if (realpathSync.native(dir) !== dir) return false;
  } catch {
    return false;
  }
  let current = dir;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch (error: unknown) {
      const code = errnoCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return true;
      return false;
    }
  }
  return true;
}
