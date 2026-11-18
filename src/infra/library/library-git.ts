import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  libraryGitEligibility,
  libraryGitSubject,
  LIBRARY_GIT_AUTHOR,
  type LibraryGitEligibility,
  type LibraryGitOperation,
} from '../../core/model/library-git';
import {
  MAX_FILE_BYTES,
  MAX_ITEM_BYTES,
  MAX_ITEM_JSON_BYTES,
  MAX_TREE_DEPTH,
} from '../../core/model/library-limits';
import { isItemId } from '../../core/ports/id-generator';
import type {
  LibraryGit,
  LibraryGitAvailability,
  LibraryGitStatus,
  LibraryGitSyncResult,
} from '../../core/ports/library-git';
import { classifyStrict } from '../../core/services/security/secret-classifier';
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

const COMMAND_MS = 15_000;
/** Laczny limit jednej synchronizacji; dluzsza (np. pierwsza na bardzo duzej bibliotece) konczy sie ostrzezeniem. */
const SYNC_MS = 20_000;
/** Spis plikow i zmian moze byc duzy; limit domyslny (4 MiB) konczylby synchronizacje na stale. */
const LIST_STDOUT_LIMIT = 64 * 1024 * 1024;
const MAX_ITEM_FILES = 2_000;
const MAX_LOCK_DEPTH = 8;
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
  // Konfiguracja repozytorium jest przepisywana z szablonu przed kazdym poleceniem; te opcje zamykaja
  // reszte: zewnetrzne programy z konfiguracji i wyjscie, ktore nie ma sie uruchomic (`include.path` nie da sie
  // wyczyscic z wiersza polecen, wiec o brak includow dbamy szablonem).
  'gpg.program=/dev/null',
  'log.showSignature=false',
  'diff.external=',
  'core.pager=cat',
  'core.sshCommand=/dev/null',
  'core.gitProxy=',
  'core.worktree=',
];
const EXTRA_ENV: Readonly<Record<string, string>> = { GIT_LITERAL_PATHSPECS: '1' };
/** Pliki, ktorych obecnosc w magazynie oznacza wspolny katalog obiektow albo przekierowanie: odmowa. */
const FORBIDDEN_GIT_DIR_FILES = ['commondir', 'gitdir', join('objects', 'info', 'alternates')];
const CONFIG_TEMPLATE =
  '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = false\n';
const REFUSED_TEXT =
  'Repozytorium biblioteki zawiera pliki przekierowujące (commondir, gitdir albo alternates), więc Git nie został uruchomiony.';

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

type ItemVerdict = LibraryGitEligibility;

const MISSING_GIT_TEXT =
  'Git nie jest dostępny w tym systemie, więc wersjonowanie biblioteki jest niedostępne. Reszta aplikacji działa bez zmian.';
const FAILED_TEXT = 'Polecenie git nie powiodło się';

export class FsLibraryGit implements LibraryGit {
  /** Liczba trwajacych polecen `git`; zamki sprzata sie tylko przy zerze (kolejka jest jedynym pisarzem). */
  private running = 0;

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

