import { PROJECT_NAME_MAX, isProjectId, projectNameProblem } from '../../../core/model/project';
import type { Result } from '../../../shared/ipc/library-contract';
import type {
  ProjectsRemoveRequest,
  ProjectsRenameRequest,
} from '../../../shared/ipc/projects-contract';
import type { ProjectsService } from '../../services/projects';
import type { IpcRegistry } from '../registry';
import type { Parsed } from './library-validation';

/**
 * Kanaly `projects:*` (ADR 0059). Zaden ladunek nie niesie sciezki: `projects:add` ignoruje ladunek
 * i otwiera okno wyboru w main, a reszta przyjmuje wylacznie identyfikator i nazwe.
 */

const BAD_SHAPE = 'Nieprawidłowe żądanie.';
const UNAVAILABLE_MESSAGE =
  'Lista projektów jest niedostępna: katalog danych aplikacji nie został przygotowany. Uruchom aplikację ponownie.';

export interface ProjectsHandlerDeps {
  readonly service: () => ProjectsService | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail<T>(field?: string): Parsed<T> {
  return {
    ok: false,
    message: field === undefined ? BAD_SHAPE : `${BAD_SHAPE} Pole „${field}” jest niepoprawne.`,
  };
}

export function parseProjectId(payload: unknown): Parsed<ProjectsRemoveRequest> {
  if (!isRecord(payload)) return fail();
  const { projectId } = payload;
  if (!isProjectId(projectId)) return fail('projectId');
  return { ok: true, value: { projectId } };
}

export function parseRenameRequest(payload: unknown): Parsed<ProjectsRenameRequest> {
  const base = parseProjectId(payload);
  if (!base.ok) return base;
  const raw = isRecord(payload) ? payload['name'] : undefined;
  if (typeof raw !== 'string' || raw.length > PROJECT_NAME_MAX * 4) return fail('name');
  const name = raw.trim();
  const problem = projectNameProblem(name);
  if (problem !== null) return { ok: false, message: problem };
  return { ok: true, value: { projectId: base.value.projectId, name } };
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

export function registerProjectsHandlers(registry: IpcRegistry, deps: ProjectsHandlerDeps): void {
  function guarded<P, T>(
    parse: (payload: unknown) => Parsed<P>,
    run: (service: ProjectsService, request: P) => Promise<Result<T>>,
  ): (payload: unknown) => Promise<Result<T>> {
    return async (payload) => {
      const parsed = parse(payload);
      if (!parsed.ok) return err('invalid-request', parsed.message);
      const service = deps.service();
      if (service === null) return err('projects-unavailable', UNAVAILABLE_MESSAGE);
      return run(service, parsed.value);
    };
  }

  const noPayload = (): Parsed<null> => ({ ok: true, value: null });

  registry.register(
    'projects:list',
    guarded(noPayload, (service) => service.list()),
  );
  // Ladunek jest ignorowany: katalog wybiera wylacznie okno systemowe w main.
  registry.register(
    'projects:add',
    guarded(noPayload, (service) => service.add()),
  );
  registry.register(
    'projects:rename',
    guarded(parseRenameRequest, (service, request) =>
      service.rename(request.projectId, request.name),
    ),
  );
  registry.register(
    'projects:remove',
    guarded(parseProjectId, (service, request) => service.remove(request.projectId)),
  );
}
