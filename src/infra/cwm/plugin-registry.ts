import { parseDocument, isScalar, isSeq } from 'yaml';

import {
  API_VERSION,
  namespaceOf,
  RESOURCE_ID_PATTERN,
  refKey,
  sanitizeGitUrl,
  validateCompanyManifest,
  type Plugin,
  type PluginSource,
  type Resource,
} from '../../core/cwm';
import { dropApprovalKeys } from './approvals';
import { pruneGitSource } from './git-source';
import { companyManifestFile, isSafeSegment, registryKindDir, type CwmLayout } from './layout';
import { lstatLoose } from './paths';
import { removePackMembers, withGlobalLock } from './packs';
import { readTextWithin } from './read';
import { removeFromResourceLists } from './resource-lists';
import { FileResourceRegistry, type RegistryEntry } from './registry';
import { toYaml } from './serialize';
import { homeScope, removeScopedTree, replaceScopedTree, writeScopedFile } from './writer';
import { listCompanyIds, loadWorkspace } from './workspace';
import { parseManifestYaml } from './yaml-manifest';
import { join } from 'node:path';

/**
 * Zarzadzanie zasobami `Plugin` z marketplace'u (ADR 0046): zapis do rejestru globalnego i edycja
 * `plugins.enable` w `company.yaml`. Wszystkie zapisy ida przez writer `~/.cwm` i mutex
 * `runtime/global` (jak `cwm sync`). Niczego tu nie zatwierdza: zatwierdzenie jest przy `cwm start`.
 */

/** Przestrzen id pluginow z marketplace'u (inna nie jest uzywalna bez importu, ADR 0043). */
export const PLUGIN_NAMESPACE = 'marketplace';

/** Przestrzen id pluginow pobieranych z git (ADR 0048). */
export const GIT_PLUGIN_NAMESPACE = 'git';

export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Blad do pokazania uzytkownikowi (kod 1), bez szczegolow wewnetrznych. */
export class PluginCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginCommandError';
  }
}

export interface PluginManifestInput {
  readonly id: string;
  readonly version: string;
  readonly marketplace: string;
  readonly plugin: string;
}

/** Dokument zasobu `Plugin` z dowolnym zrodlem, domyslnie nieaktywny. */
export function pluginSourceDocument(
  id: string,
  version: string,
  source: PluginSource,
  activation: 'enabled' | 'disabled' = 'disabled',
): unknown {
  return {
    apiVersion: API_VERSION,
    kind: 'Plugin',
    metadata: { id, version },
    spec: { source: { ...source }, activation: { default: activation } },
  };
}

/** Dokument zasobu `Plugin` z marketplace'u, nieaktywny domyslnie. */
export function pluginManifestDocument(input: PluginManifestInput): unknown {
  return pluginSourceDocument(input.id, input.version, {
    type: 'marketplace',
    marketplace: input.marketplace,
    plugin: input.plugin,
  });
}

/** Id pluginu CWM: `marketplace/<nazwa>` albo `git/<nazwa>` (inne przestrzenie wymagaja importu). */
export const isPluginId = (id: string): boolean =>
  RESOURCE_ID_PATTERN.test(id) &&
  (id.startsWith(`${PLUGIN_NAMESPACE}/`) || id.startsWith(`${GIT_PLUGIN_NAMESPACE}/`));

export const isGitPluginId = (id: string): boolean =>
  RESOURCE_ID_PATTERN.test(id) && id.startsWith(`${GIT_PLUGIN_NAMESPACE}/`);

function pluginDir(layout: CwmLayout, id: string): string {
  const name = id.slice(id.indexOf('/') + 1);
  return join(registryKindDir(layout, 'plugin'), namespaceOf(id), name);
}

