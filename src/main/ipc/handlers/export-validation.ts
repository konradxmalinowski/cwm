import { TOOL_IDS } from '../../../core/model/item';
import type { ExportApplyRequest, ExportPlanRequest } from '../../../shared/ipc/export-contract';
import type { ToolIdDto } from '../../../shared/ipc/import-contract';
import type { Parsed } from './library-validation';

/** Walidacja ladunkow `export:*` (ARCHITECTURE 7.2, regula 2). Zadne pole nie niesie sciezki. */

const BAD_SHAPE = 'Nieprawidłowe żądanie.';
const MAX_ID = 128;
const MAX_ITEMS = 500;

function fail<T>(field?: string): Parsed<T> {
  return {
    ok: false,
    message: field === undefined ? BAD_SHAPE : `${BAD_SHAPE} Pole „${field}” jest niepoprawne.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePlanRequest(payload: unknown): Parsed<ExportPlanRequest> {
  if (!isRecord(payload)) return fail();
  const { tool } = payload;
  if (typeof tool !== 'string' || !(TOOL_IDS as readonly string[]).includes(tool)) {
    return fail('tool');
  }
  const raw = payload['itemIds'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) return fail('itemIds');
  const itemIds: string[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_ID) {
      return fail('itemIds');
    }
    itemIds.push(entry);
  }
  return { ok: true, value: { tool: tool as ToolIdDto, itemIds } };
}

export function parseExportApplyRequest(payload: unknown): Parsed<ExportApplyRequest> {
  if (!isRecord(payload)) return fail();
  const { planId, approved } = payload;
  if (typeof planId !== 'string' || planId.length === 0 || planId.length > MAX_ID) {
    return fail('planId');
  }
  if (approved !== true) return fail('approved');
  return { ok: true, value: { planId, approved } };
}
