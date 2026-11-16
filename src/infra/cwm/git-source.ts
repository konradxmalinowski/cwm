import { dirname, join } from 'node:path';

import { gitAlgorithmOf, sanitizeGitUrl, verifyGitCopy } from '../../core/cwm';
import { readChecked } from '../fs/bounded-read';
import { type CwmLayout } from './layout';
import { lstatLoose } from './paths';
import { currentUid, trustedDirectory } from './marketplace';
import { readDirLimited } from './read';
import { sha256Hex, TREE_LIMITS, type TreeFile } from './runtime-sources';
import { removeScopedTree, sourcesScope } from './writer';

/**
 * Lokalne kopie pluginow z git (ADR 0048): sciezki i kontrola zaufania. Tylko odczyt, zadnych
 * procesow i sieci; pobieranie jest w `git-fetch.ts` i nie jest eksportowane z `index.ts`, zeby
 * `cwm start`, `cwm diff` i `cwm sync` nie mialy do niego drogi.
 */

/** `~/.cwm/sources/git`: kopie sa w `<skrot adresu>/<commit>/`, bez `.git`. */
export const gitSourcesRoot = (layout: CwmLayout): string => join(layout.sourcesDir, 'git');

/** Klucz katalogu repozytorium: 16 znakow skrotu adresu bez danych logowania. */
export function gitSourceKey(url: string): string {
  return sha256Hex(sanitizeGitUrl(url)).slice(0, 16);
}

export const gitSourceDir = (layout: CwmLayout, url: string, commit: string): string =>
  join(gitSourcesRoot(layout), gitSourceKey(url), commit);

/**
 * Surowe obiekty commita i drzew (z naglowkiem typu, bez kompresji), plik na obiekt o nazwie rownej
 * skrotowi. Katalog obok kopii, nie w niej: nie trafia do migawki pluginu ani do profilu.
 */
export const gitObjectsDir = (layout: CwmLayout, url: string, commit: string): string =>
  join(gitSourcesRoot(layout), gitSourceKey(url), `${commit}.objects`);

export type GitSourceLookup =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly missing: boolean; readonly reason: string };

/**
 * Kopia musi istniec, kazdy skladnik sciezki od `sources/` w dol to zwykly katalog (dowiazanie to
 * odmowa), a sama kopia nalezy do uzytkownika i nie jest zapisywalna dla grupy i innych.
 */
export async function lookupGitSource(
  layout: CwmLayout,
  url: string,
  commit: string,
): Promise<GitSourceLookup> {
  const dir = gitSourceDir(layout, url, commit);
  let current = layout.sourcesDir;
  for (const part of ['git', gitSourceKey(url), commit]) {
    current = join(current, part);
    let info: Awaited<ReturnType<typeof lstatLoose>>;
    try {
      info = await lstatLoose(current);
    } catch {
      return { ok: false, missing: false, reason: 'sciezka kopii zrodla jest nieczytelna' };
    }
    if (info === null) return { ok: false, missing: true, reason: 'brak lokalnej kopii zrodla' };
    if (info.isSymbolicLink()) {
      return { ok: false, missing: false, reason: 'dowiazanie symboliczne na sciezce kopii' };
    }
    if (!info.isDirectory()) {
      return { ok: false, missing: false, reason: 'skladnik sciezki kopii nie jest katalogiem' };
    }
  }
  const problem = await trustedDirectory(dir, currentUid());
  if (problem !== null) return { ok: false, missing: false, reason: `kopia zrodla: ${problem}` };
  return { ok: true, dir };
}

/** Limity zapisanych obiektow: te same przy zapisie (`git-fetch.ts`) i przy odczycie, zeby `fetch` nie przyjal tego, co start odrzuci. */
export const OBJECTS_LIMIT = 1000;
export const OBJECT_BYTES_LIMIT = 1024 * 1024;
export const OBJECTS_TOTAL_LIMIT = 16 * 1024 * 1024;

export type GitObjectsRead =
  | { readonly ok: true; readonly objects: Map<string, Uint8Array> }
  | { readonly ok: false; readonly missing: boolean; readonly reason: string };

