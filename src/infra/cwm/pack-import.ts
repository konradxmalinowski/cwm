import {
  groupForPacks,
  isPackKind,
  memberKey,
  packMemberHash,
  parseMemberKey,
  splitLargePacks,
  validateResource,
  type PackKind,
  type PackMemberRef,
} from '../../core/cwm';
import { resourceFileName, type CwmLayout } from './layout';
import { type ImportPlan, type PlanItem, type PlanStatus, targetNamespace } from './import-plan';
import {
  bindMember,
  deriveMember,
  isPackResource,
  memberFiles,
  type DerivedMember,
  type PackResource,
} from './pack-derive';
import {
  loadPackDefs,
  loadPackTrusts,
  newPack,
  recordPackTrust,
  savePackDef,
  type PackDefs,
} from './packs';
import { readTextWithin } from './read';
import { readTree, type TreeFile } from './runtime-sources';
import { parseManifestYaml } from './yaml-manifest';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type MemberTrustState = 'approved' | 'new' | 'changed';

export interface PackPlanMember {
  readonly key: string;
  readonly item: PlanItem;
  readonly derived: DerivedMember;
  readonly trust: MemberTrustState;
  readonly status: PlanStatus;
}

export interface PackPlan {
  readonly id: string;
  readonly definition: 'new' | 'changed' | 'same';
  readonly members: readonly PackPlanMember[];
  /** Czy pakiet wymaga zapisu: nowa albo zmieniona definicja, albo czlonek z polami wykonawczymi bez zgody. */
  readonly pending: boolean;
  /** Pakiet ma zapisana zgode, ale uszkodzony plik: zapis go nie nadpisze. */
  readonly corrupt: string | null;
}

export interface PackImportPlan {
  readonly packs: readonly PackPlan[];
  readonly problems: readonly string[];
}

function parseResource(item: PlanItem): PackResource | null {
  const manifest = item.files.find((f) => f.rel === resourceFileName(item.kind));
  if (manifest === undefined) return null;
  const parsed = parseManifestYaml(new TextDecoder().decode(manifest.bytes));
  if (!parsed.ok) return null;
  const checked = validateResource(parsed.value);
  return checked.ok && isPackResource(checked.value) ? checked.value : null;
}

const treeOf = (item: PlanItem): TreeFile[] =>
  item.files.map((f) => ({ rel: f.rel, bytes: f.bytes, executable: f.executable }));

/**
 * Plan pakietow przy imporcie: grupowanie zasobow planu (takze bez zmian), pola kazdego czlonka
 * wyprowadzone z bajtow, ktore import zapisze, i porownanie z zaufanymi skrotami. Nic nie jest zapisywane.
 */
/**
 * Zrodlo do grupowania: dla skilla, ktorego katalog jest zwyklym katalogiem z dowiazanym SKILL.md
 * (np. skille jednego repozytorium dowiazane plik po pliku), katalog celu dowiazania. Tylko do
 * nazwy pakietu; tresc i skroty liczone sa jak dotad z kopii w rejestrze.
 */
async function groupingSource(kind: PackKind, source: string | null): Promise<string | null> {
  if (kind !== 'skill' || source === null) return source;
  const manifest = join(source, 'SKILL.md');
  try {
    if (!(await lstat(manifest)).isSymbolicLink()) return source;
    return dirname(await realpath(manifest));
  } catch {
    return source;
  }
}

export async function buildPackPlan(
  layout: CwmLayout,
  plan: ImportPlan,
  from: string,
  homeDir: string,
): Promise<PackImportPlan> {
  const defs = await loadPackDefs(layout);
  const problems = [...defs.problems];
  const resources = new Map<string, { item: PlanItem; resource: PackResource }>();
  for (const item of plan.items) {
    const resource = parseResource(item);
    if (resource === null) {
      problems.push(`${item.id}: nie da sie odczytac manifestu do wyprowadzenia pol pakietu.`);
      continue;
    }
    resources.set(memberKey(resource.kind, resource.id), { item, resource });
  }
  const inputs = await Promise.all(
    [...resources.values()].map(async ({ item, resource }) => ({
      kind: resource.kind,
      id: resource.id,
      sourceReal: await groupingSource(resource.kind, item.source),
    })),
  );
  const groups = splitLargePacks(
    groupForPacks(inputs, {
      namespace: targetNamespace(plan.target),
      company: plan.target.scope === 'company',
      from,
      existing: defs.membership,
    }),
  );
  const trusts = await loadPackTrusts(layout, groups.keys());
  const derivedAll = new Map<string, DerivedMember>();
  const packOfKey = new Map<string, string>();
  for (const [id, keys] of groups) {
    for (const key of keys) {
      const entry = resources.get(key);
      if (entry === undefined) continue;
      packOfKey.set(key, id);
      derivedAll.set(
        key,
        await deriveMember({
          pack: id,
          resource: entry.resource,
          files: memberFiles(entry.resource, treeOf(entry.item)),
          homeDir,
        }),
      );
    }
  }
  // Pliki profilu, ktore ten import zapisze, i ich wlasciciele: skrypt hooka z innego zasobu dostaje
  // powiazanie juz przy imporcie; reszta ma wlasciciela ustalanego przy starcie.
  const profileOwners = new Map<string, string>();
  for (const [key, derived] of derivedAll) {
    const resource = derived.resource;
    const name = resource.id.slice(resource.id.indexOf('/') + 1);
    const entry = resources.get(key);
    if (entry === undefined) continue;
    const files = memberFiles(resource, treeOf(entry.item));
    for (const file of files) {
      if (resource.kind === 'skill') profileOwners.set(`skills/${name}/${file.rel}`, key);
      else if (resource.kind === 'files') profileOwners.set(`${resource.root}/${file.rel}`, key);
    }
    if (resource.kind === 'agent') profileOwners.set(`agents/${name}.md`, key);
    if (resource.kind === 'command') profileOwners.set(`commands/${name}.md`, key);
  }
  const treeByKey = new Map([...derivedAll].map(([key, d]) => [key, d.facts.fields.tree]));
  const packs: PackPlan[] = [];
  for (const [id, keys] of groups) {
    const members: PackPlanMember[] = [];
    for (const key of keys) {
      const entry = resources.get(key);
      const base = derivedAll.get(key);
      if (entry === undefined || base === undefined) continue;
      const derived: DerivedMember = {
        ...base,
        facts: bindMember(
          base,
          (rel) => profileOwners.get(rel) ?? null,
          (owner) => treeByKey.get(owner) ?? null,
        ),
      };
      const record = trusts.trust.get(id)?.members.find((m) => m.key === key);
      const trust: MemberTrustState =
        record === undefined
          ? 'new'
          : record.hash === packMemberHash(key, derived.facts.fields)
            ? 'approved'
            : 'changed';
      members.push({ key, item: entry.item, derived, trust, status: entry.item.status });
    }
    if (members.length === 0) continue;
    const existing = defs.packs.get(id);
    const known = new Set((existing?.spec.members ?? []).map((m) => memberKey(m.kind, m.id)));
    const definition =
      existing === undefined ? 'new' : members.every((m) => known.has(m.key)) ? 'same' : 'changed';
    packs.push({
      id,
      definition,
      members,
      pending:
        definition !== 'same' ||
        members.some((m) => m.derived.facts.required && m.trust !== 'approved'),
      corrupt: trusts.corrupt.get(id) ?? null,
    });
  }
  return { packs, problems };
}

