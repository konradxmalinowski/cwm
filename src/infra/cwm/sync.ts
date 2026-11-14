import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  dependenciesOf,
  normalizeResourceName,
  RESOURCE_SET_KEYS,
  refKey,
  type Resource,
  type ResourceKind,
} from '../../core/cwm';
import { readBounded } from '../fs/bounded-read';
import { errnoCode } from '../fs/store-error';
import { lstatOrNull } from '../fs/stat';
import { dropApprovalKeys } from './approvals';
import {
  applyImportPlan,
  buildImportPlan,
  resourceDirFor,
  targetNamespace,
  type ApplyResult,
  type ImportPlan,
  type ImportTarget,
} from './import-plan';
import { scanClaudeSource, withIncluded } from './import-source';
import { IMPORT_LIMITS, type Candidate, type ReportItem } from './import-types';
import { isSafeSegment, type CwmLayout } from './layout';
import {
  applyPackPlan,
  buildPackPlan,
  type PackApplyOutcome,
  type PackImportPlan,
} from './pack-import';
import { loadPackDefs, removePackMembers, withGlobalLock, type PackMembersRemoval } from './packs';
import { realpathLoose } from './paths';
import { removeFromResourceLists, type ListEdit, type ResourceListRef } from './resource-lists';
import { loadWorkspace, type Workspace } from './workspace';
import { homeScope, removeScopedTree } from './writer';

/**
 * `cwm sync` (ADR 0045): odswieza rejestr z katalogow natywnych zapisanych w `spec.nativeDir`
 * zasobow. Zasoby sa grupowane po (katalog zrodlowy, przestrzen nazw); kazda grupa przechodzi ten
 * sam skan, plan i pakiety co `cwm import`, a zasoby, ktorych zrodlo zniklo, ida do sekcji usuniec.
 * Zrodlo natywne jest tylko czytane, nigdy zapisywane.
 */

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

export interface SyncOptions {
  /** Jedno zrodlo (`--source`); inaczej wszystkie zrodla z rejestru. */
  readonly source?: string;
  readonly homeDir: string;
}

/** Zasob rejestru z zapisanym pochodzeniem. */
interface Tracked {
  readonly key: string;
  readonly kind: ResourceKind;
  readonly id: string;
  readonly name: string;
  readonly dir: string;
}

export type SourceState = 'ok' | 'missing' | 'error';

export interface SyncSourcePlan {
  readonly from: string;
  readonly namespace: string;
  readonly target: ImportTarget;
  readonly state: SourceState;
  readonly message: string | null;
  readonly plan: ImportPlan | null;
  readonly packs: PackImportPlan | null;
  /** Oznaczone pliki dolaczone bez pytania: sa w rejestrze z tym samym skrotem pliku (sciezki wzgledem zrodla). */
  readonly autoIncluded: readonly string[];
  /** Oznaczone pliki, ktore byly dolaczone, ale zrodlo je zmienilo: wymagaja nowej decyzji. */
  readonly changedFlagged: readonly string[];
  /** Zasoby tej grupy w rejestrze (klucze). */
  readonly tracked: readonly string[];
  /** Zrodlo nie dalo sie przejrzec w calosci (np. skrocony katalog): nic z niego nie jest usuwane. */
  readonly incomplete: boolean;
  /** Wynik skanu do ponownego planu po wyborze plikow na terminalu. */
  readonly scan: {
    readonly candidates: readonly Candidate[];
    readonly skipped: readonly ReportItem[];
    readonly root: string;
  } | null;
}

export interface SyncRemoval {
  readonly key: string;
  readonly kind: ResourceKind;
  readonly id: string;
  readonly dir: string;
  readonly from: string;
  readonly reason: 'directory' | 'entry';
  /** Miejsca, z ktorych usuniecie tez wycina zasob (config, firmy, pakiet). */
  readonly refs: readonly string[];
  /** Powody odmowy usuniecia: zasob obowiazkowy albo wymagany przez aktywny zasob. */
  readonly blockedBy: readonly string[];
}

export interface SyncPlan {
  readonly sources: readonly SyncSourcePlan[];
  readonly removals: readonly SyncRemoval[];
  readonly warnings: readonly string[];
  readonly companyIds: readonly string[];
  /** Brakuje czegos, co uniemozliwia zapis calosci planu (zob. `blocked`). */
  readonly blocked: boolean;
}

