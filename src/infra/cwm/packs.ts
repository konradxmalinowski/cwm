import { join } from 'node:path';

import {
  API_VERSION,
  ID_NAME_PATTERN,
  ID_SPACE_PATTERN,
  memberKey,
  namespaceOf,
  packMemberHash,
  validatePackManifest,
  validatePackTrustFile,
  type PackManifest,
  type PackMemberRecord,
  type PackMemberRef,
  type PackTrustFile,
} from '../../core/cwm';
import { lstatLoose } from './paths';
import { listDirectory, readManifest, readTextWithin } from './read';
import { acquireMutex, openRuntimeRoot } from './runtime-fs';
import { toYaml } from './serialize';
import type { CwmLayout } from './layout';
import {
  ensureScopedDirectory,
  homeScope,
  removeScopedFile,
  renameScopedFile,
  WriteDeniedError,
  writeScopedFile,
} from './writer';

/**
 * Pakiety w `~/.cwm` (ADR 0044):
 *   packs/<przestrzen>/<nazwa>.yaml               definicja (lista czlonkow), dane do edycji
 *   approvals/packs/<przestrzen>/<nazwa>.json     zaufane skroty czlonkow, zapisuje tylko CWM
 * Zaufane skroty leza obok zatwierdzen firm (te same uprawnienia i sprawdzenia wlasciciela), ale w
 * podkatalogu, wiec `approvals/<firma>.yaml` i lista firm sie nie myla. Zapis zaufanych skrotow idzie
 * pod mutexem `runtime/global` (`global` nie moze byc nazwa firmy, wiec nie koliduje z zadna firma).
 */

const MAX_TRUST_BYTES = 8 * 1024 * 1024;
const LOCK_COMPANY = 'global';

export const packsDir = (layout: CwmLayout): string => join(layout.home, 'packs');
export const packTrustDir = (layout: CwmLayout): string => join(layout.home, 'approvals', 'packs');

export function splitPackId(id: string): { namespace: string; name: string } | null {
  const slash = id.indexOf('/');
  if (slash < 0) return null;
  const namespace = id.slice(0, slash);
  const name = id.slice(slash + 1);
  return ID_SPACE_PATTERN.test(namespace) && ID_NAME_PATTERN.test(name)
    ? { namespace, name }
    : null;
}

function checkedId(id: string): { namespace: string; name: string } {
  const parts = splitPackId(id);
  if (parts === null) throw new WriteDeniedError(`Niepoprawne id pakietu: "${id}".`);
  return parts;
}

export function packFile(layout: CwmLayout, id: string): string {
  const { namespace, name } = checkedId(id);
  return join(packsDir(layout), namespace, `${name}.yaml`);
}

export function packTrustFile(layout: CwmLayout, id: string): string {
  const { namespace, name } = checkedId(id);
  return join(packTrustDir(layout), namespace, `${name}.json`);
}

export interface PackDefs {
  readonly packs: ReadonlyMap<string, PackManifest>;
  /** Klucz zasobu (`rodzaj:id`) -> id pakietu. Zasob zadeklarowany w dwoch pakietach nie ma pakietu. */
  readonly membership: ReadonlyMap<string, string>;
  readonly problems: readonly string[];
}

/** Wczytuje definicje pakietow. Blad jednego pliku nie psuje reszty; sporny zasob zostaje bez pakietu. */
export async function loadPackDefs(layout: CwmLayout): Promise<PackDefs> {
  const packs = new Map<string, PackManifest>();
  const problems: string[] = [];
  const root = packsDir(layout);
  const spaces = await listDirectory(layout.home, root);
  if (!spaces.ok) return { packs, membership: new Map(), problems: [spaces.message] };
  for (const space of spaces.entries) {
    if (space.name.startsWith('.')) continue;
    if (space.kind !== 'dir' || !ID_SPACE_PATTERN.test(space.name)) {
      problems.push(`packs/${space.name}: oczekiwano katalogu przestrzeni nazw.`);
      continue;
    }
    const files = await listDirectory(layout.home, join(root, space.name));
    if (!files.ok) {
      problems.push(`packs/${space.name}: ${files.message}`);
      continue;
    }
    for (const entry of files.entries) {
      if (entry.name.startsWith('.') || !entry.name.endsWith('.yaml')) continue;
      const name = entry.name.slice(0, -'.yaml'.length);
      const label = `packs/${space.name}/${entry.name}`;
      if (entry.kind !== 'file' || !ID_NAME_PATTERN.test(name)) {
        problems.push(`${label}: oczekiwano zwyklego pliku z poprawna nazwa pakietu.`);
        continue;
      }
      const loaded = await readManifest(
        layout.home,
        join(root, space.name, entry.name),
        validatePackManifest,
      );
      if (!loaded.ok) {
        problems.push(`${label}: ${loaded.problems[0]?.message ?? 'blad odczytu'}`);
        continue;
      }
      if (loaded.value.metadata.id !== `${space.name}/${name}`) {
        problems.push(`${label}: id pakietu nie zgadza sie z polozeniem pliku.`);
        continue;
      }
      packs.set(loaded.value.metadata.id, loaded.value);
    }
  }
  const owners = new Map<string, string[]>();
  for (const [id, manifest] of packs) {
    for (const ref of manifest.spec.members) {
      const key = memberKey(ref.kind, ref.id);
      owners.set(key, [...(owners.get(key) ?? []), id]);
    }
  }
  const membership = new Map<string, string>();
  for (const [key, ids] of owners) {
    const [only] = ids;
    if (ids.length === 1 && only !== undefined) membership.set(key, only);
    else
      problems.push(
        `${key}: zasob jest w wielu pakietach (${ids.join(', ')}); zostaje bez pakietu.`,
      );
  }
  return { packs, membership, problems };
}

