import {
  KNOWN_PATTERNS,
  LONG_TOKEN,
  ENTROPY_MIN_LENGTH,
  isEntropyCandidate,
  looksLikeSecretValue,
} from '../services/security/secret-classifier';

export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Zmienne, ktore zmieniaja sposob ladowania lub uruchamiania procesu albo kieruja ruch gdzie indziej. */
export const MCP_ENV_DENYLIST =
  /^(?:LD_|DYLD_|PYTHON|NPM_CONFIG_)|^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|PATH|BASH_ENV|ENV|SSL_CERT_FILE|SSL_CERT_DIR|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|GIT_SSH_COMMAND|GIT_EXEC_PATH|RUBYOPT|PERL5OPT|PERL5LIB|IFS|SHELL|HOME|NODE_TLS_REJECT_UNAUTHORIZED|GIT_ASKPASS|SSH_ASKPASS|EDITOR|VISUAL|PAGER|GIT_PAGER|GIT_EXTERNAL_DIFF|GIT_SSH|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|ZDOTDIR|PROMPT_COMMAND|LESSOPEN|BROWSER)$|^GIT_CONFIG_|_PROXY$/i;

/**
 * Dodatek dla `Settings.env` (SET-04): zmienne sterujace silnikiem. Zatwierdzenie tu nie wystarcza,
 * bo `ANTHROPIC_BASE_URL` przekierowuje caly ruch razem z tokenem logowania, a
 * `CLAUDE_CODE_SHELL_PREFIX` opakowuje kazde polecenie powloki.
 */
const ENGINE_ENV_DENYLIST =
  /^(?:CLAUDE_CONFIG_DIR|CLAUDE_CODE_TMPDIR|CLAUDE_CODE_PLUGIN_CACHE_DIR|CLAUDE_CODE_SHELL_PREFIX|CLAUDE_CODE_SHELL|CLAUDE_CODE_GIT_BASH_PATH|CLAUDE_ENV_FILE|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_CUSTOM_HEADERS)$|_BASE_URL$|^OTEL_EXPORTER_OTLP_|^OTEL_.*_HEADERS$/i;

export function isSettingsEnvNameDenied(name: string): boolean {
  return MCP_ENV_DENYLIST.test(name) || ENGINE_ENV_DENYLIST.test(name);
}

/**
 * Nazwa wyglada na nazwe sekretu (fragment, bez rozroznienia wielkosci liter). Falszywe trafienia
 * (`KEYBOARD_LAYOUT`) sa akceptowane: koncza sie wymaganiem `envRef`, nie utrata danych.
 */
const SECRET_NAME_PARTS =
  /TOKEN|SECRET|KEY|PASS|PWD|CRED|AUTH|PAT|PRIVATE|DSN|COOKIE|SESSION|BEARER|WEBHOOK|SIGNING|SIGNATURE|CERT/i;

export function nameLooksSecret(name: string): boolean {
  // PW tylko jako caly segment (`DB_PW`), bo jako fragment trafiaby w zwykle slowa.
  return (
    SECRET_NAME_PARTS.test(name) || name.split('_').some((part) => part.toUpperCase() === 'PW')
  );
}

/** Znane prefiksy po granicy slowa i z dalszym ciagiem, zeby `task-list` nie wygladalo jak `sk-`. */
const VALUE_PREFIXES = [
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/,
  /(?:^|[^A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,}/,
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{6,}/,
  /(?:^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{6,}/,
  /(?:^|[^A-Za-z0-9])xox[a-z]-[A-Za-z0-9-]{6,}/i,
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{8,}/,
  /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{8,}/,
  /(?:^|[^A-Za-z0-9])ya29\.[0-9A-Za-z_.-]{6,}/,
  /(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/,
  /-----BEGIN/,
  /:\/\/[^/@\s]*:[^/@\s]*@/,
];

/**
 * Wartosc ma ksztalt znanego sekretu (prefiks dostawcy, JWT, klucz PEM, adres z haslem). Bez
 * entropii i bez wzorcow klasyfikatora: te dawalyby falszywe trafienia na zwyklych zmiennych
 * procesu (sciezki, kolory terminala), a tu wartosc jest po prostu usuwana ze srodowiska dziecka.
 */
export function valueHasSecretShape(value: string): boolean {
  return [value, percentDecoded(value)].some((candidate) =>
    VALUE_PREFIXES.some((pattern) => pattern.test(candidate)),
  );
}

/** Nazwa sekretu z dwukropkiem lub znakiem rownosci w tekscie (`--password=...`, `token: ...`). */
const SECRET_ASSIGNMENT = /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]/i;

function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Tekst (wartosc, polecenie hooka, regula uprawnien) zawiera sekret: znany prefiks lub wzorzec
 * klasyfikatora, przypisanie sekretu albo dlugi ciag o wysokiej entropii. Prefiksy i adresy
 * z haslem sprawdzane tez po zdekodowaniu procentowym. Bez `looksLikeSecretValue`, ktore dla
 * calego polecenia z literami i cyframi trafialoby prawie zawsze.
 */
export function textHasSecret(text: string): boolean {
  for (const candidate of [text, percentDecoded(text)]) {
    if (VALUE_PREFIXES.some((pattern) => pattern.test(candidate))) return true;
    if (KNOWN_PATTERNS.some((known) => known.pattern.test(candidate))) return true;
    if (SECRET_ASSIGNMENT.test(candidate)) return true;
  }
  for (const match of text.matchAll(LONG_TOKEN)) {
    if (match[0].length >= ENTROPY_MIN_LENGTH && isEntropyCandidate(match[0])) return true;
  }
  return false;
}

/** Wartosc zmiennej wyglada jak sekret niezaleznie od nazwy. Wynik nie zawiera wartosci. */
export function valueLooksSecret(value: string): boolean {
  return textHasSecret(value) || looksLikeSecretValue(value);
}

export type EnvValueVerdict = 'ok' | 'secret-name' | 'secret-value';

/** Czy `value` moze byc wpisane wprost pod `name`. Nazwa wygrywa nad wartoscia (jedna przyczyna w bledzie). */
export function classifyEnvValue(name: string, value: string): EnvValueVerdict {
  if (nameLooksSecret(name)) return 'secret-name';
  return valueLooksSecret(value) ? 'secret-value' : 'ok';
}
