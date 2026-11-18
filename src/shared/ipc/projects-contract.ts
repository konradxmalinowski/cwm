import type { Result } from './library-contract';

/**
 * Kontrakt kanalow `projects:*` (ADR 0059). Renderer zna identyfikator i nazwe projektu, nigdy jego
 * katalogu: katalog wybiera main natywnym oknem, sprawdza i trzyma w rejestrze w `userData`.
 */
export interface ProjectDto {
  projectId: string;
  name: string;
  /**
   * Powod, dla ktorego wpis z rejestru nie przeszedl polityki katalogu przy wczytaniu (np. recznie
   * zmieniony plik). Taki projekt mozna tylko usunac; `null` dla projektu waznego.
   */
  invalid: string | null;
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

/**
 * Bez `confirmed` main zwraca liczbe elementow przypietych do projektu; z `confirmed: true` odpina je
 * do zakresu prywatnego i usuwa projekt z listy (ADR 0059).
 */
export interface ProjectsRemoveRequest {
  projectId: string;
  confirmed?: true;
}

export type ProjectsRemoveDto =
  | { status: 'confirm'; pinned: number }
  | { status: 'removed'; unpinned: number; projects: ProjectDto[] };

export type ProjectsListResult = Result<ProjectsListDto>;
export type ProjectsAddResult = Result<ProjectsAddDto>;
export type ProjectsRenameResult = Result<ProjectDto>;
export type ProjectsRemoveResult = Result<ProjectsRemoveDto>;
