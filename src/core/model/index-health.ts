/**
 * Przyczyny, dla ktorych indeks moze nie dac sie otworzyc (ADR 0029).
 *
 * Rozroznienie nie jest ozdoba: dwie z tych przyczyn prowadza do odbudowy,
 * trzy do odmowy startu. Polityka reakcji siedzi w bootstrapie procesu
 * glownego, bo to decyzja produktowa, a nie szczegol dostepu do bazy.
 */
export type IndexFailureReason =
  'corrupted' | 'unknown-schema' | 'schema-from-future' | 'not-writable' | 'native-module';

export type IndexStartupOutcome = 'ready' | 'rebuilt' | 'refused';

export interface IndexStartupInfo {
  readonly outcome: IndexStartupOutcome;
  readonly reason?: IndexFailureReason;
  readonly message?: string;
  /** Zredagowana sciezka pliku odlozonego do kwarantanny, jesli byla. */
  readonly quarantinedAs?: string;
  /**
   * Ile elementow udalo sie wczytac z plikow przy odbudowie i czego nie dalo
   * sie odzyskac: elementy, ktorych nie wczytano (z powodem), oraz to, co z
   * definicji nie wraca z plikow (log operacji, stan synchronizacji).
   */
  readonly restoredItems?: number;
  readonly notRestored?: readonly string[];
}

/** Co z definicji nie wraca z plikow po odbudowie (ADR 0014, ADR 0029 punkt 3). */
export const NOT_RECOVERABLE_FROM_FILES = [
  'log operacji (nieodtwarzalny z plikow, ADR 0014)',
  'stan synchronizacji z narzedziami (nieodtwarzalny z plikow, ADR 0029)',
] as const;
