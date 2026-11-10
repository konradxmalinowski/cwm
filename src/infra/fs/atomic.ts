import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { CodedStoreError, StoreFailureCode } from '../../core/ports/store-failure';

import { errnoCode, failureCodeFromErrno, type FsOperation } from './store-error';

export { errnoCode };

/**
 * Prymityw zapisu atomowego (ADR 0012 kroki 3 i 4, ADR 0031). Uzywa go zapis biblioteki,
 * a w Etapie 5 uzyje go `WriteGate`: jeden kod, jeden zestaw testow.
 */

export type AtomicWriteFailure =
  | 'permission-denied'
  | 'read-only'
  | 'no-space'
  | 'busy'
  | 'missing-directory'
  | 'verify-failed'
  | 'io';

export class AtomicWriteError extends Error implements CodedStoreError {
  /**
   * Ustawiane, gdy po bledzie nie udalo sie usunac pliku tymczasowego z trescia. Infra nie ma
   * loggera, wiec slad idzie w bledzie do wywolujacego: nazwa pliku (bez katalogu) i przyczyna.
   */
  leftover?: { readonly name: string; readonly cause: unknown };

  /** `failureCode` pochodzi z `failureCodeFromErrno`, a `reason` jest z niego wyprowadzany w `classify`. */
  constructor(
    readonly reason: AtomicWriteFailure,
    readonly failureCode: StoreFailureCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AtomicWriteError';
  }
}

/** Szew dla testow: pozwala wymusic awarie `rename` i odczytu oraz zasymulowac Windows. */
export interface AtomicOps {
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  rm(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  platform: NodeJS.Platform;
}

export interface AtomicWriteOptions {
  /** Tryb pliku (POSIX). Bez niego: tryb istniejacego pliku, a dla nowego 0600 (ADR 0018). */
  readonly mode?: number;
  readonly ops?: Partial<AtomicOps>;
}

export const DEFAULT_OPS: AtomicOps = {
  rename,
  readFile,
  rm: (path) => rm(path, { force: true }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: process.platform,
};

// Windows: rename na plik chwilowo otwarty przez antywirus albo indekser konczy sie EPERM/EBUSY/EACCES.
// Kilka krotkich prob (lacznie ok. 0,8 s) przeczeka typowe okno; dluzsza blokada wychodzi jako 'busy'.
const WINDOWS_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const WINDOWS_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const REASON_TEXT: Record<AtomicWriteFailure, string> = {
  'permission-denied': 'brak uprawnien do zapisu',
  'read-only': 'system plikow tylko do odczytu',
  'no-space': 'brak miejsca na dysku',
  busy: 'plik jest zablokowany albo brak uprawnien',
  'missing-directory': 'katalog docelowy nie istnieje',
  'verify-failed': 'odczyt kontrolny rozni sie od zapisu',
  io: 'blad zapisu',
};

/** Jedno mapowanie errno (`failureCodeFromErrno`); `reason` tylko je doprecyzowuje, nigdy z nim nie sprzeczny. */
function classify(
  error: unknown,
  where: string,
  platform: NodeJS.Platform,
  operation: FsOperation = 'write',
): AtomicWriteError {
  if (error instanceof AtomicWriteError) return error;
  const code = errnoCode(error);
  const failureCode = failureCodeFromErrno(code, platform, operation);
  let reason: AtomicWriteFailure = 'io';
  if (failureCode === 'no-space') reason = 'no-space';
  else if (failureCode === 'busy') reason = 'busy';
  else if (failureCode === 'permission-denied') {
    reason = code === 'EROFS' ? 'read-only' : 'permission-denied';
  } else if (code === 'ENOENT' || code === 'ENOTDIR') reason = 'missing-directory';
  return new AtomicWriteError(reason, failureCode, `${REASON_TEXT[reason]}: ${where}`, error);
}

/** Katalog z trybem 0700 przy tworzeniu (ADR 0018); na Windowsie `mode` jest ignorowany przez system. */
export async function ensureDirectory(path: string, mode = 0o700): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode });
  } catch (error: unknown) {
    throw classify(error, path, process.platform);
  }
}

async function existingMode(target: string): Promise<number | undefined> {
  try {
    return (await stat(target)).mode & 0o777;
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** Rename z ograniczonym ponowieniem na Windowsie; uzywany tez przy zamianie katalogow elementu. */
export async function renameWithRetry(
  from: string,
  to: string,
  ops: Pick<AtomicOps, 'rename' | 'sleep' | 'platform'>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await ops.rename(from, to);
      return;
    } catch (error: unknown) {
      const delay = WINDOWS_RETRY_DELAYS_MS[attempt];
      const retriable = ops.platform === 'win32' && WINDOWS_RETRY_CODES.has(errnoCode(error) ?? '');
      if (!retriable || delay === undefined) throw error;
      await ops.sleep(delay);
    }
  }
}

