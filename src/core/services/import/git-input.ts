import { gitRefProblem, gitUrlProblem } from '../../cwm/git-source';

/**
 * Kontrola adresu i refa wpisanych przez uzytkownika w kreatorze importu z repozytorium Git (ADR 0058).
 * Ta sama funkcja pracuje w rendererze (komunikat przy polu) i w main (granica IPC), wiec obie strony
 * zgadzaja sie co do tego, co jest poprawne. Komunikaty nie przytaczaja adresu: moglby zawierac haslo.
 * Wlasciwa kontrola bezpieczenstwa (forma kanoniczna, znaki sterujace) to `gitUrlProblem` z `core/cwm`.
 */

export const GIT_URL_MAX_LENGTH = 2048;
export const GIT_REF_MAX_LENGTH = 128;

export function gitUrlInputProblem(text: string): string | null {
  if (text.length === 0) return 'Podaj adres repozytorium.';
  if (text.length > GIT_URL_MAX_LENGTH) return 'Adres jest za długi.';
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return 'Adres ma niepoprawną postać. Oczekiwano https://serwer/organizacja/repozytorium.';
  }
  if (parsed.protocol !== 'https:') {
    return 'Dozwolony jest tylko adres https. Adresy ssh, git, file, ext i http są odrzucane.';
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'Adres nie może zawierać nazwy użytkownika ani hasła. Logowanie nie jest obsługiwane, więc działają tylko repozytoria publiczne.';
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return 'Adres nie może zawierać znaków ? ani #. Gałąź albo tag podaj w polu Ref.';
  }
  if (parsed.pathname === '' || parsed.pathname === '/') {
    return 'Adres nie wskazuje repozytorium: brakuje ścieżki po nazwie serwera.';
  }
  if (gitUrlProblem(text) !== null) {
    return 'Adres nie jest w formie kanonicznej. Użyj małych liter w nazwie serwera, bez spacji i znaków sterujących.';
  }
  return null;
}

/** Pusty ref to `HEAD` repozytorium, wiec jest poprawny. */
export function gitRefInputProblem(text: string): string | null {
  if (text.length === 0) return null;
  if (text.length > GIT_REF_MAX_LENGTH) return 'Ref jest za długi.';
  if (gitRefProblem(text) === null) return null;
  return 'Ref to nazwa gałęzi, taga albo pełny SHA (40 albo 64 znaki). Skrócony SHA, spacje i znaki specjalne są odrzucane.';
}
