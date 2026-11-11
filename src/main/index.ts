import { app, ipcMain, BrowserWindow } from 'electron';

import type { IndexStartupInfo } from '../core/model/index-health';
import type { ExportService } from '../core/services/export/export-service';
import type { ImportService } from '../core/services/import/import-service';
import type { HistoryService } from '../core/services/history/history-service';
import type { SyncService } from '../core/services/sync/sync-service';
import type { LibraryService } from '../core/services/library/library-service';
import { IndexStoreOpenError, SqliteIndexStore } from '../infra/db/index-store';
import { probeQuarantine, quarantineIndex } from '../infra/db/quarantine';
import { createLogger, logFilePath, type Logger } from '../infra/logging/logger';
import { databaseFile, quarantineRoot, rendererRoot } from './bootstrap/paths';
import { startIndex, type IndexOpenFailure } from './bootstrap/index-startup';
import { handleAppScheme, registerAppScheme } from './bootstrap/protocol';
import { blockOutboundNetwork, denyAllPermissions, hardenWebContents } from './bootstrap/security';
import { configureUserData, resolveMigration } from './bootstrap/user-data';
import { createMainWindow } from './bootstrap/window';
import { startExport } from './bootstrap/export';
import { startImport } from './bootstrap/import';
import { startLibrary } from './bootstrap/library';
import { restoreLibraryIndex } from './bootstrap/library-index';
import { registerDiagnosticsHandler, type IndexState } from './ipc/handlers/diagnostics';
import { registerExportHandlers } from './ipc/handlers/export';
import { registerSyncHandlers } from './ipc/handlers/sync';
import { registerImportHandlers } from './ipc/handlers/import';
import { registerLibraryHandlers } from './ipc/handlers/library';
import { IpcRegistry } from './ipc/registry';
import { IndexRebuildService } from './services/index-rebuild';
import { OperationLock } from './services/write-lock';
import { systemClock } from '../core/ports/clock';
import { homedir } from 'node:os';

registerAppScheme();
app.enableSandbox();

let dataMigration = configureUserData();

let indexState: IndexState = { store: null, info: { outcome: 'refused' } };
let libraryService: LibraryService | null = null;
let importService: ImportService | null = null;
let exportService: ExportService | null = null;
let syncService: SyncService | null = null;
let historyService: HistoryService | null = null;

/** Konczy sie, gdy start wypelnil indeks biblioteki z plikow; raport diagnostyczny na to czeka. */
let startupSettled: Promise<void> = Promise.resolve();
const writeLock = new OperationLock();

let loggerInstance: Logger | null = null;

/** Jedyny kanal logowania procesu glownego: redakcja sekretow i katalogu domowego jest wbudowana. */
function log(): Logger {
  loggerInstance ??= createLogger({
    logFile: logFilePath(app.getPath('userData')),
    homeDir: homedir(),
  });
  return loggerInstance;
}

function logImportError(error: unknown): void {
  log().error(
    '[cwm] nieoczekiwany blad importu:',
    error instanceof Error ? error.name : 'nieznany',
  );
}

function logExportError(error: unknown): void {
  log().error(
    '[cwm] nieoczekiwany blad eksportu:',
    error instanceof Error ? error.name : 'nieznany',
  );
}

function describeFailure(error: unknown): IndexOpenFailure | null {
  return error instanceof IndexStoreOpenError
    ? { reason: error.reason, message: error.message }
    : null;
}

function reportIndexStartup(info: IndexStartupInfo): void {
  if (info.outcome === 'ready') return;

  // Okno jest kanalem podstawowym (ADR 0029 punkt 3), ale stderr i kod wyjscia
  // zostaja dla CI, testow i uruchomienia z terminala. Kodu ustawiamy bez
  // konczenia procesu - inaczej okno, ktore ma pokazac powod, zniknelo by
  // razem z aplikacja.
  if (info.outcome === 'refused') {
    log().error(
      '[cwm] indeks nie zostal otwarty:',
      info.reason ?? 'nieznana przyczyna',
      info.message ?? '',
    );
    process.exitCode = 1;
    return;
  }

  log().warn(
    '[cwm] indeks byl uszkodzony i zostal odbudowany; stary plik:',
    info.quarantinedAs ?? '(brak)',
  );
}

