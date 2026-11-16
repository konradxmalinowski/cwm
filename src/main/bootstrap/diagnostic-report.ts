import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { BrowserWindow, app, dialog } from 'electron';

import type { DiagnosticsReport } from '../../core/model/diagnostics';
import { systemClock } from '../../core/ports/clock';
import type { ImportService } from '../../core/services/import/import-service';
import type { LibraryService } from '../../core/services/library/library-service';
import { writeFileAtomic } from '../../infra/fs/atomic';
import { logFilePath } from '../../infra/logging/logger';
import { readLogTail } from '../../infra/logging/read-tail';
import { redactHomeInText } from '../../infra/logging/redact';
import { DiagnosticReportService } from '../services/diagnostic-report';

export interface DiagnosticReportWiring {
  readonly userData: string;
  readonly home: string;
  readonly diagnostics: () => Promise<DiagnosticsReport>;
  readonly library: () => LibraryService | null;
  readonly importService: () => ImportService | null;
  readonly logUnexpected: (error: unknown) => void;
}

function systemUserName(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

function suggestedPath(fileName: string): string {
  try {
    return join(app.getPath('documents'), fileName);
  } catch {
    return fileName;
  }
}

async function pickReportPath(fileName: string): Promise<string | null> {
  const options = {
    title: 'Zapisz raport diagnostyczny',
    defaultPath: suggestedPath(fileName),
    buttonLabel: 'Zapisz raport',
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Tekst', extensions: ['txt'] },
    ],
  };
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result =
    parent === undefined
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(parent, options);
  return result.canceled || result.filePath === '' ? null : result.filePath;
}

/**
 * Sklada serwis eksportu raportu z elementami Electrona i dysku (ADR 0053). Serwis zna tylko
 * wstrzykniete funkcje, wiec jego logike da sie sprawdzic bez okna i bez zapisu.
 */
export function createDiagnosticReportService(
  wiring: DiagnosticReportWiring,
): DiagnosticReportService {
  const { home, userData } = wiring;
  return new DiagnosticReportService({
    diagnostics: wiring.diagnostics,
    list: () => wiring.library()?.list() ?? null,
    detect: () => wiring.importService()?.detect() ?? null,
    readLog: (maxLines) => readLogTail(logFilePath(userData), maxLines),
    redactHome: (text) => redactHomeInText(text, home),
    userName: systemUserName(),
    clock: systemClock,
    newId: () => randomUUID(),
    pickPath: pickReportPath,
    writeFile: (path, text) =>
      writeFileAtomic(path, new TextEncoder().encode(text), { mode: 0o644 }),
    protectedRoots: [join(home, '.claude'), join(home, '.codex'), join(home, '.cwm'), userData],
    logUnexpected: wiring.logUnexpected,
  });
}
