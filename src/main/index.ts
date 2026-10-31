import { app, ipcMain, BrowserWindow } from 'electron';

import type { IndexStartupInfo } from '../core/model/index-health';
import type { LibraryService } from '../core/services/library/library-service';
import { IndexStoreOpenError, SqliteIndexStore } from '../infra/db/index-store';
import { quarantineIndex } from '../infra/db/quarantine';
import { redactHomePath } from '../infra/logging/redact';
import { databaseFile, quarantineRoot, rendererRoot } from './bootstrap/paths';
import { startIndex, type IndexOpenFailure } from './bootstrap/index-startup';
import { handleAppScheme, registerAppScheme } from './bootstrap/protocol';
import { blockOutboundNetwork, denyAllPermissions, hardenWebContents } from './bootstrap/security';
import { createMainWindow } from './bootstrap/window';
import { startLibrary } from './bootstrap/library';
import { registerDiagnosticsHandler, type IndexState } from './ipc/handlers/diagnostics';
import { registerLibraryHandlers } from './ipc/handlers/library';
import { IpcRegistry } from './ipc/registry';
import { homedir } from 'node:os';

registerAppScheme();
app.enableSandbox();

let indexState: IndexState = { store: null, info: { outcome: 'refused' } };
let libraryService: LibraryService | null = null;

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
    console.error(
      '[uasm] indeks nie zostal otwarty:',
      info.reason ?? 'nieznana przyczyna',
      info.message ?? '',
    );
    process.exitCode = 1;
    return;
  }

  console.warn(
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
        console.error(
          '[uasm] nieoczekiwany blad biblioteki:',
          error instanceof Error ? error.name : 'nieznany',
        );
      },
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
      console.error('[uasm] biblioteka niedostepna:', library.failure);

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
