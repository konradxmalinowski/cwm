import { randomBytes } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import {
  chmodSync,
  closeSync,
  cpSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { DataMigrationInfo } from '../../core/model/data-migration';

export const USER_DATA_DIR_NAME = 'CWM';
/** Zapakowana v0.1.0 uzywa productName, uruchomienie ze zrodel nazwy pakietu. */
export const LEGACY_USER_DATA_DIR_NAMES = [
  'Universal AI Skills Manager',
  'universal-ai-skills-manager',
] as const;

export const MIGRATION_MARKER = '.cwm-migration';

const TEMP_PREFIX = `${USER_DATA_DIR_NAME}.migrating-`;
const LOCK_NAME = `${USER_DATA_DIR_NAME}.migrating.lock`;
const STALE_MS = 60 * 60 * 1000;

/** Wpisy, ktore robia z katalogu dane aplikacji. Cache Chromium i pliki blokad sie nie licza. */
const APP_DATA_ENTRIES = [
  'index.db',
  'library',
  'objects',
  'backups',
  'materialized',
  'root-salt',
  MIGRATION_MARKER,
];

/** Blokady Chromium: kopia zywej blokady z v0.1.0 mogla by zablokowac start nowej wersji. */
const SKIPPED_TOP_LEVEL = new Set([
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'lockfile',
]);

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'nieznany';
}

/** Najnowszy mtime drzewa (bez podazania za dowiazaniami) albo `null`, gdy `library/` jest pusty. */
function newestMtimeOfNonEmptyLibrary(dir: string): number | null {
  const library = join(dir, 'library');
  const root = statOrNull(library);
  if (root === null || !root.isDirectory()) return null;
  let newest: number | null = null;
  const stack = [library];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries: Dirent[] = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      const stat = lstatSync(full);
      newest = Math.max(newest ?? 0, stat.mtimeMs);
      if (stat.isDirectory()) stack.push(full);
    }
  }
  return newest;
}

/**
 * Kandydat kwalifikuje sie tylko z niepusta biblioteka (sam `index.db` nie wystarcza: indeks
 * odtwarza sie z plikow). Gdy kwalifikuje sie kilku, wygrywa ten z nowszym drzewem biblioteki.
 */
function pickLegacy(appData: string): string | null {
  let best: { name: string; mtime: number } | null = null;
  for (const name of LEGACY_USER_DATA_DIR_NAMES) {
    const mtime = newestMtimeOfNonEmptyLibrary(join(appData, name));
    if (mtime !== null && (best === null || mtime > best.mtime)) best = { name, mtime };
  }
  return best?.name ?? null;
}

/** Nowy katalog jest wolny, gdy go nie ma albo nie ma w nim zadnych danych aplikacji. */
function targetIsFree(target: string): boolean {
  const stat = statOrNull(target);
  if (stat === null) return true;
  if (!stat.isDirectory()) return false;
  return APP_DATA_ENTRIES.every((name) => statOrNull(join(target, name)) === null);
}

/**
 * Czy v0.1.0 dziala na tym katalogu. POSIX: `SingletonLock` to dowiazanie `host-pid`, zywy pid
 * znaczy uruchomiona instancje. Windows: Chromium trzyma `lockfile` otwarty bez wspoldzielenia,
 * wiec proba otwarcia konczy sie EBUSY. Ta galaz nie byla sprawdzona na Windowsie.
 */
function legacyIsRunning(legacy: string): boolean {
  if (process.platform === 'win32') {
    try {
      closeSync(openSync(join(legacy, 'lockfile'), 'r'));
      return false;
    } catch (error) {
      return errnoCode(error) === 'EBUSY';
    }
  }
  let linkTarget: string;
  try {
    linkTarget = readlinkSync(join(legacy, 'SingletonLock'));
  } catch {
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(linkTarget)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === 'EPERM';
  }
}

