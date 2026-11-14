import { createHash } from 'node:crypto';

import { diffFields, type FieldChange } from './approval';
import { canonicalJson } from './canonical-json';
import { Checker, childPath, field, isPlainObject, type PlainObject } from './check';
import { escapeControlChars, fail, ok, type Result } from './errors';
import { API_VERSION, ID_NAME_PATTERN, namespaceOf, RESOURCE_ID_PATTERN } from './kinds';
import { HASH16, HASH64 } from './patterns';
import { hasForbiddenKey } from './safe-keys';

/**
 * Pakiety zasobow (ADR 0044). Pakiet to nazwana lista zasobow z jednej przestrzeni nazw; zgoda na
 * pakiet (zaufany skrot kazdego czlonka) jest zapisywana przy `cwm import` i sprawdzana przy
 * `cwm start`. Ten plik jest czysty: bez dostepu do dysku.
 */

export const PACK_KINDS = ['skill', 'agent', 'command', 'files', 'settings'] as const;
export type PackKind = (typeof PACK_KINDS)[number];

export const isPackKind = (kind: string): kind is PackKind =>
  (PACK_KINDS as readonly string[]).includes(kind);

/** Zmiana wersji dokumentu skrotu czlonka uniewaznia wszystkie zaufane skroty pakietow. */
export const PACK_DOC_VERSION = 1;
export const PACK_DOMAIN = 'cwm-pack-member-v1\n';

/**
 * Sciezka profilu, ktora wchodzi do wyprowadzenia pol niezaleznych od firmy: odwolania do
 * natywnego katalogu sa przepisywane na ten znacznik zamiast na prawdziwy profil firmy.
 */
export const PACK_PROFILE_PLACEHOLDER = '/cwm-pack-profile';

/** Najwyzej tyle plikow czlonka w polach zaufanego skrotu (reszta jest tylko w skrocie drzewa). */
export const PACK_MAX_LISTED_FILES = 40;
export const PACK_MAX_MEMBERS = 400;

export const packId = (namespace: string, name: string): string => `${namespace}/${name}`;
export const packApprovalKey = (id: string): string => `pack:${id}`;
export const memberKey = (kind: PackKind, id: string): string => `${kind}:${id}`;

export interface PackMemberRef {
  readonly kind: PackKind;
  readonly id: string;
}

export interface PackManifest {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: 'Pack';
  readonly metadata: { readonly id: string };
  readonly spec: { readonly members: readonly PackMemberRef[] };
}

export function parseMemberKey(text: string): PackMemberRef | null {
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const kind = text.slice(0, colon);
  const id = text.slice(colon + 1);
  return isPackKind(kind) && RESOURCE_ID_PATTERN.test(id) ? { kind, id } : null;
}

/** Manifest pakietu to dane z dysku: nieznane pole, zly czlonek albo czlonek z obcej przestrzeni to blad. */
export function validatePackManifest(input: unknown): Result<PackManifest> {
  const c = new Checker();
  const root = c.object(
    input,
    '$',
    ['apiVersion', 'kind', 'metadata', 'spec'],
    ['apiVersion', 'kind', 'metadata', 'spec'],
  );
  if (!root) return fail(c.errors);
  const apiVersion = field(root, 'apiVersion');
  if (apiVersion !== API_VERSION) c.add('apiVersion', `Oczekiwano "${API_VERSION}".`);
  if (field(root, 'kind') !== 'Pack') c.add('kind', 'Oczekiwano "Pack".');
  const metadata = c.object(field(root, 'metadata'), 'metadata', ['id'], ['id']);
  const id = metadata
    ? c.string(field(metadata, 'id'), 'metadata.id', RESOURCE_ID_PATTERN, '<przestrzen>/<nazwa>')
    : null;
  const spec = c.object(field(root, 'spec'), 'spec', ['members'], ['members']);
  const members = spec
    ? c.list(
        field(spec, 'members'),
        'spec.members',
        (element, path): PackMemberRef | null => {
          const text = c.string(element, path);
          if (text === null) return null;
          const ref = parseMemberKey(text);
          if (ref === null) {
            c.add(
              path,
              'Oczekiwano "<rodzaj>:<przestrzen>/<nazwa>" (skill, agent, command, files, settings).',
            );
            return null;
          }
          if (id !== null && namespaceOf(ref.id) !== namespaceOf(id)) {
            c.add(path, 'Czlonek pakietu musi miec id z przestrzeni nazw pakietu.');
            return null;
          }
          return ref;
        },
        (ref) => memberKey(ref.kind, ref.id),
      )
    : [];
  if (c.errors.length > 0 || id === null) return fail(c.errors);
  return ok({
    apiVersion: API_VERSION,
    kind: 'Pack',
    metadata: { id },
    spec: { members },
  });
}