function nativeDirOf(resource: Resource): string | null {
  switch (resource.kind) {
    case 'skill':
    case 'agent':
    case 'command':
    case 'files':
      return resource.nativeDir ?? null;
    default:
      return null;
  }
}

function nameOfId(id: string): string {
  return id.slice(id.indexOf('/') + 1);
}

function setsOf(
  block: Partial<Record<string, readonly string[]>> | undefined,
): { kind: ResourceKind; id: string }[] {
  const out: { kind: ResourceKind; id: string }[] = [];
  if (block === undefined) return out;
  for (const [kind, key] of Object.entries(RESOURCE_SET_KEYS) as [ResourceKind, string][]) {
    for (const id of block[key] ?? []) out.push({ kind, id });
  }
  return out;
}

/** Katalog zrodlowy: `missing`, gdy go nie ma; `error`, gdy nie jest katalogiem albo nie da sie go sprawdzic. */
async function inspectSource(
  from: string,
): Promise<{ state: SourceState; message: string | null }> {
  try {
    const info = await stat(from);
    if (!info.isDirectory()) return { state: 'error', message: 'Zrodlo nie jest katalogiem.' };
    return { state: 'ok', message: null };
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { state: 'missing', message: 'Katalog zrodlowy nie istnieje.' };
    }
    return {
      state: 'error',
      message: `Katalogu zrodlowego nie mozna sprawdzic (${code ?? 'blad'}).`,
    };
  }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function readRegistryFile(dir: string, rel: string): Promise<Uint8Array | null> {
  try {
    const read = await readBounded(join(dir, ...rel.split('/')), IMPORT_LIMITS.fileBytes);
    return read.truncated ? null : read.bytes;
  } catch {
    return null;
  }
}

/**
 * Oznaczone pliki (mozliwy sekret) wracaja do zasobu tylko wtedy, gdy sa juz w rejestrze z tym samym
 * skrotem: ktos swiadomie je dolaczyl przy imporcie i zrodlo ich nie zmienilo. Porownanie idzie po
 * bajtach, ktore import by zapisal (dla rodzaju `files` po przetworzeniu frontmattera).
 */
async function reincludeFlagged(
  layout: CwmLayout,
  target: ImportTarget,
  candidates: readonly Candidate[],
): Promise<{ included: Set<string>; changed: Set<string> }> {
  const included = new Set<string>();
  const changed = new Set<string>();
  for (const candidate of candidates) {
    const eligible = candidate.flagged.filter((f) => !f.hard && f.file !== null);
    if (eligible.length === 0 || candidate.kind === 'settings') continue;
    const dir = resourceDirFor(layout, candidate.kind, target, candidate.name);
    for (const flagged of eligible) {
      const existing = await readRegistryFile(dir, flagged.rel);
      if (existing === null) continue;
      const next = withIncluded(candidate, new Set([flagged.path])).files.find(
        (file) => file.rel === flagged.rel,
      );
      if (next === undefined) continue;
      if (sha256(next.bytes) === sha256(existing)) included.add(flagged.path);
      else changed.add(flagged.path);
    }
  }
  return { included, changed };
}

/**
 * Klucze `rodzaj:nazwa` zasobow, ktore zrodlo nadal ma, choc plan ich nie zawiera (pominiete z
 * raportem): taki zasob nie jest usuwany z rejestru, bo jego zrodlo istnieje.
 */
function presentKeys(
  candidates: readonly Candidate[],
  skipped: readonly ReportItem[],
): Set<string> {
  const keys = new Set<string>();
  for (const candidate of candidates) keys.add(`${candidate.kind}:${candidate.name}`);
  const add = (kind: ResourceKind, raw: string): void => {
    const name = normalizeResourceName(raw);
    if (name.ok) keys.add(`${kind}:${name.name}`);
  };
  for (const entry of skipped) {
    // Zerwane dowiazanie to zrodlo, ktore zniklo (np. usuniety katalog zestawu skilli).
    if (entry.reason === 'dowiazanie zerwane') continue;
    const [root, rawEntry] = entry.item.split('/');
    if (rawEntry === undefined) continue;
    const base = rawEntry.replace(/\.md$/i, '');
    if (root === 'skills') {
      add('skill', base);
      add('files', `skills-${base}`);
    } else if (root === 'agents') {
      add('agent', base);
      add('files', `agents-${base}`);
    } else if (root === 'commands') add('command', base);
  }
  return keys;
}

