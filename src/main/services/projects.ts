import { basename } from 'node:path';

import { PROJECT_NAME_MAX, projectNameProblem } from '../../core/model/project';
import type { ProjectDirCheck } from '../../infra/projects/project-dir';
import {
  ProjectRegistryError,
  type FsProjectRegistry,
  type ProjectRecord,
} from '../../infra/projects/project-registry';
import type { Result } from '../../shared/ipc/library-contract';
import type {
  ProjectDto,
  ProjectsAddDto,
  ProjectsListDto,
} from '../../shared/ipc/projects-contract';

/**
 * Rejestr projektow po stronie main (ADR 0059). Katalog pochodzi wylacznie z okna wyboru
 * (`pickDirectory`), przechodzi `check` i dopiero wtedy trafia do rejestru. Odpowiedzi niosa
 * identyfikator i nazwe, nigdy sciezki.
 */
export interface ProjectsServiceDeps {
  readonly registry: Pick<FsProjectRegistry, 'ready' | 'list' | 'add' | 'rename' | 'remove'>;
  /** Natywne okno wyboru katalogu; `null`, gdy uzytkownik je zamknal bez wyboru. */
  readonly pickDirectory: () => Promise<string | null>;
  readonly check: (chosen: string) => Promise<ProjectDirCheck>;
  readonly logUnexpected: (error: unknown) => void;
}

const INTERNAL_MESSAGE =
  'Wystąpił nieoczekiwany błąd listy projektów. Szczegóły są w logu aplikacji.';

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

export function toProjectDto(record: Pick<ProjectRecord, 'id' | 'name'>): ProjectDto {
  return { projectId: record.id, name: record.name };
}

/** Nazwa domyslna z ostatniego elementu sciezki; sama sciezka nie wychodzi z main. */
export function defaultProjectName(dir: string): string {
  const base = basename(dir).trim().slice(0, PROJECT_NAME_MAX);
  return projectNameProblem(base) === null ? base : 'Projekt';
}

export class ProjectsService {
  /** Jedno okno wyboru naraz: drugie klikniecie w trakcie nie otwiera kolejnego. */
  private picking = false;

  constructor(private readonly deps: ProjectsServiceDeps) {}

  async list(): Promise<Result<ProjectsListDto>> {
    await this.deps.registry.ready();
    return ok({ projects: this.deps.registry.list().map(toProjectDto) });
  }

  async add(): Promise<Result<ProjectsAddDto>> {
    if (this.picking) {
      return err('project-picking', 'Okno wyboru katalogu jest już otwarte.');
    }
    this.picking = true;
    try {
      const chosen = await this.deps.pickDirectory();
      if (chosen === null) return ok({ status: 'cancelled' });
      const checked = await this.deps.check(chosen);
      if (!checked.ok) return err('project-dir-rejected', checked.message);
      const record = await this.deps.registry.add(checked.dir, defaultProjectName(checked.dir));
      return ok({ status: 'added', project: toProjectDto(record) });
    } catch (error: unknown) {
      return this.mapError(error);
    } finally {
      this.picking = false;
    }
  }

  async rename(projectId: string, name: string): Promise<Result<ProjectDto>> {
    try {
      return ok(toProjectDto(await this.deps.registry.rename(projectId, name)));
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  async remove(projectId: string): Promise<Result<ProjectsListDto>> {
    try {
      await this.deps.registry.remove(projectId);
      return ok({ projects: this.deps.registry.list().map(toProjectDto) });
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  private mapError(error: unknown): Result<never> {
    if (error instanceof ProjectRegistryError) return err(error.code, error.message);
    this.deps.logUnexpected(error);
    return err('internal', INTERNAL_MESSAGE);
  }
}
