import type { ItemKind, ToolId } from '../../src/core/model/item';
import type {
  GitSourceOpen,
  GitSourceProvider,
  GitSourceRequest,
} from '../../src/core/ports/git-source';
import type { ProjectRootCatalog, ProjectRootsResult } from '../../src/core/ports/project-roots';
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

export const GIT_COMMIT = 'a'.repeat(40);

/** Port pobierania z repozytorium Git bez sieci i dysku: zwraca z gory ustawione rooty i liczy zwolnienia kopii. */
export class FakeGitProvider implements GitSourceProvider {
  requests: GitSourceRequest[] = [];
  released = 0;
  aborted = 0;
  submodules: string[] = [];
  /** Gdy ustawione, `open` zwraca ten wynik zamiast zrodla. */
  failure: Extract<GitSourceOpen, { ok: false }> | null = null;
  /** Gdy ustawione, `open` czeka na to obietnice (test jednoczesnych pobran). */
  gate: Promise<void> | null = null;
  constructor(readonly roots: DetectedRoot[]) {}

  abort(): void {
    this.aborted++;
  }

  async open(request: GitSourceRequest): Promise<GitSourceOpen> {
    this.requests.push(request);
    if (this.gate !== null) await this.gate;
    if (this.failure !== null) return this.failure;
    return {
      ok: true,
      source: {
        origin: { url: request.url, commit: GIT_COMMIT, ref: request.ref },
        roots: this.roots,
        reader: NO_READER,
        submodules: this.submodules,
        release: () => {
          this.released++;
          return Promise.resolve();
        },
      },
    };
  }
}

export const PROJECT_A = 'proj-00000000000000aa';
export const PROJECT_B = 'proj-00000000000000bb';

/** Rejestr projektow bez dysku (ADR 0059): projekt to nazwa i lista rootow; reszta to `unknown-project`. */
export class FakeProjectCatalog implements ProjectRootCatalog {
  invalid = new Set<string>();
  constructor(readonly projects: Record<string, { name: string; roots: DetectedRoot[] }>) {}

  roots(projectId: string): Promise<ProjectRootsResult> {
    const project = this.projects[projectId];
    if (project === undefined) {
      return Promise.resolve({ ok: false, code: 'unknown-project', message: 'Nie ma projektu.' });
    }
    if (this.invalid.has(projectId)) {
      return Promise.resolve({ ok: false, code: 'project-invalid', message: 'Katalog zniknal.' });
    }
    return Promise.resolve({ ok: true, projectId, name: project.name, roots: project.roots });
  }

  ownerOf(rootId: string): { projectId: string; label: string } | null {
    for (const [projectId, project] of Object.entries(this.projects)) {
      const found = project.roots.find((r) => r.rootId === rootId);
      if (found !== undefined) return { projectId, label: found.label };
    }
    return null;
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
