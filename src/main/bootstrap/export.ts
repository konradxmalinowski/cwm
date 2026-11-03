import { systemClock } from '../../core/ports/clock';
import type { IndexStore } from '../../core/ports/index-store';
import type { WriteGate, LinkCapability } from '../../core/ports/write-gate';
import { ExportService } from '../../core/services/export/export-service';
import type { LibraryService } from '../../core/services/library/library-service';
import { LinkCapabilityDetector } from '../../infra/fs/link-mode';
import { FsWriteGate } from '../../infra/fs/write-gate';
import { FsObjectStore } from '../../infra/store/object-store';
import { systemEnv } from '../../infra/platform/env';
import { FsLocationCatalog } from '../../infra/platform/locations';
import { FsSourceReader } from '../../infra/source/fs-source-reader';
import { createAdapters } from './adapters';
import { createExporters } from './exporters';
import { indexBackedOperationLog } from './library';
import { objectsRoot } from './paths';

export type RootPathResolver = (rootId: string) => string | null;

export interface ExportBootstrapDeps {
  readonly userDataDir: string;
  /** Log operacji zyje w indeksie, ktory moze byc odmowiony; dlatego dostep leniwy. */
  readonly indexStore: () => IndexStore | null;
}

/**
 * Sklada `WriteGate`: rozwiazywanie `rootId` z katalogu lokalizacji (brama nie zna tabeli),
 * `userData`, content store wspolny z biblioteka i log operacji w indeksie.
 */
export function createWriteGate(
  resolvePath: RootPathResolver,
  deps: ExportBootstrapDeps,
  linkMode: Pick<LinkCapabilityDetector, 'capability'>,
): WriteGate {
  return new FsWriteGate({
    resolveRoot: resolvePath,
    userDataDir: deps.userDataDir,
    objects: new FsObjectStore(objectsRoot(deps.userDataDir)),
    linkMode,
    operationLog: indexBackedOperationLog(deps.indexStore),
  });
}

/** Zdolnosc dowiazan wykrywana proba w `userData/tmp` i zapamietana (ADR 0015). */
export function detectLinkCapability(
  detector: Pick<LinkCapabilityDetector, 'capability'>,
): Promise<LinkCapability> {
  return detector.capability();
}

/** Sklada eksport: katalog lokalizacji, czytnik, eksportery i bramka zapisu.  */
export function startExport(
  library: LibraryService,
  logUnexpected: (error: unknown) => void,
  deps: ExportBootstrapDeps,
): ExportService | null {
  const catalog = new FsLocationCatalog(systemEnv());
  const resolvePath: RootPathResolver = (rootId) => catalog.resolvePath(rootId);
  const linkMode = new LinkCapabilityDetector(deps.userDataDir);
  const gate = createWriteGate(resolvePath, deps, linkMode);
  return new ExportService({
    catalog,
    exporters: createExporters(createAdapters()),
    reader: new FsSourceReader(resolvePath),
    library,
    gate,
    links: () => detectLinkCapability(linkMode),
    clock: systemClock,
    onUnexpected: logUnexpected,
  });
}