/** Fsync katalogu utrwala sam rename. Najlepszym wysilkiem: nie wszystkie systemy na to pozwalaja. */
export async function syncDirectory(dir: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return;
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Brak fsync katalogu nie zmienia wyniku zapisu, ktory juz sie udal.
  }
}

/**
 * Sciezka pliku tymczasowego obok `target`; format musi pasowac do `isAtomicTempName` z core.
 * Pid i losowy sufiks: dwa procesy ani dwa zapisy w jednym nie siegaja po ten sam plik. Nazwa
 * skrocona, zeby dluga nazwa assetu nie przekroczyla limitu nazwy pliku.
 */
export function atomicTempPath(target: string): string {
  const stem = [...basename(target)].slice(0, 40).join('');
  return join(dirname(target), `.${stem}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
}

/** Plik tymczasowy starszy niz to na pewno nie nalezy do trwajacego zapisu (jak w object-store.ts). */
export const STALE_TEMP_AGE_MS = 10 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM: proces istnieje, tylko nalezy do innego uzytkownika.
    return errnoCode(error) === 'EPERM';
  }
}

/**
 * Usuwa pliki tymczasowe `writeFileAtomic` dla tego samego `target`, osierocone przez proces,
 * ktory zginal miedzy zapisem a `rename` (test przerwanej synchronizacji, Etap 9). Rusza tylko
 * nazwy w dokladnie tym formacie i tylko gdy proces-wlasciciel nie zyje albo plik jest stary,
 * wiec zapis trwajacy obok zostaje nietkniety. Zwraca nazwy usunietych plikow.
 */
export async function removeStaleTemps(
  target: string,
  now: number,
  alive: (pid: number) => boolean = pidAlive,
): Promise<string[]> {
  const dir = dirname(target);
  const prefix = `.${[...basename(target)].slice(0, 40).join('')}.`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)\.[0-9a-f]{12}\.tmp$/.exec(name.slice(prefix.length));
    if (match === null) continue;
    const pid = Number(match[1]);
    const info = await lstat(join(dir, name)).catch(() => null);
    if (info === null || !info.isFile()) continue;
    const old = now - info.mtimeMs > STALE_TEMP_AGE_MS;
    const orphan = pid !== process.pid && !alive(pid);
    if (!old && !orphan) continue;
    try {
      await rm(join(dir, name), { force: true });
      removed.push(name);
    } catch {
      // Nieusuniety smiec nie blokuje zapisu, ktory ma sie odbyc obok niego.
    }
  }
  return removed;
}

/**
 * Zapisuje `bytes` w `target` tak, ze czytelnik widzi albo stary plik, albo caly nowy.
 * Przy kazdym bledzie przed `rename` plik tymczasowy jest usuwany, a `target` zostaje nietkniety.
 */
export async function writeFileAtomic(
  target: string,
  bytes: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const ops: AtomicOps = { ...DEFAULT_OPS, ...options.ops };
  const posix = ops.platform !== 'win32';
  const tmp = atomicTempPath(target);

  let tmpExists = false;
  try {
    const mode = posix ? (options.mode ?? (await existingMode(target)) ?? 0o600) : 0o600;
    const handle = await open(tmp, 'wx', 0o600);
    tmpExists = true;
    try {
      await handle.writeFile(bytes);
      // Tryb ustawiany na pliku tymczasowym, bo rename przenosi nowy inode: bez tego
      // nadpisany plik 0600 wracalby z domyslnym trybem wg umask (ADR 0012 krok 3).
      if (posix) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Odczyt kontrolny na pliku tymczasowym, przed rename: po rename ten sam plik mogl juz
    // zastapic inny zapis i porownanie zglaszalo by falszywa rozbieznosc.
    const written = await ops.readFile(tmp);
    if (Buffer.compare(Buffer.from(written), Buffer.from(bytes)) !== 0) {
      throw new AtomicWriteError(
        'verify-failed',
        'unknown',
        `${REASON_TEXT['verify-failed']}: ${target}`,
      );
    }

    await renameWithRetry(tmp, target, ops).catch((error: unknown) => {
      throw classify(error, target, ops.platform, 'replace');
    });
    tmpExists = false;
    await syncDirectory(dirname(target), ops.platform);
  } catch (error: unknown) {
    const failure = classify(error, target, ops.platform);
    if (tmpExists) {
      // Plik tymczasowy ma pelna tresc, wiec nieudane sprzatanie idzie dalej w bledzie, nie przepada.
      await ops.rm(tmp).catch((cleanup: unknown) => {
        failure.leftover = { name: basename(tmp), cause: cleanup };
      });
    }
    throw failure;
  }
}
