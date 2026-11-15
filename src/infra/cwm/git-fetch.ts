import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpath, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  buildGitEnv,
  checkGitTreeListing,
  GIT_COMMIT_PATTERN,
  gitHardeningArgs,
  gitRefProblem,
  gitUrlProblem,
  sanitizePath,
} from '../../core/cwm';
import { executableRejection } from './engine-process';
import { gitSourceDir, gitSourcesRoot, lookupGitSource } from './git-source';
import type { CwmLayout } from './layout';
import { networkDenied } from './network-guard';
import { lstatLoose } from './paths';
import { readDirLimited } from './read';
import { readTree, TREE_LIMITS, treeSha256 } from './runtime-sources';
import { ensureScopedDirectory, homeScope, installScopedTree, removeScopedTree } from './writer';

/**
 * Jedyne miejsce w CWM, ktore siega do sieci i uruchamia `git` (ADR 0048). Wolane tylko z
 * `cwm plugin add git|fetch|update`; `cwm start`, `cwm diff` i `cwm sync` tego pliku nie importuja
 * (regula lintu i proba w `scripts/verify-boundaries.mjs`).
 *
 * `git` idzie po sciezce bezwzglednej (po `realpath`, z kontrola wlasciciela i uprawnien jak plik
 * silnika), ze srodowiskiem od zera i opcjami `-c` z `core/cwm/git-source.ts`. Pobranie to `fetch
 * --depth=1` do pustego repozytorium w katalogu roboczym 0700; drzewo jest czytane tym samym
 * `readTree` co plugin `local`, a na miejsce trafia katalog `<skrot adresu>/<commit>/` bez `.git`.
 */

const COMMAND_MS = 120_000;
const TOTAL_MS = 300_000;
const DISK_LIMIT = 64 * 1024 * 1024;
const DISK_POLL_MS = 200;
const STDOUT_LIMIT = 4 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const STALE_MS = 60 * 60 * 1000;

export type GitFetchResult =
  | {
      readonly ok: true;
      readonly commit: string;
      readonly dir: string;
      readonly treeSha256: string;
      readonly files: number;
      /** Wpisy typu submodul: nie sa pobierane, w kopii ich nie ma. */
      readonly submodules: readonly string[];
      /** Kopia z tym commitem i ta sama trescia juz byla na dysku. */
      readonly reused: boolean;
    }
  | { readonly ok: false; readonly message: string };

export interface GitFetchInput {
  readonly layout: CwmLayout;
  readonly url: string;
  /** Galaz, tag albo pelny SHA; brak oznacza `HEAD` repozytorium. Ignorowany, gdy podano `commit`. */
  readonly ref: string | null;
  /** Przypiety commit: pobierany wprost po SHA, wynik musi byc rowny. */
  readonly commit: string | null;
}

async function resolveGit(): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
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
function tidy(text: string): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return clean.length > 300 ? `...${clean.slice(-300)}` : clean;
}

interface RunContext {
  readonly git: string;
  readonly scratch: string;
  readonly allowHttp: boolean;
  readonly deadline: number;
}

