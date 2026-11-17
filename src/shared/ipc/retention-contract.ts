import type { Result } from './library-contract';

/**
 * Retencja historii i content store (ADR 0056). Cztery kanaly: odczyt i zapis ustawien oraz
 * podglad i wykonanie czyszczenia. Zaden nie przyjmuje sciezki ani listy hashy: main sam zna
 * `userData` i sam wylicza, co jest osiagalne.
 */
export interface RetentionSettingsDto {
  /** Najwiecej wpisow historii; `null` = bez limitu. */
  maxEntries: number | null;
  /** Wpisy starsze niz tyle dni sa przycinane; `null` = bez limitu. */
  maxAgeDays: number | null;
  /** Gorna granica rozmiaru osiagalnych obiektow w MiB; `null` = bez limitu. */
  maxStoreMiB: number | null;
}

export interface RetentionReportDto {
  /** `false` w podgladzie. */
  applied: boolean;
  /** Powod, dla ktorego main niczego nie ruszyl, bo nie potrafi wykazac osiagalnosci obiektow. */
  blocked: 'library-unreadable' | 'object-unreadable' | null;
  entriesBefore: number;
  /** W podgladzie: ile wpisow zostanie usunietych. Po wykonaniu: ile usunieto. */
  entriesRemoved: number;
  objectsBefore: number;
  objectsRemoved: number;
  bytesBefore: number;
  bytesFreed: number;
  /** Limit rozmiaru nie jest osiagalny, bo reszta jest chroniona. */
  sizeLimitUnmet: boolean;
  /** Pliki, ktorych nie udalo sie usunac; zostana posprzatane w nastepnym przebiegu. */
  objectsFailed: number;
  objectsSkipped: number;
}

export interface RetentionApplyRequest {
  /** Jawne potwierdzenie, ze wpisy i obiekty znikaja bez mozliwosci odzyskania. */
  confirmed: true;
}

export type RetentionSettingsResult = Result<RetentionSettingsDto>;
export type RetentionReportResult = Result<RetentionReportDto>;
