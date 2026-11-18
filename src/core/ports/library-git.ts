import type { LibraryGitOperation, LibraryGitSettings } from '../model/library-git';

/** Ustawienia wersjonowania biblioteki. Brak pliku albo plik nieczytelny daje wylaczone wersjonowanie. */
export interface LibraryGitSettingsStore {
  load(): Promise<LibraryGitSettings>;
  save(settings: LibraryGitSettings): Promise<void>;
}

export type LibraryGitAvailability =
  { readonly available: true } | { readonly available: false; readonly message: string };

export interface LibraryGitStatus {
  /** Repozytorium istnieje na dysku (takze po wylaczeniu funkcji: wylaczenie go nie usuwa). */
  readonly repository: boolean;
  readonly commits: number;
  /** ISO 8601 i temat ostatniego commita albo `null` bez commitow. */
  readonly last: { readonly at: string; readonly subject: string } | null;
  /** Elementy biblioteki z podzialem na te, ktore wchodza do historii, i wykluczone. */
  readonly items: {
    readonly included: number;
    readonly excludedPrivate: number;
    readonly excludedSecrets: number;
    readonly excludedGitEntry: number;
    readonly excludedUnreadable: number;
  };
}

export type LibraryGitSyncResult =
  | {
      readonly ok: true;
      readonly committed: boolean;
      readonly items: number;
      /** Blokada zapisu byla zajeta: nic nie zrobiono, a nastepna synchronizacja nadrobi zmiany. */
      readonly skipped?: true;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Lokalne repozytorium Git katalogu biblioteki (ADR 0060). Kazda metoda zwraca wynik zamiast
 * rzucac: awaria gita nie moze przerwac operacji na bibliotece, wiec wolajacy dostaje komunikat
 * do ostrzezenia, nie wyjatek.
 */
export interface LibraryGit {
  probe(): Promise<LibraryGitAvailability>;
  /**
   * `scanItems: false` pomija odczyt elementow (wersjonowanie wylaczone): liczniki sa zerowe, a repozytorium
   * jest czytane tylko po liczbe i ostatni commit.
   */
  status(includePrivate: boolean, scanItems: boolean): Promise<LibraryGitStatus>;
  /**
   * Doprowadza repozytorium do stanu biblioteki: dodaje i usuwa z indeksu elementy zgodnie z zasada
   * wykluczen, a gdy cos sie zmienilo, tworzy jeden commit. Bez zmian nie tworzy niczego.
   */
  sync(input: {
    readonly operation: LibraryGitOperation;
    readonly includePrivate: boolean;
    /**
     * Blokada zapisu na czas skanu i stagingu (nie commita). `null` oznacza zajeta blokade: synchronizacja
     * konczy sie `skipped`. Brak pola to brak blokady.
     */
    readonly guard?: () => (() => void) | null;
  }): Promise<LibraryGitSyncResult>;
}
