import { spawn, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { buildGitEnv, gitHardeningArgs, sanitizePath } from '../../core/cwm';
import { executableRejection } from './engine-process';
import { lstatLoose } from './paths';
import { readDirLimited } from './read';

/**
 * Wspolny proces `git` dla pobierania (`git-fetch.ts`, ADR 0048 i 0058) i dla lokalnego repozytorium
 * biblioteki (`infra/library/library-git.ts`, ADR 0060): jedno miejsce z `spawn`, ustalaniem pliku `git`
 * po sciezce bezwzglednej, srodowiskiem od zera, opcjami `-c` bez hookow i helperow hasel, limitami
 * czasu i wyjscia oraz zabijaniem grupy procesow. Ten plik nie zna sieci ani adresow: to, kto moze
 * pobierac, pilnuje regula lintu na `git-fetch.ts`.
 */

const COMMAND_MS = 120_000;
export const DISK_LIMIT = 64 * 1024 * 1024;
const DISK_POLL_MS = 200;
const STDOUT_LIMIT = 4 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

export async function resolveGit(): Promise<
  { ok: true; path: string } | { ok: false; reason: string }
> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const cwd = process.cwd();
  const reasons: string[] = [];
  for (const dir of sanitizePath(process.env['PATH'], cwd).split(':')) {
    const candidate = join(dir, 'git');
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      continue;
    }
    const reason = await executableRejection(real, cwd, uid);
    if (reason === null) return { ok: true, path: real };
    reasons.push(`${candidate}: ${reason}`);
  }
  return {
    ok: false,
    reason:
      reasons.length === 0
        ? 'nie znaleziono pliku "git" w bezwzglednych elementach PATH'
        : `plik "git" odrzucony (${reasons.join('; ')})`,
  };
}

/** Tekst z procesu do komunikatu: bez znakow sterujacych, krotko, koniec wyjscia. */
export function tidy(text: string): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return clean.length > 300 ? `...${clean.slice(-300)}` : clean;
}

export interface RunContext {
  readonly git: string;
  readonly scratch: string;
  readonly allowHttp: boolean;
  readonly deadline: number;
  /** Limit czasu jednego polecenia; domyslnie 120 s (pobieranie). Lokalne repozytorium daje krotszy. */
  readonly commandMs?: number;
  /** Dodatkowe ustawienia `-c klucz=wartosc` po zestawie hartujacym; pozniejsze wygrywaja. */
  readonly extraConfig?: readonly string[];
  /** Dodatkowe zmienne srodowiska procesu (np. `GIT_LITERAL_PATHSPECS`); nie nadpisuja PATH ani HOME. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface RunOptions {
  readonly cwd: string;
  readonly repository?: { readonly gitDir: string; readonly workTree: string };
  /** Pilnuje rozmiaru katalogu roboczego (pobieranie nie moze zapchac dysku). */
  readonly watchDisk?: boolean;
  /** Tekst na standardowe wejscie procesu (np. lista obiektow dla `cat-file --batch`). */
  readonly input?: string;
  /** Limit bajtow standardowego wyjscia (domyslnie 4 MiB). */
  readonly stdoutLimit?: number;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  /** Surowe wyjscie (obiekty binarne), bez dekodowania. */
  readonly stdoutBytes: Buffer;
  readonly stderr: string;
  /** Powod przerwania przez CWM (limit czasu, rozmiaru, sygnal) albo null. */
  readonly aborted: string | null;
}

async function directoryBytes(root: string, cap: number): Promise<number> {
  let total = 0;
  const stack = [root];
  for (let dir = stack.pop(); dir !== undefined && total <= cap; dir = stack.pop()) {
    const listing = await readDirLimited(dir, 10_000).catch(() => null);
    for (const entry of listing?.entries ?? []) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else total += (await lstatLoose(path).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

/** Trwajace procesy `git` tego procesu CWM; zamykanie aplikacji zabija ich grupy (`abortRunningGit`). */
const running = new Set<ChildProcess>();

/**
 * Zabija grupy procesow wszystkich trwajacych polecen `git` (import z repozytorium w aplikacji przy
 * `before-quit`). Bez tego `git-remote-https` przezylby aplikacje do limitu czasu. Kazde polecenie ma
 * wlasne sprzatanie (`finish`), ktore zdejmuje tez nasluchiwacze sygnalow procesu.
 */
export function abortRunningGit(): void {
  for (const child of running) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export function runGit(
  context: RunContext,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((done) => {
    const remaining = context.deadline - Date.now();
    if (remaining <= 0) {
      done({
        code: null,
        stdout: '',
        stdoutBytes: Buffer.alloc(0),
        stderr: '',
        aborted: 'przekroczono laczny limit czasu',
      });
      return;
    }
    const baseEnv = buildGitEnv({
      parent: process.env,
      scratchDir: context.scratch,
      gitDir: dirname(context.git),
      allowLoopbackHttp: context.allowHttp,
      ...(options.repository === undefined ? {} : { repository: options.repository }),
    });
    const env: Record<string, string> = { ...context.extraEnv, ...baseEnv };
    const configArgs = (context.extraConfig ?? []).flatMap((setting) => ['-c', setting]);
    const child = spawn(
      context.git,
      [...gitHardeningArgs(context.allowHttp), ...configArgs, ...args],
      {
        cwd: options.cwd,
        env,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        // Wlasna grupa procesow: limit czasu zabija tez pomocnika git-remote-https. Przy SIGKILL na samym
        // CWM grupa przezywa (nie ma kto jej zabic): konczy sie sama po zerwaniu rur albo limicie czasu `git`,
        // a katalog `.tmp-*` sprzata nastepne pobieranie (ADR 0048).
        detached: true,
      },
    );
    running.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let aborted: string | null = null;
    const abort = (reason: string): void => {
      if (aborted !== null) return;
      aborted = reason;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(
      () => abort('przekroczono limit czasu'),
      Math.min(context.commandMs ?? COMMAND_MS, remaining),
    );
    let measuring = false;
    const meter =
      options.watchDisk === true
        ? setInterval(() => {
            if (measuring) return;
            measuring = true;
            void directoryBytes(context.scratch, DISK_LIMIT)
              .then((bytes) => {
                if (bytes > DISK_LIMIT) abort('przekroczono limit rozmiaru pobierania');
              })
              .finally(() => {
                measuring = false;
              });
          }, DISK_POLL_MS)
        : null;
    const onSignal = (): void => abort('przerwano');
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > (options.stdoutLimit ?? STDOUT_LIMIT)) abort('za duze wyjscie polecenia git');
      else out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes <= STDERR_LIMIT) err.push(chunk);
    });
    if (options.input !== undefined && child.stdin !== null) {
      // Przedwczesne zamkniecie wejscia przez `git` konczy sie kodem procesu, nie wyjatkiem.
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    }
    const finish = (code: number | null, error: string | null): void => {
      running.delete(child);
      clearTimeout(timer);
      if (meter !== null) clearInterval(meter);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      const stdoutBytes = Buffer.concat(out);
      done({
        code,
        stdout: stdoutBytes.toString('utf8'),
        stdoutBytes,
        stderr: error ?? Buffer.concat(err).toString('utf8'),
        aborted,
      });
    };
    child.once('error', (error: NodeJS.ErrnoException) =>
      finish(null, `nie udalo sie uruchomic git (${error.code ?? 'nieznany'})`),
    );
    child.once('close', (code) => finish(code, null));
  });
}