export interface PackApplyOutcome {
  readonly id: string;
  readonly approved: number;
  readonly skipped: readonly string[];
}

/** Odczyt czlonka z rejestru na dysku ta sama sciezka, ktora wybiera `cwm start`. */
export async function deriveFromDisk(
  layout: CwmLayout,
  dir: string,
  kind: PackKind,
  pack: string,
  homeDir: string,
): Promise<DerivedMember | null> {
  const manifest = await readTextWithin(layout.home, join(dir, resourceFileName(kind)));
  if (!manifest.ok) return null;
  const parsed = parseManifestYaml(manifest.text);
  if (!parsed.ok) return null;
  const checked = validateResource(parsed.value);
  if (!checked.ok || !isPackResource(checked.value)) return null;
  const tree = await readTree(dir, (rel) => rel === resourceFileName(kind) || rel === '.DS_Store');
  if (!tree.ok) return null;
  return deriveMember({
    pack,
    resource: checked.value,
    files: memberFiles(checked.value, tree.files),
    homeDir,
  });
}

/**
 * Zapisuje pakiety i zgode (po zapisie zasobow do rejestru). Kazdy czlonek jest wyprowadzony jeszcze
 * raz z plikow na dysku i musi dac ten sam skrot co plan, ktory zatwierdzil uzytkownik; inaczej
 * (zapis sie nie udal, plik zmieniony po planie) nie dostaje zgody i trafia na liste pominietych.
 */
export async function applyPackPlan(
  layout: CwmLayout,
  packPlan: PackImportPlan,
  homeDir: string,
): Promise<PackApplyOutcome[]> {
  const outcomes: PackApplyOutcome[] = [];
  const defs: PackDefs = await loadPackDefs(layout);
  for (const pack of packPlan.packs) {
    if (!pack.pending) continue;
    const verified: PackPlanMember[] = [];
    const skipped: string[] = [];
    for (const member of pack.members) {
      const disk = await deriveFromDisk(
        layout,
        member.item.dir,
        member.item.kind,
        pack.id,
        homeDir,
      );
      if (
        disk !== null &&
        packMemberHash(member.key, {
          ...disk.facts.fields,
          bindings: member.derived.facts.fields.bindings,
        }) === packMemberHash(member.key, member.derived.facts.fields)
      ) {
        verified.push(member);
      } else skipped.push(member.key);
    }
    if (verified.length === 0) {
      outcomes.push({ id: pack.id, approved: 0, skipped });
      continue;
    }
    const existing = defs.packs.get(pack.id)?.spec.members ?? [];
    const merged = new Map<string, PackMemberRef>(
      existing.map((ref) => [memberKey(ref.kind, ref.id), ref]),
    );
    for (const member of verified) {
      const ref = parseMemberKey(member.key);
      if (ref !== null && isPackKind(ref.kind)) merged.set(member.key, ref);
    }
    await savePackDef(layout, newPack(pack.id, [...merged.values()]));
    if (pack.corrupt === null) {
      await recordPackTrust(
        layout,
        pack.id,
        verified.map((m) => ({ key: m.key, fields: m.derived.facts.fields })),
        'import',
      );
    } else skipped.push(...verified.map((m) => `${m.key} (uszkodzony zaufany skrot pakietu)`));
    outcomes.push({ id: pack.id, approved: pack.corrupt === null ? verified.length : 0, skipped });
  }
  return outcomes;
}