function manifestDocument(manifest: PackManifest): unknown {
  return {
    apiVersion: API_VERSION,
    kind: 'Pack',
    metadata: { id: manifest.metadata.id },
    spec: { members: manifest.spec.members.map((ref) => memberKey(ref.kind, ref.id)) },
  };
}

/** Zapis definicji tylko wtedy, gdy przejdzie ten sam walidator co odczyt. */
export async function savePackDef(layout: CwmLayout, manifest: PackManifest): Promise<void> {
  const checked = validatePackManifest(
    JSON.parse(JSON.stringify(manifestDocument(manifest))) as unknown,
  );
  if (!checked.ok) throw new WriteDeniedError('Definicja pakietu nie przechodzi walidacji.');
  const scope = homeScope(layout.home);
  const file = packFile(layout, manifest.metadata.id);
  await ensureScopedDirectory(scope, join(file, '..'));
  await writeScopedFile(scope, file, toYaml(manifestDocument(manifest)));
}

export function newPack(id: string, members: readonly PackMemberRef[]): PackManifest {
  return {
    apiVersion: API_VERSION,
    kind: 'Pack',
    metadata: { id },
    spec: {
      members: [...members].sort((a, b) =>
        memberKey(a.kind, a.id) < memberKey(b.kind, b.id) ? -1 : 1,
      ),
    },
  };
}

export async function removePackDef(layout: CwmLayout, id: string): Promise<boolean> {
  return removeScopedFile(homeScope(layout.home), packFile(layout, id));
}

export type PackTrustLoad =
  | { readonly state: 'ok'; readonly file: PackTrustFile }
  | { readonly state: 'missing' }
  | { readonly state: 'corrupt'; readonly message: string };

/**
 * Odczyt zaufanych skrotow pakietu: te same sprawdzenia co plik zatwierdzen firmy (zwykly plik,
 * wlasciciel, brak zapisu dla grupy i innych) i ostry walidator ze skrotami liczonymi z pol.
 * Uszkodzony plik to `corrupt`: nic z pakietu nie jest zatwierdzone.
 */
export async function loadPackTrust(layout: CwmLayout, id: string): Promise<PackTrustLoad> {
  if (splitPackId(id) === null) return { state: 'corrupt', message: 'Niepoprawne id pakietu.' };
  const file = packTrustFile(layout, id);
  const info = await lstatLoose(file);
  if (info === null) return { state: 'missing' };
  if (!info.isFile())
    return { state: 'corrupt', message: 'Zaufany skrot pakietu nie jest zwyklym plikiem.' };
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      return { state: 'corrupt', message: 'Zaufany skrot pakietu ma innego wlasciciela.' };
    }
    if ((info.mode & 0o022) !== 0) {
      return {
        state: 'corrupt',
        message: 'Zaufany skrot pakietu jest zapisywalny dla grupy lub innych.',
      };
    }
  }
  const read = await readTextWithin(layout.home, file, MAX_TRUST_BYTES);
  if (!read.ok) return { state: 'corrupt', message: read.message };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return { state: 'corrupt', message: 'Zaufany skrot pakietu nie jest poprawnym JSON.' };
  }
  const checked = validatePackTrustFile(parsed);
  if (!checked.ok) {
    const first = checked.errors[0];
    return {
      state: 'corrupt',
      message: `Zaufany skrot pakietu jest niepoprawny${first ? ` (${first.path}: ${first.message})` : ''}.`,
    };
  }
  if (checked.value.pack !== id) {
    return { state: 'corrupt', message: 'Zaufany skrot nalezy do innego pakietu.' };
  }
  return { state: 'ok', file: checked.value };
}

