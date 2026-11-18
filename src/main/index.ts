import { app, ipcMain, BrowserWindow } from 'electron';

import type { IndexStartupInfo } from '../core/model/index-health';
import type { ExportService } from '../core/services/export/export-service';
import type { ZipExportService } from '../core/services/export/zip-export-service';
import type { ImportService } from '../core/services/import/import-service';
import type { HistoryService } from '../core/services/history/history-service';
import type { SyncService } from '../core/services/sync/sync-service';
import type { LibraryService } from '../core/services/library/library-service';
import { IndexStoreOpenError, SqliteIndexStore } from '../infra/db/index-store';
import { probeQuarantine, quarantineIndex } from '../infra/db/quarantine';
import { createLogger, logFilePath, type Logger } from '../infra/logging/logger';
import { databaseFile, quarantineRoot, rendererRoot } from './bootstrap/paths';
import { startIndex, type IndexOpenFailure } from './bootstrap/index-startup';
import { registerCrashHandlers } from './bootstrap/crash-handlers';
import { handleAppScheme, registerAppScheme } from './bootstrap/protocol';
import { blockOutboundNetwork, denyAllPermissions, hardenWebContents } from './bootstrap/security';
import { configureUserData, resolveMigration } from './bootstrap/user-data';
import { createMainWindow } from './bootstrap/window';
import { startExport } from './bootstrap/export';
import { startImport } from './bootstrap/import';
import { indexBackedOperationLog, startLibrary } from './bootstrap/library';
import { restoreLibraryIndex } from './bootstrap/library-index';
import {
  diagnosticsSnapshot,
  registerDiagnosticsHandler,
  type IndexState,
} from './ipc/handlers/diagnostics';
import { createDiagnosticReportService } from './bootstrap/diagnostic-report';
import { createZipSaveService } from './bootstrap/zip-export';
import { createRetentionService, createRetentionSettings } from './bootstrap/retention';
import { registerExportHandlers } from './ipc/handlers/export';
import { registerSyncHandlers } from './ipc/handlers/sync';
import { registerImportHandlers } from './ipc/handlers/import';
import { registerRetentionHandlers } from './ipc/handlers/retention';
import { registerLibraryHandlers } from './ipc/handlers/library';
import { registerProjectsHandlers } from './ipc/handlers/projects';
import { startProjects, type ProjectsStartup } from './bootstrap/projects';
import { loadRootSalt } from '../infra/platform/root-salt';
import { IpcRegistry } from './ipc/registry';
import { IndexRebuildService } from './services/index-rebuild';
import { RetentionRunner } from './services/retention-runner';
import { OperationLock } from './services/write-lock';
import { systemClock } from '../core/ports/clock';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

registerAppScheme();
app.enableSandbox();

let dataMigration = configureUserData();

let indexState: IndexState = { store: null, info: { outcome: 'refused' } };
let libraryService: LibraryService | null = null;
let importService: ImportService | null = null;
let exportService: ExportService | null = null;
let zipExportService: ZipExportService | null = null;
let syncService: SyncService | null = null;
let historyService: HistoryService | null = null;
let retentionRunner: RetentionRunner | null = null;
let projectsStartup: ProjectsStartup | null = null;

/** Projekt, do ktorego nalezy root (ADR 0059); kontrola zakresu w main na gotowym planie. */
function rootOwner(rootId: string): string | null {
  return projectsStartup?.catalog.ownerOf(rootId)?.projectId ?? null;
}

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