interface RunOptions {
  readonly cwd: string;
  readonly repository?: { readonly gitDir: string; readonly workTree: string };
  /** Pilnuje rozmiaru katalogu roboczego (pobieranie nie moze zapchac dysku). */
  readonly watchDisk?: boolean;
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
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

function runGit(
  context: RunContext,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((done) => {
    const remaining = context.deadline - Date.now();
    if (remaining <= 0) {
      done({ code: null, stdout: '', stderr: '', aborted: 'przekroczono laczny limit czasu' });
      return;
    }
    const env = buildGitEnv({
      parent: process.env,
      scratchDir: context.scratch,
      gitDir: dirname(context.git),
      allowLoopbackHttp: context.allowHttp,
      ...(options.repository === undefined ? {} : { repository: options.repository }),
    });
    const child = spawn(context.git, [...gitHardeningArgs(context.allowHttp), ...args], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // Wlasna grupa procesow: limit czasu zabija tez pomocnika git-remote-https. Przy SIGKILL na samym
      // CWM grupa przezywa (nie ma kto jej zabic): konczy sie sama po zerwaniu rur albo limicie czasu `git`,
      // a katalog `.tmp-*` sprzata nastepne pobieranie (ADR 0048).
      detached: true,
    });
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
      Math.min(COMMAND_MS, remaining),
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
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > STDOUT_LIMIT) abort('za duze wyjscie polecenia git');
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes <= STDERR_LIMIT) err.push(chunk);
    });
    const finish = (code: number | null, error: string | null): void => {
      clearTimeout(timer);
      if (meter !== null) clearInterval(meter);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      done({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
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

/** Katalogi `.tmp-*` po przerwanym pobieraniu starsze niz godzina. */
async function sweepStale(layout: CwmLayout): Promise<void> {
  const root = gitSourcesRoot(layout);
  const scope = homeScope(layout.home);
  const listing = await readDirLimited(root, 1000).catch(() => null);
  for (const entry of listing?.entries ?? []) {
    if (!entry.name.startsWith('.tmp-') || !entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const info = await lstatLoose(path).catch(() => null);
    if (info !== null && Date.now() - info.mtimeMs > STALE_MS) {
      await removeScopedTree(scope, path).catch(() => undefined);
    }
  }
}

/**
 * Pobiera commit do `~/.cwm/sources/git/<skrot adresu>/<commit>/`. Siec jest tylko w pierwszym
 * poleceniu `git fetch`; reszta (lista plikow, wypakowanie) dziala na obiektach juz pobranych.
 */
export async function fetchGitSource(input: GitFetchInput): Promise<GitFetchResult> {
  // Druga warstwa po lincie i skanie zrodel: start, diff i sync ustawiaja `denyNetwork()`.
  if (networkDenied()) throw new Error('Siec jest wylaczona w tym poleceniu (ADR 0048).');
  const fail = (message: string): GitFetchResult => ({ ok: false, message });
  const urlProblem = gitUrlProblem(input.url);
  if (urlProblem !== null) return fail(urlProblem.replace(/\.$/, ''));
  if (input.commit !== null && !GIT_COMMIT_PATTERN.test(input.commit)) {
    return fail('przypiety commit nie jest pelnym SHA');
  }
  if (input.ref !== null) {
    const refProblem = gitRefProblem(input.ref);
    // Pelny SHA jako ref jest dozwolony (GIT_REF_PATTERN go przepuszcza, krotkie hex nie).
    if (refProblem !== null) return fail(refProblem.replace(/\.$/, ''));
  }
  const git = await resolveGit();
  if (!git.ok) return fail(git.reason);

  const scope = homeScope(input.layout.home);
  await ensureScopedDirectory(scope, gitSourcesRoot(input.layout));
  // Wolne miejsce przed pobraniem: dwukrotnosc limitu katalogu roboczego (pobranie plus wypakowanie).
  const space = await statfs(gitSourcesRoot(input.layout)).catch(() => null);
  if (space !== null && space.bavail * space.bsize < 2 * DISK_LIMIT) {
    return fail('za malo wolnego miejsca na dysku do pobrania');
  }
  await sweepStale(input.layout);
  const scratch = join(gitSourcesRoot(input.layout), `.tmp-${randomBytes(6).toString('hex')}`);
  await ensureScopedDirectory(scope, scratch);
  try {
    return await fetchInto(input, git.path, scratch);
  } finally {
    await removeScopedTree(scope, scratch).catch(() => undefined);
  }
}

async function fetchInto(
  input: GitFetchInput,
  git: string,
  scratch: string,
): Promise<GitFetchResult> {
  const fail = (message: string): GitFetchResult => ({ ok: false, message });
  const scope = homeScope(input.layout.home);
  const context: RunContext = {
    git,
    scratch,
    allowHttp: new URL(input.url).protocol === 'http:',
    deadline: Date.now() + TOTAL_MS,
  };
  const repo = join(scratch, 'repo');
  const work = join(scratch, 'work');
  const repository = { gitDir: join(repo, '.git'), workTree: work };
  await ensureScopedDirectory(scope, work);

  const describe = (what: string, run: RunResult): GitFetchResult =>
    fail(
      `${what}: ${run.aborted ?? (tidy(run.stderr) || `git zakonczyl sie kodem ${run.code ?? '?'}`)}`,
    );

  const init = await runGit(context, ['init', '--quiet', '--template=', repo], { cwd: scratch });
  if (init.code !== 0) return describe('nie udalo sie przygotowac katalogu roboczego', init);

  const refspec = input.commit ?? input.ref ?? 'HEAD';
  const fetched = await runGit(
    context,
    [
      'fetch',
      '--quiet',
      '--depth=1',
      '--no-tags',
      '--no-recurse-submodules',
      '--no-auto-gc',
      '--',
      input.url,
      refspec,
    ],
    { cwd: repo, watchDisk: true },
  );
  if (fetched.code !== 0) return describe('pobieranie nie powiodlo sie', fetched);

  const parsed = await runGit(
    context,
    ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'],
    {
      cwd: repo,
    },
  );
  const commit = parsed.stdout.trim();
  if (parsed.code !== 0 || !GIT_COMMIT_PATTERN.test(commit)) {
    return fail('ref nie wskazuje commita');
  }
  if (input.commit !== null && commit !== input.commit) {
    return fail('serwer zwrocil inny commit niz przypiety');
  }

  const listing = await runGit(context, ['ls-tree', '-r', '-l', '-z', commit], { cwd: repo });
  if (listing.code !== 0) return describe('nie udalo sie odczytac listy plikow', listing);
  const checked = checkGitTreeListing(listing.stdout, {
    files: TREE_LIMITS.files,
    fileBytes: TREE_LIMITS.fileBytes,
    bytes: TREE_LIMITS.bytes,
  });
  if (!checked.ok) return fail(`repozytorium nie nadaje sie na plugin: ${checked.message}`);

  const indexed = await runGit(context, ['read-tree', commit], { cwd: repo, repository });
  if (indexed.code !== 0) return describe('nie udalo sie wczytac drzewa', indexed);
  const extracted = await runGit(context, ['checkout-index', '-a', '-f', '-q'], {
    cwd: work,
    repository,
  });
  if (extracted.code !== 0) return describe('nie udalo sie wypakowac plikow', extracted);

  const tree = await readTree(work, undefined, { rejectHardlinks: true });
  if (!tree.ok) return fail(`repozytorium nie nadaje sie na plugin: ${tree.message}`);
  if (tree.files.length !== checked.files) {
    return fail('wypakowane pliki nie zgadzaja sie z lista commita');
  }
  const hash = treeSha256(tree.files);

  const dir = gitSourceDir(input.layout, input.url, commit);
  const existing = await lookupGitSource(input.layout, input.url, commit);
  if (existing.ok) {
    const current = await readTree(existing.dir, undefined, { rejectHardlinks: true });
    if (current.ok && treeSha256(current.files) === hash) {
      return {
        ok: true,
        commit,
        dir,
        treeSha256: hash,
        files: tree.files.length,
        submodules: checked.submodules,
        reused: true,
      };
    }
  }
  await installScopedTree(scope, work, dir);
  return {
    ok: true,
    commit,
    dir,
    treeSha256: hash,
    files: tree.files.length,
    submodules: checked.submodules,
    reused: false,
  };
}
