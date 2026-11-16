import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { BrowserWindow, app, dialog } from 'electron';

import { systemClock } from '../../core/ports/clock';
import type { OperationLog } from '../../core/ports/operation-log';
import type { ZipExportService } from '../../core/services/export/zip-export-service';
import { writeFileAtomic } from '../../infra/fs/atomic';
import { ZipSaveService } from '../services/zip-export';
import { protectedRoots } from './diagnostic-report';

export interface ZipExportWiring {
  readonly userData: string;
  readonly home: string;
  readonly service: () => ZipExportService | null;
  readonly log: OperationLog;
  readonly logUnexpected: (error: unknown) => void;
}

function suggestedPath(fileName: string): string {
  try {
    return join(app.getPath('documents'), fileName);
  } catch {
    return fileName;
  }
}

async function pickArchivePath(fileName: string): Promise<string | null> {
  const options = {
    title: 'Zapisz archiwum ZIP',
    defaultPath: suggestedPath(fileName),
    buttonLabel: 'Zapisz archiwum',
    filters: [{ name: 'Archiwum ZIP', extensions: ['zip'] }],
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result =
    parent === undefined
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(parent, options);
  return result.canceled || result.filePath === '' ? null : result.filePath;
}

/**
 * Sklada zapis archiwum z elementami Electrona i dysku (ADR 0054). Zapis idzie prymitywem
 * atomowym jak raport diagnostyczny: plik tymczasowy obok, rename, nowy plik z trybem 0600.
 */
export function createZipSaveService(wiring: ZipExportWiring): ZipSaveService {
  return new ZipSaveService({
    service: wiring.service,
    pickPath: pickArchivePath,
    writeFile: (path, bytes) => writeFileAtomic(path, bytes),
    exists: existsSync,
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
    protectedRoots: protectedRoots(wiring.home, wiring.userData),
    log: wiring.log,
    clock: systemClock,
    logUnexpected: wiring.logUnexpected,
  });
}