/** Zasob `Plugin` z rejestru (tylko odczyt, bez blokady) albo null; kilka definicji to blad. */
export async function findPluginResource(layout: CwmLayout, id: string): Promise<Plugin | null> {
  const { ids } = await listCompanyIds(layout);
  const registry = await FileResourceRegistry.load(layout, ids);
  const entries = pluginEntries(registry, id);
  if (entries.length > 1) {
    throw new PluginCommandError(`Id ${id} ma w rejestrze kilka definicji (cwm doctor).`);
  }
  const [entry] = entries;
  return entry === undefined ? null : (entry.resource as Plugin);
}

/** Czy dwa zrodla to ten sam wpis (marketplace: nazwa i plugin; git: adres bez danych logowania i ref). */
export function samePluginSource(a: PluginSource, b: PluginSource): boolean {
  if (a.type === 'marketplace' && b.type === 'marketplace') {
    return a.marketplace === b.marketplace && a.plugin === b.plugin;
  }
  if (a.type === 'git' && b.type === 'git') {
    return sanitizeGitUrl(a.url) === sanitizeGitUrl(b.url) && (a.ref ?? null) === (b.ref ?? null);
  }
  return false;
}

function describeSource(source: PluginSource): string {
  if (source.type === 'marketplace') return `${source.marketplace}/${source.plugin}`;
  if (source.type === 'git') return sanitizeGitUrl(source.url);
  return `zrodlo ${source.type}`;
}

function pluginEntries(registry: FileResourceRegistry, id: string): RegistryEntry[] {
  return registry.entries.filter((e) => e.resource.kind === 'plugin' && e.resource.id === id);
}

type EnableAction = 'add' | 'remove';

interface CompanyEdit {
  readonly company: string;
  readonly file: string;
  readonly text: string;
  readonly changed: boolean;
}

/**
 * Nowy tekst `company.yaml` z dopisanym albo usunietym id w `plugins.enable`. Reszta dokumentu i
 * komentarze zostaja, wynik przechodzi ten sam walidator co odczyt. Nic nie zapisuje.
 */
async function planCompanyEdit(
  layout: CwmLayout,
  company: string,
  id: string,
  action: EnableAction,
): Promise<CompanyEdit> {
  if (!isSafeSegment(company)) throw new PluginCommandError(`Niepoprawne id firmy "${company}".`);
  const file = companyManifestFile(layout, company);
  const label = `companies/${company}/company.yaml`;
  const read = await readTextWithin(layout.home, file);
  if (!read.ok) {
    throw new PluginCommandError(
      read.reason === 'missing'
        ? `Firma "${company}" nie istnieje (brak ${label}).`
        : `${label}: nie da sie odczytac (${read.message}).`,
    );
  }
  const doc = parseDocument(read.text, {
    schema: 'core',
    version: '1.2',
    merge: false,
    uniqueKeys: true,
    strict: true,
  });
  if (doc.errors.length > 0) throw new PluginCommandError(`${label} nie jest poprawnym YAML.`);

  const forbid = doc.getIn(['plugins', 'forbid'], true);
  const forbidden =
    isSeq(forbid) && forbid.items.some((item) => isScalar(item) && item.value === id);
  if (action === 'add' && forbidden) {
    throw new PluginCommandError(
      `Firma "${company}" zabrania pluginu ${id} (plugins.forbid w company.yaml); nie wlaczono.`,
    );
  }

  const enable = doc.getIn(['plugins', 'enable'], true);
  const present = isSeq(enable) && enable.items.some((i) => isScalar(i) && i.value === id);
  if (action === 'add' ? present : !present) {
    return { company, file, text: read.text, changed: false };
  }
  if (action === 'add') {
    if (isSeq(enable)) enable.add(doc.createNode(id));
    else doc.setIn(['plugins', 'enable'], doc.createNode([id]));
  } else if (isSeq(enable)) {
    enable.items = enable.items.filter((i) => !(isScalar(i) && i.value === id));
  }
  const text = doc.toString({ lineWidth: 0 });
  const parsed = parseManifestYaml(text);
  if (!parsed.ok || !validateCompanyManifest(parsed.value).ok) {
    throw new PluginCommandError(`Zmieniony ${label} nie przechodzi walidacji; zapis odrzucony.`);
  }
  return { company, file, text, changed: true };
}

