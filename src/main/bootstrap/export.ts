import { systemClock } from '../../core/ports/clock';
import type { IndexStore } from '../../core/ports/index-store';
import type { WriteGate, LinkCapability } from '../../core/ports/write-gate';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { ExportService } from '../../core/services/export/export-service';
import { HistoryService } from '../../core/services/history/history-service';
import { ZipExportService } from '../../core/services/export/zip-export-service';
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
import type { FsProjectCatalog } from '../../infra/platform/project-locations';
import { FsSourceReader } from '../../infra/source/fs-source-reader';
import { createAdapters } from './adapters';
import { createExporters } from './exporters';
import { indexBackedOperationLog } from './library';
import { indexBackedLogReader, indexBackedSyncState } from './sync';
import { objectsRoot } from './paths';
import { isMcpServerItem } from '../../core/services/mcp/mcp-server';

export type RootPathResolver = (rootId: string) => string | null;

export interface ExportBootstrapDeps {
  readonly userDataDir: string;
  /** Log operacji zyje w indeksie, ktory moze byc odmowiony; dlatego dostep leniwy. */
  readonly indexStore: () => IndexStore | null;
  /** Wersja aplikacji do manifestu archiwum ZIP. */
  readonly appVersion: string;
  /** Sol `rootId` wspolna z rejestrem projektow; bez niej wczytywana tutaj. */
  readonly rootSalt?: Promise<Uint8Array>;
  /** Rooty projektow (ADR 0059): eksport do projektu i cofniecie takiego zapisu. */
  readonly projects?: FsProjectCatalog;
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
  const { projects } = deps;
  return new FsWriteGate({
    resolveRoot: resolvePath,
    ...(projects === undefined
      ? {}
      : {
          boundaryOf: (rootId: string) => projects.boundaryOf(rootId),
          rootIntact: (rootId: string) => projects.rootIntact(rootId),
        }),
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
  readonly zip: ZipExportService;
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
    salt: await (deps.rootSalt ?? loadRootSalt(deps.userDataDir)),
  });
  const { projects } = deps;
  // Bramka, czytnik i Historia rozwiazuja rooty globalne i projektowe jednym resolverem.
  const resolvePath: RootPathResolver = (rootId) =>
    catalog.resolvePath(rootId) ?? projects?.resolvePath(rootId) ?? null;
  const linkMode = new LinkCapabilityDetector(deps.userDataDir);
  const gate = createWriteGate(resolvePath, deps, linkMode);
  const reader = new FsSourceReader(resolvePath, (rootId) => projects?.boundaryOf(rootId) ?? null);
  const state = indexBackedSyncState(deps.indexStore);
  const adapters = createAdapters();
  const exporters = createExporters(adapters);
  const exports = new ExportService({
    catalog,
    ...(projects === undefined ? {} : { projects }),
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
    // Cofniecie zapisu serwera MCP jest zablokowane (ADR 0061); usuniety element nie blokuje.
    mcpItem: (itemId) =>
      library.get(itemId).then(
        (loaded) => isMcpServerItem(loaded.item),
        () => false,
      ),
  });
  const zip = new ZipExportService({
    catalog,
    exporters,
    library,
    clock: systemClock,
    appVersion: deps.appVersion,
    deflate: (bytes) => deflateRawSync(bytes, { level: 6 }),
  });
  return { exports, sync, history, zip };
}
