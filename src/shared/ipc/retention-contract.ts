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

export type RetentionBlockedDto =
  | 'library-unreadable'
  | 'library-missing'
  | 'library-empty'
  | 'object-unreadable'
  | 'mass-prune'
  | 'empty-log'
  | 'plan-changed'
  | 'index-new'
  | 'index-rebuilt';

/** Ustawienia i powod, dla ktorego przebieg przy starcie tej sesji niczego nie zrobil (albo `null`). */
export interface RetentionStateDto extends RetentionSettingsDto {
  startupNotice: RetentionBlockedDto | null;
}

/** Zapis, ktory wlacza albo zaostrza limit, wymaga `confirmed: true` (po obejrzeniu podgladu). */
export interface RetentionSetRequest extends RetentionSettingsDto {
  confirmed?: boolean;
}

/** Bez `settings` podglad liczy na zapisanych ustawieniach. */
export interface RetentionPreviewRequest {
  settings?: RetentionSettingsDto;
}

export interface RetentionReportDto {
  /** `false` w podgladzie. */
  applied: boolean;
  /** Powod, dla ktorego main niczego nie ruszyl, bo nie potrafi wykazac osiagalnosci obiektow. */
  blocked: RetentionBlockedDto | null;
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
  /** Zegar jest przed najnowszym wpisem logu, wiec limit wieku zostal pominiety. */
  ageRuleSkipped: boolean;
  /** Tylko w podgladzie bez blokady: zezwolenie na wykonanie, wazne kilka minut, jednorazowe. */
  previewToken: string | null;
}

export interface RetentionApplyRequest {
  /** Jawne potwierdzenie, ze wpisy i obiekty znikaja bez mozliwosci odzyskania. */
  confirmed: true;
  /** Token z podgladu zapisanych ustawien; wykonanie przerywa sie, gdy plan urosl. */
  token: string;
}

export type RetentionStateResult = Result<RetentionStateDto>;
export type RetentionReportResult = Result<RetentionReportDto>;
