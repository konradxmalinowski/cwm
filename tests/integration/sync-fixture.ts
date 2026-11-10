import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createClaudeCodeAdapter } from '../../src/adapters/claude-code';
import { createCodexAdapter } from '../../src/adapters/codex';
import { systemClock, type Clock } from '../../src/core/ports/clock';
import { ExportService } from '../../src/core/services/export/export-service';
import { HistoryService } from '../../src/core/services/history/history-service';
import { SyncRecorder } from '../../src/core/services/sync/sync-recorder';
import { SyncService } from '../../src/core/services/sync/sync-service';
import { SqliteIndexStore } from '../../src/infra/db/index-store';
import type { AtomicOps } from '../../src/infra/fs/atomic';
import { FsWriteGate } from '../../src/infra/fs/write-gate';
import { FsLocationCatalog } from '../../src/infra/platform/locations';
import { FsSourceReader } from '../../src/infra/source/fs-source-reader';
import { FsBackupStore } from '../../src/infra/store/backup';
import { fsBackupReader } from '../../src/infra/store/backup-reader';
import { FsObjectStore } from '../../src/infra/store/object-store';
import { createExporters } from '../../src/main/bootstrap/exporters';
import { createTempTree } from '../harness/isolation';
import { createHarness } from '../unit/library-fakes';

import { ALL_LINKS, NO_LINKS } from './write-gate-fixture';

/** Pelny stos synchronizacji na katalogu tymczasowym: prawdziwe pliki, SQLite i brama zapisu. */
export interface SyncStackOptions {
  readonly links?: boolean;
  /** Szew na prymityw zapisu: wymuszenie awarii albo zawieszenia w polowie `apply`. */
  readonly atomicOps?: Partial<AtomicOps>;
  /** Zegar bramki zapisu, np. przesuniety, zeby plik tymczasowy przerwanego zapisu byl stary. */
  readonly gateClock?: Clock;
  /** Ponowny start na tym samym drzewie i tej samej bibliotece (po przerwanym przebiegu). */
  readonly reuse?: { readonly tree: string; readonly lib: ReturnType<typeof createHarness> };
}

export function makeSyncStack(options: SyncStackOptions = {}) {
  const tree = options.reuse?.tree ?? createTempTree('acme-sync-');
  const home = join(tree, 'home');
  const userData = join(tree, 'userData');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(userData, { recursive: true });

  const catalog = new FsLocationCatalog(
    { platform: process.platform, homeDir: home, env: {} },
    { salt: new Uint8Array(32).fill(3) },
  );
  const resolve = (id: string) => catalog.resolvePath(id);
  const reader = new FsSourceReader(resolve);
  const capability = options.links === true ? ALL_LINKS : NO_LINKS;
  const linkMode = { capability: () => Promise.resolve(capability) };
  const lib = options.reuse?.lib ?? createHarness();
  const index = SqliteIndexStore.open(join(userData, 'index.db'), { home: tree });
  const state = index.syncState();
  const oplog = index.operationLog();
  const gate = new FsWriteGate({
    resolveRoot: resolve,
    userDataDir: userData,
    objects: new FsObjectStore(join(userData, 'objects')),
    linkMode,
    operationLog: oplog,
    ...(options.atomicOps === undefined ? {} : { atomicOps: options.atomicOps }),
    ...(options.gateClock === undefined ? {} : { clock: options.gateClock }),
  });
  const adapters = [createClaudeCodeAdapter(), createCodexAdapter()];
  const exporters = createExporters(adapters);
  const exports = new ExportService({
    catalog,
    exporters,
    reader,
    library: lib.service,
    gate,
    links: () => Promise.resolve(capability),
    clock: systemClock,
    observer: new SyncRecorder({ state, reader, clock: systemClock }),
  });
  const sync = new SyncService({
    catalog,
    adapters,
    exporters,
    reader,
    library: lib.service,
    exports,
    state,
    log: oplog,
    clock: systemClock,
  });
  const history = new HistoryService({
    log: index.operationLogReader(),
    backups: fsBackupReader(new FsBackupStore(join(userData, 'backups'))),
    reader,
    exports,
    clock: systemClock,
  });
  return {
    tree,
    home,
    userData,
    skills: join(home, '.claude', 'skills'),
    lib,
    index,
    state,
    exports,
    sync,
    history,
  };
}