function start(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing !== undefined) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });

  hardenWebContents();

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    indexState.store?.close();
    indexState = { store: null, info: indexState.info };
  });

  void app.whenReady().then(() => {
    // Przed indeksem, biblioteka, logiem i oknem: do decyzji nic nie zaklada danych w nowym katalogu.
    const startupMigration = dataMigration;
    const decision = resolveMigration(dataMigration);
    if (!decision.proceed) {
      app.quit();
      return;
    }
    dataMigration = decision.info;
    handleAppScheme(rendererRoot());
    blockOutboundNetwork();
    denyAllPermissions();

    const userData = app.getPath('userData');
    const dbPath = databaseFile(userData);
    const home = homedir();

    const registry = new IpcRegistry(ipcMain, { lock: writeLock });
    const rebuild = new IndexRebuildService({
      runtime: {
        current: () => indexState,
        replace: (next) => {
          indexState = next;
        },
      },
      library: () => libraryService,
      lock: writeLock,
      clock: systemClock,
      probe: () => probeQuarantine(dbPath, quarantineRoot(userData)),
      quarantine: (stamp) => {
        quarantineIndex(dbPath, quarantineRoot(userData), stamp);
      },
      openStore: () => SqliteIndexStore.open(dbPath, { home }),
      describeFailure,
      operationLogOf: (store) => (store instanceof SqliteIndexStore ? store.operationLog() : null),
      logUnexpected: (error) => {
        log().error(
          '[cwm] nieoczekiwany blad odbudowy indeksu:',
          error instanceof Error ? error.name : 'nieznany',
        );
      },
    });
    if (startupMigration.outcome === 'failed' || startupMigration.outcome === 'deferred') {
      log().error(
        `[cwm] migracja danych z v0.1.0: ${startupMigration.outcome}, wybor: ${dataMigration.outcome}`,
        startupMigration.errorCode ?? '',
      );
    } else if (dataMigration.outcome === 'migrated') {
      log().info(
        '[cwm] dane z v0.1.0 skopiowane do nowego katalogu danych, zrodlo:',
        dataMigration.source ?? '',
      );
    }
    registerDiagnosticsHandler(registry, () => indexState, {
      dataMigration,
      rebuild,
      startupSettled: () => startupSettled,
    });
    registerLibraryHandlers(registry, {
      service: () => libraryService,
      logUnexpected: (error) => {
        log().error(
          '[cwm] nieoczekiwany blad biblioteki:',
          error instanceof Error ? error.name : 'nieznany',
        );
      },
    });
    registerImportHandlers(registry, {
      service: () => importService,
      logUnexpected: logImportError,
    });
    registerExportHandlers(registry, {
      service: () => exportService,
      logUnexpected: logExportError,
    });
    registerSyncHandlers(registry, {
      sync: () => syncService,
      history: () => historyService,
      logUnexpected: logExportError,
    });
    registry.assertImplementedRegistered();

    // Okno powstaje PRZED otwarciem indeksu (ADR 0029 punkt 3). Odmowa startu
    // to nie brak okna, tylko okno pokazujace powod - a to wymaga, zeby okno
    // istnialo niezaleznie od tego, czy indeks da sie otworzyc.
    createMainWindow();

    // Biblioteka powstaje po oknie i niezaleznie od indeksu: jej awaria nie blokuje startu,
    // a log operacji czyta indeks leniwie, dopiero przy zapisie.
    const library = startLibrary(userData, () => indexState.store);
    libraryService = library.service;
    if (library.failure !== undefined)
      log().error('[cwm] biblioteka niedostepna:', library.failure);
    if (library.service !== null) {
      importService = startImport(library.service, logImportError);
      void startExport(library.service, logExportError, {
        userDataDir: userData,
        indexStore: () => indexState.store,
      })
        .then((started) => {
          exportService = started.exports;
          syncService = started.sync;
          historyService = started.history;
        })
        .catch(logExportError);
    }

    const result = startIndex({
      openStore: () => SqliteIndexStore.open(dbPath, { home }),
      // Nazwa pliku w kwarantannie (kontrakt `quarantinedAs`), nie katalog.
      quarantine: () =>
        quarantineIndex(
          dbPath,
          quarantineRoot(userData),
          new Date().toISOString().replace(/[:.]/g, '-'),
        ).movedFiles[0] ?? '',
      describeFailure,
    });

    indexState = { store: result.store, info: result.info };
    reportIndexStartup(result.info);

    // Indeks biblioteki wypelnia sie z plikow, gdy jest swiezy albo liczba elementow sie nie
    // zgadza (ADR 0014). Blokada nie wpuszcza w tym czasie recznej odbudowy.
    const releaseStartup = writeLock.tryEnterWrite();
    startupSettled = restoreLibraryIndex(libraryService, result.info, (error) => {
      log().error(
        '[cwm] nie udalo sie wypelnic indeksu biblioteki:',
        error instanceof Error ? error.name : 'nieznany',
      );
    })
      .then((info) => {
        indexState = { store: indexState.store, info };
      })
      .finally(() => releaseStartup?.());

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

if (dataMigration.outcome === 'busy') app.quit();
else start();
