import { systemClock } from '../../core/ports/clock';
import type { WriteGate, LinkCapability } from '../../core/ports/write-gate';
import { ExportService } from '../../core/services/export/export-service';
import type { LibraryService } from '../../core/services/library/library-service';
import { systemEnv } from '../../infra/platform/env';
import { FsLocationCatalog } from '../../infra/platform/locations';
import { FsSourceReader } from '../../infra/source/fs-source-reader';
import { createAdapters } from './adapters';
import { createExporters } from './exporters';

export type RootPathResolver = (rootId: string) => string | null;

/**
 * Szew na implementacje `WriteGate` (`src/infra/fs/write-gate.ts`, osobne zadanie). Dostaje
 * rozwiazywanie `rootId` na sciezke z tego samego katalogu lokalizacji, ktorego uzywa serwis.
 * Do czasu, az implementacja trafi na main, zwraca null i kanaly `export:*` odpowiadaja bledem.
 */
export function createWriteGate(resolvePath: RootPathResolver): WriteGate | null {
  void resolvePath;
  return null;
}

/**
 * Zdolnosc dowiazan; wykrywanie (`link-mode.ts`) to osobne zadanie. Dopoki go nie ma, zakladamy
 * najgorszy przypadek, czyli kopie: eksport dziala, tylko bez dowiazan (ADR 0015).
 */
export function detectLinkCapability(): Promise<LinkCapability> {
  return Promise.resolve({ fileSymlink: false, directorySymlink: false, junction: false });
}

/** Sklada eksport: katalog lokalizacji, czytnik, eksportery i bramka zapisu. Null bez bramki. */
export function startExport(
  library: LibraryService,
  logUnexpected: (error: unknown) => void,
): ExportService | null {
  const catalog = new FsLocationCatalog(systemEnv());
  const resolvePath: RootPathResolver = (rootId) => catalog.resolvePath(rootId);
  const gate = createWriteGate(resolvePath);
  if (gate === null) return null;
  return new ExportService({
    catalog,
    exporters: createExporters(createAdapters()),
    reader: new FsSourceReader(resolvePath),
    library,
    gate,
    links: detectLinkCapability,
    clock: systemClock,
    onUnexpected: logUnexpected,
  });
}
