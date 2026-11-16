import type { Result } from './library-contract';

/**
 * Reczna odbudowa indeksu z Diagnostyki (ADR 0030). Dwa kanaly: plan i zastosowanie.
 * Zaden nie przyjmuje sciezki; main sam zna `userData` i nazwe pliku indeksu.
 */
export interface RebuildIndexPlanDto {
  planId: string;
  /** Nazwa pliku, pod ktora obecny indeks trafi do kwarantanny (bez katalogu). */
  quarantineName: string;
  /** Liczba elementow znalezionych w bibliotece do odtworzenia. */
  itemsToRestore: number;
  /** Czego odbudowa nie odzyska, po polsku (np. wpisy logu operacji, stan synchronizacji). */
  notRecoverable: string[];
  /** Obecny stan indeksu, np. odmowa przez schemat z przyszlosci (ADR 0029). */
  currentOutcome: 'ready' | 'rebuilt' | 'refused';
  currentReason: string | null;
  recoverability: 'recoverable' | 'blocked';
  blockedReason: string | null;
}

export interface RebuildIndexApplyRequest {
  planId: string;
  /** Jawne potwierdzenie utraty tego, co wymienia `notRecoverable`. */
  confirmed: true;
}

export interface RebuildIndexReportDto {
  quarantineName: string;
  restoredItems: number;
  /** Elementy, ktorych pliki nie daly sie wczytac; nie sa sukcesem. */
  failedItems: { id: string; reason: string }[];
  notRecoverable: string[];
}

export type RebuildIndexPlanResult = Result<RebuildIndexPlanDto>;
export type RebuildIndexApplyResult = Result<RebuildIndexReportDto>;

/**
 * Eksport raportu do zgloszenia bledu (ADR 0053). Dwa kanaly: podglad i zapis. Renderer nie
 * przekazuje ani tresci, ani sciezki: zapis bierze to, co main wczesniej pokazal w podgladzie,
 * po `previewId`, a plik wybiera main przez systemowe okno zapisu.
 */
export interface ReportPreviewDto {
  /** Jednorazowy identyfikator podgladu zywy w main przez kilka minut. */
  previewId: string;
  /** Pelna tresc raportu po redakcji: dokladnie to trafi do pliku. */
  text: string;
  /** Proponowana nazwa pliku bez katalogu. */
  fileName: string;
  lineCount: number;
  logLineCount: number;
}

export interface ReportSaveRequest {
  previewId: string;
}

export type ReportSaveDto = { status: 'saved'; fileName: string } | { status: 'cancelled' };

export type ReportPreviewResult = Result<ReportPreviewDto>;
export type ReportSaveResult = Result<ReportSaveDto>;
