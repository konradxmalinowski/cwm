import { Injectable } from '@angular/core';

import type { DiagnosticsReport } from '../../../../core/model/diagnostics';
import type {
  RebuildIndexApplyResult,
  RebuildIndexPlanResult,
} from '../../../../shared/ipc/diagnostics-contract';
import type { Result } from '../../../../shared/ipc/library-contract';
import type { BridgeSurface } from '../../../../shared/ipc/surface';
import { callBridge, failure } from './ipc-call';

function isReport(value: unknown): value is DiagnosticsReport {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const index = record['index'];
  return (
    typeof record['generatedAt'] === 'string' &&
    typeof record['runtime'] === 'object' &&
    typeof record['database'] === 'object' &&
    typeof index === 'object' &&
    index !== null &&
    typeof (index as Record<string, unknown>)['outcome'] === 'string'
  );
}

@Injectable({ providedIn: 'root' })
export class DiagnosticsApiService {
  /** `diagnostics:report` zwraca raport wprost, bez koperty `Result`; tu je opakowujemy. */
  async report(): Promise<Result<DiagnosticsReport>> {
    const response = await callBridge<unknown>(async (bridge) => {
      try {
        return { ok: true, value: await bridge.diagnostics.report() };
      } catch (error: unknown) {
        console.error('Wywolanie IPC odrzucone', error);
        return failure(
          'ipc-failed',
          'Nie udało się odczytać raportu z procesu głównego. Spróbuj ponownie.',
        );
      }
    });
    if (!response.ok) return response;
    if (!isReport(response.value)) {
      return failure('bad-response', 'Raport diagnostyczny ma nieoczekiwany format.');
    }
    return { ok: true, value: response.value };
  }

  /** Kanaly z ADR 0030. Ich handlery moga jeszcze nie istniec: odrzucenie daje komunikat, nie wyjatek. */
  rebuildIndexPlan(): Promise<RebuildIndexPlanResult> {
    return callBridge((bridge) => rebuildBridge(bridge).rebuildIndexPlan());
  }

  rebuildIndexApply(planId: string): Promise<RebuildIndexApplyResult> {
    return callBridge((bridge) =>
      rebuildBridge(bridge).rebuildIndexApply({ planId, confirmed: true }),
    );
  }
}

interface RebuildBridge {
  rebuildIndexPlan: () => Promise<unknown>;
  rebuildIndexApply: (request: { planId: string; confirmed: true }) => Promise<unknown>;
}

function rebuildBridge(bridge: BridgeSurface): RebuildBridge {
  const diagnostics = bridge.diagnostics as unknown as Partial<RebuildBridge>;
  if (
    typeof diagnostics.rebuildIndexPlan !== 'function' ||
    typeof diagnostics.rebuildIndexApply !== 'function'
  ) {
    throw new Error('Kanaly odbudowy indeksu nie sa dostepne w tej wersji procesu glownego.');
  }
  return diagnostics as RebuildBridge;
}
