import type { RetentionApplyRequest } from '../../../shared/ipc/retention-contract';

export type RetentionApplyParsed =
  { ok: true; value: { confirmed: boolean } } | { ok: false; message: string };

/**
 * Wykonanie czyszczenia nie przyjmuje niczego poza potwierdzeniem (ADR 0056): parser buduje wynik
 * z jednego pola, wiec `hashes`, `path` czy `seqs` z renderera nigdzie nie docieraja. `confirmed`
 * zostaje boolem, zeby brak potwierdzenia dal osobny, czytelny blad.
 */
export function parseRetentionApplyRequest(payload: unknown): RetentionApplyParsed {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: 'Nieprawidłowe żądanie.' };
  }
  const { confirmed } = payload as Partial<Record<keyof RetentionApplyRequest, unknown>>;
  return { ok: true, value: { confirmed: confirmed === true } };
}
