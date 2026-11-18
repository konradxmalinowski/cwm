import type { Result } from './library-contract';

/**
 * Kontrakt kanalow `projects:*` (ADR 0059). Renderer zna identyfikator i nazwe projektu, nigdy jego
 * katalogu: katalog wybiera main natywnym oknem, sprawdza i trzyma w rejestrze w `userData`.
 */
export interface ProjectDto {
  projectId: string;
  name: string;
}

export interface ProjectsListDto {
  projects: ProjectDto[];
}

/** `projects:add` nie przyjmuje ladunku: katalog pochodzi wylacznie z okna wyboru w main. */
export type ProjectsAddDto = { status: 'added'; project: ProjectDto } | { status: 'cancelled' };

export interface ProjectsRenameRequest {
  projectId: string;
  name: string;
}

export interface ProjectsRemoveRequest {
  projectId: string;
}

export type ProjectsListResult = Result<ProjectsListDto>;
export type ProjectsAddResult = Result<ProjectsAddDto>;
export type ProjectsRenameResult = Result<ProjectDto>;
export type ProjectsRemoveResult = Result<ProjectsListDto>;
