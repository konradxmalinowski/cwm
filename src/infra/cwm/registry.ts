import { dirname, join } from 'node:path';

import {
  ID_NAME_PATTERN,
  ID_SPACE_PATTERN,
  MAX_RESOURCES,
  namespaceOf,
  RESOURCE_KINDS,
  RESOURCE_SET_KEYS,
  refKey,
  validateResource,
  type Resource,
  type ResourceKind,
  type ResourceRef,
  type ResourceRegistry,
} from '../../core/cwm';
import {
  companyDir,
  isSafeSegment,
  registryKindDir,
  resourceFileName,
  type CwmLayout,
} from './layout';
import {
  listDirectory,
  problemWithoutPosition,
  SCAN_LIMIT_MESSAGE,
  readManifest,
  type DirEntry,
  type Problem,
} from './read';

/** Rodzaje zasobow z katalogu firmy (`companies/<firma>/{skills,agents,workflows}`). */
const COMPANY_KINDS: readonly ResourceKind[] = ['skill', 'agent', 'workflow'];
/** Gorny limit plikow przy skanie; resolver i tak tnie konfiguracje na `MAX_RESOURCES`. */
const MAX_SCANNED_FILES = MAX_RESOURCES * 4;

export type ResourceOrigin =
  { readonly scope: 'global' } | { readonly scope: 'company'; readonly company: string };

export interface RegistryEntry {
  readonly resource: Resource;
  readonly file: string;
  /** Katalog zasobu (obok pliku definicji), do sprawdzania `spec.source`. */
  readonly dir: string;
  readonly origin: ResourceOrigin;
}

/**
 * Rejestr zasobow oparty na plikach. Wszystko wczytuje `load`, wiec `candidates` jest synchroniczne
 * (port rdzenia). Wiele definicji pod jednym id zostaje w wyniku: konflikt zglasza resolver.
 */
export class FileResourceRegistry implements ResourceRegistry {
  private readonly byKey = new Map<string, Resource[]>();

  private constructor(
    readonly entries: readonly RegistryEntry[],
    readonly problems: readonly Problem[],
  ) {
    for (const entry of entries) {
      const key = refKey(entry.resource);
      const list = this.byKey.get(key);
      if (list) list.push(entry.resource);
      else this.byKey.set(key, [entry.resource]);
    }
  }

  static async load(
    layout: CwmLayout,
    companyIds: readonly string[],
  ): Promise<FileResourceRegistry> {
    const scan = new Scan(layout);
    for (const kind of RESOURCE_KINDS) await scan.registryKind(kind);
    for (const company of companyIds) await scan.company(company);
    return new FileResourceRegistry(scan.entries, scan.problems);
  }

  candidates(ref: ResourceRef): readonly Resource[] {
    return this.byKey.get(refKey(ref)) ?? [];
  }

  /** Id z wiecej niz jedna definicja, posortowane. */
  conflicts(): string[] {
    return [...this.byKey.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([key]) => key)
      .sort();
  }
}

class Scan {
  readonly entries: RegistryEntry[] = [];
  readonly problems: Problem[] = [];
  private files = 0;
  private limitReported = false;

  constructor(private readonly layout: CwmLayout) {}

  async registryKind(kind: ResourceKind): Promise<void> {
    const kindDir = registryKindDir(this.layout, kind);
    for (const space of await this.dirs(kindDir, ID_SPACE_PATTERN)) {
      const spaceDir = join(kindDir, space);
      for (const name of await this.dirs(spaceDir, ID_NAME_PATTERN)) {
        await this.file(kind, join(spaceDir, name), { scope: 'global' }, `${space}/${name}`, true);
      }
    }
  }

  async company(company: string): Promise<void> {
    if (!isSafeSegment(company)) return;
    const base = companyDir(this.layout, company);
    for (const kind of COMPANY_KINDS) {
      const kindDir = join(base, RESOURCE_SET_KEYS[kind]);
      for (const name of await this.dirs(kindDir, ID_NAME_PATTERN)) {
        await this.file(kind, join(kindDir, name), { scope: 'company', company }, name, false);
      }
    }
  }

  /** Podkatalogi o poprawnych nazwach; reszta jest pomijana, a dowiazania zglaszane. */
  private async dirs(dir: string, pattern: RegExp): Promise<string[]> {
    const listing = await listDirectory(this.layout.home, dir);
    if (!listing.ok) {
      this.problems.push(problemWithoutPosition(dir, '$', listing.message));
      return [];
    }
    if (listing.truncated) {
      this.problems.push(problemWithoutPosition(dir, '$', SCAN_LIMIT_MESSAGE));
    }
    const names: string[] = [];
    for (const entry of listing.entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'symlink') {
        this.problems.push(
          problemWithoutPosition(join(dir, entry.name), '$', 'Dowiazanie symboliczne pominiete.'),
        );
      } else if (isNamedDir(entry) && pattern.test(entry.name)) {
        names.push(entry.name);
      }
    }
    return names;
  }

  /** `expected` to `<przestrzen>/<nazwa>` (rejestr) albo sama nazwa (katalog firmy). */
  private async file(
    kind: ResourceKind,
    dir: string,
    origin: ResourceOrigin,
    expected: string,
    fullId: boolean,
  ): Promise<void> {
    const file = join(dir, resourceFileName(kind));
    if (this.files >= MAX_SCANNED_FILES) {
      if (!this.limitReported) {
        this.limitReported = true;
        this.problems.push(
          problemWithoutPosition(
            this.layout.home,
            '$',
            `${SCAN_LIMIT_MESSAGE} (najwyzej ${MAX_SCANNED_FILES} plikow zasobow).`,
          ),
        );
      }
      return;
    }
    this.files += 1;
    const loaded = await readManifest(this.layout.home, file, validateResource);
    if (!loaded.ok) {
      if (loaded.reason !== 'missing') this.problems.push(...loaded.problems);
      return;
    }
    const resource = loaded.value;
    if (resource.kind !== kind) {
      this.problems.push(
        problemWithoutPosition(
          file,
          'kind',
          `Plik ${resourceFileName(kind)} zawiera zasob rodzaju ${resource.kind}.`,
        ),
      );
      return;
    }
    if (origin.scope === 'company' && namespaceOf(resource.id) !== origin.company) {
      this.problems.push(
        problemWithoutPosition(
          file,
          'metadata.id',
          `Zasob w katalogu firmy "${origin.company}" musi miec id z jej przestrzeni nazw (${origin.company}/...), jest "${resource.id}". Zasob pominiety.`,
        ),
      );
      return;
    }
    const actual = fullId ? resource.id : (resource.id.split('/')[1] ?? '');
    if (actual !== expected) {
      this.problems.push({
        ...problemWithoutPosition(
          file,
          'metadata.id',
          `Id "${resource.id}" nie zgadza sie z polozeniem pliku (oczekiwano "${expected}").`,
        ),
      });
      return;
    }
    this.entries.push({ resource, file, dir: dirname(file), origin });
  }
}

function isNamedDir(entry: DirEntry): boolean {
  return entry.kind === 'dir';
}
