import type { ItemId } from '../../../core/model/item';
import { LibraryError } from '../../../core/model/library-errors';
import type { WritePlanEntry } from '../../../core/model/plan';
import {
  ExportError,
  redactPaths,
  type ExportApplyReport,
  type ExportPlanReport,
  type ExportService,
} from '../../../core/services/export/export-service';
import { redactSecrets } from '../../../core/services/security/secret-redactor';
import type { ToolId } from '../../../core/model/item';
import type { ZipPlanReport } from '../../../core/services/export/zip-export-service';
import type {
  ExportApplyDto,
  ExportPlanDto,
  ExportZipPlanDto,
  ExportZipSaveDto,
  PlanEntryDto,
} from '../../../shared/ipc/export-contract';
import type { Result } from '../../../shared/ipc/library-contract';
import type { IpcRegistry } from '../registry';
import { planScopeViolation, type RootOwner } from '../../services/project-scope-check';
import {
  parseExportApplyRequest,
  parsePlanRequest,
  parseZipPlanRequest,
  parseZipSaveRequest,
} from './export-validation';
import type { Parsed } from './library-validation';

const UNAVAILABLE_MESSAGE =
  'Eksport jest niedostępny: biblioteka lub zapis do narzędzi nie zostały przygotowane. Uruchom aplikację ponownie.';
const INTERNAL_MESSAGE = 'Wystąpił nieoczekiwany błąd eksportu. Szczegóły są w logu aplikacji.';

/** Podglad diffu tylko dla tekstu UTF-8 do tego rozmiaru; reszta idzie jako null. */
export const MAX_PREVIEW_BYTES = 256 * 1024;

/** Eksport do ZIP (ADR 0054): to, czego handler potrzebuje od main. Sciezke pliku zna tylko implementacja. */
export interface ZipPort {
  plan(
    tool: ToolId,
    itemIds: readonly string[],
    confirmedItemIds: readonly string[],
  ): Promise<ZipPlanReport>;
  save(planId: string): Promise<Result<ExportZipSaveDto>>;
}

