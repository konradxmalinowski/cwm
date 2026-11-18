import type { RootId } from '../model/item';
import type { ProjectId } from '../model/project';
import type { DetectedRoot } from './tool-adapter';

/**
 * Rooty projektow z rejestru (ADR 0059). Implementacja w infra zna katalog projektu i przy kazdym
 * wywolaniu sprawdza go od nowa (realpath, brak dowiazan); core dostaje tylko `rootId` i etykiety.
 */

export type ProjectRootsFailureCode = 'unknown-project' | 'project-invalid';

export type ProjectRootsResult =
  | {
      readonly ok: true;
      readonly projectId: ProjectId;
      readonly name: string;
      /** Rooty projektu w kolejnosci tabeli; root z dowiazaniem w sciezce nie jest zwracany. */
      readonly roots: readonly DetectedRoot[];
    }
  | { readonly ok: false; readonly code: ProjectRootsFailureCode; readonly message: string };

export interface ProjectRootCatalog {
  roots(projectId: ProjectId): Promise<ProjectRootsResult>;
  /** Projekt, do ktorego nalezy root; `null` dla rootow globalnych i nieznanych. */
  ownerOf(rootId: RootId): { readonly projectId: ProjectId; readonly label: string } | null;
}
