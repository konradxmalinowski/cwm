import type { RetentionApplyRequest } from '../../../shared/ipc/retention-contract';

export type RetentionApplyParsed =
  { ok: true; value: { confirmed: boolean; token: string } } | { ok: false; message: string };

const MAX_TOKEN = 128;

/**
 * Wykonanie czyszczenia nie przyjmuje niczego poza potwierdzeniem i tokenem z podgladu (ADR 0056):
 * parser buduje wynik z dwoch pol, wiec `hashes`, `path` czy `seqs` z renderera nigdzie nie docieraja.
 * `confirmed` zostaje boolem, zeby brak potwierdzenia dal osobny, czytelny blad.
 */
export function parseRetentionApplyRequest(payload: unknown): RetentionApplyParsed {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: 'Nieprawidłowe żądanie.' };
  }
  const { confirmed, token } = payload as Partial<Record<keyof RetentionApplyRequest, unknown>>;
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN) {
    return { ok: false, message: 'Nieprawidłowe żądanie. Pole „token” jest niepoprawne.' };
  }
  return { ok: true, value: { confirmed: confirmed === true, token } };
}