/** Segment nazwy pakietu z dowolnego tekstu: male litery, cyfry, `.`, `_` i `-`. */
export function sanitizePackName(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 60)
    .replace(/[.-]+$/, '');
  return ID_NAME_PATTERN.test(cleaned) ? cleaned : 'pakiet';
}

// --- Pola zaufanego skrotu czlonka -----------------------------------------------------------

export interface PackFileEntry {
  readonly path: string;
  /** 16 znakow hex: tylko do pokazania roznicy; o zaufaniu decyduje pelny skrot drzewa. */
  readonly sha256: string;
}

/**
 * Pola czlonka pakietu, wszystkie wyprowadzone wylacznie z tresci rejestru (bez firmy, profilu i
 * projektu). `def` i `exec` sa null dla czlonka bez pol wykonawczych, zeby zmiana samego opisu
 * takiego zasobu nie pytala o zgode.
 */
/**
 * Powiazanie skryptu hooka z profilu: ktory zasob (`owner`, klucz `rodzaj:id`) zapisze plik `rel` i
 * jaki ma skrot drzewa. Zapisane przy zgodzie; inny wlasciciel albo inne drzewo wlasciciela to zmiana
 * pola i pytanie o pakiet. `owner: null` to wlasciciel nieznany (ustalany przy starcie).
 */
export interface PackBinding {
  readonly rel: string;
  readonly owner: string | null;
  readonly ownerTree: string | null;
}

export interface MemberFields {
  readonly def: string | null;
  readonly tree: string;
  readonly files: readonly PackFileEntry[];
  readonly filesMore: number;
  readonly exec: Readonly<Record<string, unknown>> | null;
  /** Skrypty hookow z profilu pochodzace z innych zasobow (wlasne drzewo pokrywa `tree`). */
  readonly bindings: readonly PackBinding[];
}

export function packMemberHash(key: string, fields: MemberFields): string {
  const document = { v: PACK_DOC_VERSION, engine: 'claude-code', key, fields };
  return createHash('sha256')
    .update(PACK_DOMAIN, 'utf8')
    .update(canonicalJson(document), 'utf8')
    .digest('hex');
}

