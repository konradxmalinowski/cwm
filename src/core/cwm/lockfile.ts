import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json';
import { Checker, childPath, field } from './check';
import type { EffectiveConfiguration, Origin } from './effective';
import { compareStrings, fail, ok, type Result } from './errors';
import { GIT_COMMIT_PATTERN } from './git-source';
import {
  API_VERSION,
  ID_SPACE_PATTERN,
  refKey,
  RESOURCE_ID_PATTERN,
  RESOURCE_KINDS,
  type ResourceKind,
} from './kinds';
import type { Layer } from './merge-settings';
import { HASH64 } from './patterns';
import type { Resource } from './resource';

/**
 * Lockfile projektu (ADR 0051): powtarzalny obraz tego, co projekt dostaje po rozwiazaniu. To nie jest
 * zatwierdzenie i niczego nie zastepuje w `cwm start`: sluzy do wykrycia dryfu miedzy sesjami.
 * Dokument zawiera wylacznie nazwy, wersje i skroty: zadnych czasow, nazw hosta, sciezek bezwzglednych
 * ani jawnych wartosci. Skroty definicji nie sa jednak tajne: krotki sekret, ktory przeszedl klasyfikator
 * (np. w `args` serwera MCP albo w poleceniu hooka), da sie zgadnac ze skrotu, jesli lockfile trafi do
 * repozytorium. Nie ma tu HMAC (ADR 0051). Nazwy zasobow (takze prywatnych), firmy i projektu sa jawne.
 */
export const LOCK_KIND = 'Lock';
export const LOCK_FILE_NAME = 'cwm.lock';
export const LOCK_ENGINE = 'claude-code';
export const MAX_LOCK_BYTES = 8 * 1024 * 1024;
/** Tyle samo co `MAX_RESOURCES` resolvera: lockfile nie moze byc mniejszy niz najwiekszy wynik. */
export const MAX_LOCK_RESOURCES = 5000;

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
/** Wersja zasobu (jak w manifescie) i wersja wpisu marketplace'u (jak w katalogu). */
const RESOURCE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MARKETPLACE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const LAYERS: readonly Layer[] = ['global', 'company', 'project'];
const ORIGINS: readonly Origin[] = ['mandatory', 'optional', 'dependency'];

/** Fakty o tresci zasobu zebrane przez plan (infra); rdzen tylko je sklada. */
export interface LockFact {
  /** Klucz `rodzaj:id`. */
  readonly key: string;
  /** Skrot tresci zrodla (drzewo, plik, wygenerowana komenda, drzewo pluginu, plik polecenia MCP). */
  readonly content: string | null;
  /** Skrot skryptow hookow przypietych przez plan (tylko skroty, bez sciezek). */
  readonly pins?: string | null;
  readonly git?: { readonly commit: string; readonly tree: string };
  readonly marketplace?: { readonly name: string; readonly version: string | null };
}

export interface LockEntry {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly origin: Origin;
  readonly layer: Layer;
  readonly version: string | null;
  /** Skrot definicji zasobu z manifestu (bez `nativeDir`; wartosci `env` wpisane wprost wchodza do skrotu). */
  readonly definition: string;
  readonly content: string | null;
  readonly pins?: string;
  readonly git?: { readonly commit: string; readonly tree: string };
  readonly marketplace?: { readonly name: string; readonly version: string | null };
}

