import { systemClock } from '../../core/ports/clock';
import type { LibraryService } from '../../core/services/library/library-service';
import { ImportService } from '../../core/services/import/import-service';
import { systemEnv } from '../../infra/platform/env';
import { FsLocationCatalog } from '../../infra/platform/locations';
import { FsSourceReader } from '../../infra/source/fs-source-reader';
import { createAdapters } from './adapters';

/**
 * Sklada import: katalog lokalizacji, czytnik zrodla (tylko do odczytu) i serwis. Mapa
 * `rootId` na sciezke zyje w katalogu i nie wychodzi poza ten plik.
 */
export function startImport(
  library: LibraryService,
  logUnexpected: (error: unknown) => void,
): ImportService {
  const catalog = new FsLocationCatalog(systemEnv());
  const reader = new FsSourceReader((rootId) => catalog.resolvePath(rootId));
  return new ImportService({
    catalog,
    adapters: createAdapters(),
    reader,
    library,
    clock: systemClock,
    onUnexpected: logUnexpected,
  });
}