const AREAS: ReadonlySet<string> = new Set(['skills', 'agents', 'commands']);

async function planSource(
  layout: CwmLayout,
  target: ImportTarget,
  scan: NonNullable<SyncSourcePlan['scan']>,
  included: ReadonlySet<string>,
  homeDir: string,
): Promise<{ plan: ImportPlan; packs: PackImportPlan }> {
  const plan = await buildImportPlan(
    layout,
    target,
    scan.candidates.map((candidate) => withIncluded(candidate, included)),
    scan.skipped,
  );
  const packs = await buildPackPlan(layout, plan, scan.root, homeDir);
  return { plan, packs };
}

/** Plan jednej grupy po dolaczeniu dodatkowych oznaczonych plikow wybranych na terminalu. */
export async function rebuildSyncSource(
  layout: CwmLayout,
  source: SyncSourcePlan,
  extra: ReadonlySet<string>,
  homeDir: string,
): Promise<SyncSourcePlan> {
  if (source.scan === null) return source;
  const included = new Set([...source.autoIncluded, ...extra]);
  const built = await planSource(layout, source.target, source.scan, included, homeDir);
  return { ...source, ...built };
}

interface Group {
  readonly from: string;
  readonly namespace: string;
  readonly target: ImportTarget;
  readonly members: Tracked[];
}

function groupsOf(workspace: Workspace, conflicts: ReadonlySet<string>): Group[] {
  const groups = new Map<string, Group>();
  for (const entry of workspace.registry.entries) {
    const from = nativeDirOf(entry.resource);
    if (from === null || conflicts.has(refKey(entry.resource))) continue;
    const target: ImportTarget =
      entry.origin.scope === 'global'
        ? { scope: 'global' }
        : { scope: 'company', company: entry.origin.company };
    const namespace = targetNamespace(target);
    if (nameOfId(entry.resource.id) === '' || entry.resource.id.split('/')[0] !== namespace)
      continue;
    const key = `${from}\0${namespace}`;
    const group = groups.get(key) ?? { from, namespace, target, members: [] };
    group.members.push({
      key: refKey(entry.resource),
      kind: entry.resource.kind,
      id: entry.resource.id,
      name: nameOfId(entry.resource.id),
      dir: entry.dir,
    });
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.from + a.namespace < b.from + b.namespace ? -1 : 1,
  );
}

/** Przestrzen nazw, ktora nie jest ani wspolna, ani firma z katalogu, nie ma celu importu. */
function validTarget(group: Group): boolean {
  return group.target.scope === 'global' ? true : isSafeSegment(group.target.company);
}

