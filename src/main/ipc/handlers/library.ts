import { randomBytes } from 'node:crypto';

import type { ItemDraft, LibraryItem, LoadedItem } from '../../../core/model/item';
import { LibraryError, LibraryValidationError } from '../../../core/model/library-errors';
import type { LibraryWarning } from '../../../core/model/library-errors';
import { STORE_FAILURE_TEXT } from '../../../core/ports/store-failure';
import type {
  DeletePlan,
  ListResult,
  LibraryService,
  MutationResult,
} from '../../../core/services/library/library-service';
import type {
  DeletePlanDto,
  InconsistentDto,
  ItemDetailDto,
  ItemDraftDto,
  ItemKindDto,
  ItemSummaryDto,
  LibraryDeleteApplyDto,
  LibraryListDto,
  LibrarySaveDto,
  Result,
  WarningDto,
} from '../../../shared/ipc/library-contract';
import type { IpcRegistry } from '../registry';
import {
  parseDeleteApplyRequest,
  parseDeletePlanRequest,
  parseGetRequest,
  parseListRequest,
  parseRepairRequest,
  parseSaveRequest,
  type Parsed,
} from './library-validation';

export const DELETE_PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PLANS = 64;

const UNAVAILABLE_MESSAGE =
  'Biblioteka jest niedostępna: nie udało się przygotować jej katalogu. Sprawdź uprawnienia katalogu danych aplikacji i uruchom ją ponownie.';
const INTERNAL_MESSAGE = 'Wystąpił nieoczekiwany błąd biblioteki. Szczegóły są w logu aplikacji.';