/** `true`: blokada nalezy do nas. `false`: ktos inny migruje (swieza blokada). */
function acquireLock(lock: string): boolean {
  try {
    mkdirSync(lock);
    return true;
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error;
  }
  const stat = statOrNull(lock);
  if (stat !== null && Date.now() - stat.mtimeMs < STALE_MS) return false;
  rmSync(lock, { recursive: true, force: true });
  try {
    mkdirSync(lock);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return false;
    throw error;
  }
}

function releaseLock(lock: string): void {
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch {
    // Zostawiona blokada wygasa po godzinie.
  }
}

/** Usuwa wlasne katalogi tymczasowe oraz cudze starsze niz godzina. */
function sweepTemps(appData: string): void {
  const own = `${TEMP_PREFIX}${process.pid}-`;
  for (const name of readdirSync(appData)) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const full = join(appData, name);
    const stat = statOrNull(full);
    if (name.startsWith(own) || (stat !== null && Date.now() - stat.mtimeMs > STALE_MS)) {
      rmSync(full, { recursive: true, force: true });
    }
  }
}

/**
 * Kopiuje katalog danych v0.1.0 (`LEGACY_USER_DATA_DIR_NAMES`) do `<appData>/CWM` (ADR 0035).
 * Albo sie udaje, albo aplikacja nie rusza dalej i mowi dlaczego: kopia idzie do katalogu
 * tymczasowego obok, na miejsce trafia jednym `rename`, a stare dane nigdy nie sa zmieniane,
 * wiec nastepny start ponawia probe. Wylacznosc daje blokada `CWM.migrating.lock`. Kopia jest
 * synchroniczna, bo musi skonczyc sie przed `requestSingleInstanceLock`; przy bardzo duzej
 * bibliotece potrwa to dluzej. Dowiazania zostaja dowiazaniami. Nie rzuca wyjatkow.
 */
export function migrateLegacyUserData(appData: string): DataMigrationInfo {
  const target = join(appData, USER_DATA_DIR_NAME);
  const lock = join(appData, LOCK_NAME);
  const temp = join(appData, `${TEMP_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    const source = pickLegacy(appData);
    if (source === null || !targetIsFree(target)) return { outcome: 'none' };
    const legacy = join(appData, source);
    if (legacyIsRunning(legacy)) {
      return {
        outcome: 'deferred',
        message: 'Starsza wersja aplikacji jest uruchomiona, więc dane nie zostały przeniesione.',
      };
    }
    if (!acquireLock(lock)) return { outcome: 'busy' };
    try {
      if (!targetIsFree(target)) return { outcome: 'none' };
      sweepTemps(appData);
      cpSync(legacy, temp, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        force: false,
        errorOnExist: true,
        filter: (entry) =>
          !(dirname(entry) === legacy && SKIPPED_TOP_LEVEL.has(entry.slice(legacy.length + 1))),
      });
      writeFileSync(
        join(temp, MIGRATION_MARKER),
        `${JSON.stringify({ source, migratedAt: new Date().toISOString(), outcome: 'migrated' })}\n`,
        { mode: 0o600 },
      );
      if (process.platform !== 'win32') chmodSync(temp, 0o700);
      // Wolny katalog docelowy trzyma tylko cache Chromium; rename nie zastapi niepustego.
      rmSync(target, { recursive: true, force: true });
      renameSync(temp, target);
      return { outcome: 'migrated', source };
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      throw error;
    } finally {
      releaseLock(lock);
    }
  } catch (error) {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      // Osierocony katalog tymczasowy sprzata sweepTemps przy kolejnej probie.
    }
    const code = errnoCode(error);
    return {
      outcome: 'failed',
      errorCode: code,
      message: `Nie udało się przenieść danych z poprzedniej wersji (kod błędu: ${code}). Stare dane nie zostały zmienione.`,
    };
  }
}

/** Zapisuje wybor uzytkownika "zacznij z pusta biblioteka"; od tej chwili katalog nie jest wolny. */
export function markMigrationSkipped(userDataDir: string): void {
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(userDataDir, MIGRATION_MARKER),
    `${JSON.stringify({ migratedAt: new Date().toISOString(), outcome: 'skipped' })}\n`,
    { mode: 0o600 },
  );
}