function logRetentionError(error: unknown): void {
  log().error(
    '[cwm] nieoczekiwany blad czyszczenia historii:',
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

/**
 * Zamkniecie indeksu przy wyjsciu nie ma prawa rzucic. Wyjatek z `before-quit` jest wyjatkiem
 * nieobsluzonym, a na ten Electron pokazuje modalne okno bledu i czeka: proces nie konczy sie,
 * a na Windowsie trzyma pliki katalogu danych.
 *
 * `close()` rzuca "busy executing a query", gdy `before-quit` wejdzie w trakcie trwajacego
 * zapytania. W CI robi to Playwright: `app.close()` wykonuje sie przez inspektor jako przerwanie
 * w srodku synchronicznego `.all()` (widoku Historia), stad zawis E2E po `app.close()`.
 * Wtedy zamykamy w nastepnym obrocie petli, gdy zapytanie sie skonczy. Gdyby i to sie nie
 * udalo, proces i tak sie konczy, a SQLite odtwarza spojny stan z dziennika przy nastepnym otwarciu.
 */
function closeIndexOnQuit(store: IndexState['store'], retry = true): void {
  if (store === null) return;
  try {
    store.close();
  } catch (error: unknown) {
    if (retry) {
      setImmediate(() => {
        closeIndexOnQuit(store, false);
      });
      return;
    }
    log().warn(
      '[cwm] indeks nie zostal zamkniety przy wyjsciu:',
      error instanceof Error ? error.message : String(error),
    );
  }
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
  registerCrashHandlers(log);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // Trwajace pobieranie z repozytorium Git nie ma przezyc aplikacji (ADR 0058).
    importService?.abortGit();
    const store = indexState.store;
    indexState = { store: null, info: indexState.info };
    closeIndexOnQuit(store);
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
    const diagnosticsOptions = {
      dataMigration,
      startupSettled: () => startupSettled,
    };
    const report = createDiagnosticReportService({
      userData,
      home,
      diagnostics: () => diagnosticsSnapshot(() => indexState, diagnosticsOptions),
      library: () => libraryService,
      importService: () => importService,
      logUnexpected: (error) => {
        log().error(
          '[cwm] nieoczekiwany blad raportu diagnostycznego:',
          error instanceof Error ? error.name : 'nieznany',
        );
      },
    });
    registerDiagnosticsHandler(registry, () => indexState, {
      ...diagnosticsOptions,
      rebuild,
      report,
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
    const zipSave = createZipSaveService({
      userData,
      home,
      service: () => zipExportService,
      log: indexBackedOperationLog(() => indexState.store),
      enterWrite: () => writeLock.tryEnterWrite(),
      logLeftover: (name, cause) => {
        log().error(
          '[cwm] po nieudanym zapisie archiwum zostal plik tymczasowy:',
          name,
          cause instanceof Error ? cause.name : 'nieznany',
        );
      },
      logUnexpected: logExportError,
    });
    registerExportHandlers(registry, {
      service: () => exportService,
      zip: () => zipSave,
      rootOwner,
      logUnexpected: logExportError,
    });
    registerSyncHandlers(registry, {
      sync: () => syncService,
      history: () => historyService,
      rootOwner,
      logUnexpected: logExportError,
    });
    registerProjectsHandlers(registry, { service: () => projectsStartup?.service ?? null });
    // Retencja (ADR 0056): serwis liczy osiagalnosc z biblioteki i indeksu, wiec jest dostepny
    // dopiero, gdy oba sa otwarte; ustawienia dzialaja zawsze.
    const retentionSettings = createRetentionSettings(userData);
    const retentionService = createRetentionService(
      {
        userDataDir: userData,
        library: () => libraryService,
        indexStore: () => indexState.store,
        onUnexpected: logRetentionError,
      },
      retentionSettings,
    );
    retentionRunner = new RetentionRunner({
      settings: retentionSettings,
      service: () =>
        libraryService !== null && indexState.store instanceof SqliteIndexStore
          ? retentionService
          : null,
      lock: writeLock,
      logUnexpected: logRetentionError,
      logInfo: (message) => {
        log().info(message);
      },
    });
    registerRetentionHandlers(registry, { runner: () => retentionRunner });
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
    // Jedna obietnica soli dla rootow globalnych i projektowych: dwa rownolegle odczyty przy pierwszym
    // starcie zapisalyby dwie rozne sole.
    const rootSalt = loadRootSalt(userData);
    projectsStartup = startProjects({
      userData,
      home,
      rootSalt,
      logUnexpected: (error) => {
        log().error(
          '[cwm] nieoczekiwany blad listy projektow:',
          error instanceof Error ? error.name : 'nieznany',
        );
      },
    });
    if (library.service !== null) {
      importService = startImport(
        library.service,
        userData,
        logImportError,
        projectsStartup.catalog,
      );
      void startExport(library.service, logExportError, {
        userDataDir: userData,
        indexStore: () => indexState.store,
        appVersion: app.getVersion(),
        rootSalt,
        projects: projectsStartup.catalog,
      })
        .then((started) => {
          exportService = started.exports;
          syncService = started.sync;
          historyService = started.history;
          zipExportService = started.zip;
        })
        .catch(logExportError);
    }

    // Czy plik indeksu istnial przed startem: nowy indeks ma pusty log, a pusty log nie jest dowodem,
    // ze obiekty w store sa zbedne (ADR 0056).
    const indexExisted = existsSync(dbPath);
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

    // Po wypelnieniu indeksu i zwolnieniu blokady: przebieg retencji, tylko przy wlaczonych limitach.
    // Osobny lancuch, zeby raport diagnostyczny nie czekal na czyszczenie.
    const retentionSkip: 'index-new' | 'index-rebuilt' | null = !indexExisted
      ? 'index-new'
      : result.info.outcome !== 'ready' || result.info.quarantinedAs !== undefined
        ? 'index-rebuilt'
        : null;
    void startupSettled
      .then(() => retentionRunner?.runAtStartup(retentionSkip))
      .catch(() => undefined);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

if (dataMigration.outcome === 'busy') app.quit();
else start();