async function buildSource(
  layout: CwmLayout,
  group: Group,
  homeDir: string,
): Promise<{
  source: SyncSourcePlan;
  gone: Tracked[];
  planned: Set<string>;
  present: Set<string>;
}> {
  const base = {
    from: group.from,
    namespace: group.namespace,
    target: group.target,
    plan: null,
    packs: null,
    autoIncluded: [] as string[],
    changedFlagged: [] as string[],
    tracked: group.members.map((m) => m.key),
    incomplete: false,
    scan: null,
  };
  const none = { planned: new Set<string>(), present: new Set<string>() };
  const inspected = await inspectSource(group.from);
  if (inspected.state === 'missing') {
    return {
      source: { ...base, state: 'missing', message: inspected.message },
      gone: group.members,
      ...none,
    };
  }
  if (inspected.state === 'error' || !validTarget(group)) {
    return {
      source: {
        ...base,
        state: 'error',
        message: inspected.message ?? 'Niepoprawna przestrzen nazw.',
      },
      gone: [],
      ...none,
    };
  }
  let scanned: Awaited<ReturnType<typeof scanClaudeSource>>;
  try {
    scanned = await scanClaudeSource(group.from, { cwmHome: layout.home });
  } catch (error: unknown) {
    const code = errnoCode(error);
    return {
      source: {
        ...base,
        state: 'error',
        message: `Zrodla nie da sie przejrzec (${code ?? 'blad odczytu'}).`,
      },
      gone: [],
      ...none,
    };
  }
  if (!scanned.ok) {
    return { source: { ...base, state: 'error', message: scanned.message }, gone: [], ...none };
  }
  // Settings nie ma pochodzenia w rejestrze (brak nativeDir): sync go nie dotyka, zostaje `cwm import claude`.
  const candidates = scanned.candidates.filter((candidate) => candidate.kind !== 'settings');
  const scan = { candidates, skipped: scanned.skipped, root: scanned.from };
  const { included, changed } = await reincludeFlagged(layout, group.target, candidates);
  const built = await planSource(layout, group.target, scan, included, homeDir);
  // Obszar, ktory nie jest zwyklym katalogiem albo nie da sie go sprawdzic (EACCES, EPERM, ENOTDIR),
  // nie jest "pusty": zrodlo jest niepelne i nic z niego nie jest usuwane.
  let areaProblem = false;
  for (const area of AREAS) {
    try {
      const info = await lstatOrNull(join(scanned.from, area));
      if (info !== null && !info.isDirectory()) areaProblem = true;
    } catch {
      areaProblem = true;
    }
  }
  const incomplete = areaProblem || scanned.skipped.some((entry) => AREAS.has(entry.item));
  const present = presentKeys(candidates, scanned.skipped);
  const planned = new Set(built.plan.items.map((item) => `${item.kind}:${item.id}`));
  const gone = incomplete
    ? []
    : group.members.filter(
        (member) => !planned.has(member.key) && !present.has(`${member.kind}:${member.name}`),
      );
  return {
    source: {
      ...base,
      state: 'ok',
      message: incomplete
        ? 'Zrodlo przejrzane niepelnie (katalog pominiety albo skrocony): zasoby nie sa usuwane.'
        : null,
      plan: built.plan,
      packs: built.packs,
      autoIncluded: [...included].sort(),
      changedFlagged: [...changed].sort(),
      incomplete,
      scan,
    },
    gone,
    planned,
    present,
  };
}

/**
 * Plan synchronizacji: dla kazdej grupy (zrodlo, przestrzen nazw) plan importu i pakietow oraz lista
 * zasobow do usuniecia. Usuniecie jest zablokowane, gdy zasob jest obowiazkowy albo wymaga go aktywny
 * zasob (chyba ze tamten tez jest usuwany). Nic nie jest zapisywane.
 */
