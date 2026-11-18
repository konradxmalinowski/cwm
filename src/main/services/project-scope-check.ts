import type { ExportPlanReport } from '../../core/services/export/export-service';
import { scopeAllows } from '../../core/services/export/project-scope';

/**
 * Druga, niezalezna od planowania kontrola zakresu (ADR 0059). Main sprawdza gotowy plan: kazdy wpis
 * pisze do rootow celu (projektu albo katalogu globalnego), a kazdy element we wpisie moze do tego
 * celu trafic. Plan, ktory nie przechodzi, nie wychodzi do renderera, wiec nie da sie go zatwierdzic.
 */

/** Projekt, do ktorego nalezy root; `null` dla rootow globalnych. */
export type RootOwner = (rootId: string) => string | null;

export const SCOPE_VIOLATION_MESSAGE =
  'Plan zapisywałby poza wybranym celem albo przeniósł element między projektami, więc został odrzucony.';

export function planScopeViolation(report: ExportPlanReport, ownerOf: RootOwner): string | null {
  const destination = report.target.kind === 'project' ? report.target.projectId : null;
  const includeGlobal = report.target.kind === 'project' && report.target.includeGlobal;
  const bound = new Map(report.items.map((i) => [i.itemId as string, i]));
  for (const entry of report.plan.entries) {
    if (ownerOf(entry.rootId) !== destination) return SCOPE_VIOLATION_MESSAGE;
    for (const id of entry.itemIds) {
      const item = bound.get(id);
      if (
        item === undefined ||
        !scopeAllows(item.projectId, destination, includeGlobal, item.restricted)
      ) {
        return SCOPE_VIOLATION_MESSAGE;
      }
    }
  }
  return null;
}