export interface LibraryHandlerDeps {
  /** `null`, gdy katalogu biblioteki nie dalo sie utworzyc: kanaly odpowiadaja bledem, aplikacja dziala. */
  readonly service: () => LibraryService | null;
  readonly now?: () => number;
  /** Token planu usuniecia; domyslnie losowy, z crypto. */
  readonly newToken?: () => string;
  /** Szew na log bledow nieoczekiwanych (bez tresci zadania). */
  readonly logUnexpected?: (error: unknown) => void;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

function invalid<T>(parsed: Extract<Parsed<T>, { ok: false }>): Result<never> {
  return err('invalid-request', parsed.message);
}

/** Buduje odpowiedz z `reason` i `message`; `cause`, stos i `detail` zostaja w main. */
function mapError(error: unknown, logUnexpected: (e: unknown) => void): Result<never> {
  if (error instanceof LibraryValidationError) {
    const messages = [...new Set(error.issues.map((issue) => issue.message))];
    return err(error.reason, messages.join(' '));
  }
  if (error instanceof LibraryError) return err(error.reason, error.message);
  logUnexpected(error);
  return err('internal', INTERNAL_MESSAGE);
}

function warningsDto(warnings: readonly LibraryWarning[]): WarningDto[] {
  return warnings.map((w) => ({ code: w.code, message: w.message }));
}

export function toDetailDto(item: LibraryItem): ItemDetailDto {
  return {
    id: item.id,
    kind: item.kind,
    identity: {
      slug: item.identity.slug,
      declaredName: item.identity.declaredName,
      aliases: [...item.identity.aliases],
    },
    content: {
      title: item.content.title,
      description: item.content.description,
      descriptionOrigin: item.content.descriptionOrigin,
      body: item.content.body,
    },
    scope: item.classification.scope,
    assets: item.assets.map((a) => ({ relPath: a.relPath, size: a.sizeBytes })),
    // Tylko nazwa narzedzia: `importedFrom.path` jest sciezka bezwzgledna (regula 4).
    importedFromTool: item.source.importedFrom?.tool ?? null,
    revision: item.version.revision,
    updatedAt: item.version.updatedAt,
  };
}

function toSummaryDto(item: LibraryItem): ItemSummaryDto {
  return {
    id: item.id,
    kind: item.kind,
    slug: item.identity.slug,
    title: item.content.title,
    description: item.content.description,
    revision: item.version.revision,
    updatedAt: item.version.updatedAt,
  };
}

function matchesQuery(item: LibraryItem, needle: string): boolean {
  return [item.identity.slug, item.content.title, item.content.description, item.content.body].some(
    (field) => field.toLowerCase().includes(needle),
  );
}

export function toListDto(
  result: ListResult,
  query: string | undefined,
  kind?: ItemKindDto,
): LibraryListDto {
  const needle = query?.trim().toLowerCase() ?? '';
  const items = result.items
    .filter((item) => kind === undefined || item.kind === kind)
    .filter((item) => needle.length === 0 || matchesQuery(item, needle))
    .map(toSummaryDto);

  const inconsistent: InconsistentDto[] = result.inconsistent.map((entry) => ({
    id: entry.id,
    slug: entry.slug,
    kind: entry.kind,
    files: entry.files.map((f) => ({ path: f.path, problem: f.problem })),
  }));
  const problems = result.problems.map((p) => ({ id: p.id, reason: p.reason, message: p.message }));
  return { items, problems, inconsistent };
}

function toSaveDto(result: MutationResult): LibrarySaveDto {
  return { item: toDetailDto(result.item), warnings: warningsDto(result.warnings) };
}

/**
 * Szkic z renderera nie niesie aliasow, atrybutow ani pol, ktorych UI nie edytuje. Przy
 * aktualizacji dziedziczymy je z zapisanego elementu, inaczej zapis z formularza kasowalby je po cichu.
 */
export function toItemDraft(dto: ItemDraftDto, previous: LoadedItem | null): ItemDraft {
  const before = previous?.item ?? null;
  const declaredName =
    dto.declaredName === undefined ? (before?.identity.declaredName ?? null) : dto.declaredName;
  const descriptionOrigin =
    before !== null && before.content.description === dto.description
      ? before.content.descriptionOrigin
      : 'source';
  const scope = dto.scope ?? before?.classification.scope;

  return {
    kind: dto.kind,
    identity: { slug: dto.slug, declaredName, aliases: before?.identity.aliases ?? [] },
    content: { title: dto.title, description: dto.description, descriptionOrigin, body: dto.body },
    ...(before === null ? {} : { attributes: before.attributes }),
    ...(scope === undefined
      ? {}
      : {
          classification: {
            scope,
            secretFindings: before?.classification.secretFindings ?? [],
          },
        }),
  };
}

interface PendingPlan {
  readonly plan: DeletePlan;
  readonly expiresAt: number;
}

function toPlanDto(plan: DeletePlan, token: string): DeletePlanDto {
  const status = plan.recoverability.status;
  return {
    token,
    itemId: plan.itemId,
    kind: plan.kind,
    slug: plan.slug,
    title: plan.title,
    recoverability: status,
    unrecoverable: plan.unrecoverable.map((entry) => ({
      path: entry.relPath,
      reason: `Tego pliku nie da się zachować w kopii: ${STORE_FAILURE_TEXT[entry.failure]}.`,
    })),
    blockedReason: status === 'blocked' ? plan.recoverability.reason : null,
  };
}

export function registerLibraryHandlers(registry: IpcRegistry, deps: LibraryHandlerDeps): void {
  const now = deps.now ?? Date.now;
  const newToken = deps.newToken ?? ((): string => randomBytes(24).toString('base64url'));
  const logUnexpected = deps.logUnexpected ?? ((): void => undefined);
  // Plany zyja tylko w main: renderer dostaje DTO z tokenem, a `apply` bierze plan stad.
  const plans = new Map<string, PendingPlan>();

  function purgeExpired(): void {
    const t = now();
    for (const [token, pending] of plans) {
      if (pending.expiresAt <= t) plans.delete(token);
    }
    // Mapa nie rosnie bez granic, gdy renderer planuje bez konca. Najstarsze odpadaja pierwsze.
    while (plans.size >= MAX_PENDING_PLANS) {
      const oldest = plans.keys().next();
      if (oldest.done === true) break;
      plans.delete(oldest.value);
    }
  }

  /** Wspolna oslona: niedostepna biblioteka i kazdy wyjatek koncza jako `Result`, nie rzut do renderera. */
  function guarded<P, T>(
    parse: (payload: unknown) => Parsed<P>,
    run: (service: LibraryService, request: P) => Promise<Result<T>>,
  ): (payload: unknown) => Promise<Result<T>> {
    return async (payload) => {
      const parsed = parse(payload);
      if (!parsed.ok) return invalid(parsed);
      const service = deps.service();
      if (service === null) return err('library-unavailable', UNAVAILABLE_MESSAGE);
      try {
        return await run(service, parsed.value);
      } catch (error: unknown) {
        return mapError(error, logUnexpected);
      }
    };
  }

  registry.register(
    'library:list',
    guarded(parseListRequest, async (service, request) =>
      ok(toListDto(await service.list(), request.query, request.kind)),
    ),
  );

  registry.register(
    'library:get',
    guarded(parseGetRequest, async (service, request) =>
      ok(toDetailDto((await service.get(request.id)).item)),
    ),
  );

  registry.register(
    'library:save',
    guarded(parseSaveRequest, async (service, request) => {
      if (request.id === undefined) {
        return ok(toSaveDto(await service.create(toItemDraft(request.draft, null))));
      }
      const previous = await service.get(request.id);
      return ok(toSaveDto(await service.update(request.id, toItemDraft(request.draft, previous))));
    }),
  );

  registry.register(
    'library:delete-plan',
    guarded(parseDeletePlanRequest, async (service, request) => {
      const plan = await service.planDelete(request.id);
      purgeExpired();
      const token = newToken();
      plans.set(token, { plan, expiresAt: now() + DELETE_PLAN_TTL_MS });
      return ok(toPlanDto(plan, token));
    }),
  );

  registry.register(
    'library:delete-apply',
    guarded(parseDeleteApplyRequest, async (service, request) => {
      purgeExpired();
      const pending = plans.get(request.token);
      if (pending === undefined) {
        return err(
          'plan-expired',
          'Plan usunięcia wygasł albo nie istnieje. Zaplanuj usunięcie jeszcze raz.',
        );
      }
      try {
        const result = await service.applyDelete(pending.plan, {
          acknowledgeUnrecoverable: request.acknowledgeUnrecoverable === true,
        });
        plans.delete(request.token);
        const dto: LibraryDeleteApplyDto = { warnings: warningsDto(result.warnings) };
        return ok(dto);
      } catch (error: unknown) {
        // Brak potwierdzenia da sie naprawic tym samym planem; kazdy inny blad zuzywa token.
        const retryable =
          error instanceof LibraryError && error.reason === 'unrecoverable-unacknowledged';
        if (!retryable) plans.delete(request.token);
        throw error;
      }
    }),
  );

  registry.register(
    'library:repair',
    guarded(parseRepairRequest, async (service, request) => {
      const result =
        request.action === 'adopt-disk'
          ? await service.adoptDisk(request.id)
          : await service.restoreVersion(request.id);
      return ok(toSaveDto(result));
    }),
  );
}
