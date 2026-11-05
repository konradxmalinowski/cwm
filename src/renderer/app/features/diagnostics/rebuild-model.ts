import type {
  RebuildIndexPlanDto,
  RebuildIndexReportDto,
} from '../../../../shared/ipc/diagnostics-contract';
import { baseName, redactPaths } from '../../core/state/startup';

export type RebuildState =
  | { readonly status: 'idle' }
  | { readonly status: 'planning' }
  | { readonly status: 'plan'; readonly plan: RebuildIndexPlanDto; readonly acknowledged: boolean }
  | { readonly status: 'applying'; readonly plan: RebuildIndexPlanDto }
  | { readonly status: 'done'; readonly report: RebuildIndexReportDto }
  | { readonly status: 'error'; readonly step: 'plan' | 'apply'; readonly message: string };

export interface RebuildOutcomeView {
  /** `complete` tylko gdy wczytano co najmniej jeden element i zaden nie zawiodl. */
  readonly kind: 'complete' | 'incomplete';
  readonly label: string;
  readonly restored: string;
  readonly zeroWarning: boolean;
  readonly failed: readonly { id: string; reason: string }[];
  readonly notRecoverable: readonly string[];
  readonly quarantineName: string;
}

/**
 * Zero odtworzonych elementow i kazdy element, ktorego nie udalo sie wczytac, to wynik niepelny.
 * Odbudowa, ktora skonczyla sie bez bledu, ale nic nie wczytala, nie moze wygladac na sukces.
 */
export function describeOutcome(report: RebuildIndexReportDto): RebuildOutcomeView {
  const zero = report.restoredItems === 0;
  const failedCount = report.failedItems.length;
  const incomplete = zero || failedCount > 0;
  const restored = zero
    ? 'Nie odtworzono żadnego elementu.'
    : `Odtworzono elementów: ${report.restoredItems}.`;
  return {
    kind: incomplete ? 'incomplete' : 'complete',
    label: incomplete ? 'Odbudowa niepełna.' : 'Indeks odbudowany.',
    restored:
      failedCount > 0 ? `${restored} Nie udało się wczytać elementów: ${failedCount}.` : restored,
    zeroWarning: zero,
    failed: report.failedItems.map((entry) => ({
      id: entry.id,
      reason: redactPaths(entry.reason),
    })),
    notRecoverable: report.notRecoverable.map(redactPaths),
    quarantineName: baseName(report.quarantineName),
  };
}

export function itemsToRestoreText(count: number): string {
  return count === 0
    ? '0. W bibliotece nie znaleziono żadnego elementu do odtworzenia.'
    : String(count);
}