async function applyCompanyEdits(layout: CwmLayout, edits: readonly CompanyEdit[]): Promise<void> {
  const scope = homeScope(layout.home);
  for (const edit of edits) if (edit.changed) await writeScopedFile(scope, edit.file, edit.text);
}

export interface AddPluginInput {
  readonly id: string;
  readonly version: string;
  readonly source: PluginSource;
  readonly companies: readonly string[];
}

export interface AddPluginResult {
  readonly status: 'created' | 'unchanged';
  readonly id: string;
  readonly version: string;
  /** Firmy, w ktorych `plugins.enable` faktycznie sie zmienilo. */
  readonly enabled: readonly string[];
  /** Firmy, ktore juz mialy id w `plugins.enable`. */
  readonly alreadyEnabled: readonly string[];
}

/**
 * Zapisuje zasob `Plugin` do rejestru (gdy go nie ma) i dopisuje id do `plugins.enable` wskazanych
 * firm. Wszystkie edycje firm sa przygotowane i zwalidowane przed pierwszym zapisem, wiec bledna
 * firma albo `forbid` nie zostawia polowicznego stanu.
 */
export function addPluginToRegistry(
  layout: CwmLayout,
  input: AddPluginInput,
): Promise<AddPluginResult> {
  return withGlobalLock(layout, async () => {
    const document = pluginSourceDocument(input.id, input.version, input.source);
    const { ids } = await listCompanyIds(layout);
    const registry = await FileResourceRegistry.load(layout, ids);
    const existing = pluginEntries(registry, input.id);
    const hint =
      input.source.type === 'marketplace'
        ? `Wybierz inne id: --id ${PLUGIN_NAMESPACE}/${input.source.marketplace}-${input.source.plugin}`
        : 'Wybierz inne id (--id).';
    let unchanged = false;
    if (existing.length > 1) {
      throw new PluginCommandError(`Id ${input.id} ma w rejestrze kilka definicji (cwm doctor).`);
    }
    const [current] = existing;
    if (current !== undefined) {
      const source = (current.resource as Extract<Resource, { kind: 'plugin' }>).source;
      if (!samePluginSource(source, input.source)) {
        throw new PluginCommandError(
          `Id ${input.id} jest juz zajete przez ${describeSource(source)}, a nie ${describeSource(input.source)}. ${hint}`,
        );
      }
      unchanged = true;
    } else if ((await lstatLoose(pluginDir(layout, input.id))) !== null) {
      throw new PluginCommandError(
        `Katalog ${pluginDir(layout, input.id)} istnieje, ale nie zawiera poprawnego plugin.yaml (cwm doctor). ${hint}`,
      );
    }

    const edits: CompanyEdit[] = [];
    for (const company of [...new Set(input.companies)]) {
      edits.push(await planCompanyEdit(layout, company, input.id, 'add'));
    }

    if (!unchanged) {
      const bytes = new TextEncoder().encode(toYaml(document));
      await replaceScopedTree(homeScope(layout.home), pluginDir(layout, input.id), [
        { rel: 'plugin.yaml', bytes, executable: false },
      ]);
    }
    await applyCompanyEdits(layout, edits);
    return {
      status: unchanged ? 'unchanged' : 'created',
      id: input.id,
      version:
        current === undefined || current.resource.version === undefined
          ? input.version
          : current.resource.version,
      enabled: edits.filter((e) => e.changed).map((e) => e.company),
      alreadyEnabled: edits.filter((e) => !e.changed).map((e) => e.company),
    };
  });
}

/** Wlacza albo wylacza plugin w firmie. Zwraca true, gdy plik sie zmienil. */
export function setPluginEnabled(
  layout: CwmLayout,
  company: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  return withGlobalLock(layout, async () => {
    if (enabled) {
      const { ids } = await listCompanyIds(layout);
      const registry = await FileResourceRegistry.load(layout, ids);
      if (pluginEntries(registry, id).length === 0) {
        throw new PluginCommandError(
          `Plugin ${id} nie istnieje w rejestrze (cwm plugin add <marketplace>/<plugin>).`,
        );
      }
    }
    const edit = await planCompanyEdit(layout, company, id, enabled ? 'add' : 'remove');
    await applyCompanyEdits(layout, [edit]);
    return edit.changed;
  });
}