export interface LockDocument {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: typeof LOCK_KIND;
  readonly company: string;
  readonly project: string;
  readonly engine: { readonly name: typeof LOCK_ENGINE; readonly version: string | null };
  readonly resources: readonly LockEntry[];
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Skrot definicji zasobu: kanoniczny JSON bez pol zaleznych od maszyny (`nativeDir`). Wartosci `env`
 * wpisane wprost wchodza do skrotu: zasob z taka wartoscia przeszedl juz `classifyEnvValue`, a zmiana
 * np. modelu ma byc dryfem. `envRef` wchodzi jako nazwa zmiennej.
 */
export function lockDefinition(resource: Resource): string {
  const copy: Record<string, unknown> = { ...resource };
  delete copy['nativeDir'];
  return sha256(canonicalJson(copy));
}

/** Skrot listy skrotow skryptow hookow (posortowanych, bez powtorzen) albo null, gdy nic nie przypieto. */
export function lockPinsHash(shas: readonly (string | null)[]): string | null {
  const known = [...new Set(shas.filter((sha): sha is string => sha !== null))].sort();
  return known.length === 0 ? null : sha256(canonicalJson(known));
}

export interface BuildLockInput {
  readonly effective: EffectiveConfiguration;
  readonly facts: readonly LockFact[];
  /** Wersja silnika z `claude --version`; null, gdy silnika brak albo sie nie udalo. */
  readonly engineVersion: string | null;
}

/** Czysta funkcja: ten sam wynik rozwiazania i fakty daja ten sam dokument. */
export function buildLock(input: BuildLockInput): LockDocument {
  const facts = new Map(input.facts.map((fact) => [fact.key, fact]));
  const resources = input.effective.resources
    .map((entry): LockEntry => {
      const resource = entry.resource;
      const fact = facts.get(refKey(resource));
      return {
        id: resource.id,
        kind: resource.kind,
        origin: entry.origin,
        layer: entry.layer,
        version: resource.version ?? null,
        definition: lockDefinition(resource),
        content: fact?.content ?? null,
        ...(fact?.pins === undefined || fact.pins === null ? {} : { pins: fact.pins }),
        ...(fact?.git === undefined
          ? {}
          : { git: { commit: fact.git.commit, tree: fact.git.tree } }),
        ...(fact?.marketplace === undefined
          ? {}
          : { marketplace: { name: fact.marketplace.name, version: fact.marketplace.version } }),
      };
    })
    .sort((a, b) => compareStrings(entryKey(a), entryKey(b)));
  return {
    apiVersion: API_VERSION,
    kind: LOCK_KIND,
    company: input.effective.profile.company,
    project: input.effective.profile.project,
    engine: { name: LOCK_ENGINE, version: input.engineVersion },
    resources,
  };
}

const entryKey = (entry: LockEntry): string => `${entry.kind}:${entry.id}`;

/**
 * Zapis lockfile: JSON z posortowanymi kluczami (kolejnosc z `canonicalJson`), wciecie 2 spacje,
 * koncowy nowy wiersz. Bajty zaleza tylko od dokumentu, wiec dwa zapisy sa identyczne.
 */
export function formatLock(doc: LockDocument): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(doc)), null, 2)}\n`;
}

/** Tekst albo null; `undefined` oznacza blad (juz zapisany w `c`). */
function nullableString(
  c: Checker,
  value: unknown,
  path: string,
  pattern?: RegExp,
): string | null | undefined {
  if (value === null) return null;
  return c.string(value, path, pattern) ?? undefined;
}

function parseEntry(c: Checker, value: unknown, path: string): LockEntry | null {
  const obj = c.object(
    value,
    path,
    [
      'id',
      'kind',
      'origin',
      'layer',
      'version',
      'definition',
      'content',
      'pins',
      'git',
      'marketplace',
    ],
    ['id', 'kind', 'origin', 'layer', 'version', 'definition', 'content'],
  );
  if (obj === null) return null;
  const id = c.string(field(obj, 'id'), childPath(path, 'id'), RESOURCE_ID_PATTERN);
  const kind = c.oneOf(field(obj, 'kind'), childPath(path, 'kind'), RESOURCE_KINDS);
  const origin = c.oneOf(field(obj, 'origin'), childPath(path, 'origin'), ORIGINS);
  const layer = c.oneOf(field(obj, 'layer'), childPath(path, 'layer'), LAYERS);
  const version = nullableString(
    c,
    field(obj, 'version'),
    childPath(path, 'version'),
    RESOURCE_VERSION_PATTERN,
  );
  const definition = c.string(field(obj, 'definition'), childPath(path, 'definition'), HASH64);
  const content = nullableString(c, field(obj, 'content'), childPath(path, 'content'), HASH64);
  const pinsRaw = field(obj, 'pins');
  const pins =
    pinsRaw === undefined ? undefined : c.string(pinsRaw, childPath(path, 'pins'), HASH64);
  const gitRaw = field(obj, 'git');
  let git: LockEntry['git'];
  if (gitRaw !== undefined) {
    const gitPath = childPath(path, 'git');
    const g = c.object(gitRaw, gitPath, ['commit', 'tree'], ['commit', 'tree']);
    if (g !== null) {
      const commit = c.string(field(g, 'commit'), childPath(gitPath, 'commit'), GIT_COMMIT_PATTERN);
      const tree = c.string(field(g, 'tree'), childPath(gitPath, 'tree'), HASH64);
      if (commit !== null && tree !== null) git = { commit, tree };
    }
  }
  const mpRaw = field(obj, 'marketplace');
  let marketplace: LockEntry['marketplace'];
  if (mpRaw !== undefined) {
    const mpPath = childPath(path, 'marketplace');
    const m = c.object(mpRaw, mpPath, ['name', 'version'], ['name', 'version']);
    if (m !== null) {
      const name = c.string(field(m, 'name'), childPath(mpPath, 'name'), ID_SPACE_PATTERN);
      const mpVersion = nullableString(
        c,
        field(m, 'version'),
        childPath(mpPath, 'version'),
        MARKETPLACE_VERSION_PATTERN,
      );
      if (name !== null && mpVersion !== undefined) marketplace = { name, version: mpVersion };
    }
  }
  if (
    id === null ||
    kind === null ||
    origin === null ||
    layer === null ||
    definition === null ||
    content === undefined ||
    version === undefined
  ) {
    return null;
  }
  return {
    id,
    kind,
    origin,
    layer,
    version,
    definition,
    content,
    ...(pins === undefined || pins === null ? {} : { pins }),
    ...(git === undefined ? {} : { git }),
    ...(marketplace === undefined ? {} : { marketplace }),
  };
}

/** Odczyt lockfile z tekstu: scisly, nieznane pola i obca wersja dokumentu to bledy, nie ciche pominiecie. */
export function parseLock(text: string): Result<LockDocument> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail([{ path: '$', message: 'Lockfile nie jest poprawnym JSON.' }]);
  }
  const c = new Checker();
  const root = c.object(
    raw,
    '$',
    ['apiVersion', 'kind', 'company', 'project', 'engine', 'resources'],
    ['apiVersion', 'kind', 'company', 'project', 'engine', 'resources'],
  );
  if (root === null) return fail(c.errors);
  if (field(root, 'apiVersion') !== API_VERSION) {
    c.add('apiVersion', `Oczekiwano "${API_VERSION}" (inna wersja formatu).`);
  }
  if (field(root, 'kind') !== LOCK_KIND) c.add('kind', `Oczekiwano "${LOCK_KIND}".`);
  const company = c.string(field(root, 'company'), 'company', /^[a-z0-9][a-z0-9-]{0,62}$/);
  const project = c.string(field(root, 'project'), 'project', /^[a-z0-9][a-z0-9-]{0,62}$/);
  const engine = c.object(
    field(root, 'engine'),
    'engine',
    ['name', 'version'],
    ['name', 'version'],
  );
  let engineVersion: string | null = null;
  if (engine !== null) {
    if (field(engine, 'name') !== LOCK_ENGINE) c.add('engine.name', `Oczekiwano "${LOCK_ENGINE}".`);
    engineVersion =
      nullableString(c, field(engine, 'version'), 'engine.version', VERSION_PATTERN) ?? null;
  }
  const list: unknown = field(root, 'resources');
  const resources: LockEntry[] = [];
  if (!Array.isArray(list)) c.add('resources', 'Oczekiwano listy.');
  else if (list.length > MAX_LOCK_RESOURCES) {
    c.add('resources', `Lista moze miec najwyzej ${MAX_LOCK_RESOURCES} elementow.`);
  } else {
    const seen = new Set<string>();
    list.forEach((item: unknown, index) => {
      const entry = parseEntry(c, item, `resources[${index}]`);
      if (entry === null) return;
      const key = entryKey(entry);
      if (seen.has(key)) c.add(`resources[${index}]`, 'Powtorzony zasob.');
      else {
        seen.add(key);
        resources.push(entry);
      }
    });
  }
  if (c.errors.length > 0 || company === null || project === null) return fail(c.errors);
  return ok({
    apiVersion: API_VERSION,
    kind: LOCK_KIND,
    company,
    project,
    engine: { name: LOCK_ENGINE, version: engineVersion },
    resources: resources.sort((a, b) => compareStrings(entryKey(a), entryKey(b))),
  });
}

export type LockField =
  'origin' | 'layer' | 'version' | 'definition' | 'content' | 'pins' | 'git' | 'marketplace';

export interface LockChange {
  readonly key: string;
  readonly change: 'added' | 'removed' | 'changed';
  readonly fields: readonly LockField[];
  /** Opis zmian pol (skroty skrocone do 12 znakow), do wypisania. */
  readonly details: readonly string[];
}

export interface LockDrift {
  /** Firma albo projekt inne niz w lockfile. */
  readonly identity: readonly string[];
  readonly resources: readonly LockChange[];
  /** Obie wersje znane i rozne; wersja nieznana po jednej ze stron nie jest dryfem. */
  readonly engine: { readonly locked: string; readonly current: string } | null;
}

const short = (value: string | null | undefined): string =>
  value === null || value === undefined ? '(brak)' : value.slice(0, 12);

function describe(field: LockField, a: LockEntry, b: LockEntry): string {
  switch (field) {
    case 'origin':
      return `origin ${a.origin} -> ${b.origin}`;
    case 'layer':
      return `layer ${a.layer} -> ${b.layer}`;
    case 'version':
      return `version ${a.version ?? '(brak)'} -> ${b.version ?? '(brak)'}`;
    case 'definition':
      return `definition ${short(a.definition)} -> ${short(b.definition)}`;
    case 'content':
      return `content ${short(a.content)} -> ${short(b.content)}`;
    case 'pins':
      return `pins ${short(a.pins)} -> ${short(b.pins)}`;
    case 'git': {
      const parts: string[] = [];
      if (a.git?.commit !== b.git?.commit) {
        parts.push(`commit ${short(a.git?.commit)} -> ${short(b.git?.commit)}`);
      }
      if (a.git?.tree !== b.git?.tree) {
        parts.push(`tree ${short(a.git?.tree)} -> ${short(b.git?.tree)}`);
      }
      return parts.join(', ');
    }
    case 'marketplace':
      return `marketplace ${a.marketplace?.name ?? '(brak)'}@${a.marketplace?.version ?? '(brak)'} -> ${
        b.marketplace?.name ?? '(brak)'
      }@${b.marketplace?.version ?? '(brak)'}`;
  }
}

function changedFields(a: LockEntry, b: LockEntry): LockField[] {
  const out: LockField[] = [];
  if (a.origin !== b.origin) out.push('origin');
  if (a.layer !== b.layer) out.push('layer');
  if (a.version !== b.version) out.push('version');
  if (a.definition !== b.definition) out.push('definition');
  if (a.content !== b.content) out.push('content');
  if (a.pins !== b.pins) out.push('pins');
  if (a.git?.commit !== b.git?.commit || a.git?.tree !== b.git?.tree) out.push('git');
  if (
    a.marketplace?.name !== b.marketplace?.name ||
    a.marketplace?.version !== b.marketplace?.version
  ) {
    out.push('marketplace');
  }
  return out;
}

/** Porownanie zapisanego lockfile z obrazem liczonym teraz; czysta funkcja, wynik posortowany. */
export function compareLocks(locked: LockDocument, current: LockDocument): LockDrift {
  const identity: string[] = [];
  if (locked.company !== current.company) {
    identity.push(`firma ${locked.company} -> ${current.company}`);
  }
  if (locked.project !== current.project) {
    identity.push(`projekt ${locked.project} -> ${current.project}`);
  }
  const before = new Map(locked.resources.map((entry) => [entryKey(entry), entry]));
  const after = new Map(current.resources.map((entry) => [entryKey(entry), entry]));
  const changes: LockChange[] = [];
  for (const [key, entry] of after) {
    const old = before.get(key);
    if (old === undefined) {
      changes.push({ key, change: 'added', fields: [], details: [] });
      continue;
    }
    const fields = changedFields(old, entry);
    if (fields.length > 0) {
      changes.push({
        key,
        change: 'changed',
        fields,
        details: fields.map((name) => describe(name, old, entry)),
      });
    }
  }
  for (const key of before.keys()) {
    if (!after.has(key)) changes.push({ key, change: 'removed', fields: [], details: [] });
  }
  changes.sort((a, b) => compareStrings(a.key, b.key));
  const lockedVersion = locked.engine.version;
  const currentVersion = current.engine.version;
  const engine =
    lockedVersion !== null && currentVersion !== null && lockedVersion !== currentVersion
      ? { locked: lockedVersion, current: currentVersion }
      : null;
  return { identity, resources: changes, engine };
}

/** Dryf zasobow lub tozsamosci (bez wersji silnika, ktora jest tylko ostrzezeniem w `cwm start`). */
export const hasResourceDrift = (drift: LockDrift): boolean =>
  drift.identity.length > 0 || drift.resources.length > 0;

export const hasAnyDrift = (drift: LockDrift): boolean =>
  hasResourceDrift(drift) || drift.engine !== null;

/** Jedna linia podsumowania dryfu do ostrzezen. */
export function summarizeDrift(drift: LockDrift): string {
  const count = (kind: LockChange['change']): number =>
    drift.resources.filter((change) => change.change === kind).length;
  const parts = [
    `dodane ${count('added')}`,
    `usuniete ${count('removed')}`,
    `zmienione ${count('changed')}`,
  ];
  if (drift.identity.length > 0) parts.push(`tozsamosc ${drift.identity.length}`);
  return parts.join(', ');
}
