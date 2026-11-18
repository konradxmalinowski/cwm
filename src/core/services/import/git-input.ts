import { gitRefProblem, gitUrlProblem } from '../../cwm/git-source';

/**
 * Kontrola adresu i refa wpisanych przez uzytkownika w kreatorze importu z repozytorium Git (ADR 0058).
 * Ta sama funkcja pracuje w rendererze (komunikat przy polu) i w main (granica IPC), wiec obie strony
 * zgadzaja sie co do tego, co jest poprawne. Komunikaty nie przytaczaja adresu: moglby zawierac haslo.
 * Wlasciwa kontrola bezpieczenstwa (forma kanoniczna, znaki sterujace) to `gitUrlProblem` z `core/cwm`.
 */

export const GIT_URL_MAX_LENGTH = 2048;
export const GIT_REF_MAX_LENGTH = 128;

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/**
 * Adresy, ktore nie sa publicznym serwerem repozytoriow: literały IP (v4 i v6), `localhost`, nazwy z
 * domen lokalnych i prywatnych oraz nazwy bez kropki. Parser `URL` sprowadza zapisy typu `0x7f.1` do
 * kanonicznego IPv4, wiec wystarczy sprawdzic postac kanoniczna. To nie jest ochrona przed nazwa DNS,
 * ktora wskazuje na adres prywatny: takiej nazwy aplikacja nie rozwiazuje przed pobraniem (ADR 0058).
 */
export function gitHostProblem(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const isIp = host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  const isPrivateName =
    host === 'localhost' ||
    host === 'home.arpa' ||
    PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (isIp || isPrivateName || !host.includes('.')) {
    return 'Adres wskazuje na komputer lokalny, adres IP albo nazwę z sieci prywatnej. Podaj publiczną nazwę serwera, na przykład github.com.';
  }
  return null;
}

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
  const hostProblem = gitHostProblem(parsed.hostname);
  if (hostProblem !== null) return hostProblem;
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
