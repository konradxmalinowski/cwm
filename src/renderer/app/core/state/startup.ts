import type { IndexFailureReason, IndexStartupInfo } from '../../../../core/model/index-health';

export const REASON_LABEL: Readonly<Record<IndexFailureReason, string>> = {
  corrupted: 'Indeks był uszkodzony.',
  'unknown-schema': 'Schemat indeksu nie jest znany tej wersji aplikacji.',
  'schema-from-future': 'Indeks zapisała nowsza wersja aplikacji.',
  'not-writable': 'Katalog danych aplikacji nie jest zapisywalny.',
  'native-module': 'Nie załadował się moduł bazy danych.',
};

export const REASON_ADVICE: Readonly<Record<IndexFailureReason, string>> = {
  corrupted: '',
  'unknown-schema': '',
  'schema-from-future':
    'Zaktualizuj aplikację do nowszej wersji. Indeks nie został zmieniony, bo odbudowa wyrzuciłaby log operacji.',
  'not-writable': 'Sprawdź uprawnienia katalogu danych aplikacji i wolne miejsce na dysku.',
  'native-module': 'Zainstaluj aplikację ponownie albo zgłoś błąd.',
};

export type StartupKind = 'normal' | 'rebuilt' | 'refused';

export function startupKind(info: IndexStartupInfo): StartupKind {
  if (info.outcome === 'refused') return 'refused';
  if (info.outcome === 'rebuilt') return 'rebuilt';
  return 'normal';
}

/**
 * Co zostalo odbudowane, a czego nie. Log operacji nie wraca nigdy (ADR 0014), wiec przy
 * odbudowie jest wymieniony zawsze. Zero wczytanych elementow nie jest sukcesem i tak jest
 * opisane.
 */
export function rebuildFacts(info: IndexStartupInfo): {
  readonly restored: string;
  readonly zeroWarning: boolean;
  readonly notRestored: readonly string[];
} {
  const count = info.restoredItems;
  const zeroWarning = count === undefined || count === 0;
  const restored =
    count === undefined
      ? 'Liczba wczytanych elementów jest nieznana.'
      : count === 0
        ? 'Nie wczytano żadnego elementu.'
        : `Wczytano elementów: ${count}.`;
  const notRestored = [
    'Log operacji: nie da się go odtworzyć z plików.',
    ...(info.notRestored ?? []),
  ];
  return { restored, zeroWarning, notRestored };
}

const ABSOLUTE_PATH = /(^|[\s("'`])((?:[A-Za-z]:[\\/]|\/)[^\s"'`),;]+)/g;

/** Ostatnia obrona: ARCHITECTURE 7.2 reguła 4 zakazuje sciezek z main, ale UI nie polega na tym slepo. */
export function redactPaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, '$1[ścieżka ukryta]');
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

const ABSOLUTE_START = /^(?:[A-Za-z]:[\\/]|\/)/;

/** Etykieta lokalizacji z raportu: gdy main podal sciezke bezwzgledna, pokazujemy tylko nazwe pliku. */
export function safeLocationLabel(label: string): string {
  return ABSOLUTE_START.test(label) ? baseName(label) : redactPaths(label);
}
