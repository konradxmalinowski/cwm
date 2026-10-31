import { ITEM_KINDS } from '../../../core/model/item';
import { isItemId } from '../../../core/ports/id-generator';
import type {
  ItemDraftDto,
  ItemKindDto,
  LibraryDeleteApplyRequest,
  LibraryDeletePlanRequest,
  LibraryGetRequest,
  LibraryListRequest,
  LibraryRepairRequest,
  LibrarySaveRequest,
  RepairAction,
} from '../../../shared/ipc/library-contract';

/**
 * Walidacja ladunkow z renderera (ARCHITECTURE 7.2, regula 2). Renderer jest niezaufany, wiec
 * kazdy parser buduje wynik z wybranych pol zamiast przepuszczac obiekt dalej: nieznane
 * pola przepadaja, a mass assignment jest niemozliwy z konstrukcji.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const BAD_SHAPE = 'Nieprawidłowe żądanie.';
const SCOPES = ['public', 'private', 'project'] as const;
const REPAIR_ACTIONS: readonly RepairAction[] = ['adopt-disk', 'restore-version'];
/** Limit na pola krotkie. Limity tresci (body, assety) egzekwuje rdzen. */
const MAX_SHORT_FIELD = 512;
const MAX_QUERY = 256;
const MAX_TOKEN = 128;

function fail<T>(field?: string): Parsed<T> {
  return {
    ok: false,
    message: field === undefined ? BAD_SHAPE : `${BAD_SHAPE} Pole „${field}” jest niepoprawne.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is ItemKindDto {
  return typeof value === 'string' && (ITEM_KINDS as readonly string[]).includes(value);
}

export function parseListRequest(payload: unknown): Parsed<LibraryListRequest> {
  // Brak ladunku to lista bez filtrow.
  if (payload === undefined || payload === null) return { ok: true, value: {} };
  if (!isRecord(payload)) return fail();

  const result: LibraryListRequest = {};
  const { query, kind } = payload;
  if (query !== undefined) {
    if (typeof query !== 'string' || query.length > MAX_QUERY) return fail('query');
    result.query = query;
  }
  if (kind !== undefined) {
    if (!isKind(kind)) return fail('kind');
    result.kind = kind;
  }
  return { ok: true, value: result };
}

function parseId(payload: unknown): Parsed<string> {
  if (!isRecord(payload)) return fail();
  const { id } = payload;
  if (!isItemId(id)) return fail('id');
  return { ok: true, value: id };
}

export function parseGetRequest(payload: unknown): Parsed<LibraryGetRequest> {
  const id = parseId(payload);
  return id.ok ? { ok: true, value: { id: id.value } } : id;
}

export function parseDeletePlanRequest(payload: unknown): Parsed<LibraryDeletePlanRequest> {
  return parseGetRequest(payload);
}

export function parseDeleteApplyRequest(payload: unknown): Parsed<LibraryDeleteApplyRequest> {
  if (!isRecord(payload)) return fail();
  const { token, acknowledgeUnrecoverable } = payload;
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN) {
    return fail('token');
  }
  if (acknowledgeUnrecoverable !== undefined && typeof acknowledgeUnrecoverable !== 'boolean') {
    return fail('acknowledgeUnrecoverable');
  }
  return {
    ok: true,
    value: acknowledgeUnrecoverable === undefined ? { token } : { token, acknowledgeUnrecoverable },
  };
}

export function parseRepairRequest(payload: unknown): Parsed<LibraryRepairRequest> {
  const id = parseId(payload);
  if (!id.ok) return id;
  const { action } = payload as Record<string, unknown>;
  if (typeof action !== 'string' || !(REPAIR_ACTIONS as readonly string[]).includes(action)) {
    return fail('action');
  }
  return { ok: true, value: { id: id.value, action: action as RepairAction } };
}

function parseDraft(value: unknown): Parsed<ItemDraftDto> {
  if (!isRecord(value)) return fail('draft');
  const { kind, slug, declaredName, title, description, body, scope } = value;

  if (!isKind(kind)) return fail('draft.kind');
  if (typeof slug !== 'string' || slug.length > MAX_SHORT_FIELD) return fail('draft.slug');
  if (typeof title !== 'string' || title.length > MAX_SHORT_FIELD) return fail('draft.title');
  // Opis i tresc moga byc dlugie, ich rozmiar sprawdza rdzen (limit-exceeded).
  if (typeof description !== 'string') return fail('draft.description');
  if (typeof body !== 'string') return fail('draft.body');

  const draft: ItemDraftDto = { kind, slug, title, description, body };
  if (declaredName !== undefined) {
    if (
      declaredName !== null &&
      (typeof declaredName !== 'string' || declaredName.length > MAX_SHORT_FIELD)
    ) {
      return fail('draft.declaredName');
    }
    draft.declaredName = declaredName;
  }
  if (scope !== undefined) {
    if (typeof scope !== 'string' || !(SCOPES as readonly string[]).includes(scope)) {
      return fail('draft.scope');
    }
    draft.scope = scope as (typeof SCOPES)[number];
  }
  return { ok: true, value: draft };
}

export function parseSaveRequest(payload: unknown): Parsed<LibrarySaveRequest> {
  if (!isRecord(payload)) return fail();
  const draft = parseDraft(payload['draft']);
  if (!draft.ok) return draft;

  const { id } = payload;
  if (id === undefined) return { ok: true, value: { draft: draft.value } };
  if (!isItemId(id)) return fail('id');
  return { ok: true, value: { id, draft: draft.value } };
}
