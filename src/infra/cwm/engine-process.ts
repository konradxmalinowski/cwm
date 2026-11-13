import { execFile, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';

import { sanitizePath } from '../../core/cwm';
import { isPathInside } from '../../core/model/path-containment';
import { lstatLoose } from './paths';

/** Wersja silnika, na ktorej oparto flagi i wyniki V-01..V-08 (ADR 0036). */
export const EXPECTED_ENGINE_VERSION = '2.1.322';

export type EngineLookup =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reasons: readonly string[] };

const STICKY = 0o1000;

/**
 * Katalog nadrzedny wpisu (po `realpath`): wlasciciel root albo biezacy uzytkownik, bez zapisu dla
 * grupy i innych (chyba ze z bitem sticky). Wspolne dla pliku silnika i katalogu marketplace'u:
 * kto moze zapisywac w katalogu nadrzednym, moze podmienic wpis.
 */
export async function parentRejection(real: string, uid: number): Promise<string | null> {
  const parent = await lstatLoose(dirname(real));
  if (parent === null || !parent.isDirectory()) return 'brak katalogu nadrzednego';
  if (parent.uid !== 0 && parent.uid !== uid) return 'katalog nadrzedny ma innego wlasciciela';
  if ((parent.mode & 0o022) !== 0 && (parent.mode & STICKY) === 0) {
    return 'katalog nadrzedny zapisywalny dla grupy lub innych';
  }
  return null;
}

/** Powod odrzucenia pliku albo null, gdy plik jest akceptowalny (SPN-01 pkt 1). */
async function rejection(
  real: string,
  projectDir: string,
  uid: number | null,
): Promise<string | null> {
  const info = await lstatLoose(real);
  if (info === null || !info.isFile()) return 'to nie jest zwykly plik';
  if ((info.mode & 0o111) === 0) return 'brak prawa wykonania';
  if (isPathInside(real, projectDir, { allowSame: true })) return 'plik lezy w katalogu projektu';
  if (uid !== null) {
    if (info.uid !== 0 && info.uid !== uid)
      return 'wlasciciel to ktos inny niz root i biezacy uzytkownik';
    if ((info.mode & 0o022) !== 0) return 'plik zapisywalny dla grupy lub innych';
    return parentRejection(real, uid);
  }
  return null;
}

/**
 * Plik `claude` do uruchomienia (SPN-01): `runtime.claude.path` albo bezwzgledne elementy `PATH`,
 * po `realpath`, ze sprawdzeniem wlasciciela i uprawnien. Wzgledne i puste elementy `PATH` nie
 * licza sie, bo `cwd` to niezaufany katalog projektu.
 */
export async function resolveEngineBinary(input: {
  readonly configuredPath: string | null;
  readonly pathEnv: string | undefined;
  readonly projectDir: string;
}): Promise<EngineLookup> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const candidates =
    input.configuredPath !== null
      ? [input.configuredPath]
      : sanitizePath(input.pathEnv, input.projectDir)
          .split(':')
          .map((dir) => join(dir, 'claude'));
  const reasons: string[] = [];
  for (const candidate of candidates) {
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      if (input.configuredPath !== null) reasons.push('runtime.claude.path nie istnieje');
      continue;
    }
    const reason = await rejection(real, input.projectDir, uid);
    if (reason === null) return { ok: true, path: real };
    reasons.push(`${candidate}: ${reason}`);
  }
  if (reasons.length === 0)
    reasons.push('nie znaleziono pliku "claude" w bezwzglednych elementach PATH');
  return { ok: false, reasons };
}

/**
 * `claude --version` w minimalnym srodowisku, z limitem czasu i wyjscia. `scratchDir` to pusty
 * katalog tymczasowy 0700 (SEC-14): jest i katalogiem roboczym, i `CLAUDE_CONFIG_DIR`, wiec proba
 * nie dotyka ani profilu firmy, ani katalogu projektu. Null, gdy sie nie uda.
 */
export function queryEngineVersion(path: string, scratchDir: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      path,
      ['--version'],
      {
        cwd: scratchDir,
        env: {
          PATH: sanitizePath(process.env['PATH']),
          HOME: process.env['HOME'] ?? '',
          CLAUDE_CONFIG_DIR: scratchDir,
        },
        timeout: 5000,
        maxBuffer: 4096,
        shell: false,
        windowsHide: true,
      },
      (error, stdout) => {
        const match = error ? null : /(\d+\.\d+\.\d+)/.exec(stdout);
        done(match?.[1] ?? null);
      },
    );
  });
}

/**
 * Uruchomienie silnika (SPN-05): bez powloki, `stdio: inherit`, kod wyjscia przekazany dalej, a
 * smierc od sygnalu to 128+n. Dziecko dziedziczy grupe procesow terminala i samo dostaje SIGINT oraz
 * SIGHUP z terminala, wiec CWM je tylko przezywa (bez przekazywania, zeby sesja nie dostala ich
 * dwa razy); przekazywany jest SIGTERM wyslany do samego procesu CWM. Argumenty i srodowisko nie
 * sa logowane.
 */
export function runEngine(
  binary: string,
  argv: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly onSpawn?: (pid: number) => void;
  },
): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(binary, [...argv], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      shell: false,
    });
    if (child.pid !== undefined) options.onSpawn?.(child.pid);
    const outlive = (): void => undefined;
    const forwardTerm = (): void => void child.kill('SIGTERM');
    process.on('SIGINT', outlive);
    process.on('SIGHUP', outlive);
    process.on('SIGTERM', forwardTerm);
    const cleanup = (): void => {
      process.off('SIGINT', outlive);
      process.off('SIGHUP', outlive);
      process.off('SIGTERM', forwardTerm);
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      fail(new Error(`Nie udalo sie uruchomic silnika (${error.code ?? 'nieznany'}).`));
    });
    child.once('close', (code, signal) => {
      cleanup();
      done(code ?? 128 + (signal === null ? 0 : (osConstants.signals[signal] ?? 0)));
    });
  });
}
