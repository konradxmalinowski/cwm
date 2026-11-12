import { ID_NAME_PATTERN } from './kinds';

/** Nazwy zajete przez silnik w profilu (skille zsynchronizowane z claude.ai) - IMP-10, PRF-02. */
export const RESERVED_RESOURCE_NAMES: readonly string[] = ['synced'];

export type NameResult =
  | { readonly ok: true; readonly name: string; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Nazwa z dysku -> segment nazwy w id zasobu: NFC, male litery, znaki spoza `[a-z0-9._-]` zamienione
 * na `-`. Zmiana jest jawna (`changed`), a kolizje po normalizacji wykrywa wywolujacy: na macOS
 * `Foo` i `foo` to ten sam katalog, wiec nie moga trafic do rejestru jako dwa zasoby.
 */
export function normalizeResourceName(raw: string): NameResult {
  const lowered = raw.normalize('NFC').toLowerCase();
  const name = lowered
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-.]+$/, '');
  if (name === '') return { ok: false, reason: 'Nazwa nie zawiera zadnych dopuszczalnych znakow.' };
  if (!ID_NAME_PATTERN.test(name)) {
    return { ok: false, reason: 'Nazwa po normalizacji nie pasuje do wzorca id (do 63 znakow).' };
  }
  if (RESERVED_RESOURCE_NAMES.includes(name)) {
    return { ok: false, reason: `Nazwa "${name}" jest zarezerwowana przez silnik.` };
  }
  return { ok: true, name, changed: name !== raw };
}