export interface UpdateGitPluginInput {
  readonly id: string;
  readonly commit: string;
  /** Skrot drzewa zainstalowanej kopii (`source.tree`). */
  readonly tree: string;
  /** Nowy ref; `undefined` zostawia obecny. */
  readonly ref?: string;
  /** Nowa wersja zasobu; `undefined` zostawia obecna. */
  readonly version?: string;
}

export interface UpdateGitPluginResult {
  readonly previous: Extract<PluginSource, { type: 'git' }>;
  readonly current: Extract<PluginSource, { type: 'git' }>;
  readonly version: string;
  /** Kopia poprzedniego commita zostala usunieta (nikt inny jej nie uzywa). */
  readonly previousPruned: boolean;
}

function gitSourceUsed(registry: FileResourceRegistry, skip: string | null) {
  return (url: string, commit: string): boolean =>
    registry.entries.some(({ resource }) => {
      if (resource.kind !== 'plugin' || resource.id === skip) return false;
      const source = resource.source;
      return (
        source.type === 'git' &&
        source.commit === commit &&
        sanitizeGitUrl(source.url) === sanitizeGitUrl(url)
      );
    });
}

/**
 * Zapisuje w manifescie pluginu z git nowy commit (i opcjonalnie ref oraz wersje), a potem usuwa
 * kopie poprzedniego commita, jesli zaden inny zasob jej nie uzywa. Zatwierdzenie zostaje przy
 * `cwm start`: drzewo sie zmienia, wiec skrot tez.
 */
export function updateGitPluginSource(
  layout: CwmLayout,
  input: UpdateGitPluginInput,
): Promise<UpdateGitPluginResult> {
  return withGlobalLock(layout, async () => {
    const { ids } = await listCompanyIds(layout);
    const registry = await FileResourceRegistry.load(layout, ids);
    const entries = pluginEntries(registry, input.id);
    const [entry] = entries;
    if (entry === undefined) {
      throw new PluginCommandError(`Plugin ${input.id} nie istnieje w rejestrze.`);
    }
    if (entries.length > 1) {
      throw new PluginCommandError(`Id ${input.id} ma w rejestrze kilka definicji (cwm doctor).`);
    }
    const plugin = entry.resource as Plugin;
    if (plugin.source.type !== 'git') {
      throw new PluginCommandError(`Plugin ${input.id} nie pochodzi z git.`);
    }
    const previous = plugin.source;
    const current: Extract<PluginSource, { type: 'git' }> = {
      type: 'git',
      url: previous.url,
      ...((input.ref ?? previous.ref) === undefined ? {} : { ref: input.ref ?? previous.ref }),
      commit: input.commit,
      tree: input.tree,
    };
    const version = input.version ?? plugin.version;
    const document = pluginSourceDocument(input.id, version, current, plugin.activationDefault);
    const bytes = new TextEncoder().encode(toYaml(document));
    await replaceScopedTree(homeScope(layout.home), pluginDir(layout, input.id), [
      { rel: 'plugin.yaml', bytes, executable: false },
    ]);
    let previousPruned = false;
    if (previous.commit !== undefined && previous.commit !== input.commit) {
      previousPruned = await pruneGitSource(
        layout,
        previous.url,
        previous.commit,
        gitSourceUsed(registry, input.id),
      ).catch(() => false);
    }
    return { previous, current, version, previousPruned };
  });
}

/** Przygotowuje i waliduje edycje `plugins.enable` bez zapisu: nieistniejaca firma albo `forbid` to blad, jeszcze przed siecia. */
export async function precheckEnable(
  layout: CwmLayout,
  companies: readonly string[],
  id: string,
): Promise<void> {
  for (const company of [...new Set(companies)]) await planCompanyEdit(layout, company, id, 'add');
}

