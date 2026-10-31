import { app } from 'electron';

import type { DiagnosticsReport, RuntimeInfo } from '../../../core/model/diagnostics';
import type { IndexStartupInfo } from '../../../core/model/index-health';
import { systemClock } from '../../../core/ports/clock';
import type { IndexStore } from '../../../core/ports/index-store';
import { buildDiagnosticsReport } from '../../services/diagnostics';
import type { IpcRegistry } from '../registry';

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

export function registerDiagnosticsHandler(
  registry: IpcRegistry,
  indexState: () => IndexState,
): void {
  registry.register('diagnostics:report', (): DiagnosticsReport => {
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
}
