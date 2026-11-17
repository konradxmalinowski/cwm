/**
 * Polityka retencji historii i content store (ADR 0056). Kazdy limit jest opcjonalny: `null`
 * znaczy "bez limitu", a komplet `null` to zachowanie sprzed tej zmiany (store rosnie monotonicznie).
 */
export interface RetentionSettings {
  /** Najwiecej wpisow historii (grup operacji); starsze ponad limit sa przycinane. */
  readonly maxEntries: number | null;
  /** Wpisy starsze niz tyle dni sa przycinane. Dotyczy wpisow, nigdy samych obiektow. */
  readonly maxAgeDays: number | null;
  /** Gorna granica rozmiaru obiektow osiagalnych z zachowanych wpisow i biblioteki, w MiB. */
  readonly maxStoreMiB: number | null;
}

export const NO_RETENTION_LIMITS: RetentionSettings = {
  maxEntries: null,
  maxAgeDays: null,
  maxStoreMiB: null,
};

export const RETENTION_BOUNDS = {
  maxEntries: { min: 10, max: 1_000_000 },
  maxAgeDays: { min: 1, max: 3650 },
  maxStoreMiB: { min: 16, max: 1_048_576 },
} as const;

export const RETENTION_FIELD_LABEL: Readonly<Record<keyof RetentionSettings, string>> = {
  maxEntries: 'Liczba wpisów historii',
  maxAgeDays: 'Wiek wpisu w dniach',
  maxStoreMiB: 'Rozmiar content store w MiB',
};

export type RetentionParse =
  | { readonly ok: true; readonly value: RetentionSettings }
  | { readonly ok: false; readonly message: string };

/**
 * Walidacja niezaufanego wejscia (IPC albo plik na dysku). Wynik budowany jest z trzech znanych
 * pol, wiec inne klucze nigdzie nie docieraja. Liczba spoza zakresu jest bledem, nie jest przycinana.
 */
export function parseRetentionSettings(raw: unknown): RetentionParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'Nieprawidłowe ustawienia retencji.' };
  }
  const record = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof RetentionSettings]: RetentionSettings[K] } = {
    maxEntries: null,
    maxAgeDays: null,
    maxStoreMiB: null,
  };
  for (const field of ['maxEntries', 'maxAgeDays', 'maxStoreMiB'] as const) {
    const value = record[field];
    if (value === null || value === undefined) continue;
    const { min, max } = RETENTION_BOUNDS[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return {
        ok: false,
        message: `Pole „${RETENTION_FIELD_LABEL[field]}” musi być liczbą całkowitą od ${min} do ${max} albo puste.`,
      };
    }
    out[field] = value;
  }
  return { ok: true, value: out };
}

export function hasRetentionLimits(settings: RetentionSettings): boolean {
  return (
    settings.maxEntries !== null || settings.maxAgeDays !== null || settings.maxStoreMiB !== null
  );
}

/** Dlaczego przebieg nie rusza niczego: nie da sie wykazac, ktore obiekty sa osiagalne. */
export type RetentionBlockReason = 'library-unreadable' | 'object-unreadable';

/** Wynik przebiegu: podgladu (`applied: false`) albo wykonanego czyszczenia. */
export interface RetentionReport {
  readonly applied: boolean;
  readonly blocked: RetentionBlockReason | null;
  readonly entriesBefore: number;
  /** W podgladzie: ile wpisow zostanie usunietych. Po wykonaniu: ile usunieto. */
  readonly entriesRemoved: number;
  readonly objectsBefore: number;
  /** Jak wyzej, dla obiektow content store. */
  readonly objectsRemoved: number;
  readonly bytesBefore: number;
  /** Jak wyzej, dla zwolnionych bajtow. */
  readonly bytesFreed: number;
  /** Limit rozmiaru nie zostal osiagniety, bo reszta jest chroniona (biblioteka, ostatnie cofniecie). */
  readonly sizeLimitUnmet: boolean;
  /** Pliki, ktorych nie dalo sie usunac przy wykonaniu; zostana posprzatane w nastepnym przebiegu. */
  readonly objectsFailed: number;
  /** Wpisy w katalogu store, ktorych nie ruszamy (dowiazania, nie-pliki). */
  readonly objectsSkipped: number;
}