/** Lista plikow do pol: posortowana, z ograniczeniem i bez znakow sterujacych w sciezkach. */
export function listFiles(files: readonly { readonly path: string; readonly sha256: string }[]): {
  files: PackFileEntry[];
  filesMore: number;
} {
  const sorted = files
    .map((file) => ({
      path: escapeControlChars(file.path).slice(0, 400),
      sha256: file.sha256.slice(0, 16),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files: sorted.slice(0, PACK_MAX_LISTED_FILES),
    filesMore: Math.max(0, sorted.length - PACK_MAX_LISTED_FILES),
  };
}

export interface PackMemberRecord {
  readonly key: string;
  readonly hash: string;
  readonly approvedAt: string;
  readonly via: 'import' | 'start';
  readonly fields: MemberFields;
}

export interface PackTrustFile {
  readonly pack: string;
  readonly members: readonly PackMemberRecord[];
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const KEY = /^(?:skill|agent|command|files|settings):[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,512}$/u;

function readFields(c: Checker, value: unknown, path: string): MemberFields | null {
  const obj = c.object(
    value,
    path,
    ['def', 'tree', 'files', 'filesMore', 'exec', 'bindings'],
    ['def', 'tree', 'files', 'filesMore', 'exec', 'bindings'],
  );
  if (!obj) return null;
  const defValue = field(obj, 'def');
  const def =
    defValue === null ? null : c.string(defValue, childPath(path, 'def'), HASH64, '64 znaki hex');
  const tree = c.string(field(obj, 'tree'), childPath(path, 'tree'), HASH64, '64 znaki hex');
  const files = c.list(
    field(obj, 'files'),
    childPath(path, 'files'),
    (element, elementPath): PackFileEntry | null => {
      const entry = c.object(element, elementPath, ['path', 'sha256'], ['path', 'sha256']);
      if (!entry) return null;
      const filePath = c.string(field(entry, 'path'), childPath(elementPath, 'path'));
      const sha = c.string(field(entry, 'sha256'), childPath(elementPath, 'sha256'), HASH16);
      return filePath !== null && sha !== null ? { path: filePath, sha256: sha } : null;
    },
    (entry) => entry.path,
  );
  const bindings = c.list(
    field(obj, 'bindings'),
    childPath(path, 'bindings'),
    (element, elementPath): PackBinding | null => {
      const entry = c.object(
        element,
        elementPath,
        ['rel', 'owner', 'ownerTree'],
        ['rel', 'owner', 'ownerTree'],
      );
      if (!entry) return null;
      const rel = c.string(field(entry, 'rel'), childPath(elementPath, 'rel'));
      const ownerValue = field(entry, 'owner');
      const owner =
        ownerValue === null ? null : c.string(ownerValue, childPath(elementPath, 'owner'), KEY);
      const treeValue = field(entry, 'ownerTree');
      const ownerTree =
        treeValue === null
          ? null
          : c.string(treeValue, childPath(elementPath, 'ownerTree'), HASH64);
      if (rel === null || (ownerValue !== null && owner === null)) return null;
      if (treeValue !== null && ownerTree === null) return null;
      return { rel, owner, ownerTree };
    },
    (entry) => entry.rel,
  );
  const more = c.integer(field(obj, 'filesMore'), childPath(path, 'filesMore'), 0, 1_000_000);
  const execValue = field(obj, 'exec');
  let exec: PlainObject | null = null;
  if (execValue !== null) {
    if (!isPlainObject(execValue) || hasForbiddenKey(execValue)) {
      c.add(childPath(path, 'exec'), 'Oczekiwano obiektu bez zabronionych kluczy albo null.');
    } else exec = execValue;
  }
  if (tree === null || more === null) return null;
  if (defValue !== null && def === null) return null;
  return { def, tree, files, filesMore: more, exec, bindings };
}

/** Plik zaufanego skrotu pakietu: ostry walidator, a skrot kazdego czlonka jest liczony z jego pol. */
export function validatePackTrustFile(input: unknown): Result<PackTrustFile> {
  const c = new Checker();
  const root = c.object(
    input,
    '$',
    ['apiVersion', 'kind', 'pack', 'members'],
    ['apiVersion', 'kind', 'pack'],
  );
  if (!root) return fail(c.errors);
  if (field(root, 'apiVersion') !== API_VERSION)
    c.add('apiVersion', `Oczekiwano "${API_VERSION}".`);
  if (field(root, 'kind') !== 'PackApprovals') c.add('kind', 'Oczekiwano "PackApprovals".');
  const pack = c.string(field(root, 'pack'), 'pack', RESOURCE_ID_PATTERN, '<przestrzen>/<nazwa>');
  const members = c.list(
    field(root, 'members'),
    'members',
    (element, path): PackMemberRecord | null => {
      const obj = c.object(
        element,
        path,
        ['key', 'hash', 'approvedAt', 'via', 'fields'],
        ['key', 'hash', 'approvedAt', 'via', 'fields'],
      );
      if (!obj) return null;
      const key = c.string(field(obj, 'key'), childPath(path, 'key'), KEY, 'rodzaj:id');
      const hash = c.string(field(obj, 'hash'), childPath(path, 'hash'), HASH64, '64 znaki hex');
      const approvedAt = c.string(
        field(obj, 'approvedAt'),
        childPath(path, 'approvedAt'),
        TIMESTAMP,
        'czas UTC ISO 8601',
      );
      const via = c.oneOf(field(obj, 'via'), childPath(path, 'via'), ['import', 'start'] as const);
      const fields = readFields(c, field(obj, 'fields'), childPath(path, 'fields'));
      if (key === null || hash === null || approvedAt === null || via === null || fields === null) {
        return null;
      }
      if (packMemberHash(key, fields) !== hash) {
        c.add(childPath(path, 'hash'), 'Skrot nie zgadza sie z polami czlonka.');
        return null;
      }
      return { key, hash, approvedAt, via, fields };
    },
    (record) => record.key,
  );
  if (c.errors.length > 0 || pack === null) return fail(c.errors);
  return ok({ pack, members });
}

/** Skrot calego pakietu do wypisania (`approvals list`): z posortowanych skrotow czlonkow. */
export function packTrustDigest(file: PackTrustFile): string {
  const lines = [...file.members.map((m) => m.hash)].sort().join('\n');
  return createHash('sha256').update(PACK_DOMAIN, 'utf8').update(lines, 'utf8').digest('hex');
}

// --- Wyprowadzenie czlonka i ocena ---------------------------------------------------------

/**
 * Skrypt, ktory hook czlonka uruchamia z profilu: `rel` wzgledem profilu, `owner` to klucz zasobu,
 * ktory ten plik zapisze do profilu w tym planie (null: zaden). Zalezy od zestawu zasobow firmy,
 * wiec nie moze byc zapisany przy imporcie; sprawdzany jest przy starcie.
 */
export interface PackDep {
  readonly rel: string;
  readonly owner: string | null;
}

export interface PackMemberFacts {
  readonly pack: string;
  readonly key: string;
  readonly kind: PackKind;
  readonly id: string;
  readonly fields: MemberFields;
  /** Czlonek ma pola wykonawcze i wymaga zatwierdzenia (`needsApproval`). */
  readonly required: boolean;
  readonly warnings: readonly string[];
  readonly deps: readonly PackDep[];
  /** Powody, dla ktorych pol nie da sie wyprowadzic deterministycznie: zgoda pakietu ich nie obejmuje. */
  readonly blockers: readonly string[];
}

export type PackVerdict =
  | {
      readonly state: 'covered';
      readonly pack: string;
      readonly approvedAt: string;
      readonly via: 'import' | 'start';
    }
  | {
      readonly state: 'pending';
      readonly pack: string;
      /** `blocked`: pola zalezne od firmy albo planu, pakiet ich nie obejmuje (zgoda tylko dla tej firmy). */
      readonly reason: 'new' | 'changed' | 'blocked';
      readonly changes: readonly FieldChange[];
      readonly blockers: readonly string[];
    };

function fileDetail(before: MemberFields, after: MemberFields): string[] {
  const a = new Map(before.files.map((f) => [f.path, f.sha256]));
  const b = new Map(after.files.map((f) => [f.path, f.sha256]));
  const out: string[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(path);
    const y = b.get(path);
    if (x === undefined) out.push(`dodany plik: ${path}`);
    else if (y === undefined) out.push(`usuniety plik: ${path}`);
    else if (x !== y) out.push(`zmieniony plik: ${path}`);
  }
  if (before.filesMore > 0 || after.filesMore > 0) {
    out.push('(lista plikow skrocona do pierwszych 40; pelna zmiana jest w skrocie drzewa)');
  }
  return out;
}

/**
 * Ocena czlonkow planu wobec zaufanych skrotow pakietow. Czlonek jest objety zgoda, gdy jego skrot
 * (definicja, drzewo, pola wykonawcze) rowna sie zaufanemu, nic go nie blokuje, a kazdy skrypt hooka
 * z profilu pochodzi z czlonka pakietu o zgodnym zaufanym skrocie. Reszta wraca jako `pending`.
 * Zwraca werdykty tylko dla czlonkow z polami wykonawczymi (`required`).
 */
export function evaluatePackMembers(
  facts: readonly PackMemberFacts[],
  trust: ReadonlyMap<string, PackTrustFile>,
): Map<string, PackVerdict> {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const recordOf = (f: PackMemberFacts): PackMemberRecord | undefined =>
    trust.get(f.pack)?.members.find((m) => m.key === f.key);
  const matches = (f: PackMemberFacts): boolean =>
    recordOf(f)?.hash === packMemberHash(f.key, f.fields);

  const verdicts = new Map<string, PackVerdict>();
  for (const f of facts) {
    if (!f.required) continue;
    const record = recordOf(f);
    const changes: FieldChange[] = [];
    const blockers = [...f.blockers];
    let reason: 'new' | 'changed' = 'changed';
    if (record === undefined) reason = 'new';
    else if (record.hash !== packMemberHash(f.key, f.fields)) {
      changes.push(...diffFields(record.fields, f.fields as unknown as Record<string, unknown>));
    }
    for (const dep of f.deps) {
      if (dep.owner === f.key) continue;
      if (dep.owner === null) {
        blockers.push(`skrypt hooka ${dep.rel}: plik nie pochodzi z zadnego zasobu tego planu`);
        continue;
      }
      const owner = byKey.get(dep.owner);
      if (owner === undefined) {
        blockers.push(`skrypt hooka ${dep.rel}: pochodzi z zasobu ${dep.owner} spoza pakietow`);
      } else if (owner.pack !== f.pack) {
        blockers.push(
          `skrypt hooka ${dep.rel}: pochodzi z zasobu ${dep.owner} z innego pakietu (${owner.pack})`,
        );
      } else if (owner.blockers.length > 0) {
        blockers.push(
          `skrypt hooka ${dep.rel}: zasob ${dep.owner} nie ma zaufanych pol (zgoda tylko dla firmy)`,
        );
      } else if (!matches(owner)) {
        const ownerRecord = recordOf(owner);
        changes.push({
          name: `zasob ze skryptem hooka: ${dep.owner}`,
          before: ownerRecord === undefined ? null : JSON.stringify(ownerRecord.fields.tree),
          after: JSON.stringify(owner.fields.tree),
          detail:
            ownerRecord === undefined
              ? ['zasob nie jest w zaufanym skrocie pakietu']
              : fileDetail(ownerRecord.fields, owner.fields),
        });
      }
    }
    if (blockers.length > 0) {
      verdicts.set(f.key, { state: 'pending', pack: f.pack, reason: 'blocked', changes, blockers });
    } else if (record !== undefined && changes.length === 0) {
      verdicts.set(f.key, {
        state: 'covered',
        pack: f.pack,
        approvedAt: record.approvedAt,
        via: record.via,
      });
    } else {
      verdicts.set(f.key, { state: 'pending', pack: f.pack, reason, changes, blockers });
    }
  }
  return verdicts;
}

/** Zaufani czlonkowie pakietu, ktorych zasobu nie ma juz w rejestrze (do pokazania na ekranie zmian). */
export function removedMembers(
  trust: PackTrustFile | undefined,
  exists: (key: string) => boolean,
): string[] {
  return (trust?.members ?? [])
    .map((m) => m.key)
    .filter((key) => !exists(key))
    .sort();
}

/** Wartosc z kazdym tekstem przeksztalconym przez `fn` (obiekty, listy, teksty; reszta bez zmian). */
export function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return (value as unknown[]).map((item) => mapStrings(item, fn));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, mapStrings(inner, fn)]),
    );
  }
  return value;
}

