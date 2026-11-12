import type { EffectiveConfiguration, EffectiveResource, Origin } from './effective';
import { compareStrings, fail, ok, type Result, type ValidationError } from './errors';
import {
  API_VERSION,
  forEachId,
  forEachRef,
  isSharedNamespace,
  namespaceOf,
  refKey,
  RESOURCE_SET_KEYS,
  type ResourceKind,
  type ResourceRef,
} from './kinds';
import type { CompanyManifest, GlobalConfig, ProjectManifest } from './manifest';
import { LAYER_RANK, mergeSettings, type Layer } from './merge-settings';
import { validatePolicy } from './policy';
import type { ResourceRegistry } from './registry';
import { dependenciesOf, formatResource } from './resource';

/** Gorne limity na niezaufany graf zaleznosci. */
export const MAX_RESOURCES = 5000;
export const MAX_DEPTH = 64;
const MAX_CYCLE_IDS = 10;

export interface ResolveOptions {
  /** Id firmy projektu nadrzednego. Projekt zagniezdzony musi nalezec do tej samej firmy. */
  readonly parentCompany?: string;
  /** Manifesty firm, z ktorych projekt importuje. Import z firmy spoza listy jest bledem. */
  readonly importSources?: readonly CompanyManifest[];
}

interface Root {
  readonly ref: ResourceRef;
  readonly path: string;
  readonly layer: Layer;
}

interface Frame {
  readonly key: string;
  readonly layer: Layer;
  readonly dependencies: readonly ResourceRef[];
  next: number;
}

const ORIGIN_RANK: Record<Origin, number> = { dependency: 0, optional: 1, mandatory: 2 };

/**
 * Sklada konfiguracje projektu z warstw: global, firma, projekt, importy. Zwraca komplet bledow
 * zamiast pierwszego, a wynik jest posortowany, zeby ten sam stan wejsciowy dawal ten sam lockfile.
 * Nigdy nie rzuca: nieoczekiwany wyjatek konczy sie bledem w wyniku.
 */
export function resolve(
  global: GlobalConfig,
  company: CompanyManifest,
  project: ProjectManifest,
  registry: ResourceRegistry,
  options: ResolveOptions = {},
): Result<EffectiveConfiguration> {
  try {
    return build(global, company, project, registry, options);
  } catch {
    return fail([{ path: '$', message: 'Nieoczekiwany blad podczas skladania konfiguracji.' }]);
  }
}