export async function buildSyncPlan(layout: CwmLayout, options: SyncOptions): Promise<SyncPlan> {
  const workspace = await loadWorkspace(layout);
  if (!workspace.global.ok) {
    throw new SyncError('config.yaml jest niepoprawny albo nieczytelny (cwm doctor).');
  }
  const config = workspace.global.value;
  const only = options.source === undefined ? null : await realpathLoose(resolve(options.source));
  const conflicts = new Set(workspace.registry.conflicts());
  const allGroups = groupsOf(workspace, conflicts);
  const selected: Group[] = [];
  for (const group of allGroups) {
    if (only === null || (await realpathLoose(group.from)) === only) selected.push(group);
  }
  if (selected.length === 0) {
    throw new SyncError(
      options.source === undefined
        ? 'Rejestr nie ma zasobow z zapisanym zrodlem (spec.nativeDir). Zaimportuj: cwm import claude'
        : 'Zaden zasob w rejestrze nie pochodzi z tego zrodla (--source).',
    );
  }
  // Wszystkie grupy sa przegladane (takze przy --source): zasob moze byc w planie albo w zrodle innej
  // grupy, wiec "zniknal" wolno orzec dopiero po sprawdzeniu ich wszystkich.
  const built: { group: Group; result: Awaited<ReturnType<typeof buildSource>> }[] = [];
  for (const group of allGroups) {
    built.push({ group, result: await buildSource(layout, group, options.homeDir) });
  }
  const plannedAll = new Set<string>();
  const presentAll = new Set<string>();
  const claimedBy = new Map<string, Set<string>>();
  for (const { group, result } of built) {
    if (result.source.state !== 'ok') continue;
    for (const key of result.planned) {
      plannedAll.add(key);
      claimedBy.set(
        key,
        (claimedBy.get(key) ?? new Set()).add(`${group.from}\0${group.namespace}`),
      );
    }
    for (const key of result.present) presentAll.add(key);
  }
  // Zasob zgłoszony przez dwa zrodla przestawialby `nativeDir` tam i z powrotem: oba zrodla sa bledem.
  const doubled = new Map<string, string>();
  for (const [key, froms] of claimedBy) {
    if (froms.size > 1) for (const id of froms) doubled.set(id, key);
  }
  const sources: SyncSourcePlan[] = [];
  const gone: (Tracked & { from: string; reason: 'directory' | 'entry' })[] = [];
  const warnings: string[] = [];
  for (const { group, result } of built) {
    if (only !== null && !selected.includes(group)) continue;
    let source = result.source;
    const clash = doubled.get(`${group.from}\0${group.namespace}`);
    if (clash !== undefined) {
      source = {
        ...source,
        state: 'error',
        message: `Zasob ${clash} wystepuje w wielu zrodlach (${[...(claimedBy.get(clash) ?? [])].map((id) => id.split('\0')[0]).join(', ')}): nic z tego zrodla nie jest zmieniane.`,
        plan: null,
        packs: null,
        scan: null,
      };
    }
    sources.push(source);
    if (clash !== undefined) continue;
    for (const member of result.gone) {
      if (plannedAll.has(member.key) || presentAll.has(`${member.kind}:${member.name}`)) {
        warnings.push(
          `${member.key} nie ma zrodla w ${group.from}, ale istnieje w innym zrodle: zostaje w rejestrze.`,
        );
        continue;
      }
      gone.push({
        ...member,
        from: group.from,
        reason: source.state === 'missing' ? 'directory' : 'entry',
      });
    }
  }

  const goneKeys = new Set(gone.map((g) => g.key));
  const mandatory = new Set(setsOf(config.resources.mandatory).map((r) => refKey(r)));
  const optional = setsOf(config.resources.optional);
  const defs = await loadPackDefs(layout);
  const active = new Set<string>([...mandatory, ...optional.map((r) => refKey(r))]);
  const refsByKey = new Map<string, string[]>();
  const note = (key: string, text: string): void => {
    refsByKey.set(key, [...(refsByKey.get(key) ?? []), text]);
  };
  for (const ref of setsOf(config.resources.mandatory)) note(refKey(ref), 'config.yaml: mandatory');
  for (const ref of optional) note(refKey(ref), 'config.yaml: optional');
  for (const [company, loaded] of workspace.companies) {
    if (!loaded.ok) continue;
    for (const ref of setsOf(loaded.value.resources.enable)) {
      active.add(refKey(ref));
      note(refKey(ref), `firma ${company}: enable`);
    }
    for (const ref of setsOf(loaded.value.resources.disableOptional)) {
      note(refKey(ref), `firma ${company}: disableOptional`);
    }
    for (const ref of setsOf(loaded.value.exports)) note(refKey(ref), `firma ${company}: exports`);
  }
  for (const record of workspace.homeProjects) {
    if (!record.loaded.ok) continue;
    for (const ref of setsOf(record.loaded.value.spec.resources.enable)) {
      active.add(refKey(ref));
      if (goneKeys.has(refKey(ref))) {
        warnings.push(
          `projekt ${record.loaded.value.metadata.id} (firma ${record.loaded.value.metadata.company}) wlacza ${refKey(ref)}; po usunieciu wpis w manifescie projektu zostaje do recznego poprawienia.`,
        );
      }
    }
  }

  const removals: SyncRemoval[] = gone.map((item) => {
    const blockedBy: string[] = [];
    const refKeyOfItem = refKey({ kind: item.kind, id: item.id });
    if (mandatory.has(refKeyOfItem)) {
      blockedBy.push(
        `jest w resources.mandatory (config.yaml); zdejmij go stamtad recznie, potem ponow sync`,
      );
    }
    for (const entry of workspace.registry.entries) {
      const key = refKey(entry.resource);
      if (goneKeys.has(key) || !active.has(key)) continue;
      if (dependenciesOf(entry.resource).some((dep) => refKey(dep) === refKeyOfItem)) {
        blockedBy.push(`wymaga go aktywny zasob ${key}`);
      }
    }
    const refs = [...(refsByKey.get(refKeyOfItem) ?? [])];
    const pack = defs.membership.get(item.key);
    if (pack !== undefined) refs.push(`pakiet ${pack}`);
    return {
      key: item.key,
      kind: item.kind,
      id: item.id,
      dir: item.dir,
      from: item.from,
      reason: item.reason,
      refs,
      blockedBy,
    };
  });
  removals.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    sources,
    removals,
    warnings,
    companyIds: workspace.companyIds,
    blocked: removals.some((removal) => removal.blockedBy.length > 0),
  };
}

