import { randomBytes } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';

import {
  checkGitTreeListing,
  GIT_COMMIT_PATTERN,
  gitAlgorithmOf,
  gitListedBlobIds,
  gitListedTreeIds,
  gitObjectId,
  gitRawObject,
  gitRefProblem,
  gitUrlProblem,
  parseGitCatFileBatch,
  planGitTree,
  verifyGitCopy,
} from '../../core/cwm';
import {
  gitObjectsDir,
  gitSourceDir,
  gitSourcesRoot,
  lookupGitSource,
  OBJECT_BYTES_LIMIT,
  OBJECTS_LIMIT,
  OBJECTS_TOTAL_LIMIT,
  verifyGitSourceCopy,
} from './git-source';
import type { CwmLayout } from './layout';
import {
  abortRunningGit,
  DISK_LIMIT,
  resolveGit,
  runGit,
  tidy,
  type RunContext,
  type RunResult,
} from './git-process';
import { networkDenied } from './network-guard';
import { lstatLoose } from './paths';
import { readDirLimited } from './read';
import { readTree, TREE_LIMITS, treeSha256 } from './runtime-sources';
import {
  ensureScopedDirectory,
  sourcesScope,
  installScopedTree,
  removeScopedTree,
  replaceScopedTree,
  type ScopedTreeFile,
  WriteDeniedError,
} from './writer';

/**
 * Jedyne miejsce w CWM, ktore siega do sieci i uruchamia `git` (ADR 0048). Wolane tylko z
 * `cwm plugin add git|fetch|update` i z importu z repozytorium Git w aplikacji (ADR 0058, jedyny
 * importer to `infra/git-import/git-import-source.ts`); `cwm start`, `cwm diff` i `cwm sync` tego
 * pliku nie importuja (regula lintu i proba w `scripts/verify-boundaries.mjs`).
 *
 * `git` idzie po sciezce bezwzglednej (po `realpath`, z kontrola wlasciciela i uprawnien jak plik
 * silnika), ze srodowiskiem od zera i opcjami `-c` z `core/cwm/git-source.ts`. Pobranie to `fetch
 * --depth=1` do pustego repozytorium w katalogu roboczym 0700; pliki powstaja z blobow odczytanych
 * przez `cat-file --batch` (bajty bez zmian, bez `checkout`), a o ich zgodnosci z commitem decyduje lancuch
 * skrotow z `core/cwm/git-objects.ts`. Na miejsce trafia katalog `<skrot adresu>/<commit>/` bez `.git` oraz
 * obok niego `<commit>.objects/` z surowymi obiektami commita i drzew (weryfikacja offline przy starcie).
 */

const TOTAL_MS = 300_000;
/** Obiekty z `cat-file --batch`: bloby do limitu drzewa plus drzewa i naglowki. */
const OBJECTS_STDOUT_LIMIT = TREE_LIMITS.bytes + 4 * 1024 * 1024;
const STALE_MS = 60 * 60 * 1000;

export { abortRunningGit };

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
  | { readonly ok: false; readonly message: string; readonly kind?: GitFetchFailureKind };

/**
 * Skad pochodzi odmowa: `git-missing` (brak uruchamialnego `git`), `process` (proces `git` zawiodl albo
 * zostal przerwany, komunikat moze zawierac wyjscie serwera i sciezke katalogu roboczego) i `content`
 * (kontrola CWM odrzucila adres, ref albo tresc commita; komunikat jest wlasny i bez sciezek). Brak pola to `content`.
 */
export type GitFetchFailureKind = 'git-missing' | 'process' | 'content';

export interface GitFetchInput {
  readonly layout: CwmLayout;
  readonly url: string;
  /** Galaz, tag albo pelny SHA; brak oznacza `HEAD` repozytorium. Ignorowany, gdy podano `commit`. */
  readonly ref: string | null;
  /** Przypiety commit: pobierany wprost po SHA, wynik musi byc rowny. */
  readonly commit: string | null;
}

