import { execFile } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';

import { lstatLoose } from './paths';
import { readTextWithin } from './read';

const MAX_GITIGNORE_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 5000;

/** `unknown`: nie da sie rozstrzygnac (brak gita, wzorce z negacja), wiec ostrzegamy. */
export type IgnoreStatus = 'ignored' | 'not-ignored' | 'unknown';

/** Najblizszy katalog z `.git` (katalog albo plik worktree) w gore od `dir`. */
export async function findGitRoot(dir: string): Promise<string | null> {
  let current = dir;
  for (;;) {
    if ((await lstatLoose(join(current, '.git'))) !== null) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

type GitResult = IgnoreStatus | 'no-git';

/**
 * `git check-ignore -q -- <plik>`: kod 0 to ignorowany, 1 nieignorowany, inny to blad. Bez powloki,
 * argumenty tablica, katalog roboczy to projekt, timeout. `core.fsmonitor=false` wylacza program
 * wskazany w `.git/config` obcego repozytorium.
 */
function checkIgnoreWithGit(projectDir: string, file: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', 'check-ignore', '-q', '--', file],
      { cwd: projectDir, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error) => {
        if (error === null) return resolve('ignored');
        const code: unknown = (error as { code?: unknown }).code;
        if (code === 'ENOENT') return resolve('no-git');
        resolve(code === 1 ? 'not-ignored' : 'unknown');
      },
    );
  });
}

/** Wzorce, ktore rozstrzygaja ignorowanie `<projekt>/.cwm`, gdy plik ma bazowy katalog `base`. */
function acceptedPatterns(base: string, projectDir: string): Set<string> {
  const rel = relative(base, projectDir).split(sep).filter(Boolean).join('/');
  const accepted = new Set(['.cwm', '.cwm/', '**/.cwm', '**/.cwm/']);
  // Wzorzec z ukosnikiem jest zakotwiczony w katalogu pliku, wiec liczy sie tylko dla tego katalogu.
  const anchored = rel === '' ? '.cwm' : `${rel}/.cwm`;
  for (const form of [
    `/${anchored}`,
    `/${anchored}/`,
    ...(rel === '' ? [] : [anchored, `${anchored}/`]),
  ]) {
    accepted.add(form);
  }
  return accepted;
}

async function checkIgnoreByHeuristic(gitRoot: string, projectDir: string): Promise<IgnoreStatus> {
  const sources = [
    { file: join(gitRoot, '.gitignore'), base: gitRoot },
    { file: join(projectDir, '.gitignore'), base: projectDir },
    { file: join(gitRoot, '.git', 'info', 'exclude'), base: gitRoot },
  ];
  let ignored = false;
  for (const { file, base } of sources) {
    const read = await readTextWithin(dirname(file), file, MAX_GITIGNORE_BYTES);
    if (!read.ok) continue;
    const lines = read.text.split(/\r?\n/).map((line) => line.trim());
    // Negacja moze odwrocic wczesniejszy wzorzec, a tej kolejnosci nie odtwarzamy.
    if (lines.some((line) => line.startsWith('!'))) return 'unknown';
    const accepted = acceptedPatterns(base, projectDir);
    if (lines.some((line) => accepted.has(line))) ignored = true;
  }
  return ignored ? 'ignored' : 'not-ignored';
}

/** Czy `<projekt>/.cwm` jest ignorowany przez git: `git check-ignore`, a bez gita heurystyka. */
export async function cwmIgnoreStatus(gitRoot: string, projectDir: string): Promise<IgnoreStatus> {
  const viaGit = await checkIgnoreWithGit(projectDir, join('.cwm', 'project.yaml'));
  if (viaGit !== 'no-git') return viaGit;
  return checkIgnoreByHeuristic(gitRoot, projectDir);
}