function build(
  global: GlobalConfig,
  company: CompanyManifest,
  project: ProjectManifest,
  registry: ResourceRegistry,
  options: ResolveOptions,
): Result<EffectiveConfiguration> {
  const errors: ValidationError[] = [];
  const add = (path: string, message: string): void => void errors.push({ path, message });
  const companyId = company.metadata.id;
  const spec = project.spec;

  if (project.metadata.company !== companyId) {
    add(
      'project.metadata.company',
      `Projekt nalezy do firmy "${project.metadata.company}", podano firme "${companyId}".`,
    );
  }
  if (options.parentCompany !== undefined && options.parentCompany !== companyId) {
    add(
      'parentCompany',
      `Projekt zagniezdzony musi nalezec do firmy projektu nadrzednego ("${options.parentCompany}").`,
    );
  }

  const sourceOf = (id: string) => options.importSources?.find((s) => s.metadata.id === id);
  /** Firma, do ktorej nalezy id, albo null dla zasobow wspolnych i wlasnych. */
  const foreignOwner = (id: string): string | null => {
    const namespace = namespaceOf(id);
    return namespace === companyId || isSharedNamespace(namespace) ? null : namespace;
  };
  const isPrivate = (ref: ResourceRef): boolean => {
    const found = registry.candidates(ref)[0];
    return found?.kind === 'skill' && found.visibility === 'private';
  };
  const exportsRef = (source: CompanyManifest, ref: ResourceRef): boolean =>
    source.exports[RESOURCE_SET_KEYS[ref.kind]].includes(ref.id);

  // Importy najpierw: granica miedzy firmami (zasob obcy wchodzi tylko przez import) zalezy od ich wyniku.
  const imported = new Set<string>();
  const importedFrom = new Set<string>();
  const importRoots: Root[] = [];
  forEachRef(company.exports, 'company.exports', (ref, path) => {
    if (isPrivate(ref))
      add(path, `Zasob ${refKey(ref)} ma widocznosc private i nie moze byc eksportowany.`);
  });
  spec.imports.forEach((entry, index) => {
    const path = `project.spec.imports[${index}]`;
    const source = sourceOf(entry.from);
    if (entry.from === companyId)
      return add(`${path}.from`, 'Projekt nie importuje z wlasnej firmy.');
    if (!source) return add(`${path}.from`, `Nieznane zrodlo importu "${entry.from}".`);
    importedFrom.add(entry.from);
    forEachRef(entry, path, (ref, refPath) => {
      const key = refKey(ref);
      const owner = foreignOwner(ref.id);
      if (owner !== null && owner !== entry.from) {
        add(
          refPath,
          `Zasob ${key} nalezy do firmy "${owner}", a import wskazuje firme "${entry.from}".`,
        );
      } else if (!exportsRef(source, ref)) {
        add(refPath, `Firma "${entry.from}" nie eksportuje zasobu ${key}.`);
      } else if (isPrivate(ref)) {
        add(refPath, `Zasob ${key} ma widocznosc private i nie moze byc importowany.`);
      } else {
        imported.add(key);
        importRoots.push({ ref, path: refPath, layer: 'project' });
      }
    });
  });

  const mandatory = new Map<string, Root>();
  const optional = new Map<string, Root>();
  const companyDisabled = new Set<string>();
  /** Wszystko, co firma lub projekt wylaczyly. Jako zaleznosc takiego zasobu nie wolno zachowac. */
  const disabled = new Set<string>();
  const enableInto =
    (target: Map<string, Root>, layer: Layer) => (ref: ResourceRef, path: string) => {
      const projectLayer = layer === 'project';
      const key = refKey(ref);
      const owner = foreignOwner(ref.id);
      if (owner !== null && !imported.has(key)) {
        add(path, `Zasob ${key} nalezy do firmy "${owner}" i wchodzi tylko przez spec.imports.`);
      }
      if (projectLayer && companyDisabled.has(key)) {
        add(path, `Firma "${companyId}" wylaczyla zasob ${key}, projekt nie moze go wlaczyc.`);
      }
      if (!target.has(key)) target.set(key, { ref, path, layer });
    };
  const disable = (ref: ResourceRef, path: string): void => {
    if (mandatory.has(refKey(ref))) {
      add(path, `Zasob ${refKey(ref)} jest obowiazkowy i nie mozna go wylaczyc.`);
    } else {
      disabled.add(refKey(ref));
      optional.delete(refKey(ref));
    }
  };

  forEachRef(
    global.resources.mandatory,
    'global.resources.mandatory',
    enableInto(mandatory, 'global'),
  );
  forEachRef(
    global.resources.optional,
    'global.resources.optional',
    enableInto(optional, 'global'),
  );
  const enableCompany = enableInto(optional, 'company');
  forEachRef(company.resources.enable, 'company.resources.enable', enableCompany);
  forEachId('plugin', company.plugins.enable, 'company.plugins.enable', enableCompany);
  forEachId('mcp', company.mcp.enable, 'company.mcp.enable', enableCompany);
  forEachRef(
    company.resources.disableOptional,
    'company.resources.disableOptional',
    (ref, path) => {
      companyDisabled.add(refKey(ref));
      disable(ref, path);
    },
  );

  const enableProject = enableInto(optional, 'project');
  forEachRef(spec.resources.enable, 'project.spec.resources.enable', enableProject);
  forEachId('plugin', spec.plugins.enable, 'project.spec.plugins.enable', enableProject);
  forEachId('mcp', spec.mcp.enable, 'project.spec.mcp.enable', enableProject);
  for (const root of importRoots) enableProject(root.ref, root.path);
  forEachRef(spec.resources.disableOptional, 'project.spec.resources.disableOptional', disable);
  forEachId('plugin', spec.plugins.disable, 'project.spec.plugins.disable', disable);
  forEachId('mcp', spec.mcp.disable, 'project.spec.mcp.disable', disable);

  const forbidden = new Set<string>();
  forEachId('plugin', company.plugins.forbid, 'company.plugins.forbid', (ref) =>
    forbidden.add(refKey(ref)),
  );

  const entries = new Map<string, EffectiveResource>();
  /** Klucze, ktorych brak w wyniku ma juz wlasny blad, wiec polityka nie zglasza ich drugi raz. */
  const handled = new Set<string>();
  const stack: Frame[] = [];
  let aborted = false;

  const reject = (key: string, path: string, message: string): void => {
    handled.add(key);
    add(path, message);
  };

  const enter = (
    ref: ResourceRef,
    origin: Origin,
    path: string,
    parent: string | null,
    layer: Layer,
  ): void => {
    const key = refKey(ref);
    if (forbidden.has(key)) {
      return reject(key, path, `Plugin ${ref.id} jest zabroniony przez firme "${companyId}".`);
    }
    const cycleStart = stack.findIndex((frame) => frame.key === key);
    if (cycleStart >= 0) {
      const ids = [...stack.slice(cycleStart).map((frame) => frame.key), key];
      const shown = ids.slice(0, MAX_CYCLE_IDS).join(' -> ');
      return add(path, `Cykl zaleznosci: ${shown}${ids.length > MAX_CYCLE_IDS ? ' -> ...' : ''}.`);
    }
    const known = entries.get(key);
    if (known) {
      entries.set(key, {
        ...known,
        origin: ORIGIN_RANK[origin] > ORIGIN_RANK[known.origin] ? origin : known.origin,
        layer: LAYER_RANK[layer] < LAYER_RANK[known.layer] ? layer : known.layer,
      });
      return;
    }
    if (parent !== null && disabled.has(key)) {
      return reject(
        key,
        path,
        `${parent} zalezy od ${key}, ktory jest wylaczony przez firme lub projekt.`,
      );
    }
    if (parent !== null) {
      // Zaleznosc obca musi byc eksportowana przez firme, z ktorej projekt importuje.
      const owner = foreignOwner(ref.id);
      const source = owner !== null && importedFrom.has(owner) ? sourceOf(owner) : undefined;
      if (owner !== null && (!source || !exportsRef(source, ref) || isPrivate(ref))) {
        return reject(
          key,
          path,
          `${parent} zalezy od ${key}, ktory nie jest eksportowany przez firme "${owner}" (lub projekt nie importuje z tej firmy).`,
        );
      }
    }
    const found = registry.candidates(ref);
    if (found.length > 1) {
      return reject(
        key,
        path,
        `Identyfikator ${key} ma ${found.length} definicji w rejestrze (konflikt).`,
      );
    }
    const resource = found[0];
    if (!resource) {
      // Brak zaleznosci przechodniej zglasza validatePolicy, brak zasobu wybranego wprost zglaszamy tu.
      if (origin !== 'dependency') add(path, `Zasob ${key} nie istnieje w rejestrze.`);
      return;
    }
    if (entries.size >= MAX_RESOURCES) {
      aborted = true;
      return add('$', `Konfiguracja przekracza limit ${MAX_RESOURCES} zasobow.`);
    }
    if (stack.length >= MAX_DEPTH) {
      return reject(key, path, `Lancuch zaleznosci jest glebszy niz ${MAX_DEPTH} poziomow.`);
    }
    entries.set(key, { origin, layer, resource });
    const dependencies = [...dependenciesOf(resource)].sort((a, b) =>
      compareStrings(refKey(a), refKey(b)),
    );
    stack.push({ key, layer, dependencies, next: 0 });
  };

  // Jawny stos zamiast rekurencji: gleboki lancuch z manifestu nie moze przepelnic stosu wywolan.
  const visitRoot = (root: Root, origin: Origin): void => {
    enter(root.ref, origin, root.path, null, root.layer);
    while (stack.length > 0 && !aborted) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const dependency = frame.dependencies[frame.next];
      frame.next += 1;
      if (dependency === undefined) stack.pop();
      else enter(dependency, 'dependency', `${frame.key}.dependencies`, frame.key, frame.layer);
    }
    stack.length = 0;
  };

  const byKey = (roots: Iterable<Root>): Root[] =>
    [...roots].sort((a, b) => compareStrings(refKey(a.ref), refKey(b.ref)));
  for (const root of byKey(mandatory.values())) visitRoot(root, 'mandatory');
  for (const root of byKey(optional.values())) {
    if (!mandatory.has(refKey(root.ref))) visitRoot(root, 'optional');
  }

  const resources = [...entries.values()].sort((a, b) =>
    compareStrings(refKey(a.resource), refKey(b.resource)),
  );
  const settingsMerge = mergeSettings(
    resources.flatMap((entry) =>
      entry.resource.kind === 'settings' ? [{ resource: entry.resource, layer: entry.layer }] : [],
    ),
  );
  errors.push(...settingsMerge.errors);
  const resolved = (kind: ResourceKind): string[] =>
    resources
      .filter((entry) => entry.resource.kind === kind)
      .map((entry) => formatResource(entry.resource));
  const effective: EffectiveConfiguration = {
    apiVersion: API_VERSION,
    kind: 'EffectiveConfiguration',
    profile: { company: companyId, project: project.metadata.id, engine: spec.engine },
    resolved: {
      skills: resolved('skill'),
      agents: resolved('agent'),
      workflows: resolved('workflow'),
      plugins: resolved('plugin'),
      mcp: resolved('mcp'),
      settings: resolved('settings'),
      commands: resolved('command'),
    },
    settings: settingsMerge.merged,
    validation: { conflicts: [], missingDependencies: [] },
    resources,
  };
  const policy = validatePolicy(effective, handled);
  if (!policy.ok) errors.push(...policy.errors);

  return errors.length > 0 ? fail(errors) : ok(effective);
}
