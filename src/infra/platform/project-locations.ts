import { createHmac } from 'node:crypto';
import path from 'node:path';

import type { RootId } from '../../core/model/item';
import type { ProjectRootCatalog, ProjectRootsResult } from '../../core/ports/project-roots';
import type { DetectedRoot } from '../../core/ports/tool-adapter';
import {
  probeSegments,
  projectRootIntactSync,
  storedProjectDirIntact,
} from '../projects/project-dir';
import type { FsProjectRegistry, ProjectRecord } from '../projects/project-registry';
import { PROJECT_CANDIDATES, type ProjectCandidateSpec } from './locations';

/**
 * Rooty projektow z rejestru (ADR 0059), na tabeli `PROJECT_CANDIDATES`. `rootId` liczy sie z tej
 * samej trwalej soli co rooty globalne, wiec kopie zapasowe i Historia odnajduja go po restarcie.
 * Katalog projektu jest sprawdzany przy kazdym uzyciu: zmiana w dowiazanie albo zmiana `realpath`
 * wylacza projekt do czasu ponownego dodania.
 */

const INVALID_MESSAGE =
  'Katalog projektu zniknął, został przeniesiony albo stał się dowiązaniem symbolicznym. Usuń projekt z listy i dodaj go ponownie.';
const UNREADABLE_MESSAGE =
  'Nie udało się odczytać katalogu projektu (brak uprawnień albo błąd dysku). Sprawdź katalog i spróbuj ponownie.';
const UNKNOWN_MESSAGE = 'Nie ma takiego projektu. Odśwież listę projektów.';

interface Hit {
  readonly project: ProjectRecord;
  readonly spec: ProjectCandidateSpec;
}

export class FsProjectCatalog implements ProjectRootCatalog {
  private salt: Uint8Array | null = null;
  private readonly saltReady: Promise<void>;

  constructor(
    private readonly registry: Pick<FsProjectRegistry, 'ready' | 'list' | 'get' | 'invalidReason'>,
    salt: Promise<Uint8Array>,
    /** Polityka katalogu z okna wyboru, uruchamiana od nowa przy kazdym `roots()`. */
    private readonly check: (dir: string) => Promise<string | null> = () => Promise.resolve(null),
  ) {
    this.saltReady = salt.then((value) => {
      this.salt = value;
    });
  }

  async roots(projectId: string): Promise<ProjectRootsResult> {
    await Promise.all([this.saltReady, this.registry.ready()]);
    const project = this.registry.get(projectId);
    if (project === null) return { ok: false, code: 'unknown-project', message: UNKNOWN_MESSAGE };
    const listed = this.registry.invalidReason(project.id);
    if (listed !== null) return { ok: false, code: 'project-invalid', message: listed };
    if (!(await storedProjectDirIntact(project.dir))) {
      return { ok: false, code: 'project-invalid', message: INVALID_MESSAGE };
    }
    const policy = await this.check(project.dir);
    if (policy !== null) return { ok: false, code: 'project-invalid', message: policy };
    const roots: DetectedRoot[] = [];
    for (const spec of PROJECT_CANDIDATES) {
      const state = await probeSegments(project.dir, spec.segments);
      if (state === 'error') {
        return { ok: false, code: 'project-invalid', message: UNREADABLE_MESSAGE };
      }
      // Dowiazanie w sciezce roota prowadziloby zapis i odczyt poza repozytorium: root znika z listy.
      if (state === 'linked') continue;
      const exists = state === spec.entry;
      roots.push({
        rootId: this.idFor(project, spec),
        tool: spec.tool,
        kind: spec.kind,
        label: labelFor(project, spec),
        exists,
        active: exists,
      });
    }
    return { ok: true, projectId: project.id, name: project.name, roots };
  }

  /** Dla bramki zapisu i czytnika: sciezka roota albo `null`, gdy katalog projektu nie przechodzi kontroli. */
  resolvePath(rootId: RootId): string | null {
    const hit = this.find(rootId);
    if (hit === null) return null;
    if (!projectRootIntactSync(hit.project.dir, hit.spec.segments)) return null;
    return path.join(hit.project.dir, ...hit.spec.segments);
  }

  /** Katalog projektu jako druga granica dla bramki zapisu i czytnika; `null` dla rootow globalnych. */
  boundaryOf(rootId: RootId): string | null {
    return this.find(rootId)?.project.dir ?? null;
  }

  /** Kontrola tuz przed kazdym zapisem; rooty spoza rejestru projektow nie sa tu oceniane. */
  rootIntact(rootId: RootId): boolean {
    const hit = this.find(rootId);
    return hit === null || projectRootIntactSync(hit.project.dir, hit.spec.segments);
  }

  ownerOf(rootId: RootId): { readonly projectId: string; readonly label: string } | null {
    const hit = this.find(rootId);
    return hit === null
      ? null
      : { projectId: hit.project.id, label: labelFor(hit.project, hit.spec) };
  }

  private find(rootId: RootId): Hit | null {
    if (this.salt === null || !rootId.startsWith('root-')) return null;
    for (const project of this.registry.list()) {
      if (this.registry.invalidReason(project.id) !== null) continue;
      for (const spec of PROJECT_CANDIDATES) {
        if (this.idFor(project, spec) === rootId) return { project, spec };
      }
    }
    return null;
  }

  private idFor(project: ProjectRecord, spec: ProjectCandidateSpec): RootId {
    const absolute = path.join(project.dir, ...spec.segments);
    const digest = createHmac('sha256', this.salt ?? new Uint8Array())
      .update(`project|${project.id}|${spec.tool}|${spec.kind}|${absolute}`)
      .digest('base64url');
    return `root-${digest.slice(0, 22)}`;
  }
}

/** Etykieta bez sciezki bezwzglednej: nazwa projektu i sciezka wzgledna roota. */
function labelFor(project: ProjectRecord, spec: ProjectCandidateSpec): string {
  return `${project.name}: ${spec.segments.join('/')}`;
}
