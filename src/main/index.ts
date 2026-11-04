import { app, ipcMain, BrowserWindow } from 'electron';

import type { IndexStartupInfo } from '../core/model/index-health';
import type { ExportService } from '../core/services/export/export-service';
import type { ImportService } from '../core/services/import/import-service';
import type { LibraryService } from '../core/services/library/library-service';
import { IndexStoreOpenError, SqliteIndexStore } from '../infra/db/index-store';
import { quarantineIndex } from '../infra/db/quarantine';
import { createLogger, logFilePath, type Logger } from '../infra/logging/logger';
import { redactHomePath } from '../infra/logging/redact';
import { databaseFile, quarantineRoot, rendererRoot } from './bootstrap/paths';
import { startIndex, type IndexOpenFailure } from './bootstrap/index-startup';
import { handleAppScheme, registerAppScheme } from './bootstrap/protocol';
import { blockOutboundNetwork, denyAllPermissions, hardenWebContents } from './bootstrap/security';
import { createMainWindow } from './bootstrap/window';
import { startExport } from './bootstrap/export';
import { startImport } from './bootstrap/import';
import { startLibrary } from './bootstrap/library';
import { registerDiagnosticsHandler, type IndexState } from './ipc/handlers/diagnostics';
import { registerExportHandlers } from './ipc/handlers/export';
import { registerImportHandlers } from './ipc/handlers/import';
import { registerLibraryHandlers } from './ipc/handlers/library';
import { IpcRegistry } from './ipc/registry';
import { homedir } from 'node:os';

registerAppScheme();
app.enableSandbox();

let indexState: IndexState = { store: null, info: { outcome: 'refused' } };
let libraryService: LibraryService | null = null;
let importService: ImportService | null = null;
let exportService: ExportService | null = null;

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
    '[uasm] nieoczekiwany blad importu:',
    error instanceof Error ? error.name : 'nieznany',
  );
}

function logExportError(error: unknown): void {
  log().error(
    '[uasm] nieoczekiwany blad eksportu:',
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
      '[uasm] indeks nie zostal otwarty:',
      info.reason ?? 'nieznana przyczyna',
      info.message ?? '',
    );
    process.exitCode = 1;
    return;
  }

  log().warn(
    '[uasm] indeks byl uszkodzony i zostal odbudowany; stary plik:',
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
    handleAppScheme(rendererRoot());
    blockOutboundNetwork();
    denyAllPermissions();

    const registry = new IpcRegistry(ipcMain);
    registerDiagnosticsHandler(registry, () => indexState);
    registerLibraryHandlers(registry, {
      service: () => libraryService,
      logUnexpected: (error) => {
        log().error(
          '[uasm] nieoczekiwany blad biblioteki:',
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
    registry.assertImplementedRegistered();

    // Okno powstaje PRZED otwarciem indeksu (ADR 0029 punkt 3). Odmowa startu
    // to nie brak okna, tylko okno pokazujace powod - a to wymaga, zeby okno
    // istnialo niezaleznie od tego, czy indeks da sie otworzyc.
    createMainWindow();

    const userData = app.getPath('userData');

    // Biblioteka powstaje po oknie i niezaleznie od indeksu: jej awaria nie blokuje startu,
    // a log operacji czyta indeks leniwie, dopiero przy zapisie.
    const library = startLibrary(userData, () => indexState.store);
    libraryService = library.service;
    if (library.failure !== undefined)
      log().error('[uasm] biblioteka niedostepna:', library.failure);
    if (library.service !== null) {
      importService = startImport(library.service, logImportError);
      exportService = startExport(library.service, logExportError, {
        userDataDir: userData,
        indexStore: () => indexState.store,
      });
    }

    const dbPath = databaseFile(userData);
    const home = homedir();

    const result = startIndex({
      openStore: () => SqliteIndexStore.open(dbPath, { home }),
      quarantine: () =>
        redactHomePath(
          quarantineIndex(
            dbPath,
            quarantineRoot(userData),
            new Date().toISOString().replace(/[:.]/g, '-'),
          ).directory,
          home,
        ),
      describeFailure,
    });

    indexState = { store: result.store, info: result.info };
    reportIndexStartup(result.info);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

start();
