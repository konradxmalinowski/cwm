import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  libraryGitEligibility,
  libraryGitSubject,
  LIBRARY_GIT_AUTHOR,
  type LibraryGitEligibility,
  type LibraryGitOperation,
} from '../../core/model/library-git';
import { MAX_ITEM_JSON_BYTES } from '../../core/model/library-limits';
import { isItemId } from '../../core/ports/id-generator';
import type {
  LibraryGit,
  LibraryGitAvailability,
  LibraryGitStatus,
  LibraryGitSyncResult,
} from '../../core/ports/library-git';
import { resolveGit, runGit, tidy, type RunContext, type RunResult } from '../cwm/git-process';
import { ensureDirectory, writeFileAtomic } from '../fs/atomic';
import { readChecked } from '../fs/bounded-read';
import { lstatOrNull } from '../fs/stat';

/**
 * Lokalne repozytorium Git katalogu `library/` (ADR 0060). Magazyn obiektow (`GIT_DIR`) lezy poza
 * biblioteka, w `<userData>/library-git`, a `library/` jest tylko drzewem roboczym (`GIT_WORK_TREE`):
 * w bibliotece nie ma wiec `.git`, a store elementow nie widzi obcego wpisu.
 *
 * Proces `git` to ten sam kod co przy pobieraniu (`cwm/git-process.ts`): sciezka bezwzgledna, srodowisko
 * od zera bez configu globalnego i systemowego, hooki wylaczone, bez helperow hasel i pytan, limity
 * czasu. Tu dochodzi `protocol.https.allow=never` (zadne polecenie nie dotyka sieci), autor neutralny,
 * brak podpisow i wlasne atrybuty (`info/attributes`), ktore wylaczaja filtry i konwersje konca linii
 * takze wtedy, gdy plik pomocniczy elementu nazywa sie `.gitattributes`.
 *
 * Do historii wchodza wylacznie elementy z `libraryGitEligibility`. Pliki dodaje sie z listy sciezek
 * (`items/<id>`), nie `git add -A`, wiec `.gitignore` w pliku pomocniczym nie ukryje tresci, a wykluczony
 * element nie wejdzie przez przypadek; `info/exclude` powtarza wykluczenia dla recznych polecen.
 */

const COMMAND_MS = 20_000;
const SYNC_MS = 90_000;
const STALE_LOCK_MS = 5 * 60 * 1000;
const SCRATCH_DIR = 'cwm-scratch';
const ATTRIBUTES = '* -text -filter -ident -diff -merge !working-tree-encoding\n';
const FIXED_CONFIG: readonly string[] = [
  'protocol.https.allow=never',
  'protocol.http.allow=never',
  `user.name=${LIBRARY_GIT_AUTHOR.name}`,
  `user.email=${LIBRARY_GIT_AUTHOR.email}`,
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'core.excludesFile=/dev/null',
  'core.safecrlf=false',
  'core.symlinks=true',
  'init.defaultBranch=main',
];

export interface FsLibraryGitOptions {
  /** Katalog biblioteki (drzewo robocze); elementy leza w `items/<id>`. */
  readonly libraryDir: string;
  /** Magazyn obiektow repozytorium, poza `libraryDir`. */
  readonly gitDir: string;
}

interface ItemScan {
  readonly byId: ReadonlyMap<string, LibraryGitEligibility>;
  readonly counts: LibraryGitStatus['items'];
}

const MISSING_GIT_TEXT =
  'Git nie jest dostępny w tym systemie, więc wersjonowanie biblioteki jest niedostępne. Reszta aplikacji działa bez zmian.';
const FAILED_TEXT = 'Polecenie git nie powiodło się';

export class FsLibraryGit implements LibraryGit {
  constructor(private readonly options: FsLibraryGitOptions) {}

  async probe(): Promise<LibraryGitAvailability> {
    if (process.platform === 'win32') {
      return {
        available: false,
        message: 'Wersjonowanie biblioteki w Git nie jest jeszcze obsługiwane w systemie Windows.',
      };
    }
    const git = await resolveGit();
    return git.ok ? { available: true } : { available: false, message: MISSING_GIT_TEXT };
  }

