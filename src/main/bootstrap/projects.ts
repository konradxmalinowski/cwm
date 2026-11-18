import { join } from 'node:path';

import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron';

import type { LibraryService } from '../../core/services/library/library-service';
import { FsProjectCatalog } from '../../infra/platform/project-locations';
import {
  checkChosenProjectDir,
  projectDirPolicyProblem,
  type ProjectDirContext,
} from '../../infra/projects/project-dir';
import { FsProjectRegistry } from '../../infra/projects/project-registry';
import { ProjectsService } from '../services/projects';
import { protectedRoots } from './diagnostic-report';

/** Rejestr projektow w `userData` (ADR 0059). */
export const PROJECTS_FILE_NAME = 'projects.json';

export interface ProjectsWiring {
  readonly userData: string;
  readonly home: string;
  /** Ta sama trwala sol co dla rootow globalnych: `rootId` projektu przetrwa restart. */
  readonly rootSalt: Promise<Uint8Array>;
  /** Biblioteka do odpiecia elementow przy usuwaniu projektu; `null`, gdy niedostepna. */
  readonly library: () => Pick<LibraryService, 'list' | 'update'> | null;
  readonly logUnexpected: (error: unknown) => void;
}

export interface ProjectsStartup {
  readonly registry: FsProjectRegistry;
  readonly catalog: FsProjectCatalog;
  readonly service: ProjectsService;
}

/** Natywne okno wyboru katalogu. Jedyna droga, ktora sciezka projektu trafia do aplikacji. */
async function pickProjectDirectory(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Wybierz katalog projektu',
    buttonLabel: 'Dodaj projekt',
    properties: ['openDirectory', 'dontAddToRecent'],
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result =
    parent === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export function startProjects(wiring: ProjectsWiring): ProjectsStartup {
  const { userData, home } = wiring;
  const ctx: ProjectDirContext = {
    platform: process.platform,
    home,
    protectedDirs: protectedRoots(home, userData),
    env: process.env,
  };
  // Ta sama polityka co przy dodaniu: przy wczytaniu rejestru i przy kazdym uzyciu projektu (ADR 0059).
  const policy = (dir: string): Promise<string | null> => projectDirPolicyProblem(dir, ctx);
  const registry = new FsProjectRegistry(join(userData, PROJECTS_FILE_NAME), {
    onUnexpected: wiring.logUnexpected,
    check: policy,
  });
  void registry.ready();
  const catalog = new FsProjectCatalog(registry, wiring.rootSalt, policy);
  const service = new ProjectsService({
    registry,
    library: wiring.library,
    pickDirectory: pickProjectDirectory,
    check: (chosen) => checkChosenProjectDir(chosen, ctx),
    logUnexpected: wiring.logUnexpected,
  });
  return { registry, catalog, service };
}
