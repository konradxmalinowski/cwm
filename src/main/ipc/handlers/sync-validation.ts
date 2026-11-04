import { TOOL_IDS } from '../../../core/model/item';
import type { ToolIdDto } from '../../../shared/ipc/import-contract';
import type {
  HistoryListRequest,
  HistoryRollbackRequest,
  SyncApplyRequest,
  SyncPlanRequest,
  SyncResolutionDto,
  SyncStatusRequest,
} from '../../../shared/ipc/sync-contract';
import type { Parsed } from './library-validation';

/** Walidacja ladunkow `sync:*` i `history:*` (ARCHITECTURE 7.2, regula 2). Zadne pole nie niesie sciezki. */

const BAD_SHAPE = 'Nieprawidłowe żądanie.';
const MAX_ID = 128;
const MAX_ITEMS = 500;
const MAX_RESOLUTIONS = 1000;
const RESOLUTIONS: readonly SyncResolutionDto[] = ['library-wins', 'tool-wins', 'skip'];

function fail<T>(field?: string): Parsed<T> {
  return {
    ok: false,
    message: field === undefined ? BAD_SHAPE : `${BAD_SHAPE} Pole „${field}” jest niepoprawne.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTool(value: unknown): value is ToolIdDto {
  return typeof value === 'string' && (TOOL_IDS as readonly string[]).includes(value);
}

function idOf(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;
}

function toolList(raw: unknown): ToolIdDto[] | null {
  if (!Array.isArray(raw) || raw.length > TOOL_IDS.length) return null;
  const out: ToolIdDto[] = [];
  for (const t of raw as unknown[]) {
    if (!isTool(t)) return null;
    out.push(t);
  }
  return out;
}

export function parseStatusRequest(payload: unknown): Parsed<SyncStatusRequest> {
  if (payload === undefined || payload === null) return { ok: true, value: {} };
  if (!isRecord(payload)) return fail();
  if (payload['tools'] === undefined) return { ok: true, value: {} };
  const tools = toolList(payload['tools']);
  return tools === null ? fail('tools') : { ok: true, value: { tools } };
}

export function parseSyncPlanRequest(payload: unknown): Parsed<SyncPlanRequest> {
  if (!isRecord(payload)) return fail();
  const tools = toolList(payload['tools']);
  if (tools === null || tools.length === 0) return fail('tools');
  const rawIds = payload['itemIds'];
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_ITEMS) {
    return fail('itemIds');
  }
  const itemIds: string[] = [];
  for (const id of rawIds as unknown[]) {
    if (!idOf(id)) return fail('itemIds');
    itemIds.push(id);
  }
  const resolutions: NonNullable<SyncPlanRequest['resolutions']> = [];
  const rawRes = payload['resolutions'];
  if (rawRes !== undefined) {
    if (!Array.isArray(rawRes) || rawRes.length > MAX_RESOLUTIONS) return fail('resolutions');
    for (const r of rawRes as unknown[]) {
      if (
        !isRecord(r) ||
        !idOf(r['itemId']) ||
        !isTool(r['tool']) ||
        !RESOLUTIONS.includes(r['resolution'] as SyncResolutionDto)
      ) {
        return fail('resolutions');
      }
      resolutions.push({
        itemId: r['itemId'],
        tool: r['tool'],
        resolution: r['resolution'] as SyncResolutionDto,
      });
    }
  }
  return { ok: true, value: { tools, itemIds, resolutions } };
}

export function parseSyncApplyRequest(payload: unknown): Parsed<SyncApplyRequest> {
  if (!isRecord(payload)) return fail();
  const { syncId, approved } = payload;
  if (!idOf(syncId)) return fail('syncId');
  if (approved !== true) return fail('approved');
  return { ok: true, value: { syncId, approved } };
}

export function parseHistoryListRequest(payload: unknown): Parsed<HistoryListRequest> {
  if (payload === undefined || payload === null) return { ok: true, value: {} };
  if (!isRecord(payload)) return fail();
  const value: HistoryListRequest = {};
  const { limit, before } = payload;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      return fail('limit');
    }
    value.limit = limit;
  }
  if (before !== undefined) {
    if (!idOf(before)) return fail('before');
    value.before = before;
  }
  return { ok: true, value };
}

export function parseRollbackRequest(payload: unknown): Parsed<HistoryRollbackRequest> {
  if (!isRecord(payload) || !idOf(payload['operationId'])) return fail('operationId');
  return { ok: true, value: { operationId: payload['operationId'] } };
}
