import { chmod, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { isPathInside } from '../../core/model/path-containment';
import { ensureDirectory, writeFileAtomic } from '../fs/atomic';
import { isProtectedName, lstatLoose, protectedSegment, realpathLoose } from './paths';
import { isInside } from './read';

/**
 * Jedyny kod CLI, ktory zapisuje na dysk. Dwa dozwolone korzenie: `~/.cwm` (`CWM_HOME`) i
 * `<projekt>/.cwm`. Zapis jest zawsze atomowy (temp + rename z `infra/fs/atomic`), a natywnych plikow
 * narzedzi (`.claude/`, `CLAUDE.md`, `.mcp.json`) nie ruszamy nigdy, nawet gdyby sciezka je wskazala.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const posix = process.platform !== 'win32';

export class WriteDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteDeniedError';
  }
}

export interface WriteScope {
  /** Katalog, poza ktory zapis nie wychodzi. */
  readonly root: string;
  /** Tylko `~/.cwm` moze byc dowiazaniem do innego miejsca (wybor uzytkownika); `<projekt>/.cwm` nie. */
  readonly allowSymlinkRoot: boolean;
}

export function homeScope(home: string): WriteScope {
  return { root: resolve(home), allowSymlinkRoot: true };
}

export function projectScope(projectDir: string): WriteScope {
  return { root: join(resolve(projectDir), '.cwm'), allowSymlinkRoot: false };
}

/** Korzen zapisu (po rozwiazaniu dowiazan) nie moze miec w sciezce chronionego segmentu. */
async function checkRoot(scope: WriteScope): Promise<string> {
  const lexical = protectedSegment(scope.root);
  if (lexical !== null) {
    throw new WriteDeniedError(`Katalog zapisu lezy w "${lexical}": ${scope.root}`);
  }
  const info = await lstatLoose(scope.root);
  if (info?.isSymbolicLink() === true && !scope.allowSymlinkRoot) {
    throw new WriteDeniedError(`${scope.root} jest dowiazaniem symbolicznym.`);
  }
  const real = await realpathLoose(scope.root);
  const resolvedSegment = protectedSegment(real);
  if (resolvedSegment !== null) {
    throw new WriteDeniedError(`Katalog zapisu wskazuje na "${resolvedSegment}": ${real}`);
  }
  return real;
}

/** Sprawdza sciezke wzgledem korzenia i zwraca ja w postaci z rozwiazanym korzeniem. */
async function checkTarget(scope: WriteScope, target: string): Promise<string> {
  const abs = resolve(target);
  const rel = relative(scope.root, abs);
  if (!isPathInside(abs, scope.root)) {
    throw new WriteDeniedError(`Zapis poza katalogiem ${scope.root}: ${abs}`);
  }
  const segments = rel.split(sep);
  for (const segment of segments) {
    if (isProtectedName(segment)) {
      throw new WriteDeniedError(`CWM nie zapisuje natywnej konfiguracji narzedzi: ${abs}`);
    }
  }

  const rootReal = await checkRoot(scope);

  // Kazdy istniejacy skladnik pod korzeniem musi byc zwyklym katalogiem (lub plikiem docelowym).
  let current = rootReal;
  for (const segment of segments) {
    current = join(current, segment);
    const info = await lstatLoose(current);
    if (info === null) break;
    if (info.isSymbolicLink()) {
      throw new WriteDeniedError(`Dowiazanie symboliczne na sciezce zapisu: ${current}`);
    }
  }
  const resolved = join(rootReal, rel);
  if (!isInside(rootReal, resolved)) throw new WriteDeniedError(`Zapis poza katalogiem: ${abs}`);
  return resolved;
}

/** Tworzy brakujace katalogi od korzenia w dol, kazdy z trybem 0700 na POSIX. */
export async function ensureScopedDirectory(scope: WriteScope, dir: string): Promise<void> {
  const rootEffective = await checkRoot(scope);
  const target = resolve(dir) === scope.root ? rootEffective : await checkTarget(scope, dir);
  const info = await lstatLoose(target);
  if (info !== null) {
    if (!info.isDirectory()) throw new WriteDeniedError(`To nie jest katalog: ${target}`);
    return;
  }
  const missing: string[] = [];
  for (let probe = target; (await lstatLoose(probe)) === null; probe = dirname(probe)) {
    missing.unshift(probe);
  }
  await ensureDirectory(target, DIR_MODE);
  // Rodzice korzenia (np. brakujace czesci CWM_HOME) tez powstaly, ale ich uprawnien nie zmieniamy.
  if (posix) {
    for (const created of missing) {
      if (isInside(rootEffective, created)) await chmod(created, DIR_MODE);
    }
  }
}

/** Zapis atomowy z trybem 0600. Istniejacy cel musi byc zwyklym plikiem; katalog nadrzedny musi istniec. */
export async function writeScopedFile(
  scope: WriteScope,
  file: string,
  text: string,
): Promise<void> {
  const target = await checkTarget(scope, file);
  const info = await lstatLoose(target);
  if (info !== null && !info.isFile()) {
    throw new WriteDeniedError(`Cel zapisu nie jest zwyklym plikiem: ${target}`);
  }
  await writeFileAtomic(target, new TextEncoder().encode(text), { mode: FILE_MODE });
}

/**
 * Katalog projektu (`create` i `attach`): nie moze miec chronionego segmentu w rzeczywistej
 * sciezce, lezec w katalogu danych CWM, byc nim ani sprawiac, ze `<katalog>/.cwm` byloby katalogiem
 * danych (np. `attach ~` przy domyslnym `~/.cwm`). Dowiazanie do katalogu jest akceptowane.
 */
export async function assertProjectDirAllowed(dir: string, home: string): Promise<string> {
  const lexical = protectedSegment(resolve(dir));
  const real = await realpathLoose(dir);
  const resolvedSegment = protectedSegment(real);
  const blocked = lexical ?? resolvedSegment;
  if (blocked !== null) {
    throw new WriteDeniedError(
      `Katalog projektu lezy w "${blocked}" (natywna konfiguracja narzedzi).`,
    );
  }
  const homeReal = await realpathLoose(home);
  if (isPathInside(real, homeReal, { allowSame: true })) {
    throw new WriteDeniedError('Projekt nie moze lezec w katalogu danych CWM ani byc nim.');
  }
  if (join(real, '.cwm') === homeReal) {
    throw new WriteDeniedError(
      'Katalog projektu zawieralby katalog danych CWM jako swoje .cwm. Ustaw CWM_HOME gdzie indziej.',
    );
  }
  return real;
}

/** Tworzy katalog projektu (`cwm project create`) z domyslnymi uprawnieniami: to katalog uzytkownika. */
export async function createProjectDirectory(dir: string, home: string): Promise<void> {
  await assertProjectDirAllowed(dir, home);
  const abs = resolve(dir);
  if ((await lstatLoose(abs)) !== null) return;
  await mkdir(abs, { recursive: true });
  // realpath potwierdza, ze utworzony katalog nie wyladowal przez dowiazanie w chronionym miejscu.
  const real = await realpath(abs);
  if (protectedSegment(real) !== null)
    throw new WriteDeniedError('Katalog projektu w chronionym miejscu.');
}