// --- Grupowanie przy imporcie ----------------------------------------------------------------

export interface GroupInput {
  readonly kind: PackKind;
  readonly id: string;
  /** Sciezka zasobu po realpath (pochodzenie importu); null, gdy nieznana. */
  readonly sourceReal: string | null;
}

export interface GroupOptions {
  /** Przestrzen nazw pakietow (`global` albo id firmy). */
  readonly namespace: string;
  readonly company: boolean;
  /** `realpath(--from)`. */
  readonly from: string;
  /** Zasoby, ktore juz naleza do pakietu (klucz zasobu -> id pakietu): zostaja tam, gdzie sa. */
  readonly existing: ReadonlyMap<string, string>;
}

const KIND_PACK_NAME: Record<PackKind, string> = {
  skill: 'skills',
  agent: 'agents',
  command: 'commands',
  files: 'files',
  settings: 'settings',
};
const NATIVE_DIR: Partial<Record<PackKind, string>> = {
  skill: 'skills',
  agent: 'agents',
  command: 'commands',
};

const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** Pierwszy segment nazwy (`antislop-ui` -> `antislop`); dla `Files` bez przedrostka `skills-` i `agents-`. */
function prefixOf(item: GroupInput): string | null {
  let name = item.id.slice(item.id.indexOf('/') + 1);
  if (item.kind === 'files') name = name.replace(/^(?:skills|agents)-/, '');
  const dash = name.indexOf('-');
  const head = dash < 0 ? name : name.slice(0, dash);
  return head.length >= 3 ? head : null;
}