  async status(includePrivate: boolean): Promise<LibraryGitStatus> {
    const scan = await this.scan(includePrivate);
    const empty: LibraryGitStatus = {
      repository: false,
      commits: 0,
      last: null,
      items: scan.counts,
    };
    if ((await lstatOrNull(join(this.options.gitDir, 'HEAD'))) === null) return empty;
    const prepared = await this.context(30_000);
    if (!prepared.ok) return { ...empty, repository: true };
    const context = prepared.context;
    const count = await this.run(context, ['rev-list', '--count', 'HEAD']);
    const commits = count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) : 0;
    const last = await this.run(context, ['log', '-1', '--format=%cI|%s']);
    const line = last.code === 0 ? last.stdout.trim() : '';
    const split = line.indexOf('|');
    return {
      repository: true,
      commits: Number.isInteger(commits) ? commits : 0,
      last: split > 0 ? { at: line.slice(0, split), subject: line.slice(split + 1) } : null,
      items: scan.counts,
    };
  }

  async sync(input: {
    readonly operation: LibraryGitOperation;
    readonly includePrivate: boolean;
  }): Promise<LibraryGitSyncResult> {
    try {
      return await this.doSync(input.operation, input.includePrivate);
    } catch {
      return { ok: false, message: FAILED_TEXT };
    }
  }

  private async doSync(
    operation: LibraryGitOperation,
    includePrivate: boolean,
  ): Promise<LibraryGitSyncResult> {
    const prepared = await this.context(SYNC_MS);
    if (!prepared.ok) return { ok: false, message: prepared.message };
    const context = prepared.context;
    const scan = await this.scan(includePrivate);
    const repositoryProblem = await this.ensureRepository(context, scan);
    if (repositoryProblem !== null) return { ok: false, message: repositoryProblem };

    const included = [...scan.byId].filter(([, state]) => state === 'included').map(([id]) => id);
    const tracked = await this.run(context, ['ls-files', '-z']);
    if (tracked.code !== 0 || tracked.aborted !== null) return this.failure('ls-files', tracked);
    const trackedPaths = tracked.stdout.split('\0').filter((path) => path !== '');
    const keep = new Set(included);
    const stale = [
      ...new Set(
        trackedPaths
          .map((path) => ({ path, id: itemIdOf(path) }))
          .filter(({ id }) => id === null || !keep.has(id))
          .map(({ path, id }) => (id === null ? path : `items/${id}`)),
      ),
    ];
    if (stale.length > 0) {
      const removed = await this.run(
        context,
        [
          'rm',
          '-r',
          '-q',
          '--cached',
          '--ignore-unmatch',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        { input: `${stale.join('\0')}\0` },
      );
      if (removed.code !== 0) return this.failure('rm', removed);
    }
    if (included.length > 0) {
      const added = await this.run(
        context,
        ['add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { input: `${included.map((id) => `items/${id}`).join('\0')}\0` },
      );
      if (added.code !== 0) return this.failure('add', added);
    }

    const staged = await this.run(context, ['diff', '--cached', '--name-only', '-z']);
    if (staged.code !== 0) return this.failure('diff', staged);
    const changed = new Set<string>();
    for (const path of staged.stdout.split('\0')) {
      const id = itemIdOf(path);
      if (id !== null) changed.add(id);
    }
    if (staged.stdout === '') return { ok: true, committed: false, items: 0 };
    // Wpisy poza `items/<id>` (zdjete z indeksu) nie sa elementami; commit i tak je zapisuje.
    const items = changed.size;
    const committed = await this.run(context, [
      'commit',
      '-q',
      '--no-verify',
      '-m',
      libraryGitSubject(operation, items),
    ]);
    if (committed.code !== 0) return this.failure('commit', committed);
    return { ok: true, committed: true, items };
  }

  /** Komunikat bez sciezek i bez wyjscia procesu; szczegol idzie tylko do kodu wyjscia. */
  private failure(step: string, run: { aborted: string | null }): LibraryGitSyncResult {
    return {
      ok: false,
      message:
        run.aborted === null
          ? `${FAILED_TEXT} (${step}).`
          : `${FAILED_TEXT} (${step}): ${tidy(run.aborted)}.`,
    };
  }

  private async context(
    totalMs: number,
  ): Promise<{ ok: true; context: RunContext } | { ok: false; message: string }> {
    const git = await resolveGit();
    if (!git.ok) return { ok: false, message: MISSING_GIT_TEXT };
    const scratch = join(this.options.gitDir, SCRATCH_DIR);
    try {
      await ensureDirectory(this.options.gitDir, 0o700);
      await ensureDirectory(scratch, 0o700);
    } catch {
      return { ok: false, message: 'Nie udało się przygotować katalogu repozytorium.' };
    }
    return {
      ok: true,
      context: {
        git: git.path,
        scratch,
        allowHttp: false,
        deadline: Date.now() + totalMs,
        commandMs: COMMAND_MS,
        extraConfig: FIXED_CONFIG,
      },
    };
  }

  private run(
    context: RunContext,
    args: readonly string[],
    extra: { readonly input?: string } = {},
  ): Promise<RunResult> {
    return runGit(context, args, {
      cwd: this.options.libraryDir,
      repository: { gitDir: this.options.gitDir, workTree: this.options.libraryDir },
      ...extra,
    });
  }

  /** Tworzy repozytorium przy pierwszym uzyciu i odswieza pliki `info/` zgodnie z aktualna zasada. */
  private async ensureRepository(context: RunContext, scan: ItemScan): Promise<string | null> {
    const head = await lstatOrNull(join(this.options.gitDir, 'HEAD'));
    if (head === null) {
      const init = await this.run(context, ['init', '--quiet', '--template=']);
      if (init.code !== 0) return `${FAILED_TEXT} (init).`;
    }
    // Zamkniecie aplikacji w trakcie polecenia zostawia `index.lock`; jedyny uzytkownik repozytorium to ta
    // kolejka, wiec zamek starszy niz kilka minut jest martwy i blokowalby kazdy nastepny commit.
    const lock = join(this.options.gitDir, 'index.lock');
    const lockInfo = await lstatOrNull(lock);
    if (lockInfo !== null && Date.now() - lockInfo.mtimeMs > STALE_LOCK_MS) {
      await rm(lock, { force: true });
    }
    const info = join(this.options.gitDir, 'info');
    await ensureDirectory(info, 0o700);
    const excluded = [...scan.byId]
      .filter(([, state]) => state !== 'included')
      .map(([id]) => `/items/${id}/`)
      .sort();
    const exclude = [
      '# cwm: elementy poza historia (prywatne, z sekretami albo nieczytelne)',
      ...excluded,
    ];
    await writeFileAtomic(
      join(info, 'exclude'),
      new TextEncoder().encode(`${exclude.join('\n')}\n`),
      {
        mode: 0o600,
      },
    );
    await writeFileAtomic(join(info, 'attributes'), new TextEncoder().encode(ATTRIBUTES), {
      mode: 0o600,
    });
    return null;
  }

  private async scan(includePrivate: boolean): Promise<ItemScan> {
    const byId = new Map<string, LibraryGitEligibility>();
    const counts = { included: 0, excludedPrivate: 0, excludedSecrets: 0, excludedUnreadable: 0 };
    const root = join(this.options.libraryDir, 'items');
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return { byId, counts };
    }
    for (const name of names.sort()) {
      if (!isItemId(name)) continue;
      const info = await lstatOrNull(join(root, name));
      if (info === null || !info.isDirectory()) continue;
      const state = await this.classify(join(root, name, 'item.json'), includePrivate);
      byId.set(name, state);
      if (state === 'included') counts.included += 1;
      else if (state === 'excluded-private') counts.excludedPrivate += 1;
      else if (state === 'excluded-secrets') counts.excludedSecrets += 1;
      else counts.excludedUnreadable += 1;
    }
    return { byId, counts };
  }

  private async classify(path: string, includePrivate: boolean): Promise<LibraryGitEligibility> {
    try {
      const read = await readChecked(path, MAX_ITEM_JSON_BYTES, { strict: true });
      if (read.kind !== 'ok') return 'excluded-unreadable';
      return libraryGitEligibility(
        JSON.parse(new TextDecoder().decode(read.bytes)),
        includePrivate,
      );
    } catch {
      return 'excluded-unreadable';
    }
  }
}

/** Identyfikator elementu ze sciezki `items/<id>/...` albo `null` dla czegokolwiek innego. */
function itemIdOf(path: string): string | null {
  const [root, id] = path.split('/');
  return root === 'items' && id !== undefined && isItemId(id) ? id : null;
}