/** Katalogi `.tmp-*` po przerwanym pobieraniu starsze niz godzina. */
async function sweepStale(layout: CwmLayout): Promise<void> {
  const root = gitSourcesRoot(layout);
  const scope = sourcesScope(layout.home, gitSourcesRoot(layout));
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
  if (!git.ok) return { ok: false, message: git.reason, kind: 'git-missing' };

  const scope = sourcesScope(input.layout.home, gitSourcesRoot(input.layout));
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
  const scope = sourcesScope(input.layout.home, gitSourcesRoot(input.layout));
  const context: RunContext = {
    git,
    scratch,
    allowHttp: new URL(input.url).protocol === 'http:',
    deadline: Date.now() + TOTAL_MS,
  };
  const work = join(scratch, 'work');

  const describe = (what: string, run: RunResult): GitFetchResult => ({
    ok: false,
    kind: 'process',
    message: `${what}: ${run.aborted ?? (tidy(run.stderr) || `git zakonczyl sie kodem ${run.code ?? '?'}`)}`,
  });

  // Format skrotow repozytorium roboczego musi byc taki jak na serwerze. Przypiety commit go wskazuje
  // (40 albo 64 znaki); bez niego proba SHA-1, a SHA-256 po komunikacie o niezgodnych algorytmach.
  const pinned = input.commit === null ? null : gitAlgorithmOf(input.commit);
  const formats: readonly ('sha1' | 'sha256')[] = pinned === null ? ['sha1', 'sha256'] : [pinned];
  const refspec = input.commit ?? input.ref ?? 'HEAD';
  let repo = '';
  for (const [index, format] of formats.entries()) {
    repo = join(scratch, `repo-${format}`);
    const init = await runGit(
      context,
      [
        'init',
        '--quiet',
        '--template=',
        ...(format === 'sha256' ? ['--object-format=sha256'] : []),
        repo,
      ],
      { cwd: scratch },
    );
    if (init.code !== 0) return describe('nie udalo sie przygotowac katalogu roboczego', init);
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
    if (fetched.code === 0) break;
    const retry = index < formats.length - 1 && /mismatched algorithms/i.test(fetched.stderr);
    if (!retry) return describe('pobieranie nie powiodlo sie', fetched);
  }

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

  const limits = {
    files: TREE_LIMITS.files,
    fileBytes: TREE_LIMITS.fileBytes,
    bytes: TREE_LIMITS.bytes,
  };
  const listing = await runGit(context, ['ls-tree', '-r', '-t', '-l', '-z', commit], {
    cwd: repo,
  });
  if (listing.code !== 0) return describe('nie udalo sie odczytac listy plikow', listing);
  const checked = checkGitTreeListing(listing.stdout, limits);
  if (!checked.ok) return fail(`repozytorium nie nadaje sie na plugin: ${checked.message}`);

  // Surowe obiekty: commit, drzewa i bloby. Lista z `ls-tree` tylko wskazuje, co pobrac; o tym, co trafi
  // na dysk, decyduje lancuch skrotow od commita sprawdzony w core (planGitTree, verifyGitCopy).
  const treeIds = gitListedTreeIds(listing.stdout);
  const blobIds = gitListedBlobIds(listing.stdout);
  if ([...treeIds, ...blobIds].some((id) => id.length !== commit.length)) {
    return fail('repozytorium nie nadaje sie na plugin: niezgodny format skrotow obiektow');
  }
  const batch = await runGit(context, ['cat-file', '--batch'], {
    cwd: repo,
    input: `${[commit, `${commit}^{tree}`, ...treeIds, ...blobIds].join('\n')}\n`,
    stdoutLimit: OBJECTS_STDOUT_LIMIT,
  });
  if (batch.code !== 0) return describe('nie udalo sie odczytac obiektow', batch);
  const objects = parseGitCatFileBatch(batch.stdoutBytes, commit.length);
  if (!objects.ok) return fail(`repozytorium nie nadaje sie na plugin: ${objects.message}`);
  const chain = new Map<string, Uint8Array>();
  const blobs = new Map<string, Uint8Array>();
  for (const object of objects.objects) {
    if (object.type === 'blob') blobs.set(object.id, object.body);
    else if (object.type === 'commit' || object.type === 'tree') {
      chain.set(object.id, gitRawObject(object.type, object.body));
    } else return fail('repozytorium nie nadaje sie na plugin: nieoczekiwany typ obiektu');
  }
  const plan = planGitTree(commit, chain, limits);
  if (!plan.ok) return fail(`repozytorium nie nadaje sie na plugin: ${plan.message}`);
  const stored = new Map([...chain].filter(([id]) => plan.objectIds.has(id)));

  // Zapis dokladnych bajtow bloba: bez atrybutow, filtrow i konwersji konca linii (nie ma tu `checkout`).
  const algorithm = gitAlgorithmOf(commit) ?? 'sha1';
  const staged: ScopedTreeFile[] = [];
  for (const entry of plan.entries) {
    const blob = blobs.get(entry.id);
    if (blob === undefined || gitObjectId(algorithm, 'blob', blob) !== entry.id) {
      return fail('repozytorium nie nadaje sie na plugin: brak albo uszkodzony blob');
    }
    staged.push({ rel: entry.rel, bytes: blob, executable: entry.executable });
  }
  // Te same limity obiektow co przy odczycie (`readGitObjects`): inaczej fetch przyjalby kopie, ktora start odrzuci.
  let storedBytes = 0;
  for (const raw of stored.values()) {
    storedBytes += raw.length;
    if (raw.length > OBJECT_BYTES_LIMIT) {
      return fail('repozytorium nie nadaje sie na plugin: obiekt drzewa wiekszy niz 1 MiB');
    }
  }
  if (stored.size > OBJECTS_LIMIT || storedBytes > OBJECTS_TOTAL_LIMIT) {
    return fail(
      'repozytorium nie nadaje sie na plugin: za duzo obiektow drzew (limit 1000 i 16 MiB)',
    );
  }
  const objectsStage = join(scratch, 'objects');
  try {
    await replaceScopedTree(scope, work, staged);
    await replaceScopedTree(
      scope,
      objectsStage,
      [...stored].map(([id, raw]) => ({ rel: id, bytes: raw, executable: false })),
    );
  } catch (error: unknown) {
    // Odmowa writera (WriteDeniedError) idzie do wolajacego; reszta (np. zbyt dluga nazwa) to blad repozytorium.
    if (error instanceof WriteDeniedError) throw error;
    return fail('nie udalo sie zapisac plikow kopii (zbyt dluga nazwa albo blad zapisu)');
  }

  const tree = await readTree(work, undefined, { rejectHardlinks: true });
  if (!tree.ok) return fail(`repozytorium nie nadaje sie na plugin: ${tree.message}`);
  const verdict = verifyGitCopy(commit, stored, tree.files, limits);
  if (!verdict.ok) return fail(`kopia nie zgadza sie z commitem: ${verdict.message}`);
  const hash = treeSha256(tree.files);

  const dir = gitSourceDir(input.layout, input.url, commit);
  const existing = await lookupGitSource(input.layout, input.url, commit);
  if (existing.ok) {
    const current = await readTree(existing.dir, undefined, { rejectHardlinks: true });
    if (
      current.ok &&
      treeSha256(current.files) === hash &&
      (await verifyGitSourceCopy(input.layout, input.url, commit, current.files)).ok
    ) {
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
  // Najpierw kopia, potem obiekty; gdy obiekty sie nie zapisza, kopia jest wycofywana (nie zostaje bez obiektow).
  await installScopedTree(scope, work, dir);
  try {
    await installScopedTree(scope, objectsStage, gitObjectsDir(input.layout, input.url, commit));
  } catch (error: unknown) {
    await removeScopedTree(scope, dir).catch(() => false);
    throw error;
  }
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