/** Wczytuje zapisane obiekty commita i drzew. Tylko zwykle pliki o nazwie rownej skrotowi, w katalogu uzytkownika. */
export async function readGitObjects(
  layout: CwmLayout,
  url: string,
  commit: string,
): Promise<GitObjectsRead> {
  const fail = (reason: string, missing = false): GitObjectsRead => ({
    ok: false,
    missing,
    reason,
  });
  const dir = gitObjectsDir(layout, url, commit);
  const info = await lstatLoose(dir).catch(() => undefined);
  if (info === undefined) return fail('katalog obiektow kopii jest nieczytelny');
  if (info === null) return fail('brak zapisanych obiektow commita', true);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return fail('obiekty kopii: dowiazanie albo nie katalog');
  }
  const problem = await trustedDirectory(dir, currentUid());
  if (problem !== null) return fail(`obiekty kopii: ${problem}`);
  const algorithm = gitAlgorithmOf(commit);
  if (algorithm === null) return fail('przypiety commit nie jest pelnym SHA');
  const listing = await readDirLimited(dir, OBJECTS_LIMIT).catch(() => null);
  if (listing === null || listing.truncated) return fail('katalog obiektow kopii jest nieczytelny');
  const pattern = algorithm === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  const objects = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of listing.entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) {
      return fail('obiekty kopii: nieoczekiwany wpis w katalogu');
    }
    const read = await readChecked(join(dir, entry.name), OBJECT_BYTES_LIMIT, {
      strict: true,
    }).catch(() => null);
    if (read === null || read.kind !== 'ok') return fail('obiekty kopii: nieczytelny plik');
    total += read.bytes.length;
    if (total > OBJECTS_TOTAL_LIMIT) return fail('obiekty kopii: lacznie wiecej niz 16 MiB');
    objects.set(entry.name, read.bytes);
  }
  return { ok: true, objects };
}

export type GitCopyCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: boolean; readonly message: string };

/**
 * Kopia (juz wczytana jako `files`) zgadza sie z przypietym commitem: skrot commita, lancuch drzew i
 * blobow z zapisanych obiektow (czysty JS, bez `git` i sieci). `missing` oznacza kopie sprzed tej
 * kontroli (bez obiektow): to migracja, nie podmiana.
 */
export async function verifyGitSourceCopy(
  layout: CwmLayout,
  url: string,
  commit: string,
  files: readonly TreeFile[],
): Promise<GitCopyCheck> {
  const objects = await readGitObjects(layout, url, commit);
  if (!objects.ok) return { ok: false, missing: objects.missing, message: objects.reason };
  const verdict = verifyGitCopy(commit, objects.objects, files, {
    files: TREE_LIMITS.files,
    fileBytes: TREE_LIMITS.fileBytes,
    bytes: TREE_LIMITS.bytes,
  });
  return verdict.ok ? { ok: true } : { ok: false, missing: false, message: verdict.message };
}

/**
 * Usuwa kopie `<skrot adresu>/<commit>/` (i pusty katalog repozytorium), gdy `stillUsed` mowi, ze
 * zaden zasob jej nie uzywa. Wolane po `plugin remove` i `plugin update`. Zwraca true, gdy cos usunieto.
 */
export async function pruneGitSource(
  layout: CwmLayout,
  url: string,
  commit: string,
  stillUsed: (url: string, commit: string) => boolean,
): Promise<boolean> {
  if (stillUsed(url, commit)) return false;
  const scope = sourcesScope(layout.home, gitSourcesRoot(layout));
  const dir = gitSourceDir(layout, url, commit);
  const removed = await removeScopedTree(scope, dir);
  await removeScopedTree(scope, gitObjectsDir(layout, url, commit)).catch(() => false);
  const parent = dirname(dir);
  const left = await readDirLimited(parent, 1).catch(() => null);
  if (left !== null && left.entries.length === 0) await removeScopedTree(scope, parent);
  return removed;
}
