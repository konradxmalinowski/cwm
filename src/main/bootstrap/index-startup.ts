import {
  NOT_RECOVERABLE_FROM_FILES,
  type IndexFailureReason,
  type IndexStartupInfo,
} from '../../core/model/index-health';
import type { IndexStore } from '../../core/ports/index-store';

/**
 * Triaz awarii indeksu (ADR 0029 punkt 1).
 *
 * Polityka reakcji siedzi tutaj, a nie w `infra/`, bo to decyzja produktowa:
 * co zrobic z uszkodzonym indeksem uzytkownika, a nie szczegol dostepu do
 * bazy. Moduł nie importuje Electrona ani systemu plikow, wiec kazda sciezke
 * triazu da sie sprawdzic testem jednostkowym.
 */

export interface IndexOpenFailure {
  readonly reason: IndexFailureReason;
  readonly message: string;
}

export interface IndexStartupDeps {
  /** Otwiera indeks albo rzuca bledem z rozpoznana przyczyna. */
  readonly openStore: () => IndexStore;
  /** Odklada stary plik do kwarantanny albo rzuca. Zwraca zredagowana sciezke. */
  readonly quarantine: () => string;
  /** Rozpoznaje blad otwarcia. Zwraca `null`, jesli to nie jest nasz typ bledu. */
  readonly describeFailure: (error: unknown) => IndexOpenFailure | null;
}

export interface IndexStartupResult {
  readonly info: IndexStartupInfo;
  readonly store: IndexStore | null;
}

const REBUILDABLE: ReadonlySet<IndexFailureReason> = new Set<IndexFailureReason>([
  'corrupted',
  'unknown-schema',
]);

function refused(
  failure: IndexOpenFailure,
  extra?: { quarantinedAs?: string },
): IndexStartupResult {
  return {
    store: null,
    info: {
      outcome: 'refused',
      reason: failure.reason,
      message: failure.message,
      ...(extra?.quarantinedAs === undefined ? {} : { quarantinedAs: extra.quarantinedAs }),
    },
  };
}

export function startIndex(deps: IndexStartupDeps): IndexStartupResult {
  let failure: IndexOpenFailure | null;

  try {
    return { store: deps.openStore(), info: { outcome: 'ready' } };
  } catch (error: unknown) {
    failure = deps.describeFailure(error);
    if (failure === null) {
      return {
        store: null,
        info: {
          outcome: 'refused',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // Schemat z przyszlosci, brak prawa zapisu i niedzialajacy modul natywny nie
  // sa problemem danych albo nie daja sie naprawic odbudowa. Odmowa, bez
  // dotykania pliku uzytkownika.
  if (!REBUILDABLE.has(failure.reason)) return refused(failure);

  // Odbudowa nadpisuje plik, ktory moze zawierac dane, wiec najpierw
  // kwarantanna (ADR 0028). Nieudana kwarantanna wstrzymuje odbudowe - nie ma
  // wariantu "usun i sprobuj".
  let quarantinedAs: string;
  try {
    quarantinedAs = deps.quarantine();
  } catch (error: unknown) {
    return refused({
      reason: failure.reason,
      message:
        `indeks wymaga odbudowy, ale nie udalo sie odlozyc starego pliku do kwarantanny, ` +
        `wiec odbudowa nie zostala uruchomiona: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    });
  }

  try {
    const store = deps.openStore();
    return {
      store,
      info: {
        outcome: 'rebuilt',
        reason: failure.reason,
        message: failure.message,
        quarantinedAs,
        // Poczatkowy stan; po wypelnieniu indeksu z plikow main podmienia liczbe i liste.
        restoredItems: 0,
        notRestored: NOT_RECOVERABLE_FROM_FILES,
      },
    };
  } catch (error: unknown) {
    const second = deps.describeFailure(error);
    return refused(
      {
        reason: second?.reason ?? failure.reason,
        message: `odbudowa indeksu nie przeszla: ${second?.message ?? String(error)}`,
      },
      { quarantinedAs },
    );
  }
}
