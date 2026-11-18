import { join } from 'node:path';

import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron';

import { FsProjectCatalog } from '../../infra/platform/project-locations';
import { checkChosenProjectDir } from '../../infra/projects/project-dir';
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
  const registry = new FsProjectRegistry(join(userData, PROJECTS_FILE_NAME), {
    onUnexpected: wiring.logUnexpected,
  });
  void registry.ready();
  const catalog = new FsProjectCatalog(registry, wiring.rootSalt);
  const service = new ProjectsService({
    registry,
    pickDirectory: pickProjectDirectory,
    check: (chosen) =>
      checkChosenProjectDir(chosen, {
        platform: process.platform,
        home,
        protectedDirs: protectedRoots(home, userData),
        env: process.env,
      }),
    logUnexpected: wiring.logUnexpected,
  });
  return { registry, catalog, service };
}
