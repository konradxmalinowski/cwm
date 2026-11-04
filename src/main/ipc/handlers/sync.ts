import { LibraryError } from '../../../core/model/library-errors';
import { ExportError } from '../../../core/services/export/export-service';
import { HistoryError, type HistoryService } from '../../../core/services/history/history-service';
import { SyncError, type SyncService } from '../../../core/services/sync/sync-service';
import type { Result } from '../../../shared/ipc/library-contract';
import type {
  HistoryListDto,
  HistoryRollbackDto,
  SyncApplyDto,
  SyncPlanDto,
  SyncStatusDto,
} from '../../../shared/ipc/sync-contract';
import type { IpcRegistry } from '../registry';
import { toPlanDto } from './export';
import type { Parsed } from './library-validation';
import {
  parseHistoryListRequest,
  parseRollbackRequest,
  parseStatusRequest,
  parseSyncApplyRequest,
  parseSyncPlanRequest,
} from './sync-validation';

const UNAVAILABLE_MESSAGE =
  'Synchronizacja jest niedostępna: biblioteka lub zapis do narzędzi nie zostały przygotowane. Uruchom aplikację ponownie.';
const INTERNAL_MESSAGE =
  'Wystąpił nieoczekiwany błąd synchronizacji. Szczegóły są w logu aplikacji.';

export interface SyncHandlerDeps {
  readonly sync: () => SyncService | null;
  readonly history: () => HistoryService | null;
  readonly logUnexpected?: (error: unknown) => void;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/** Odpowiedz budowana jawnie: `cause`, stos i sciezki nie wychodza. */
function mapError(error: unknown, logUnexpected: (e: unknown) => void): Result<never> {
  if (error instanceof SyncError || error instanceof HistoryError || error instanceof ExportError) {
    return err(error.code, error.message);
  }
  if (error instanceof LibraryError) return err(error.reason, error.message);
  logUnexpected(error);
  return err('internal', INTERNAL_MESSAGE);
}

export function registerSyncHandlers(registry: IpcRegistry, deps: SyncHandlerDeps): void {
  const logUnexpected = deps.logUnexpected ?? ((): void => undefined);

  function guarded<P, S, T>(
    service: () => S | null,
    parse: (payload: unknown) => Parsed<P>,
    run: (service: S, request: P) => Promise<Result<T>>,
  ): (payload: unknown) => Promise<Result<T>> {
    return async (payload) => {
      const parsed = parse(payload);
      if (!parsed.ok) return err('invalid-request', parsed.message);
      const target = service();
      if (target === null) return err('sync-unavailable', UNAVAILABLE_MESSAGE);
      try {
        return await run(target, parsed.value);
      } catch (error: unknown) {
        return mapError(error, logUnexpected);
      }
    };
  }

  registry.register(
    'sync:status',
    guarded(deps.sync, parseStatusRequest, async (service, request) => {
      const report = await service.status(request.tools);
      const value: SyncStatusDto = {
        missingTools: [...report.missingTools],
        items: report.items.map((i) => ({
          itemId: i.itemId,
          kind: i.kind,
          slug: i.slug,
          title: i.title,
          tool: i.tool,
          status: i.status,
          lastSyncedAt: i.lastSyncedAt,
          materialization: i.materialization,
        })),
        orphans: report.orphans.map((o) => ({
          tool: o.tool,
          rootLabel: o.rootLabel,
          relPath: o.relPath,
          reason: o.reason,
        })),
      };
      return ok(value);
    }),
  );

  registry.register(
    'sync:plan',
    guarded(deps.sync, parseSyncPlanRequest, async (service, request) => {
      const report = await service.plan(request.tools, request.itemIds, request.resolutions ?? []);
      const value: SyncPlanDto = {
        syncId: report.syncId,
        plans: report.plans.map(toPlanDto),
        adoptions: report.adoptions.map((a) => ({
          itemId: a.itemId,
          tool: a.tool,
          title: a.title,
          before: a.before,
          after: a.after,
        })),
        skipped: report.skipped.map((s) => ({
          itemId: s.itemId,
          tool: s.tool,
          reason: s.reason,
        })),
        applicable: report.applicable,
      };
      return ok(value);
    }),
  );

  registry.register(
    'sync:apply',
    guarded(deps.sync, parseSyncApplyRequest, async (service, request) => {
      const report = await service.apply(request.syncId, request.approved);
      const value: SyncApplyDto = {
        syncId: report.syncId,
        results: report.results.map((r) => ({
          planId: r.planId,
          backupId: r.backupId,
          entries: r.entries.map((e) => ({
            entryId: e.entryId,
            outcome: e.outcome,
            message: e.message,
          })),
          verified: r.verified,
          rolledBack: r.rolledBack,
        })),
        adopted: report.adopted.map((a) => ({
          itemId: a.itemId,
          tool: a.tool,
          ok: a.ok,
          message: a.message,
        })),
      };
      return ok(value);
    }),
  );

  registry.register(
    'history:list',
    guarded(deps.history, parseHistoryListRequest, async (service, request) => {
      const entries = await service.list(request.limit, request.before);
      const value: HistoryListDto = {
        entries: entries.map((e) => ({
          operationId: e.operationId,
          at: e.at,
          kind: e.kind,
          tool: e.tool,
          summary: e.summary,
          itemIds: [...e.itemIds],
          revertible: e.revertible,
          revertedBy: e.revertedBy,
        })),
      };
      return ok(value);
    }),
  );

  registry.register(
    'history:rollback',
    guarded(deps.history, parseRollbackRequest, async (service, request) => {
      const value: HistoryRollbackDto = toPlanDto(await service.rollback(request.operationId));
      return ok(value);
    }),
  );
}
