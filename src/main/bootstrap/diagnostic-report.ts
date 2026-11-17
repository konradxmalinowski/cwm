import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
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

/** Katalogi konfiguracji narzedzi i danych aplikacji, takze z nadpisan zmiennymi srodowiska. */
export function protectedRoots(home: string, userData: string): string[] {
  const overrides = [process.env['CLAUDE_CONFIG_DIR'], process.env['CODEX_HOME']].filter(
    (value): value is string => value !== undefined && value.trim() !== '',
  );
  // GEMINI_CLI_HOME wskazuje katalog nadrzedny: konfiguracja jest w jego podkatalogu `.gemini`.
  const geminiHome = process.env['GEMINI_CLI_HOME'];
  if (geminiHome !== undefined && geminiHome.trim() !== '') {
    overrides.push(join(geminiHome, '.gemini'));
  }
  return [
    join(home, '.claude'),
    join(home, '.codex'),
    join(home, '.gemini'),
    join(home, '.agents'),
    join(home, '.cwm'),
    userData,
    ...overrides,
  ];
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
    // Bez `mode`: nowy plik dostaje 0600, a istniejacy zachowuje swoj tryb.
    writeFile: (path, text) => writeFileAtomic(path, new TextEncoder().encode(text)),
    exists: existsSync,
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
    protectedRoots: protectedRoots(home, userData),
    logUnexpected: wiring.logUnexpected,
  });
}
