import { systemClock } from '../../core/ports/clock';
import type { IndexStore } from '../../core/ports/index-store';
import type { WriteGate, LinkCapability } from '../../core/ports/write-gate';
import { join } from 'node:path';

import { ExportService } from '../../core/services/export/export-service';
import { HistoryService } from '../../core/services/history/history-service';
import { SyncRecorder } from '../../core/services/sync/sync-recorder';
import { SyncService } from '../../core/services/sync/sync-service';
import { FsBackupStore } from '../../infra/store/backup';
import { fsBackupReader } from '../../infra/store/backup-reader';
import { loadRootSalt } from '../../infra/platform/root-salt';
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
import { indexBackedLogReader, indexBackedSyncState } from './sync';
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

export interface ExportStartup {
  readonly exports: ExportService;
  readonly sync: SyncService;
  readonly history: HistoryService;
}

/**
 * Sklada eksport, synchronizacje i historie na wspolnym katalogu lokalizacji, czytniku i bramce.
 * Wspolny `ExportService` jest warunkiem: plan cofniecia z historii jest zatwierdzany zwyklym
 * `export:apply`, a kazdy udany zapis zostawia rekord synchronizacji.
 */
export async function startExport(
  library: LibraryService,
  logUnexpected: (error: unknown) => void,
  deps: ExportBootstrapDeps,
): Promise<ExportStartup> {
  const catalog = new FsLocationCatalog(systemEnv(), {
    salt: await loadRootSalt(deps.userDataDir),
  });
  const resolvePath: RootPathResolver = (rootId) => catalog.resolvePath(rootId);
  const linkMode = new LinkCapabilityDetector(deps.userDataDir);
  const gate = createWriteGate(resolvePath, deps, linkMode);
  const reader = new FsSourceReader(resolvePath);
  const state = indexBackedSyncState(deps.indexStore);
  const adapters = createAdapters();
  const exporters = createExporters(adapters);
  const exports = new ExportService({
    catalog,
    exporters,
    reader,
    library,
    gate,
    links: () => detectLinkCapability(linkMode),
    clock: systemClock,
    observer: new SyncRecorder({ state, reader, clock: systemClock }),
    onUnexpected: logUnexpected,
  });
  const sync = new SyncService({
    catalog,
    adapters,
    exporters,
    reader,
    library,
    exports,
    state,
    log: indexBackedOperationLog(deps.indexStore),
    clock: systemClock,
    onUnexpected: logUnexpected,
  });
  const history = new HistoryService({
    log: indexBackedLogReader(deps.indexStore),
    backups: fsBackupReader(new FsBackupStore(join(deps.userDataDir, 'backups'))),
    reader,
    exports,
    clock: systemClock,
  });
  return { exports, sync, history };
}