/**
 * Automatyczne grupowanie zasobow przy imporcie: (1) import do firmy to jeden pakiet o nazwie
 * firmy; (2) zasoby z jednego katalogu zrodlowego po realpath (np. skille dowiazane z jednego
 * repozytorium), gdy katalog nie jest natywnym katalogiem rodzaju; (3) wspolny przedrostek nazwy
 * (co najmniej dwa zasoby); (4) reszta wedlug rodzaju. Zasob, ktory juz jest w pakiecie, zostaje w nim.
 */
export function groupForPacks(
  items: readonly GroupInput[],
  options: GroupOptions,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const place = (name: string, key: string): void => {
    const id = packId(options.namespace, name);
    result.set(id, [...(result.get(id) ?? []), key]);
  };
  const open: GroupInput[] = [];
  for (const item of items) {
    const key = memberKey(item.kind, item.id);
    const existing = options.existing.get(key);
    if (existing !== undefined) result.set(existing, [...(result.get(existing) ?? []), key]);
    else open.push(item);
  }
  if (options.company) {
    for (const item of open) place(options.namespace, memberKey(item.kind, item.id));
  } else {
    const linked = new Map<string, GroupInput[]>();
    for (const item of open) {
      const native = NATIVE_DIR[item.kind];
      if (native === undefined || item.sourceReal === null) continue;
      const parent = parentOf(item.sourceReal);
      if (parent === '' || parent === `${options.from}/${native}`) continue;
      linked.set(parent, [...(linked.get(parent) ?? []), item]);
    }
    const claimed = new Set<GroupInput>();
    const names = new Set<string>();
    for (const [parent, group] of linked) {
      if (group.length < 2) continue;
      const name = sanitizePackName(baseOf(parent));
      names.add(name);
      for (const item of group) {
        place(name, memberKey(item.kind, item.id));
        claimed.add(item);
      }
    }
    const rest = open.filter((item) => !claimed.has(item));
    const byPrefix = new Map<string, GroupInput[]>();
    for (const item of rest) {
      const prefix = prefixOf(item);
      if (prefix !== null) byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), item]);
    }
    for (const item of rest) {
      const prefix = prefixOf(item);
      const same = prefix === null ? [] : (byPrefix.get(prefix) ?? []);
      const name = prefix === null ? null : sanitizePackName(prefix);
      if (name !== null && (same.length >= 2 || names.has(name))) {
        place(name, memberKey(item.kind, item.id));
      } else place(KIND_PACK_NAME[item.kind], memberKey(item.kind, item.id));
    }
  }
  for (const [id, keys] of [...result]) {
    result.set(id, [...new Set(keys)].sort());
  }
  return result;
}

/** Dzieli zbyt duze pakiety na `nazwa`, `nazwa-2`, ... (limit czlonkow manifestu). */
export function splitLargePacks(
  groups: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, keys] of groups) {
    if (keys.length <= PACK_MAX_MEMBERS) {
      out.set(id, [...keys]);
      continue;
    }
    for (let start = 0, part = 1; start < keys.length; start += PACK_MAX_MEMBERS, part += 1) {
      out.set(part === 1 ? id : `${id}-${part}`, keys.slice(start, start + PACK_MAX_MEMBERS));
    }
  }
  return out;
}
