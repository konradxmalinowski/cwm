import { dirname, join } from 'node:path';

import { sanitizeGitUrl } from '../../core/cwm';
import { type CwmLayout } from './layout';
import { lstatLoose } from './paths';
import { currentUid, trustedDirectory } from './marketplace';
import { readDirLimited } from './read';
import { sha256Hex } from './runtime-sources';
import { homeScope, removeScopedTree } from './writer';

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
  const scope = homeScope(layout.home);
  const dir = gitSourceDir(layout, url, commit);
  const removed = await removeScopedTree(scope, dir);
  const parent = dirname(dir);
  const left = await readDirLimited(parent, 1).catch(() => null);
  if (left !== null && left.entries.length === 0) await removeScopedTree(scope, parent);
  return removed;
}
