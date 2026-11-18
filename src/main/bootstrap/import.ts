import { join } from 'node:path';

import { systemClock } from '../../core/ports/clock';
import type { LibraryService } from '../../core/services/library/library-service';
import { ImportService } from '../../core/services/import/import-service';
import { FsGitSourceProvider } from '../../infra/git-import/git-import-source';
import { systemEnv } from '../../infra/platform/env';
import { FsLocationCatalog } from '../../infra/platform/locations';
import type { FsProjectCatalog } from '../../infra/platform/project-locations';
import { FsSourceReader } from '../../infra/source/fs-source-reader';
import { createAdapters } from './adapters';

/** Katalog roboczy importu z repozytorium Git: pod `userData`, 0700, zawartosc tylko na czas skanu (ADR 0058). */
export const GIT_IMPORT_DIR_NAME = 'git-import';

/**
 * Sklada import: katalog lokalizacji, czytnik zrodla (tylko do odczytu) i serwis. Mapa
 * `rootId` na sciezke zyje w katalogu i nie wychodzi poza ten plik. Pobieranie z repozytorium Git
 * dostaje katalog roboczy pod `userData`; pozostalosci po przerwanym imporcie znikaja przy starcie.
 */
export function startImport(
  library: LibraryService,
  userDataDir: string,
  logUnexpected: (error: unknown) => void,
  projects?: FsProjectCatalog,
): ImportService {
  const catalog = new FsLocationCatalog(systemEnv());
  // Czytnik zna rooty globalne i projektowe; rooty projektu sprawdzaja katalog przy kazdym odczycie (ADR 0059).
  const reader = new FsSourceReader(
    (rootId) => catalog.resolvePath(rootId) ?? projects?.resolvePath(rootId) ?? null,
    (rootId) => projects?.boundaryOf(rootId) ?? null,
  );
  const git = new FsGitSourceProvider({
    workDir: join(userDataDir, GIT_IMPORT_DIR_NAME),
    onUnexpected: logUnexpected,
  });
  git.purgeAtStart();
  return new ImportService({
    catalog,
    adapters: createAdapters(),
    reader,
    git,
    ...(projects === undefined ? {} : { projects }),
    library,
    clock: systemClock,
    onUnexpected: logUnexpected,
  });
}
