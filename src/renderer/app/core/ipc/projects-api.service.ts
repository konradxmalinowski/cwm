import { Injectable } from '@angular/core';

import type { Result } from '../../../../shared/ipc/library-contract';
import type {
  ProjectDto,
  ProjectsAddDto,
  ProjectsListDto,
  ProjectsRemoveDto,
  ProjectsRemoveRequest,
  ProjectsRenameRequest,
} from '../../../../shared/ipc/projects-contract';
import { callBridge } from './ipc-call';

/** Typowane metody nad `window.cwm.projects` (ADR 0059). Renderer nie zna katalogow projektow. */
@Injectable({ providedIn: 'root' })
export class ProjectsApiService {
  list(): Promise<Result<ProjectsListDto>> {
    return callBridge((bridge) => bridge.projects.list());
  }

  /** Otwiera okno wyboru katalogu w main; renderer niczego nie podaje. */
  add(): Promise<Result<ProjectsAddDto>> {
    return callBridge((bridge) => bridge.projects.add());
  }

  rename(request: ProjectsRenameRequest): Promise<Result<ProjectDto>> {
    return callBridge((bridge) => bridge.projects.rename(request));
  }

  /** Bez `confirmed` zwraca liczbe przypietych elementow; z `confirmed` odpina je i usuwa projekt. */
  remove(request: ProjectsRemoveRequest): Promise<Result<ProjectsRemoveDto>> {
    return callBridge((bridge) => bridge.projects.remove(request));
  }
}