  async status(includePrivate: boolean, scanItems: boolean): Promise<LibraryGitStatus> {
    const scan = scanItems ? await this.scan(includePrivate) : null;
    const empty: LibraryGitStatus = {
      repository: false,
      commits: 0,
      last: null,
      items: scan?.counts ?? ZERO_COUNTS,
    };
    if ((await lstatOrNull(join(this.options.gitDir, 'HEAD'))) === null) return empty;
    const found = { ...empty, repository: true };
    const prepared = await this.context(COMMAND_MS);
    if (!prepared.ok) return found;
    if ((await this.prepareExisting()) !== null) return found;
    const context = prepared.context;
    const count = await this.run(context, ['rev-list', '--count', 'HEAD']);
    const commits = count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) : 0;
    const last = await this.run(context, ['log', '-1', '--format=%cI|%s']);
    const line = last.code === 0 ? last.stdout.trim() : '';
    const split = line.indexOf('|');
    return {
      ...found,
      commits: Number.isInteger(commits) ? commits : 0,
      last: split > 0 ? { at: line.slice(0, split), subject: line.slice(split + 1) } : null,
    };
  }

  async sync(input: {
    readonly operation: LibraryGitOperation;
    readonly includePrivate: boolean;
    readonly guard?: () => (() => void) | null;
  }): Promise<LibraryGitSyncResult> {
    try {
      return await this.doSync(input.operation, input.includePrivate, input.guard);
    } catch {
      return { ok: false, message: FAILED_TEXT };
    }
  }

  private async doSync(
    operation: LibraryGitOperation,
    includePrivate: boolean,
    guard: (() => (() => void) | null) | undefined,
  ): Promise<LibraryGitSyncResult> {
    const prepared = await this.context(SYNC_MS);
    if (!prepared.ok) return { ok: false, message: prepared.message };
    const context = prepared.context;
    const refused = await this.prepareExisting();
    if (refused !== null) return { ok: false, message: refused };

    // Blokada zapisu tylko na czas skanu i stagingu: commit idzie poza nia.
    let release: (() => void) | null = null;
    if (guard !== undefined) {
      release = guard();
      if (release === null) return { ok: true, committed: false, items: 0, skipped: true };
    }
    let items: number | undefined;
    try {
      await this.removeStaleLocks();
      const scan = await this.scan(includePrivate);
      const repositoryProblem = await this.ensureRepository(context, scan);
      if (repositoryProblem !== null) return { ok: false, message: repositoryProblem };

      const included = [...scan.byId].filter(([, state]) => state === 'included').map(([id]) => id);
      const tracked = await this.run(context, ['ls-files', '-z'], {
        stdoutLimit: LIST_STDOUT_LIMIT,
      });
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

      const staged = await this.run(context, ['diff', '--cached', '--name-only', '-z'], {
        stdoutLimit: LIST_STDOUT_LIMIT,
      });
      if (staged.code !== 0) return this.failure('diff', staged);
      if (staged.stdout === '') return { ok: true, committed: false, items: 0 };
      const changed = new Set<string>();
      for (const path of staged.stdout.split('\0')) {
        const id = itemIdOf(path);
        if (id !== null) changed.add(id);
      }
      // Wpisy poza `items/<id>` (zdjete z indeksu) nie sa elementami; commit i tak je zapisuje.
      items = changed.size;
    } finally {
      release?.();
    }
    if (items === undefined) return { ok: false, message: FAILED_TEXT };
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
        extraEnv: EXTRA_ENV,
      },
    };
  }

  private async run(
    context: RunContext,
    args: readonly string[],
    extra: { readonly input?: string; readonly stdoutLimit?: number } = {},
  ): Promise<RunResult> {
    this.running += 1;
    try {
      return await runGit(context, args, {
        cwd: this.options.libraryDir,
        repository: { gitDir: this.options.gitDir, workTree: this.options.libraryDir },
        ...extra,
      });
    } finally {
      this.running -= 1;
    }
  }

  /**
   * Przed kazdym uruchomieniem `git` w istniejacym magazynie: odmowa, gdy w nim pliki przekierowujace
   * (`commondir`, `gitdir`, `objects/info/alternates`), i przepisanie `config` z szablonu, zeby opcje
   * wpisane tam z zewnatrz (hooki, filtry, programy, `include`) nigdy nie byly czytane. Brak magazynu to OK.
   */
  private async prepareExisting(): Promise<string | null> {
    if ((await lstatOrNull(join(this.options.gitDir, 'HEAD'))) === null) return null;
    for (const name of FORBIDDEN_GIT_DIR_FILES) {
      if ((await lstatOrNull(join(this.options.gitDir, name))) !== null) return REFUSED_TEXT;
    }
    await this.writeConfig();
    return null;
  }

  private async writeConfig(): Promise<void> {
    const path = join(this.options.gitDir, 'config');
    let current: string | null;
    try {
      current = await readFile(path, 'utf8');
    } catch {
      current = null;
    }
    if (current !== CONFIG_TEMPLATE) {
      await writeFileAtomic(path, new TextEncoder().encode(CONFIG_TEMPLATE), { mode: 0o600 });
    }
  }

  /**
   * Zamek zostawiony po zabitym poleceniu (`index.lock`, `HEAD.lock`, `refs/**\/*.lock`, `packed-refs.lock`,
   * `shallow.lock`) blokowalby kazdy nastepny commit. Kolejka tego procesu jest jedynym pisarzem, a odczyty
   * stanu nie biora zamkow, wiec gdy zaden `git` nie dziala, kazdy zamek jest martwy.
   */
  private async removeStaleLocks(): Promise<void> {
    if (this.running !== 0) return;
    const stack: { dir: string; depth: number }[] = [{ dir: this.options.gitDir, depth: 0 }];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      let entries;
      try {
        entries = await readdir(next.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = join(next.dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== SCRATCH_DIR && next.depth < MAX_LOCK_DEPTH) {
            stack.push({ dir: path, depth: next.depth + 1 });
          }
        } else if (entry.name.endsWith('.lock')) {
          await rm(path, { force: true });
        }
      }
    }
  }

  /** Tworzy repozytorium przy pierwszym uzyciu i odswieza pliki `info/` zgodnie z aktualna zasada. */
  private async ensureRepository(context: RunContext, scan: ItemScan): Promise<string | null> {
    const head = await lstatOrNull(join(this.options.gitDir, 'HEAD'));
    if (head === null) {
      const init = await this.run(context, ['init', '--quiet', '--template=']);
      if (init.code !== 0) return `${FAILED_TEXT} (init).`;
      const refused = await this.prepareExisting();
      if (refused !== null) return refused;
    }
    const info = join(this.options.gitDir, 'info');
    await ensureDirectory(info, 0o700);
    const excluded = [...scan.byId]
      .filter(([, state]) => state !== 'included')
      .map(([id]) => `/items/${id}/`)
      .sort();
    const exclude = [
      '# cwm: elementy poza historia (prywatne, z sekretami, z wpisem .git albo nieczytelne)',
      ...excluded,
    ];
    await writeFileAtomic(
      join(info, 'exclude'),
      new TextEncoder().encode(`${exclude.join('\n')}\n`),
      { mode: 0o600 },
    );
    await writeFileAtomic(join(info, 'attributes'), new TextEncoder().encode(ATTRIBUTES), {
      mode: 0o600,
    });
    return null;
  }

  private async scan(includePrivate: boolean): Promise<ItemScan> {
    const byId = new Map<string, LibraryGitEligibility>();
    const counts = { ...ZERO_COUNTS };
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
      const state = await this.classify(join(root, name), includePrivate);
      byId.set(name, state);
      if (state === 'included') counts.included += 1;
      else if (state === 'excluded-private') counts.excludedPrivate += 1;
      else if (state === 'excluded-secrets') counts.excludedSecrets += 1;
      else if (state === 'excluded-git-entry') counts.excludedGitEntry += 1;
      else counts.excludedUnreadable += 1;
    }
    return { byId, counts };
  }

  /**
   * `item.json` mowi, co element deklaruje, ale `secretFindings` bywa nieaktualne (edycja po imporcie, plik
   * zmieniony na dysku). O wejsciu do historii decyduje wiec dodatkowo swiezy skan calej tresci elementu
   * (`classifyStrict`, jak w archiwum ZIP): wszystkie pliki, w tym tytul i opis w `item.json`, tresc, pliki
   * pomocnicze i snapshoty. Plik albo katalog `.git` gdziekolwiek, dowiazanie i przekroczenie limitow
   * wykluczaja element.
   */
  private async classify(itemDir: string, includePrivate: boolean): Promise<ItemVerdict> {
    try {
      const read = await readChecked(join(itemDir, 'item.json'), MAX_ITEM_JSON_BYTES, {
        strict: true,
      });
      if (read.kind !== 'ok') return 'excluded-unreadable';
      const declared = libraryGitEligibility(
        JSON.parse(new TextDecoder().decode(read.bytes)),
        includePrivate,
      );
      if (declared !== 'included') return declared;
      return await this.scanContent(itemDir);
    } catch {
      return 'excluded-unreadable';
    }
  }

  private async scanContent(itemDir: string): Promise<ItemVerdict> {
    const files: { relPath: string; bytes: Uint8Array }[] = [];
    let total = 0;
    const stack: { dir: string; rel: string; depth: number }[] = [
      { dir: itemDir, rel: '', depth: 0 },
    ];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (next.depth > MAX_TREE_DEPTH) return 'excluded-unreadable';
      const entries = await readdir(next.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.toLowerCase() === '.git') return 'excluded-git-entry';
        const rel = next.rel === '' ? entry.name : `${next.rel}/${entry.name}`;
        const path = join(next.dir, entry.name);
        if (entry.isDirectory()) {
          stack.push({ dir: path, rel, depth: next.depth + 1 });
        } else if (entry.isFile()) {
          if (files.length >= MAX_ITEM_FILES) return 'excluded-unreadable';
          const read = await readChecked(path, MAX_FILE_BYTES, { strict: true });
          if (read.kind !== 'ok') return 'excluded-unreadable';
          total += read.bytes.byteLength;
          if (total > MAX_ITEM_BYTES) return 'excluded-unreadable';
          files.push({ relPath: rel, bytes: read.bytes });
        } else {
          // Dowiazanie albo plik specjalny: magazyn elementow ich nie tworzy, wiec to cudza ingerencja.
          return 'excluded-unreadable';
        }
      }
    }
    return classifyStrict(files).length > 0 ? 'excluded-secrets' : 'included';
  }
}

const ZERO_COUNTS = {
  included: 0,
  excludedPrivate: 0,
  excludedSecrets: 0,
  excludedGitEntry: 0,
  excludedUnreadable: 0,
};

/** Identyfikator elementu ze sciezki `items/<id>/...` albo `null` dla czegokolwiek innego. */
function itemIdOf(path: string): string | null {
  const [root, id] = path.split('/');
  return root === 'items' && id !== undefined && isItemId(id) ? id : null;
}