export interface PackTrusts {
  readonly trust: ReadonlyMap<string, PackTrustFile>;
  /** Pakiety z uszkodzonym plikiem: bez zgody, z komunikatem. */
  readonly corrupt: ReadonlyMap<string, string>;
}

export async function loadPackTrusts(
  layout: CwmLayout,
  ids: Iterable<string>,
): Promise<PackTrusts> {
  const trust = new Map<string, PackTrustFile>();
  const corrupt = new Map<string, string>();
  for (const id of new Set(ids)) {
    const loaded = await loadPackTrust(layout, id);
    if (loaded.state === 'ok') trust.set(id, loaded.file);
    else if (loaded.state === 'corrupt') corrupt.set(id, loaded.message);
  }
  return { trust, corrupt };
}

function trustDocument(file: PackTrustFile): unknown {
  return {
    apiVersion: API_VERSION,
    kind: 'PackApprovals',
    pack: file.pack,
    members: file.members.map((m) => ({
      key: m.key,
      hash: m.hash,
      approvedAt: m.approvedAt,
      via: m.via,
      fields: m.fields,
    })),
  };
}

async function writeTrust(layout: CwmLayout, file: PackTrustFile): Promise<void> {
  const document = trustDocument(file);
  const text = `${JSON.stringify(document, null, 1)}\n`;
  const checked = validatePackTrustFile(JSON.parse(text) as unknown);
  if (!checked.ok) {
    const first = checked.errors[0];
    throw new WriteDeniedError(
      `Zaufany skrot pakietu nie przechodzi walidacji${first ? ` (${first.path}: ${first.message})` : ''}.`,
    );
  }
  const scope = homeScope(layout.home);
  const target = packTrustFile(layout, file.pack);
  await ensureScopedDirectory(scope, join(target, '..'));
  await writeScopedFile(scope, target, text);
}

/** Pod mutexem globalnym: czyta, scala i zapisuje. Nie rzuca, gdy zaden zapis nie jest potrzebny. */
async function withTrustLock<T>(layout: CwmLayout, run: () => Promise<T>): Promise<T> {
  const root = await openRuntimeRoot(layout, LOCK_COMPANY);
  const release = await acquireMutex(root);
  try {
    return await run();
  } finally {
    await release();
  }
}

export interface TrustedMember {
  readonly key: string;
  readonly fields: PackMemberRecord['fields'];
}

/**
 * Zapisuje zgode na czlonkow pakietu (zastepuje wpisy o tych samych kluczach, reszte zostawia).
 * Uszkodzony plik to blad: nie nadpisujemy go po cichu.
 */
export async function recordPackTrust(
  layout: CwmLayout,
  id: string,
  members: readonly TrustedMember[],
  via: 'import' | 'start',
  now: Date = new Date(),
): Promise<PackTrustFile> {
  checkedId(id);
  return withTrustLock(layout, async () => {
    const loaded = await loadPackTrust(layout, id);
    if (loaded.state === 'corrupt') throw new WriteDeniedError(loaded.message);
    const current = loaded.state === 'ok' ? loaded.file.members : [];
    const replaced = new Set(members.map((m) => m.key));
    const added: PackMemberRecord[] = members.map((m) => ({
      key: m.key,
      hash: packMemberHash(m.key, m.fields),
      approvedAt: now.toISOString(),
      via,
      fields: m.fields,
    }));
    const next: PackTrustFile = {
      pack: id,
      members: [...current.filter((m) => !replaced.has(m.key)), ...added].sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
      ),
    };
    await writeTrust(layout, next);
    return next;
  });
}

export async function listTrustedPackIds(layout: CwmLayout): Promise<string[]> {
  const ids: string[] = [];
  const spaces = await listDirectory(layout.home, packTrustDir(layout));
  if (!spaces.ok) return ids;
  for (const space of spaces.entries) {
    if (space.kind !== 'dir' || !ID_SPACE_PATTERN.test(space.name)) continue;
    const files = await listDirectory(layout.home, join(packTrustDir(layout), space.name));
    if (!files.ok) continue;
    for (const entry of files.entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
      const name = entry.name.slice(0, -'.json'.length);
      if (ID_NAME_PATTERN.test(name)) ids.push(`${space.name}/${name}`);
    }
  }
  return ids.sort();
}

/** Odwoluje zaufane skroty pakietu (plik znika). Zwraca, czy cos usunieto. */
export async function revokePackTrust(layout: CwmLayout, id: string): Promise<boolean> {
  checkedId(id);
  return withTrustLock(layout, () =>
    removeScopedFile(homeScope(layout.home), packTrustFile(layout, id)),
  );
}

