import type { Result } from './library-contract';

/**
 * Opcjonalne wersjonowanie biblioteki w lokalnym repozytorium Git (ADR 0060). Dwa kanaly: odczyt
 * stanu i zapis ustawien. Zaden nie przyjmuje sciezki, adresu ani komunikatu commita: repozytorium
 * lezy w `userData`, a temat commita buduje main.
 */
export interface VersioningSettingsDto {
  /** Po kazdej operacji zapisujacej biblioteke powstaje commit. */
  enabled: boolean;
  /** Zgoda na elementy spoza zakresu `public`. Elementy z wykrytymi sekretami nie wchodza nigdy. */
  includePrivate: boolean;
}

export interface VersioningStateDto extends VersioningSettingsDto {
  /** `git` jest uruchamialny w tym systemie. */
  available: boolean;
  /** Stały komunikat po polsku, gdy `available` jest `false`; bez sciezek. */
  unavailableMessage: string | null;
  /** Repozytorium istnieje na dysku (takze po wylaczeniu funkcji). */
  repository: boolean;
  commits: number;
  lastCommitAt: string | null;
  lastCommitSubject: string | null;
  /** Elementy, ktore wchodza do historii, i wykluczone (prywatne, z sekretami, nieczytelne). */
  itemsIncluded: number;
  itemsExcludedPrivate: number;
  itemsExcludedSecrets: number;
  itemsExcludedUnreadable: number;
  /** Ostatnia awaria gita w tej sesji albo `null`; biblioteka dziala niezaleznie od niej. */
  warning: string | null;
}

export type VersioningStateResult = Result<VersioningStateDto>;
