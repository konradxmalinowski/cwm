import { app } from 'electron';

import type { DiagnosticsReport, RuntimeInfo } from '../../../core/model/diagnostics';
import type { IndexStartupInfo } from '../../../core/model/index-health';
import { systemClock } from '../../../core/ports/clock';
import type { IndexStore } from '../../../core/ports/index-store';
import { buildDiagnosticsReport } from '../../services/diagnostics';
import type { IndexRebuildService } from '../../services/index-rebuild';
import type { IpcRegistry } from '../registry';
import { parseRebuildApplyRequest } from './diagnostics-validation';

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

export interface DiagnosticsHandlerOptions {
  readonly rebuild?: IndexRebuildService;
  /** Konczy sie, gdy start wypelnil indeks z plikow; raport nie pokazuje wtedy polowy odbudowy. */
  readonly startupSettled?: () => Promise<void>;
}

export function registerDiagnosticsHandler(
  registry: IpcRegistry,
  indexState: () => IndexState,
  options: DiagnosticsHandlerOptions = {},
): void {
  registry.register('diagnostics:report', async (): Promise<DiagnosticsReport> => {
    await options.startupSettled?.();
    const state = indexState();
    return buildDiagnosticsReport({
      runtime: runtimeInfo(),
      indexStore: state.store,
      index: state.info,
      clock: systemClock,
      appIcon: 'placeholder',
      stage: STAGE,
    });
  });
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
}
