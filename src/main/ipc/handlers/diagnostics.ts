import { app } from 'electron';

import type { DataMigrationInfo } from '../../../core/model/data-migration';
import type { DiagnosticsReport, RuntimeInfo } from '../../../core/model/diagnostics';
import type { IndexStartupInfo } from '../../../core/model/index-health';
import { systemClock } from '../../../core/ports/clock';
import type { IndexStore } from '../../../core/ports/index-store';
import { buildDiagnosticsReport } from '../../services/diagnostics';
import type { IndexRebuildService } from '../../services/index-rebuild';
import type { IpcRegistry } from '../registry';
import type {
  ReportPreviewResult,
  ReportSaveResult,
} from '../../../shared/ipc/diagnostics-contract';
import { parseRebuildApplyRequest, parseReportSaveRequest } from './diagnostics-validation';

const STAGE = 'etap-2-biblioteka';

function runtimeInfo(): RuntimeInfo {
  return {
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    electronVersion: process.versions['electron'] ?? 'unknown',
    chromeVersion: process.versions['chrome'] ?? 'unknown',
    nodeVersion: process.versions['node'] ?? 'unknown',
    packaged: app.isPackaged,
  };
}

export interface IndexState {
  readonly store: IndexStore | null;
  readonly info: IndexStartupInfo;
}

/** Eksport raportu do zgloszenia (ADR 0053): to, co handler potrzebuje z `DiagnosticReportService`. */
export interface ReportExporter {
  preview(): Promise<ReportPreviewResult>;
  save(previewId: string): Promise<ReportSaveResult>;
}

export interface DiagnosticsHandlerOptions {
  readonly dataMigration?: DataMigrationInfo;
  readonly rebuild?: IndexRebuildService;
  readonly report?: ReportExporter;
  /** Konczy sie, gdy start wypelnil indeks z plikow; raport nie pokazuje wtedy polowy odbudowy. */
  readonly startupSettled?: () => Promise<void>;
}

/** Ten sam raport zasila ekran Diagnostyka i eksport do zgloszenia, wiec jest budowany w jednym miejscu. */
export async function diagnosticsSnapshot(
  indexState: () => IndexState,
  options: Pick<DiagnosticsHandlerOptions, 'dataMigration' | 'startupSettled'> = {},
): Promise<DiagnosticsReport> {
  await options.startupSettled?.();
  const state = indexState();
  return buildDiagnosticsReport({
    runtime: runtimeInfo(),
    indexStore: state.store,
    index: state.info,
    clock: systemClock,
    appIcon: 'provided',
    stage: STAGE,
    ...(options.dataMigration === undefined ? {} : { dataMigration: options.dataMigration }),
  });
}

export function registerDiagnosticsHandler(
  registry: IpcRegistry,
  indexState: () => IndexState,
  options: DiagnosticsHandlerOptions = {},
): void {
  registry.register('diagnostics:report', (): Promise<DiagnosticsReport> =>
    diagnosticsSnapshot(indexState, options),
  );
  const { rebuild } = options;
  const unavailable = {
    ok: false,
    error: { code: 'internal', message: 'Odbudowa indeksu jest niedostępna.' },
  } as const;

  // Plan nie przyjmuje niczego: ladunek jest ignorowany, a plik indeksu zna tylko main.
  registry.register('diagnostics:rebuild-index-plan', async () => {
    await options.startupSettled?.();
    return rebuild === undefined ? unavailable : rebuild.plan();
  });

  registry.register('diagnostics:rebuild-index-apply', (payload) => {
    const parsed = parseRebuildApplyRequest(payload);
    if (!parsed.ok)
      return { ok: false, error: { code: 'invalid-request', message: parsed.message } };
    return rebuild === undefined
      ? unavailable
      : rebuild.apply(parsed.value.planId, parsed.value.confirmed);
  });

  const { report } = options;
  const reportUnavailable = {
    ok: false,
    error: { code: 'internal', message: 'Eksport raportu jest niedostępny.' },
  } as const;

  // Podglad nie przyjmuje niczego: ladunek jest ignorowany, a zrodla danych zna tylko main.
  registry.register('diagnostics:report-preview', () =>
    report === undefined ? reportUnavailable : report.preview(),
  );

  // Zapis przyjmuje wylacznie `previewId`: tresc to ta z podgladu, sciezke wybiera main.
  registry.register('diagnostics:report-save', (payload) => {
    const parsed = parseReportSaveRequest(payload);
    if (!parsed.ok)
      return { ok: false, error: { code: 'invalid-request', message: parsed.message } };
    return report === undefined ? reportUnavailable : report.save(parsed.value.previewId);
  });
}
