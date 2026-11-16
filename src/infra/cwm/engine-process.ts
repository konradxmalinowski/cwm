import { spawn, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';

import { buildEngineProbeEnv, sanitizePath, type EngineMetadata } from '../../core/cwm';
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

/**
 * Powod odrzucenia pliku wykonywalnego albo null, gdy plik jest akceptowalny (SPN-01 pkt 1). Wspolne
 * dla silnika i dla `git` (ADR 0048): zwykly plik z prawem wykonania poza katalogiem `projectDir`,
 * wlasciciel root albo biezacy uzytkownik, bez zapisu dla grupy i innych, bezpieczny katalog nadrzedny.
 */
export async function executableRejection(
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
    const reason = await executableRejection(real, input.projectDir, uid);
    if (reason === null) return { ok: true, path: real };
    reasons.push(`${candidate}: ${reason}`);
  }
  if (reasons.length === 0)
    reasons.push('nie znaleziono pliku "claude" w bezwzglednych elementach PATH');
  return { ok: false, reasons };
}

interface ProbeLimits {
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

interface ProbeResult {
  readonly stdout: string | null;
  readonly timedOut: boolean;
}

/** SIGKILL na cala grupe procesow proby (dzieci i wnuki); bez grup (Windows) tylko na sam proces. */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // proces juz nie istnieje
    }
  }
}

/**
 * Jedno polecenie metadanych silnika w minimalnym srodowisku (`buildEngineProbeEnv`), z limitem czasu i
 * wyjscia. `scratchDir` to pusty katalog tymczasowy 0700 (SEC-14): jest i katalogiem roboczym, i
 * `CLAUDE_CONFIG_DIR`, wiec proba nie dotyka ani profilu firmy, ani katalogu projektu. Proces startuje we
 * wlasnej grupie (`detached`), a przekroczenie czasu lub rozmiaru, a takze samo zakonczenie procesu konczy
 * cala grupe SIGKILL, wiec zaden wnuk (np. proces w tle skryptu powloki) nie przezywa proby.
 */
function probeEngine(
  path: string,
  args: readonly string[],
  scratchDir: string,
  limits: ProbeLimits,
  projectDir: string | null,
): Promise<ProbeResult> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(path, [...args], {
        cwd: scratchDir,
        env: buildEngineProbeEnv(process.env, scratchDir, projectDir),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch {
      done({ stdout: null, timedOut: false });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let errorBytes = 0;
    let timedOut = false;
    let overflow = false;
    let failed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, limits.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxBytes) {
        overflow = true;
        killGroup(child);
      } else chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > limits.maxBytes) {
        overflow = true;
        killGroup(child);
      }
    });
    child.once('error', () => {
      failed = true;
    });
    child.once('exit', () => killGroup(child));
    child.once('close', (code) => {
      clearTimeout(timer);
      killGroup(child);
      const ok = !failed && !overflow && !timedOut && code === 0;
      done({ stdout: ok ? Buffer.concat(chunks).toString('utf8') : null, timedOut });
    });
  });
}

/** Wynik polecenia metadanych (tekst) albo null: kod wyjscia inny niz 0, czas, rozmiar, brak pliku. */
export async function runEngineMetadata(
  path: string,
  args: readonly string[],
  scratchDir: string,
  limits: ProbeLimits,
  projectDir: string | null,
): Promise<string | null> {
  return (await probeEngine(path, args, scratchDir, limits, projectDir)).stdout;
}

const VERSION_LIMITS: ProbeLimits = { timeoutMs: 5000, maxBytes: 4096 };
const HELP_LIMITS: ProbeLimits = { timeoutMs: 10_000, maxBytes: 256 * 1024 };

const versionOf = (out: string | null): string | null =>
  out === null ? null : (/(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null);

/**
 * `claude --version`: wersja `x.y.z` albo null. `projectDir` wycina z `PATH` elementy w katalogu projektu
 * (null, gdy projektu nie ma).
 */
export async function queryEngineVersion(
  path: string,
  scratchDir: string,
  projectDir: string | null,
): Promise<string | null> {
  return versionOf(
    await runEngineMetadata(path, ['--version'], scratchDir, VERSION_LIMITS, projectDir),
  );
}

/** Po tylu przekroczeniach czasu w jednym sprawdzeniu reszta polecen nie jest uruchamiana. */
export const MAX_PROBE_TIMEOUTS = 2;

/**
 * Sprawdzenie metadanych silnika (ADR 0052): `--version`, `--help`, `plugin --help`, `mcp --help`, po
 * kolei, w jednym pustym katalogu proby. Nic poza tymi czterema poleceniami: bez `-p`, bez logowania,
 * bez modelu i bez sieci po stronie CWM. Po `MAX_PROBE_TIMEOUTS` przekroczeniach czasu reszta jest pomijana
 * (wynik null), zeby zawieszony silnik nie wstrzymywal startu o 4 timeouty. `timeoutMs` zastepuje limity czasu
 * (testy).
 */
export async function collectEngineMetadata(
  path: string,
  scratchDir: string,
  projectDir: string | null,
  timeoutMs?: number,
): Promise<EngineMetadata> {
  let timeouts = 0;
  const run = async (args: readonly string[], limits: ProbeLimits): Promise<string | null> => {
    if (timeouts >= MAX_PROBE_TIMEOUTS) return null;
    const effective = timeoutMs === undefined ? limits : { ...limits, timeoutMs };
    const result = await probeEngine(path, args, scratchDir, effective, projectDir);
    if (result.timedOut) timeouts += 1;
    return result.stdout;
  };
  const version = versionOf(await run(['--version'], VERSION_LIMITS));
  const help = await run(['--help'], HELP_LIMITS);
  const pluginHelp = await run(['plugin', '--help'], HELP_LIMITS);
  const mcpHelp = await run(['mcp', '--help'], HELP_LIMITS);
  return { version, help, pluginHelp, mcpHelp };
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
