/**
 * Sciezki wskazane w poleceniu hooka (IMP-08): skrypt moze sie zmienic bez zmiany polecenia, wiec
 * zatwierdzenie musi obejmowac jego tresc. Parsowanie powloki jest heurystyka i nie daje pelnego
 * obrazu, dlatego to, czego nie da sie przypiac, jest oznaczane jako takie, a nie pomijane.
 */
export interface HookPathToken {
  readonly raw: string;
  /**
   * `home`: `~/`, `$HOME/` lub `${HOME}/`. `variable`: kazda inna sciezka bez kotwicy (zmienna,
   * wzgledna, wyliczana) - nieprzypinalna. `absolute`: zaczyna sie od `/`.
   */
  readonly base: 'absolute' | 'home' | 'variable';
  /** Dla `absolute` cala sciezka, dla `home` czesc po katalogu domowym, dla `variable` pusty tekst. */
  readonly rest: string;
}

export const MAX_HOOK_PATH_TOKENS = 32;
const SEPARATORS = /[\s;|&()<>`]+/;

function classify(token: string): HookPathToken | null {
  const home = /^(?:~|\$HOME|\$\{HOME\})\/(.+)$/.exec(token);
  if (home?.[1] !== undefined) return { raw: token, base: 'home', rest: home[1] };
  if (token.startsWith('/')) {
    return token.length > 1 && !token.startsWith('/dev/')
      ? { raw: token, base: 'absolute', rest: token }
      : null;
  }
  // Wszystko inne ze znakiem `/` (`./x.sh`, `hooks/x.sh`, `$VAR/x`) nie ma stalej kotwicy.
  return token.includes('/') ? { raw: token, base: 'variable', rest: '' } : null;
}

export interface HookPathScan {
  readonly tokens: HookPathToken[];
  /** Ile sciezek ponad `MAX_HOOK_PATH_TOKENS` nie zostalo zwroconych. */
  readonly dropped: number;
}

/** Cudzyslowy zdejmowane najpierw, wiec `"$HOME"/x` daje `$HOME/x` (a nie token z cudzyslowem). */
export function extractHookPathTokens(command: string): HookPathScan {
  const found = new Map<string, HookPathToken>();
  for (const piece of command.replace(/["']/g, '').split(SEPARATORS)) {
    const eq = piece.indexOf('=');
    const token = classify(eq >= 0 ? piece.slice(eq + 1) : piece);
    if (token !== null && !found.has(token.raw)) found.set(token.raw, token);
  }
  const all = [...found.values()];
  return {
    tokens: all.slice(0, MAX_HOOK_PATH_TOKENS),
    dropped: Math.max(0, all.length - MAX_HOOK_PATH_TOKENS),
  };
}