/** Zmiana nazwy pakietu: definicja i zaufane skroty (skrot czlonka nie zawiera nazwy pakietu). */
export async function renamePack(layout: CwmLayout, from: string, to: string): Promise<void> {
  if (namespaceOf(from) !== namespaceOf(to)) {
    throw new WriteDeniedError('Nowa nazwa musi zostac w tej samej przestrzeni nazw.');
  }
  const scope = homeScope(layout.home);
  await withTrustLock(layout, async () => {
    const def = await loadPackDefs(layout);
    const manifest = def.packs.get(from);
    if (manifest === undefined) throw new WriteDeniedError(`Nie ma pakietu ${from}.`);
    if (def.packs.has(to)) throw new WriteDeniedError(`Pakiet ${to} juz istnieje.`);
    const trustLoad = await loadPackTrust(layout, to);
    if (trustLoad.state !== 'missing')
      throw new WriteDeniedError(`Pakiet ${to} ma juz zaufane skroty.`);
    const trusted = await loadPackTrust(layout, from);
    if (trusted.state === 'corrupt') throw new WriteDeniedError(trusted.message);
    await savePackDef(layout, newPack(to, manifest.spec.members));
    if (trusted.state === 'ok') {
      await ensureScopedDirectory(scope, join(packTrustFile(layout, to), '..'));
      await renameScopedFile(scope, packTrustFile(layout, from), packTrustFile(layout, to));
      await writeTrust(layout, { pack: to, members: trusted.file.members });
    }
    await removeScopedFile(scope, packFile(layout, from));
  });
}

/** Usuwa zaufane wpisy zasobu ze wszystkich pakietow (pod mutexem). Zwraca id pakietow, z ktorych usunieto. */
export async function dropPackRecords(
  layout: CwmLayout,
  keys: readonly string[],
): Promise<string[]> {
  const scope = homeScope(layout.home);
  return withTrustLock(layout, async () => {
    const touched: string[] = [];
    for (const id of await listTrustedPackIds(layout)) {
      const loaded = await loadPackTrust(layout, id);
      if (loaded.state === 'corrupt') throw new WriteDeniedError(`Pakiet ${id}: ${loaded.message}`);
      if (loaded.state !== 'ok') continue;
      const rest = loaded.file.members.filter((m) => !keys.includes(m.key));
      if (rest.length === loaded.file.members.length) continue;
      if (rest.length === 0) await removeScopedFile(scope, packTrustFile(layout, id));
      else await writeTrust(layout, { pack: id, members: rest });
      touched.push(id);
    }
    return touched;
  });
}

/** Zasoby z zaufanym wpisem majacym pola wykonawcze (do ostrzezenia przy `revoke --company`). */
export async function trustedExecKeys(layout: CwmLayout): Promise<string[]> {
  const keys: string[] = [];
  for (const id of await listTrustedPackIds(layout)) {
    const loaded = await loadPackTrust(layout, id);
    if (loaded.state !== 'ok') continue;
    for (const m of loaded.file.members) if (m.fields.exec !== null) keys.push(m.key);
  }
  return keys.sort();
}

/**
 * Przenosi zasob do innego pakietu pod mutexem: definicje obu pakietow i usuniecie wpisu ze starego
 * pakietu (zgoda nie przechodzi razem z zasobem).
 */
export async function movePackMember(
  layout: CwmLayout,
  ref: PackMemberRef,
  target: string,
): Promise<string | null> {
  checkedId(target);
  const key = memberKey(ref.kind, ref.id);
  return withTrustLock(layout, async () => {
    const defs = await loadPackDefs(layout);
    const from = defs.membership.get(key) ?? null;
    if (from === target) throw new WriteDeniedError(`${key} jest juz w pakiecie ${target}.`);
    const dest = defs.packs.get(target);
    await savePackDef(layout, newPack(target, [...(dest?.spec.members ?? []), ref]));
    if (from !== null) {
      const rest = (defs.packs.get(from)?.spec.members ?? []).filter(
        (m) => memberKey(m.kind, m.id) !== key,
      );
      if (rest.length === 0) await removePackDef(layout, from);
      else await savePackDef(layout, newPack(from, rest));
    }
    const scope = homeScope(layout.home);
    for (const id of from === null ? [] : [from]) {
      const loaded = await loadPackTrust(layout, id);
      if (loaded.state !== 'ok') continue;
      const left = loaded.file.members.filter((m) => m.key !== key);
      if (left.length === loaded.file.members.length) continue;
      if (left.length === 0) await removeScopedFile(scope, packTrustFile(layout, id));
      else await writeTrust(layout, { pack: id, members: left });
    }
    return from;
  });
}