export interface ExportHandlerDeps {
  /** `null`, gdy biblioteka albo bramka zapisu jest niedostepna: kanaly odpowiadaja bledem. */
  readonly service: () => ExportService | null;
  /** `null`, gdy eksport do ZIP nie jest przygotowany (biblioteka niedostepna): kanaly odpowiadaja bledem. */
  readonly zip?: () => ZipPort | null;
  /** Wlasciciel roota z rejestru projektow (ADR 0059); bez rejestru kazdy root jest globalny. */
  readonly rootOwner?: RootOwner;
  readonly logUnexpected?: (error: unknown) => void;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

function mapError(error: unknown, logUnexpected: (e: unknown) => void): Result<never> {
  if (error instanceof ExportError) return err(error.code, error.message);
  if (error instanceof LibraryError) return err(error.reason, error.message);
  logUnexpected(error);
  return err('internal', INTERNAL_MESSAGE);
}

/** Tekst UTF-8 bez NUL i do limitu; inaczej null (plik binarny albo zbyt duzy). */
export function previewText(bytes: Uint8Array | null): string | null {
  if (bytes === null || bytes.byteLength > MAX_PREVIEW_BYTES) return null;
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Podglad przechodzi redakcje sekretow, zanim opusci main; diff w rendererze liczy sie na wyniku. */
function redactedPreview(bytes: Uint8Array | null, relPath: string): string | null {
  const text = previewText(bytes);
  return text === null ? null : redactSecrets(text, relPath).text;
}

function toEntryDto(entry: WritePlanEntry, entryId: string, rootLabel: string): PlanEntryDto {
  const isDirectory = entry.files !== null;
  return {
    entryId,
    rootLabel,
    relPath: entry.relPath,
    action: entry.action,
    scope: entry.scope,
    materialization: entry.materialization,
    itemIds: [...entry.itemIds],
    before: isDirectory ? null : redactedPreview(entry.previous, entry.relPath),
    after: isDirectory ? null : redactedPreview(entry.content, entry.relPath),
    files: (entry.files ?? []).map((f) => f.relPath),
    recoverability: entry.recoverability?.status ?? 'blocked',
    blockedReason:
      entry.recoverability === null
        ? 'Wpis nie został sprawdzony.'
        : entry.recoverability.status === 'blocked'
          ? redactPaths(entry.recoverability.reason ?? 'Wpis jest zablokowany.')
          : null,
    warnings: entry.warnings.map(redactPaths),
  };
}

/** Odpowiedz budowana jawnie, pole po polu: bajty, `rootId` i sciezki bezwzgledne nie wychodza. */
export function toPlanDto(report: ExportPlanReport): ExportPlanDto {
  const { plan } = report;
  const byId = new Map(report.items.map((i) => [i.itemId, i]));
  const labelOf = (rootId: string): string =>
    report.rootLabels.get(rootId) ?? 'nieznana lokalizacja';
  return {
    planId: report.planId,
    tool: report.tool,
    toolMissing: report.toolMissing,
    ...(report.target.kind === 'project'
      ? { project: { projectId: report.target.projectId, name: report.target.name } }
      : {}),
    verdicts: plan.verdicts.flatMap(({ itemId, verdict }) => {
      const item = byId.get(itemId);
      if (item === undefined) return [];
      return [
        {
          itemId,
          kind: item.kind,
          slug: item.slug,
          title: item.title,
          level: verdict.level,
          reasons: [...verdict.reasons],
          lostAttributes: [...verdict.lostAttributes],
          addedAttributes: [...verdict.addedAttributes],
        },
      ];
    }),
    entries: plan.entries.map((e, i) =>
      toEntryDto(e, report.entryIds[i] ?? `e${i + 1}`, labelOf(e.rootId)),
    ),
    refusals: plan.refusals.map((r) => ({
      itemId: r.itemId,
      kind: r.kind,
      slug: r.slug,
      reason: r.reason,
    })),
    conflicts: plan.conflicts.map((c) => ({
      itemIds: [...c.itemIds],
      relPath: c.relPath,
      reason: c.reason,
      ...(c.options === undefined
        ? {}
        : { options: c.options.map((o) => ({ id: o.id, label: o.label })) }),
    })),
    orphans: plan.orphans.map((o) => ({
      rootLabel: labelOf(o.rootId),
      relPath: o.relPath,
      reason: o.reason,
    })),
    // Plan bez zmian (same `unchanged`) nic nie zapisze, wiec nie jest do zapisu.
    applicable:
      plan.applicable && !report.toolMissing && plan.entries.some((e) => e.action !== 'unchanged'),
  };
}

/** Plan archiwum to plan eksportu plus to, czego archiwum dotyczy: nazwa, liczby i elementy poza nim. */
export function toZipPlanDto(plan: ZipPlanReport): ExportZipPlanDto {
  return {
    ...toPlanDto(plan.report),
    zip: {
      fileName: plan.archive.fileName,
      fileCount: plan.archive.fileCount,
      sizeBytes: plan.archive.sizeBytes,
      held: plan.held.map((h) => ({
        itemId: h.itemId,
        kind: h.kind,
        slug: h.slug,
        title: h.title,
        reason: h.reason,
        confirmed: h.confirmed,
      })),
    },
  };
}

function toApplyDto(report: ExportApplyReport): ExportApplyDto {
  return {
    planId: report.planId,
    backupId: report.backupId,
    entries: report.entries.map((e) => ({
      entryId: e.entryId,
      outcome: e.outcome,
      message: e.message,
    })),
    verified: report.verified,
    rolledBack: report.rolledBack,
  };
}

export function registerExportHandlers(registry: IpcRegistry, deps: ExportHandlerDeps): void {
  const logUnexpected = deps.logUnexpected ?? ((): void => undefined);

  function guarded<P, T>(
    parse: (payload: unknown) => Parsed<P>,
    run: (service: ExportService, request: P) => Promise<Result<T>>,
  ): (payload: unknown) => Promise<Result<T>> {
    return async (payload) => {
      const parsed = parse(payload);
      if (!parsed.ok) return err('invalid-request', parsed.message);
      const service = deps.service();
      if (service === null) return err('export-unavailable', UNAVAILABLE_MESSAGE);
      try {
        return await run(service, parsed.value);
      } catch (error: unknown) {
        return mapError(error, logUnexpected);
      }
    };
  }

  const rootOwner: RootOwner = deps.rootOwner ?? ((): null => null);

  registry.register(
    'export:plan',
    guarded(parsePlanRequest, async (service, request) => {
      const report = await service.preview(
        request.tool,
        request.itemIds,
        (request.resolutions ?? []).map((r) => ({
          itemId: r.itemId as ItemId,
          relPath: r.relPath,
          resolution: r.resolution,
        })),
        request.projectId === undefined
          ? { kind: 'global' }
          : {
              kind: 'project',
              projectId: request.projectId,
              includeGlobal: request.includeGlobal === true,
            },
      );
      // Serwis zapamietuje plan dopiero po tej kontroli: odrzucony plan nie ma `planId` do zapisu.
      const violation = planScopeViolation(report, rootOwner);
      if (violation !== null) return err('scope-violation', violation);
      service.retain(report);
      return ok(toPlanDto(report));
    }),
  );

  registry.register(
    'export:apply',
    guarded(parseExportApplyRequest, async (service, request) =>
      ok(toApplyDto(await service.apply(request.planId, request.approved))),
    ),
  );

  function guardedZip<P, T>(
    parse: (payload: unknown) => Parsed<P>,
    run: (zip: ZipPort, request: P) => Promise<Result<T>>,
  ): (payload: unknown) => Promise<Result<T>> {
    return async (payload) => {
      const parsed = parse(payload);
      if (!parsed.ok) return err('invalid-request', parsed.message);
      const zip = deps.zip?.() ?? null;
      if (zip === null) return err('export-unavailable', UNAVAILABLE_MESSAGE);
      try {
        return await run(zip, parsed.value);
      } catch (error: unknown) {
        return mapError(error, logUnexpected);
      }
    };
  }

  registry.register(
    'export:zip-plan',
    guardedZip(parseZipPlanRequest, async (zip, request) =>
      ok(
        toZipPlanDto(await zip.plan(request.tool, request.itemIds, request.confirmedItemIds ?? [])),
      ),
    ),
  );

  // Zapis przyjmuje wylacznie `planId`: sciezke wybiera main oknem zapisu, tresc to archiwum z planu.
  registry.register(
    'export:zip-save',
    guardedZip(parseZipSaveRequest, (zip, request) => zip.save(request.planId)),
  );
}
