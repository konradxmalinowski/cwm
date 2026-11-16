import type {
  RebuildIndexApplyRequest,
  ReportSaveRequest,
} from '../../../shared/ipc/diagnostics-contract';

const MAX_PLAN_ID = 128;

export type RebuildApplyParsed =
  { ok: true; value: { planId: string; confirmed: boolean } } | { ok: false; message: string };

/**
 * Kanaly odbudowy nie przyjmuja sciezki (ADR 0030): parser buduje wynik z dwoch pol i
 * odrzuca reszte, wiec `path`, `dbPath` czy `quarantineRoot` z renderera nigdzie nie docieraja.
 * `confirmed` zostaje boolem, zeby brak potwierdzenia dalo osobny, czytelny blad.
 */
export function parseRebuildApplyRequest(payload: unknown): RebuildApplyParsed {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: 'Nieprawidłowe żądanie.' };
  }
  const { planId, confirmed } = payload as Partial<Record<keyof RebuildIndexApplyRequest, unknown>>;
  if (typeof planId !== 'string' || planId.length === 0 || planId.length > MAX_PLAN_ID) {
    return { ok: false, message: 'Nieprawidłowe żądanie. Pole „planId” jest niepoprawne.' };
  }
  return { ok: true, value: { planId, confirmed: confirmed === true } };
}

const PREVIEW_ID = /^[A-Za-z0-9-]{1,64}$/;

export type ReportSaveParsed =
  { ok: true; value: { previewId: string } } | { ok: false; message: string };

/**
 * Zapis raportu przyjmuje tylko identyfikator podgladu. Tresc i sciezka z renderera nie docieraja
 * nigdzie: parser buduje wynik z jednego pola, wiec `text`, `path` czy `fileName` przepadaja.
 */
export function parseReportSaveRequest(payload: unknown): ReportSaveParsed {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: 'Nieprawidłowe żądanie.' };
  }
  const { previewId } = payload as Partial<Record<keyof ReportSaveRequest, unknown>>;
  if (typeof previewId !== 'string' || !PREVIEW_ID.test(previewId)) {
    return { ok: false, message: 'Nieprawidłowe żądanie. Pole „previewId” jest niepoprawne.' };
  }
  return { ok: true, value: { previewId } };
}
