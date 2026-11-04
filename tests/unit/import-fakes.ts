import type { ItemKind, ToolId } from '../../src/core/model/item';
import type { SourceReader } from '../../src/core/ports/source-reader';
import type {
  DetectedRoot,
  ImportCandidate,
  ImportSkip,
  LocationCatalog,
  RootKind,
  ToolAdapter,
} from '../../src/core/ports/tool-adapter';
import {
  ImportService,
  type ImportServiceDeps,
} from '../../src/core/services/import/import-service';
import { createHarness, bytes } from './library-fakes';

export function root(
  id: string,
  tool: ToolId,
  overrides: Partial<DetectedRoot> = {},
): DetectedRoot {
  return {
    rootId: id,
    tool,
    kind: 'skills',
    label: `~/${tool === 'codex' ? '.codex' : '.claude'}/skills`,
    exists: true,
    active: true,
    ...overrides,
  };
}

export interface CandidateSpec {
  readonly slug: string;
  readonly root: DetectedRoot;
  readonly relPath?: string;
  readonly kind?: ItemKind;
  readonly body?: string;
  readonly title?: string;
  readonly description?: string;
  readonly aliasKey?: string | null;
  readonly assets?: { relPath: string; text: string }[];
  readonly sourceFiles?: { relPath: string; text: string }[];
}

export function candidate(spec: CandidateSpec): ImportCandidate {
  const body = spec.body ?? `# ${spec.slug}\n\nTresc skilla ${spec.slug}.\n`;
  return {
    tool: spec.root.tool,
    rootId: spec.root.rootId,
    relPath: spec.relPath ?? `${spec.slug}/SKILL.md`,
    kind: spec.kind ?? 'skill',
    draft: {
      kind: spec.kind ?? 'skill',
      identity: { slug: spec.slug, declaredName: null, aliases: [] },
      content: {
        title: spec.title ?? spec.slug,
        description: spec.description ?? `Opis ${spec.slug}.`,
        descriptionOrigin: 'source',
        body,
      },
      ...(spec.assets === undefined
        ? {}
        : { assets: spec.assets.map((a) => ({ relPath: a.relPath, bytes: bytes(a.text) })) }),
      source: {
        snapshots: [
          {
            tool: spec.root.tool,
            files: (spec.sourceFiles ?? [{ relPath: 'SKILL.md', text: body }]).map((f) => ({
              relPath: f.relPath,
              bytes: bytes(f.text),
              mode: null,
            })),
            unmappedKeys: [],
          },
        ],
        importedFrom: null,
      },
    },
    warnings: [],
    aliasKey: spec.aliasKey ?? null,
  };
}

export class FakeCatalog implements LocationCatalog {
  /** Narzedzia, ktorych katalog glowny istnieje; domyslnie wszystkie. */
  homes: Set<ToolId> | null = null;
  constructor(public roots: DetectedRoot[]) {}
  toolHomeExists(tool: ToolId): Promise<boolean> {
    return Promise.resolve(this.homes === null || this.homes.has(tool));
  }
  detect(): Promise<readonly DetectedRoot[]> {
    return Promise.resolve(this.roots);
  }
}

export class FakeAdapter implements ToolAdapter {
  readonly displayName: string;
  scans = 0;
  failOn = new Set<string>();
  constructor(
    readonly id: ToolId,
    readonly rootKinds: readonly RootKind[],
    public byRoot: Record<string, ImportCandidate[]>,
    public skippedByRoot: Record<string, ImportSkip[]> = {},
  ) {
    this.displayName = id;
  }
  scan(rootInfo: DetectedRoot): Promise<{ candidates: ImportCandidate[]; skipped: ImportSkip[] }> {
    this.scans++;
    if (this.failOn.has(rootInfo.rootId)) return Promise.reject(new Error('/abs/sciezka/blad'));
    return Promise.resolve({
      candidates: this.byRoot[rootInfo.rootId] ?? [],
      skipped: this.skippedByRoot[rootInfo.rootId] ?? [],
    });
  }
}

export const NO_READER: SourceReader = {
  list: () => Promise.reject(new Error('nieuzywany')),
  read: () => Promise.reject(new Error('nieuzywany')),
  resolveSymlink: () => Promise.reject(new Error('nieuzywany')),
  mode: () => Promise.reject(new Error('nieuzywany')),
};

export function importHarness(
  roots: DetectedRoot[],
  adapters: readonly ToolAdapter[],
  overrides: Partial<ImportServiceDeps> = {},
) {
  const lib = createHarness();
  const catalog = new FakeCatalog(roots);
  let counter = 0;
  const service = new ImportService({
    catalog,
    adapters,
    reader: NO_READER,
    library: lib.service,
    clock: lib.clock,
    newToken: () => `token-${++counter}`,
    ...overrides,
  });
  const { service: library, ...rest } = lib;
  return { ...rest, library, catalog, service, reader: NO_READER };
}
