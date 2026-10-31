/**
 * Wspolny zbior przyczyn awarii magazynow (LibraryStore, ObjectStore). Core nie zna klas bledow
 * infra, wiec infra ustawia pole `failureCode` na rzucanym bledzie, a serwis zamienia je na komunikat.
 */
export const STORE_FAILURE_CODES = [
  'no-space',
  'permission-denied',
  'busy',
  'symlink',
  'path-too-deep',
  'not-a-file',
  'too-large',
  'invalid-path',
  'unknown',
] as const;
export type StoreFailureCode = (typeof STORE_FAILURE_CODES)[number];

export interface CodedStoreError extends Error {
  readonly failureCode: StoreFailureCode;
}

export function failureCodeOf(error: unknown): StoreFailureCode {
  if (typeof error === 'object' && error !== null && 'failureCode' in error) {
    const { failureCode } = error;
    if (STORE_FAILURE_CODES.includes(failureCode as StoreFailureCode)) {
      return failureCode as StoreFailureCode;
    }
  }
  return 'unknown';
}

/** Tekst dla uzytkownika, bez sciezek (renderer nigdy ich nie dostaje). */
export const STORE_FAILURE_TEXT: Record<StoreFailureCode, string> = {
  'no-space': 'brak miejsca na dysku',
  'permission-denied': 'brak uprawnień do pliku lub katalogu',
  busy: 'plik jest zajęty przez inny program',
  symlink: 'w katalogu elementu jest dowiązanie symboliczne',
  'path-too-deep': 'drzewo plików elementu jest zbyt głębokie',
  'not-a-file': 'w miejscu pliku jest katalog albo inny wpis specjalny',
  'too-large': 'plik lub element przekracza dozwolony rozmiar',
  'invalid-path': 'nazwa lub ścieżka pliku jest niedozwolona',
  unknown: 'nieznana przyczyna',
};
