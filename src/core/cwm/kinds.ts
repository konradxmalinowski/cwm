export const API_VERSION = 'cwm.dev/v1';

export const RESOURCE_KINDS = [
  'skill',
  'agent',
  'workflow',
  'plugin',
  'mcp',
  'settings',
  'command',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Nazwa pola z lista id danego rodzaju (`exports.plugins`, `dependencies.skills`). */
export const RESOURCE_SET_KEYS = {
  skill: 'skills',
  agent: 'agents',
  workflow: 'workflows',
  plugin: 'plugins',
  mcp: 'mcp',
  settings: 'settings',
  command: 'commands',
} as const satisfies Record<ResourceKind, string>;
export type SetKey = (typeof RESOURCE_SET_KEYS)[ResourceKind];

/** Listy id pogrupowane po rodzaju. Bloki manifestow uzywaja podzbiorow (`Pick`). */
export type ResourceSet = { readonly [K in SetKey]: readonly string[] };

export interface ResourceRef {
  readonly kind: ResourceKind;
  readonly id: string;
}

/** Segment przestrzeni i segment nazwy w id zasobu. Nazwa nie konczy sie kropka. */
export const ID_SPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ID_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9_-])?$/;

/** `<przestrzen>/<nazwa>`, male litery ASCII, np. `acme-a/coding-standards`. */
export const RESOURCE_ID_PATTERN =
  /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9_-])?$/;

/**
 * Przestrzenie nazw, ktore nie naleza do zadnej firmy: `global` to zasoby wspolne, a `marketplace`,
 * `local` i `git` to zarezerwowane zrodla pluginow. Id firmy nie moze byc zadnym z nich. Zasob
 * z inna przestrzenia niz te i niz firma projektu jest obcy i wchodzi tylko przez import.
 */
export const SHARED_NAMESPACES = ['global', 'marketplace', 'local', 'git'] as const;

export function isSharedNamespace(namespace: string): boolean {
  return (SHARED_NAMESPACES as readonly string[]).includes(namespace);
}

export function namespaceOf(id: string): string {
  return id.slice(0, id.indexOf('/'));
}

export const ALL_SET_KEYS: readonly SetKey[] = RESOURCE_KINDS.map(
  (kind) => RESOURCE_SET_KEYS[kind],
);

export function refKey(ref: ResourceRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function emptyResourceSet(): ResourceSet {
  return {
    skills: [],
    agents: [],
    workflows: [],
    plugins: [],
    mcp: [],
    settings: [],
    commands: [],
  };
}

/** Wola `fn` dla kazdego id ze zbioru, ze sciezka pola. Brakujace listy sa puste. */
export function forEachRef(
  set: Partial<ResourceSet>,
  path: string,
  fn: (ref: ResourceRef, refPath: string) => void,
): void {
  for (const kind of RESOURCE_KINDS) {
    const key = RESOURCE_SET_KEYS[kind];
    forEachId(kind, set[key] ?? [], `${path}.${key}`, fn);
  }
}

export function forEachId(
  kind: ResourceKind,
  ids: readonly string[],
  path: string,
  fn: (ref: ResourceRef, refPath: string) => void,
): void {
  ids.forEach((id, index) => fn({ kind, id }, `${path}[${index}]`));
}
