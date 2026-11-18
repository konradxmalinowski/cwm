import { basename } from 'node:path';

import type { ItemDraft, LibraryItem } from '../../core/model/item';
import { PROJECT_NAME_MAX, projectNameProblem } from '../../core/model/project';
import type { LibraryService } from '../../core/services/library/library-service';
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
  ProjectsRemoveDto,
} from '../../shared/ipc/projects-contract';

/**
 * Rejestr projektow po stronie main (ADR 0059). Katalog pochodzi wylacznie z okna wyboru
 * (`pickDirectory`), przechodzi `check` i dopiero wtedy trafia do rejestru. Odpowiedzi niosa
 * identyfikator i nazwe, nigdy sciezki.
 */
export interface ProjectsServiceDeps {
  readonly registry: Pick<
    FsProjectRegistry,
    'ready' | 'list' | 'get' | 'invalidReason' | 'add' | 'rename' | 'remove'
  >;
  /** Biblioteka do odpiecia elementow przy usuwaniu projektu (ADR 0059); `null`, gdy niedostepna. */
  readonly library: () => Pick<LibraryService, 'list' | 'update'> | null;
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

export function toProjectDto(
  record: Pick<ProjectRecord, 'id' | 'name'>,
  invalidReason: string | null = null,
): ProjectDto {
  return { projectId: record.id, name: record.name, invalid: invalidReason };
}

/** Szkic odpiecia: ten sam element, zakres prywatny (najwezszy) i bez `projectId`; pliki pomocnicze i zrodlo zostaja. */
function unpinnedDraft(item: LibraryItem): ItemDraft {
  return {
    kind: item.kind,
    identity: item.identity,
    content: item.content,
    attributes: item.attributes,
    classification: { scope: 'private', secretFindings: item.classification.secretFindings },
  };
}

const LIBRARY_UNAVAILABLE =
  'Biblioteka jest niedostępna, więc nie da się odpiąć elementów projektu. Projekt zostaje na liście.';

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
    return ok({ projects: this.dtos() });
  }

  private dtos(): ProjectDto[] {
    return this.deps.registry
      .list()
      .map((p) => toProjectDto(p, this.deps.registry.invalidReason(p.id)));
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

  /**
   * Usuniecie z listy odpina elementy projektu do zakresu prywatnego, zeby nie zostaly przypiete do
   * identyfikatora, ktorego juz nie ma (ADR 0059). Bez `confirmed` zwraca liczbe przypietych elementow
   * do potwierdzenia; z `confirmed` odpina je i dopiero potem usuwa wpis. Blad odpiecia zostawia projekt.
   */
  async remove(projectId: string, confirmed: boolean): Promise<Result<ProjectsRemoveDto>> {
    try {
      await this.deps.registry.ready();
      if (this.deps.registry.get(projectId) === null) {
        return err('unknown-project', 'Nie ma takiego projektu. Odśwież listę projektów.');
      }
      const library = this.deps.library();
      if (library === null) return err('library-unavailable', LIBRARY_UNAVAILABLE);
      const pinned = (await library.list()).items.filter(
        (item) => item.classification.projectId === projectId,
      );
      if (!confirmed) return ok({ status: 'confirm', pinned: pinned.length });
      let unpinned = 0;
      for (const item of pinned) {
        try {
          await library.update(item.id, unpinnedDraft(item), { note: `odpieto=${projectId}` });
          unpinned++;
        } catch (error: unknown) {
          this.deps.logUnexpected(error);
          return err(
            'unpin-failed',
            `Odpięto ${unpinned} z ${pinned.length} elementów, a następny się nie udał. Projekt zostaje na liście; spróbuj jeszcze raz.`,
          );
        }
      }
      await this.deps.registry.remove(projectId);
      return ok({ status: 'removed', unpinned, projects: this.dtos() });
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
