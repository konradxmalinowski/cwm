/**
 * Wynik jednorazowego przeniesienia katalogu danych z v0.1.0 (ADR 0035).
 * - `none`: migracja niepotrzebna (nowy katalog ma dane albo nie ma starego).
 * - `migrated`: dane skopiowane.
 * - `failed`: kopia sie nie udala, stare dane nietkniete, nastepny start ponowi probe.
 * - `deferred`: starsza wersja aplikacji jest uruchomiona; kopia czekalaby na jej zapisy.
 * - `busy`: inna instancja wlasnie migruje; ta konczy prace bez komunikatu.
 * - `skipped`: uzytkownik wybral start z pusta biblioteka; migracja nie jest ponawiana.
 */
export type DataMigrationOutcome = 'none' | 'migrated' | 'failed' | 'deferred' | 'busy' | 'skipped';

export interface DataMigrationInfo {
  readonly outcome: DataMigrationOutcome;
  /** Przy `migrated`: nazwa (bez sciezki) katalogu v0.1.0, z ktorego skopiowano dane. */
  readonly source?: string;
  /** Przy `failed`: sam kod bledu systemu plikow (np. `EACCES`), bez sciezek. */
  readonly errorCode?: string;
  /** Przy `failed` i `deferred`: powod po polsku, bez sciezek. */
  readonly message?: string;
}