export interface SyncApplyResult {
  readonly imports: readonly ApplyResult[];
  readonly packs: readonly PackApplyOutcome[];
  readonly removed: readonly {
    readonly key: string;
    readonly ok: boolean;
    readonly message?: string;
  }[];
  readonly listEdits: readonly ListEdit[];
  readonly packRemoval: PackMembersRemoval | null;
  readonly approvalCompanies: readonly string[];
  /** Bledy, ktore nie przerwaly reszty; niepusta lista to kod wyjscia 1. */
  readonly failures: readonly string[];
}

/**
 * Zapis zatwierdzonego planu. Kolejnosc: zasoby i pakiety, potem czyszczenie odwolan (config, firmy,
 * pakiety, zatwierdzenia), a katalogi usuwanych zasobow na koncu: gdy cos po drodze padnie, zasob
 * zostaje w rejestrze ze zrodlem, ktore zniklo, wiec kolejny `cwm sync` dokonczy usuwanie.
 */
export function applySyncPlan(
  layout: CwmLayout,
  plan: SyncPlan,
  homeDir: string,
  describeError: (error: unknown) => string,
): Promise<SyncApplyResult> {
  // Mutex `runtime/global` przez caly zapis (takze edycje YAML), jak zapis zaufanych skrotow pakietow.
  return withGlobalLock(layout, () => applyLocked(layout, plan, homeDir, describeError));
}

async function applyLocked(
  layout: CwmLayout,
  plan: SyncPlan,
  homeDir: string,
  describeError: (error: unknown) => string,
): Promise<SyncApplyResult> {
  const failures: string[] = [];
  const imports: ApplyResult[] = [];
  const packs: PackApplyOutcome[] = [];
  for (const source of plan.sources) {
    if (source.state !== 'ok' || source.plan === null || source.packs === null) continue;
    const results = await applyImportPlan(layout, source.plan, describeError);
    imports.push(...results);
    for (const result of results) {
      if (!result.ok)
        failures.push(`${result.kind} ${result.id}: ${result.message ?? 'blad zapisu'}`);
    }
    try {
      packs.push(...(await applyPackPlan(layout, source.packs, homeDir)));
    } catch (error: unknown) {
      failures.push(`zgoda pakietow (${source.from}): ${describeError(error)}`);
    }
  }

  const removed: { key: string; ok: boolean; message?: string }[] = [];
  let listEdits: ListEdit[] = [];
  let packRemoval: PackMembersRemoval | null = null;
  let approvalCompanies: string[] = [];
  if (plan.removals.length > 0) {
    const refs: ResourceListRef[] = plan.removals.map((r) => ({ kind: r.kind, id: r.id }));
    const keys = plan.removals.map((r) => r.key);
    let cleaned = true;
    try {
      listEdits = await removeFromResourceLists(layout, plan.companyIds, refs);
      packRemoval = await removePackMembers(layout, keys);
      const dropped = await dropApprovalKeys(
        layout,
        plan.removals.map((r) => refKey(r)),
      );
      approvalCompanies = dropped.touched;
      for (const company of dropped.corrupt) {
        failures.push(`zatwierdzenia firmy ${company} sa uszkodzone: zostaly bez zmian`);
      }
    } catch (error: unknown) {
      cleaned = false;
      failures.push(
        `czyszczenie odwolan (config, firmy, pakiety, zatwierdzenia): ${describeError(error)}; zasoby zostaja w rejestrze, ponow cwm sync`,
      );
    }
    if (cleaned) {
      const scope = homeScope(layout.home);
      for (const removal of plan.removals) {
        try {
          await removeScopedTree(scope, removal.dir);
          removed.push({ key: removal.key, ok: true });
        } catch (error: unknown) {
          const message = describeError(error);
          removed.push({ key: removal.key, ok: false, message });
          failures.push(`usuniecie ${removal.key}: ${message}`);
        }
      }
    }
  }
  return { imports, packs, removed, listEdits, packRemoval, approvalCompanies, failures };
}