/** Usuwa kopie zrodla git, jesli zaden zasob z rejestru jej nie uzywa (sciezki bledow po pobraniu). */
export async function pruneUnusedGitSource(
  layout: CwmLayout,
  url: string,
  commit: string,
): Promise<boolean> {
  const { ids } = await listCompanyIds(layout);
  const registry = await FileResourceRegistry.load(layout, ids);
  return pruneGitSource(layout, url, commit, gitSourceUsed(registry, null)).catch(() => false);
}

export interface RemovePluginResult {
  readonly id: string;
  readonly listEdits: readonly string[];
  readonly approvalCompanies: readonly string[];
  /** Projekty z `~/.cwm`, ktorych `plugins.enable` nadal wymienia plugin (manifest zostaje do recznej poprawki). */
  readonly projectWarnings: readonly string[];
  /** Plugin z git: kopia zrodla w `sources/git` zostala usunieta (nikt inny jej nie uzywa). */
  readonly sourcePruned: boolean;
}

/**
 * Usuwa plugin z rejestru, z list `exports` firm i z zatwierdzen. Odmawia, gdy ktoras firma go
 * wlacza. Kolejnosc jak w sync: najpierw odwolania, katalog na koncu, wiec przerwanie zostawia
 * zasob w rejestrze, a nie wpis do nieistniejacego zasobu.
 */
export function removePluginFromRegistry(
  layout: CwmLayout,
  id: string,
): Promise<RemovePluginResult> {
  return withGlobalLock(layout, async () => {
    const workspace = await loadWorkspace(layout);
    const entries = pluginEntries(workspace.registry, id);
    const [entry] = entries;
    if (entry === undefined) throw new PluginCommandError(`Plugin ${id} nie istnieje w rejestrze.`);
    if (entries.length > 1) {
      throw new PluginCommandError(`Id ${id} ma w rejestrze kilka definicji (cwm doctor).`);
    }
    const enabling: string[] = [];
    for (const [company, loaded] of workspace.companies) {
      if (!loaded.ok) {
        throw new PluginCommandError(
          `Manifest firmy "${company}" jest niepoprawny, nie da sie sprawdzic, czy wlacza ${id} (cwm doctor).`,
        );
      }
      if (loaded.value.plugins.enable.includes(id)) enabling.push(company);
    }
    if (enabling.length > 0) {
      throw new PluginCommandError(
        `Plugin ${id} wlacza firma: ${enabling.sort().join(', ')}. Wylacz najpierw: cwm plugin disable ${id} --company <firma>.`,
      );
    }
    const projectWarnings = workspace.homeProjects
      .filter((p) => p.loaded.ok && p.loaded.value.spec.plugins.enable.includes(id))
      .map((p) => (p.loaded.ok ? p.loaded.value.metadata.id : ''));

    const key = refKey({ kind: 'plugin', id });
    const edits = await removeFromResourceLists(layout, workspace.companyIds, [
      { kind: 'plugin', id },
    ]);
    await removePackMembers(layout, [key]);
    const dropped = await dropApprovalKeys(layout, [key]);
    if (dropped.corrupt.length > 0) {
      throw new PluginCommandError(
        `Zatwierdzenia firm ${dropped.corrupt.join(', ')} sa uszkodzone; plugin zostaje w rejestrze (cwm doctor).`,
      );
    }
    await removeScopedTree(homeScope(layout.home), entry.dir);
    const source = (entry.resource as Plugin).source;
    const sourcePruned =
      source.type === 'git' && source.commit !== undefined
        ? await pruneGitSource(
            layout,
            source.url,
            source.commit,
            gitSourceUsed(workspace.registry, id),
          ).catch(() => false)
        : false;
    return {
      id,
      listEdits: edits.flatMap((e) => e.removed.map((r) => `${e.label}: ${r}`)),
      approvalCompanies: dropped.touched,
      projectWarnings,
      sourcePruned,
    };
  });
}
