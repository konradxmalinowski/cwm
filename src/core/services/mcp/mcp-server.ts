import { isSettingsEnvNameDenied, nameLooksSecret, textHasSecret } from '../../cwm/env-policy';
import { hasInvisibleChar } from '../security/invisible-chars';
import { redactSecrets } from '../security/secret-redactor';
import type { ItemId, JsonValue, LibraryItem, ToolId } from '../../model/item';

/**
 * Serwer MCP w bibliotece i reguly jego eksportu (ADR 0061, ADR 0062). Czyste funkcje, bez I/O: adaptery
 * tlumacza format narzedzia na `McpServerSpec` i z powrotem, a reguly tutaj decyduja, co wolno zapisac.
 *
 * Biblioteka nigdy nie trzyma wartosci zmiennych srodowiskowych ani naglowkow, tylko ich nazwy i
 * odniesienia do zmiennych. Eksport zapisuje odniesienia: `${NAZWA}` w Claude Code i Gemini CLI,
 * `env_vars = ["NAZWA"]`, `bearer_token_env_var` i `env_http_headers` w Codeksie. Ta sama zasada co
 * `envRef` w manifestach CLI (`core/cwm/resource.ts`), i ten sam test sekretu w tekscie (`textHasSecret`).
 */

export type McpTransport = 'stdio' | 'http' | 'sse';

/** Zmienna srodowiskowa serwera: `name` widzi serwer, `ref` to zmienna u uzytkownika, z ktorej ja bierze. */
export interface McpEnvRef {
  readonly name: string;
  readonly ref: string;
}

/** Schemat przed odniesieniem w wartosci naglowka (`Bearer ${X}`); `null`: sama wartosc zmiennej. */
export type McpHeaderScheme = 'Bearer' | 'Basic';

/**
 * Naglowek HTTP serwera (ADR 0062): nazwa, zmienna u uzytkownika i opcjonalny schemat. `ref` jest `null`,
 * gdy zrodlo mialo wartosc wpisana wprost: wartosc nie trafia do biblioteki, a serwer bez odniesienia
 * nie przechodzi eksportu.
 */
export interface McpHeaderRef {
  readonly name: string;
  readonly ref: string | null;
  readonly scheme: McpHeaderScheme | null;
}

export interface McpServerSpec {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly url: string | null;
  readonly env: readonly McpEnvRef[];
  /** Naglowki HTTP ze zrodla: nazwy i odniesienia do zmiennych, nigdy wartosci. */
  readonly headers: readonly McpHeaderRef[];
}

/** Klucz `toolSetting.key` serwera MCP w danym narzedziu: `<prefiks>.<nazwa>`. */
export const MCP_KEY_PREFIX: Readonly<Record<ToolId, string>> = {
  'claude-code': 'mcpServers',
  codex: 'mcp_servers',
  'gemini-cli': 'mcpServers',
};

const KEY_PATTERN = /^(?:mcpServers|mcp_servers)\.(.+)$/;
/** Nazwa, ktora jest jednoczesnie golym kluczem TOML i bezpiecznym kluczem JSON. */
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** `${NAZWA}` w Claude Code; Codex tej skladni nie rozwija. */
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}$/;
/** Gemini CLI rozwija `$NAZWA` i `${NAZWA}` w napisach settings.json (dokumentacja configuration). */
const GEMINI_REFERENCE =
  /^\$(?:\{([A-Za-z_][A-Za-z0-9_]{0,127})\}|([A-Za-z_][A-Za-z0-9_]{0,127}))$/;
/**
 * Nazwa naglowka: token z RFC 7230 (bez spacji, dwukropka, CR i LF), dodatkowo bez `$`, bo Gemini CLI
 * rozwija zmienne w napisach settings.json.
 */
const HEADER_NAME = /^[!#%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
/** Naglowki, ktore steruja polaczeniem albo niosa sesje; serwer z nimi nie przechodzi eksportu. */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'cookie',
  'proxy-authorization',
  'proxy-connection',
]);
/**
 * Zmienne z danymi logowania samych narzedzi i dostawcow chmury. Naglowek wysyla wartosc pod adres
 * serwera, wiec odniesienie do nich byloby wyciekiem (Claude Code czyta je w naglowkach jako puste).
 */
const HEADER_REF_DENIED =
  /^(?:ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|GEMINI_|GOOGLE_|GCLOUD_|AWS_|AZURE_)/i;
/**
 * Tokeny popularnych uslug (forge, rejestry pakietow, czaty, platnosci). Typowe serwery MCP ich uzywaja
 * (np. GitHub: `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`), wiec to nie odmowa, tylko zawsze
 * jawne zdanie w podgladzie potwierdzenia, do jakiego hosta trafi wartosc (ADR 0062).
 */
const HEADER_REF_SERVICE_TOKEN =
  /^(?:GITHUB_|GH_|GITLAB_|NPM_|HF_|HUGGING_FACE_|SLACK_|DOCKER_|DIGITALOCEAN_|CLOUDFLARE_|CF_|STRIPE_|TWILIO_|SENTRY_)/i;
const MAX_HEADERS = 32;
// eslint-disable-next-line no-control-regex -- kontrolujemy dokladnie znaki sterujace
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_TEXT = 4096;
const MAX_ARGS = 128;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Nazwy z `Object.prototype` (np. `__proto__`, `constructor`) nie sa nazwami serwerow. */
const PROTOTYPE_NAMES = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

/** Powod odmowy nazwy serwera albo `null`. */
export function mcpNameProblem(name: string): string | null {
  if (!MCP_NAME_PATTERN.test(name)) {
    return `Nazwa serwera MCP „${name.slice(0, 64)}” ma znaki spoza liter, cyfr, - i _. Zmień ją w narzędziu źródłowym.`;
  }
  if (PROTOTYPE_NAMES.has(name)) {
    return `Nazwa serwera MCP „${name}” jest zastrzeżona (nazwa wbudowana JavaScriptu). Zmień ją w narzędziu źródłowym.`;
  }
  return null;
}

// --- dane logowania w argumentach i adresie (ADR 0061, punkt 3) ---

/** Flagi, ktorych nazwa zawiera fragment nazwy sekretu, ale to zwykle nie sa dane logowania. */
const SECRET_FLAG_EXEMPT = new Set(['PATH', 'PATHS', 'PATTERN', 'PATTERNS', 'PATCH']);
const AUTH_TEXT = /\b(?:bearer|basic)\s|authorization|\bx-[a-z0-9-]*key\s*:/i;
const HEX_RUN = /[0-9a-f]{32,}/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SECRET_QUERY = new Set(['key', 'sig', 'code', 'token']);

function flagCarriesSecret(arg: string): boolean {
  if (arg === '-H' || arg === '--header' || arg.startsWith('--header=')) return true;
  const match = /^--?([A-Za-z][A-Za-z0-9_-]*)(?:=|$)/.exec(arg);
  if (match === null) return false;
  const name = (match[1] ?? '').replace(/-/g, '_').toUpperCase();
  return !SECRET_FLAG_EXEMPT.has(name) && nameLooksSecret(name);
}

function tokenLike(text: string): boolean {
  return HEX_RUN.test(text) || UUID.test(text);
}

/**
 * Odniesienie, ktore samo wyglada na token (wklejona wartosc zamiast nazwy zmiennej, np. znany prefiks,
 * ciag szesnastkowy od 32 znakow, UUID albo dlugi ciag o wysokiej entropii). Takie odniesienie nie trafia
 * do biblioteki ani do pliku, bo `${<token>}` w pliku to sam sekret (ADR 0062).
 */
export function refLooksLikeToken(ref: string): boolean {
  return textHasSecret(ref) || tokenLike(ref);
}

/**
 * Dane logowania, ktorych `textHasSecret` nie widzi (heksadecymalne tokeny i UUID maja niska entropie):
 * wartosc po fladze o nazwie sekretu albo po `-H`/`--header`, naglowek autoryzacji w argumencie, parametr
 * adresu o nazwie sekretu, ciag szesnastkowy od 32 znakow albo UUID. Powod nie zawiera wartosci.
 */
export function mcpCredentialProblem(spec: McpServerSpec): string | null {
  for (let i = 0; i < spec.args.length; i++) {
    const arg = spec.args[i] ?? '';
    if (flagCarriesSecret(arg) && (arg.includes('=') || i + 1 < spec.args.length)) {
      return `argument ${i + 1} jest flagą, która przekazuje dane logowania.`;
    }
    if (AUTH_TEXT.test(arg)) return `argument ${i + 1} zawiera nagłówek autoryzacji.`;
    if (tokenLike(arg)) return `argument ${i + 1} zawiera token (ciąg szesnastkowy albo UUID).`;
  }
  if (spec.url !== null) {
    let parsed: URL | null;
    try {
      parsed = new URL(spec.url);
    } catch {
      parsed = null;
    }
    if (parsed !== null) {
      for (const key of parsed.searchParams.keys()) {
        if (SECRET_QUERY.has(key.toLowerCase()) || nameLooksSecret(key)) {
          return 'adres ma parametr, który przekazuje dane logowania.';
        }
      }
      if (tokenLike(parsed.pathname) || tokenLike(parsed.search)) {
        return 'adres zawiera token (ciąg szesnastkowy albo UUID).';
      }
    }
  }
  return null;
}

/** Wspolna dla importu i eksportu: tekst serwera nie moze niesc sekretu ani byc maskowany w podgladzie. */
export function mcpSecretProblem(spec: McpServerSpec): string | null {
  const texts = [spec.command, spec.url, ...spec.args].filter((t): t is string => t !== null);
  if (texts.some((t) => hasInvisibleChar(t))) {
    return 'polecenie, argument albo adres zawiera niewidoczny znak (kierunek tekstu albo zerowa szerokość).';
  }
  if (texts.some((t) => textHasSecret(t))) {
    return 'polecenie, argument albo adres wygląda na sekret.';
  }
  const credential = mcpCredentialProblem(spec);
  if (credential !== null) return credential;
  // Podglad przechodzi redakcje; gdyby ja zmienila, uzytkownik potwierdzalby zamaskowane polecenie.
  const launch = describeLaunch(spec);
  if (redactSecrets(launch).text !== launch) {
    return 'polecenie albo adres zawiera fragment, który podgląd musiałby zamaskować.';
  }
  return null;
}

export function mcpSettingKey(tool: ToolId, name: string): string {
  return `${MCP_KEY_PREFIX[tool]}.${name}`;
}

/** Czy element jest serwerem MCP (ustawienie narzedzia z kluczem `mcpServers.*` albo `mcp_servers.*`). */
export function isMcpServerItem(item: LibraryItem): boolean {
  const setting = item.attributes.toolSetting;
  return item.kind === 'tool-setting' && setting !== undefined && KEY_PATTERN.test(setting.key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') return null;
    out.push(entry);
  }
  return out;
}

/** Wartosc `toolSetting.value` zapisana przez import: tylko nazwy zmiennych i naglowkow. */
export function mcpSettingValue(spec: McpServerSpec): JsonValue {
  return {
    transport: spec.transport,
    command: spec.command,
    args: [...spec.args],
    url: spec.url,
    env: spec.env.map((e) => ({ name: e.name, ref: e.ref })),
    headers: spec.headers.map((h) => ({ name: h.name, ref: h.ref, scheme: h.scheme })),
  };
}

/** Naglowki z `item.json`: lista nazw (zapis sprzed ADR 0062, bez odniesien) albo lista `{ name, ref, scheme }`. */
function headerList(value: unknown): McpHeaderRef[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: McpHeaderRef[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry === 'string') {
      out.push({ name: entry, ref: null, scheme: null });
      continue;
    }
    if (!isRecord(entry) || typeof entry['name'] !== 'string') return null;
    const ref = entry['ref'];
    const scheme = entry['scheme'];
    if (ref !== undefined && ref !== null && typeof ref !== 'string') return null;
    if (scheme !== undefined && scheme !== null && scheme !== 'Bearer' && scheme !== 'Basic') {
      return null;
    }
    out.push({
      name: entry['name'],
      ref: typeof ref === 'string' ? ref : null,
      scheme: scheme === 'Bearer' || scheme === 'Basic' ? scheme : null,
    });
  }
  return out;
}

export type McpRead =
  | { readonly ok: true; readonly spec: McpServerSpec }
  | { readonly ok: false; readonly reason: string };

const INCOMPLETE =
  'Serwer MCP nie ma kompletnego opisu w bibliotece (transport, polecenie albo adres). Zaimportuj go ponownie z narzędzia.';

/**
 * Odczyt serwera z elementu biblioteki. Wartosci zmiennych nie sa czytane nigdy: z obiektu `env`
 * (np. reczna edycja `item.json`) bierzemy tylko nazwy, a kazda z nich jest odniesieniem do zmiennej o tej nazwie.
 */
export function readMcpServer(item: LibraryItem): McpRead {
  const setting = item.attributes.toolSetting;
  const match = setting === undefined ? null : KEY_PATTERN.exec(setting.key);
  if (setting === undefined || match === null) {
    return { ok: false, reason: 'Element nie jest serwerem MCP.' };
  }
  const name = match[1] ?? '';
  const value = setting.value;
  if (!isRecord(value)) return { ok: false, reason: INCOMPLETE };
  const transport = value['transport'];
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    return { ok: false, reason: INCOMPLETE };
  }
  const command = typeof value['command'] === 'string' ? value['command'] : null;
  const url = typeof value['url'] === 'string' ? value['url'] : null;
  const args = value['args'] === undefined ? [] : stringList(value['args']);
  const headers = headerList(value['headers']);
  if (args === null || headers === null) return { ok: false, reason: INCOMPLETE };
  const env: McpEnvRef[] = [];
  const rawEnv = value['env'];
  if (Array.isArray(rawEnv)) {
    for (const entry of rawEnv as unknown[]) {
      if (!isRecord(entry) || typeof entry['name'] !== 'string') {
        return { ok: false, reason: INCOMPLETE };
      }
      const ref = typeof entry['ref'] === 'string' ? entry['ref'] : entry['name'];
      env.push({ name: entry['name'], ref });
    }
  } else if (isRecord(rawEnv)) {
    for (const key of Object.keys(rawEnv)) env.push({ name: key, ref: key });
  } else if (rawEnv !== undefined && rawEnv !== null) {
    return { ok: false, reason: INCOMPLETE };
  }
  if (transport === 'stdio' ? command === null : url === null) {
    return { ok: false, reason: INCOMPLETE };
  }
  return { ok: true, spec: { name, transport, command, args, url, env, headers } };
}

export interface McpExportCheck {
  /** Powod odmowy; `null`, gdy serwer moze trafic do narzedzia. */
  readonly refusal: string | null;
  /** Adres po normalizacji (`URL.href`); to on trafia do pliku. `null` dla stdio. */
  readonly url: string | null;
  /** Zmienne, ktore trafia do pliku jako odniesienia. */
  readonly env: readonly McpEnvRef[];
  /** Naglowki, ktore trafia do pliku jako odniesienia (ADR 0062); zawsze z `ref`. */
  readonly headers: readonly McpHeaderRef[];
  /** Ostrzezenia dla planu, po polsku, bez wartosci. */
  readonly warnings: readonly string[];
  /**
   * Naglowki, ktorych zmienna wyglada na dane logowania (`nameLooksSecret`): jawne zdanie, ze wartosc
   * trafi do hosta serwera (ADR 0062). Pokazywane w podgladzie potwierdzenia.
   */
  readonly headerNotices: readonly string[];
}

function refuse(reason: string): McpExportCheck {
  return { refusal: reason, url: null, env: [], headers: [], warnings: [], headerNotices: [] };
}

function textProblem(label: string, text: string): string | null {
  if (text.length === 0 || text.length > MAX_TEXT || CONTROL_CHARS.test(text)) {
    return `${label} jest puste, za długie albo zawiera znak sterujący.`;
  }
  if (hasInvisibleChar(text)) {
    return `${label} zawiera niewidoczny znak (kierunek tekstu albo zerowa szerokość).`;
  }
  if (text.includes('$')) {
    return `${label} zawiera znak $. Narzędzia rozwijają zmienne w różny sposób, więc eksport przenosi zmienne wyłącznie przez env i nagłówki.`;
  }
  if (textHasSecret(text)) {
    return `${label} wygląda na sekret. Eksport nie kopiuje sekretów; przekaż wartość przez zmienną środowiskową.`;
  }
  return null;
}

/** Adres http i sse: tylko https albo http na localhost, bez danych logowania w adresie. */
export function mcpUrlProblem(url: string): string | null {
  const text = textProblem('Adres serwera', url);
  if (text !== null) return text;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Adres serwera nie jest poprawnym adresem URL.';
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'Adres serwera zawiera dane logowania. Eksport ich nie kopiuje.';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)) return null;
  return 'Adres serwera musi używać https (http jest dozwolone tylko dla localhost).';
}

/** Adres IP w sieci prywatnej, petli zwrotnej albo link-local (dla ostrzezenia przy https). */
function privateHost(hostname: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (!hostname.startsWith('[')) return false;
  const v6 = hostname.slice(1, -1).toLowerCase();
  return v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:');
}

/** Powod odmowy nazwy naglowka albo `null` (token RFC 7230, poza lista zabroniona). */
export function mcpHeaderNameProblem(name: string): string | null {
  if (!HEADER_NAME.test(name)) {
    return 'nazwa nagłówka HTTP ma znaki spoza tokenu HTTP (spacja, dwukropek, znak sterujący) albo jest za długa.';
  }
  if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
    return `nagłówek ${name} steruje połączeniem albo niesie sesję i nie jest przenoszony.`;
  }
  return null;
}

/** Tekst naglowka do podgladu i powodow: nazwa, schemat i zmienna, nigdy wartosc. */
export function describeHeader(header: McpHeaderRef): string {
  if (header.ref === null) return `${header.name} (bez odniesienia)`;
  return `${header.name}: ${header.scheme === null ? '' : `${header.scheme} `}\${${header.ref}}`;
}

/**
 * Naglowki serwera http albo sse (ADR 0062). Kazdy musi byc odniesieniem do zmiennej, bo serwer bez
 * naglowka zwykle nie dziala, a wartosci eksport nie kopiuje. Codex wyraza tylko `Bearer` w
 * `Authorization` (`bearer_token_env_var`) i sama wartosc zmiennej (`env_http_headers`).
 */
function headerProblem(spec: McpServerSpec, tool: ToolId): string | null {
  if (spec.headers.length > MAX_HEADERS) return 'serwer ma za dużo nagłówków HTTP.';
  const seen = new Set<string>();
  for (const header of spec.headers) {
    const name = mcpHeaderNameProblem(header.name);
    if (name !== null) return name;
    const lower = header.name.toLowerCase();
    if (seen.has(lower)) return `nagłówek ${header.name} występuje więcej niż raz.`;
    seen.add(lower);
    if (header.ref === null) {
      return `nagłówki HTTP bez odniesienia do zmiennej (${header.name}). Wartość wpisana wprost nie jest kopiowana, a serwer bez nagłówka nie zadziała. Zapisz w narzędziu źródłowym odniesienie, np. "Bearer \${NAZWA}", i zaimportuj serwer ponownie.`;
    }
    if (!ENV_NAME.test(header.ref)) {
      return `nagłówek ${header.name} ma niepoprawną nazwę zmiennej.`;
    }
    if (refLooksLikeToken(header.ref)) {
      return `nagłówek ${header.name} ma zamiast nazwy zmiennej tekst, który wygląda na token. Wpisz w narzędziu źródłowym nazwę zmiennej i zaimportuj serwer ponownie.`;
    }
    if (isSettingsEnvNameDenied(header.ref) || HEADER_REF_DENIED.test(header.ref)) {
      return `nagłówek ${header.name} bierze wartość ze zmiennej ${header.ref}, która niesie dane logowania narzędzia albo chmury albo zmienia ruch sieciowy. Taka wartość nie jest wysyłana do serwera MCP.`;
    }
    if (tool === 'codex') {
      if (header.scheme === 'Basic') {
        return `nagłówek ${header.name} ma schemat Basic, którego Codex nie wyraża odniesieniem do zmiennej (env_http_headers przekazuje samą wartość zmiennej).`;
      }
      if (header.scheme === 'Bearer' && lower !== 'authorization') {
        return `nagłówek ${header.name} ma schemat Bearer, a Codex dodaje go tylko do nagłówka Authorization (bearer_token_env_var).`;
      }
    }
  }
  return null;
}

/**
 * Reguly eksportu jednego serwera do jednego narzedzia (ADR 0061, ADR 0062). Zakres (projekt czy
 * katalog globalny) sprawdza wczesniej `project-scope.ts`, a wybor pliku adapter.
 */
export function checkMcpExport(spec: McpServerSpec, tool: ToolId): McpExportCheck {
  const nameProblem = mcpNameProblem(spec.name);
  if (nameProblem !== null) return refuse(nameProblem);
  const warnings: string[] = [];
  let url: string | null = null;
  let headers: readonly McpHeaderRef[] = [];
  const headerNotices: string[] = [];
  if (spec.transport === 'stdio') {
    const command = spec.command ?? '';
    const problem =
      textProblem('Polecenie serwera', command) ??
      (spec.args.length > MAX_ARGS ? 'Serwer ma za dużo argumentów.' : null) ??
      spec.args.map((a) => textProblem('Argument serwera', a)).find((p) => p !== null) ??
      null;
    if (problem !== null) return refuse(`Serwer MCP „${spec.name}”: ${problem}`);
    warnings.push(
      `Serwer MCP „${spec.name}” uruchamia program na tym komputerze: ${describeLaunch(spec)}`,
    );
    if (spec.headers.length > 0) {
      warnings.push(
        `Nagłówki HTTP dotyczą tylko serwerów http i sse i zostaną pominięte: ${spec.headers.map((h) => h.name.slice(0, 64)).join(', ')}.`,
      );
    }
  } else {
    if (tool === 'codex' && spec.transport === 'sse') {
      return refuse(
        `Serwer MCP „${spec.name}” używa transportu sse, którego Codex nie obsługuje (tylko stdio i http).`,
      );
    }
    const problem = mcpUrlProblem(spec.url ?? '');
    if (problem !== null) return refuse(`Serwer MCP „${spec.name}”: ${problem}`);
    const parsed = new URL(spec.url ?? '');
    url = parsed.href;
    if (parsed.protocol === 'https:' && privateHost(parsed.hostname)) {
      warnings.push(
        `Serwer MCP „${spec.name}” ma adres w sieci prywatnej, pętli zwrotnej albo link-local. Sprawdź, czy to ten serwer, którego się spodziewasz.`,
      );
    }
    const header = headerProblem(spec, tool);
    if (header !== null) return refuse(`Serwer MCP „${spec.name}”: ${header}`);
    headers = spec.headers;
    warnings.push(`Serwer MCP „${spec.name}” łączy się z adresem: ${url}`);
    if (headers.length > 0) {
      warnings.push(
        `Wartości nagłówków HTTP nie są kopiowane. Serwer wyśle pod ten adres wartości zmiennych: ${headers.map(describeHeader).join(', ')}.`,
      );
    }
    for (const h of headers) {
      if (h.ref === null || !(nameLooksSecret(h.ref) || HEADER_REF_SERVICE_TOKEN.test(h.ref))) {
        continue;
      }
      headerNotices.push(
        `Nagłówek ${h.name} wyśle wartość zmiennej ${h.ref}, która wygląda na dane logowania, do hosta ${parsed.host}. Zapisz ten serwer tylko, jeśli ufasz temu hostowi.`,
      );
    }
    warnings.push(...headerNotices);
  }
  const secret = mcpSecretProblem({ ...spec, url });
  if (secret !== null) return refuse(`Serwer MCP „${spec.name}”: ${secret}`);
  const env: McpEnvRef[] = [];
  for (const entry of spec.env) {
    if (!ENV_NAME.test(entry.name) || !ENV_NAME.test(entry.ref)) {
      warnings.push(
        `Zmienna „${entry.name.slice(0, 64)}” ma niepoprawną nazwę i zostanie pominięta.`,
      );
      continue;
    }
    if (refLooksLikeToken(entry.ref)) {
      warnings.push(
        `Zmienna ${entry.name.slice(0, 64)} ma zamiast nazwy zmiennej źródłowej tekst, który wygląda na token, i zostanie pominięta.`,
      );
      continue;
    }
    if (isSettingsEnvNameDenied(entry.name) || isSettingsEnvNameDenied(entry.ref)) {
      warnings.push(
        `Zmienna ${entry.name} zmienia sposób uruchamiania procesu albo ruch sieciowy i zostanie pominięta.`,
      );
      continue;
    }
    if (spec.transport !== 'stdio') {
      warnings.push(`Zmienna ${entry.name} dotyczy tylko serwerów stdio i zostanie pominięta.`);
      continue;
    }
    if (tool === 'codex' && entry.ref !== entry.name) {
      warnings.push(
        `Zmienna ${entry.name} bierze wartość z ${entry.ref}, a Codex przekazuje zmienną tylko pod tą samą nazwą. Zostanie pominięta.`,
      );
      continue;
    }
    env.push(entry);
  }
  if (env.length > 0) {
    warnings.push(
      `Wartości zmiennych nie są kopiowane. Serwer weźmie je ze środowiska: ${env.map((e) => e.ref).join(', ')}.`,
    );
  }
  return { refusal: null, url, env, headers, warnings, headerNotices };
}

/** Polecenie w calosci, do podgladu: argumenty ze spacja albo cudzyslowem w cudzyslowach JSON. */
export function describeLaunch(spec: McpServerSpec): string {
  if (spec.transport !== 'stdio') return spec.url ?? '';
  const quote = (part: string): string => (/^[^\s"'\\]+$/.test(part) ? part : JSON.stringify(part));
  return [spec.command ?? '', ...spec.args].map(quote).join(' ');
}

function normalUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function headerKey(h: McpHeaderRef): string {
  return `${h.name.toLowerCase()}=${h.scheme ?? ''}:${h.ref ?? ''}`;
}

/** Te same pola po obu stronach: nazwa, transport, polecenie, argumenty, adres, zmienne i naglowki. */
export function sameMcpServer(a: McpServerSpec, b: McpServerSpec): boolean {
  const key = (s: McpServerSpec): string =>
    JSON.stringify([
      s.transport,
      // Polecenie i argumenty dotycza tylko stdio; serwer http zapisany bez nich jest ten sam.
      s.transport === 'stdio' ? s.command : null,
      s.transport === 'stdio' ? s.args : [],
      normalUrl(s.url),
      [...s.env].map((e) => `${e.name}=${e.ref}`).sort(),
      s.transport === 'stdio' ? [] : s.headers.map(headerKey).sort(),
    ]);
  return key(a) === key(b);
}

/** Roznica do pokazania w konflikcie nadpisania: same pola opisu, nigdy wartosci zmiennych. */
export function describeMcpDifference(
  current: McpServerSpec,
  next: McpServerSpec,
  notes: readonly string[] = [],
): string {
  const lines: string[] = [];
  const show = (s: McpServerSpec): string => `${s.transport}: ${describeLaunch(s)}`;
  if (show(current) !== show(next)) lines.push(`teraz ${show(current)}; po zamianie ${show(next)}`);
  const envOf = (s: McpServerSpec): string =>
    s.env.length === 0 ? 'brak' : s.env.map((e) => e.name).join(', ');
  if (envOf(current) !== envOf(next)) {
    lines.push(`zmienne teraz: ${envOf(current)}; po zamianie: ${envOf(next)}`);
  }
  const headersOf = (s: McpServerSpec): string =>
    s.transport === 'stdio' || s.headers.length === 0
      ? 'brak'
      : s.headers.map(describeHeader).join(', ');
  if (headersOf(current) !== headersOf(next)) {
    lines.push(`nagłówki teraz: ${headersOf(current)}; po zamianie: ${headersOf(next)}`);
  }
  lines.push(...notes);
  return lines.length === 0 ? 'inne pola definicji' : lines.join('; ');
}

// ---- formaty narzedzi (czyste mapowanie, uzywane przez import i eksport) ----

export interface NativeRead {
  readonly spec: McpServerSpec;
  /** Klucze zrodla bez odpowiednika w bibliotece; wartosci nie sa zapamietywane. */
  readonly unmapped: readonly string[];
  /** Ostrzezenia importu, po polsku, bez wartosci. */
  readonly warnings: readonly string[];
}

export type NativeResult =
  ({ readonly ok: true } & NativeRead) | { readonly ok: false; readonly reason: string };

/** Odmowa importu: do biblioteki nie trafia nic z tego serwera, takze opis ani snapshot. */
function nativeTextProblem(spec: McpServerSpec): string | null {
  const name = mcpNameProblem(spec.name);
  if (name !== null) return name;
  const problem = mcpSecretProblem(spec);
  return problem === null
    ? null
    : `${problem.charAt(0).toUpperCase()}${problem.slice(1)} Serwer nie jest importowany, żeby wartość nie trafiła do biblioteki.`;
}

const HEADER_VALUE = /^(?:(bearer|basic) +)?(\S+)$/i;

interface HeadersRead {
  readonly headers: McpHeaderRef[];
  readonly warnings: string[];
}

/**
 * Naglowki z obiektu `headers` (Claude Code, Gemini CLI). Wartosc bedaca czystym odniesieniem
 * (`${X}`, `Bearer ${X}`, `Basic ${X}`) daje `ref`; kazda inna (token wpisany wprost, `${X:-domyslna}`,
 * tekst wokol odniesienia) zostawia sama nazwe z ostrzezeniem. Nazwa spoza tokenu HTTP odrzuca serwer:
 * napis ze znakami sterujacymi nie trafia do biblioteki. Powody nie zawieraja wartosci.
 */
function readHeaders(raw: unknown, reference: RegExp): HeadersRead | string {
  const headers: McpHeaderRef[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { headers, warnings };
  const literal: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!HEADER_NAME.test(key)) {
      return `nazwa nagłówka HTTP ma znaki spoza tokenu HTTP albo jest za długa. Serwer nie jest importowany.`;
    }
    const match = typeof value === 'string' ? HEADER_VALUE.exec(value) : null;
    const ref = match === null ? null : reference.exec(match[2] ?? '');
    const variable = ref === null ? undefined : (ref[1] ?? ref[2]);
    if (match === null || variable === undefined || refLooksLikeToken(variable)) {
      literal.push(key);
      headers.push({ name: key, ref: null, scheme: null });
      continue;
    }
    const scheme = match[1]?.toLowerCase();
    headers.push({
      name: key,
      ref: variable,
      scheme: scheme === 'bearer' ? 'Bearer' : scheme === 'basic' ? 'Basic' : null,
    });
  }
  if (literal.length > 0) {
    warnings.push(
      `Nagłówki HTTP ${literal.join(', ')} mają wartość wpisaną wprost, która nie została zaimportowana. Bez odniesienia do zmiennej (np. "Bearer \${NAZWA}") serwer nie przejdzie eksportu.`,
    );
  }
  if (headers.some((h) => h.ref !== null)) {
    warnings.push(
      'Z nagłówków HTTP zaimportowane zostały tylko nazwy i odniesienia do zmiennych, bez wartości.',
    );
  }
  return { headers, warnings };
}

/** Obiekt `headers` z odniesieniami dla Claude Code i Gemini CLI (`"Bearer ${REF}"`). */
function headerObject(headers: readonly McpHeaderRef[]): Record<string, JsonValue> {
  return Object.fromEntries(
    headers.map((h) => [h.name, `${h.scheme === null ? '' : `${h.scheme} `}\${${h.ref ?? ''}}`]),
  );
}

/**
 * Wpis z `mcpServers` Claude Code (`~/.claude.json`, `.mcp.json`). Wartosc zmiennej `${INNA}` zapamietuje
 * odniesienie do `INNA`; kazda inna wartosc jest pomijana, a zostaje tylko nazwa.
 */
export function fromClaudeServer(name: string, raw: unknown): NativeResult {
  if (!isRecord(raw)) return { ok: false, reason: `Serwer MCP „${name}” nie jest obiektem.` };
  const known = new Set(['type', 'command', 'args', 'env', 'url', 'headers']);
  const declared = raw['type'];
  const transport: McpTransport | null =
    declared === undefined
      ? typeof raw['command'] === 'string'
        ? 'stdio'
        : null
      : declared === 'stdio' || declared === 'http' || declared === 'sse'
        ? declared
        : null;
  if (transport === null) {
    return {
      ok: false,
      reason: `Serwer MCP „${name}” ma nieznany transport, więc nie jest importowany.`,
    };
  }
  const args = raw['args'] === undefined ? [] : stringList(raw['args']);
  if (args === null) {
    return { ok: false, reason: `Argumenty serwera MCP „${name}” nie są listą napisów.` };
  }
  const warnings: string[] = [];
  const env: McpEnvRef[] = [];
  let literal = false;
  if (isRecord(raw['env'])) {
    for (const [key, value] of Object.entries(raw['env'])) {
      const found = typeof value === 'string' ? ENV_REFERENCE.exec(value)?.[1] : undefined;
      const ref = found !== undefined && refLooksLikeToken(found) ? undefined : found;
      if (ref === undefined) literal = true;
      env.push({ name: key, ref: ref ?? key });
    }
  }
  if (literal) {
    warnings.push(
      'Wartości zmiennych środowiskowych serwera nie zostały zaimportowane, tylko ich nazwy. Po eksporcie serwer weźmie je ze środowiska.',
    );
  }
  const read = readHeaders(raw['headers'], ENV_REFERENCE);
  if (typeof read === 'string') return { ok: false, reason: `Serwer MCP „${name}”: ${read}` };
  warnings.push(...read.warnings);
  const spec: McpServerSpec = {
    name,
    transport,
    command: typeof raw['command'] === 'string' ? raw['command'] : null,
    args,
    url: typeof raw['url'] === 'string' ? raw['url'] : null,
    env,
    headers: read.headers,
  };
  if (transport === 'stdio' ? spec.command === null : spec.url === null) {
    return { ok: false, reason: `Serwer MCP „${name}” nie ma polecenia ani adresu.` };
  }
  const secret = nativeTextProblem(spec);
  if (secret !== null) return { ok: false, reason: `Serwer MCP „${name}”: ${secret}` };
  const unmapped = Object.keys(raw).filter((k) => !known.has(k));
  return { ok: true, spec, unmapped, warnings };
}

/** Wpis Claude Code z odniesieniami zamiast wartosci. */
export function toClaudeServer(
  spec: McpServerSpec,
  env: readonly McpEnvRef[],
  headers: readonly McpHeaderRef[] = [],
): JsonValue {
  if (spec.transport === 'stdio') {
    const out: Record<string, JsonValue> = {
      type: 'stdio',
      command: spec.command ?? '',
      args: [...spec.args],
    };
    if (env.length > 0) {
      out['env'] = Object.fromEntries(env.map((e) => [e.name, `\${${e.ref}}`]));
    }
    return out;
  }
  const out: Record<string, JsonValue> = { type: spec.transport, url: spec.url ?? '' };
  if (headers.length > 0) out['headers'] = headerObject(headers);
  return out;
}

/** Tabela `[mcp_servers.<nazwa>]` Codeksa. `env` z wartosciami daje same nazwy. */
export function fromCodexServer(name: string, raw: unknown): NativeResult {
  if (!isRecord(raw)) return { ok: false, reason: `Serwer MCP „${name}” nie jest tabelą.` };
  const known = new Set([
    'command',
    'args',
    'env',
    'env_vars',
    'url',
    'http_headers',
    'env_http_headers',
    'bearer_token_env_var',
  ]);
  const command = typeof raw['command'] === 'string' ? raw['command'] : null;
  const url = typeof raw['url'] === 'string' ? raw['url'] : null;
  if ((command === null) === (url === null)) {
    return {
      ok: false,
      reason: `Serwer MCP „${name}” musi mieć dokładnie jedno z pól command albo url.`,
    };
  }
  const args = raw['args'] === undefined ? [] : stringList(raw['args']);
  if (args === null) {
    return { ok: false, reason: `Argumenty serwera MCP „${name}” nie są listą napisów.` };
  }
  const warnings: string[] = [];
  const env: McpEnvRef[] = [];
  const seen = new Set<string>();
  if (isRecord(raw['env'])) {
    const names = Object.keys(raw['env']);
    for (const key of names) {
      seen.add(key);
      env.push({ name: key, ref: key });
    }
    if (names.length > 0) {
      warnings.push(
        'Wartości zmiennych środowiskowych serwera nie zostały zaimportowane, tylko ich nazwy. Po eksporcie serwer weźmie je ze środowiska.',
      );
    }
  }
  const vars = raw['env_vars'] === undefined ? [] : stringList(raw['env_vars']);
  if (vars === null) {
    return {
      ok: false,
      reason: `Pole env_vars serwera MCP „${name}” nie jest listą nazw, więc serwer nie jest importowany.`,
    };
  }
  for (const key of vars) {
    if (seen.has(key)) continue;
    seen.add(key);
    env.push({ name: key, ref: key });
  }
  // Naglowki (ADR 0062): `bearer_token_env_var` to `Authorization: Bearer ${X}`, `env_http_headers`
  // mapuje nazwe naglowka na nazwe zmiennej, a `http_headers` ma wartosci wprost: zostaje sama nazwa.
  const headers: McpHeaderRef[] = [];
  const bearer = raw['bearer_token_env_var'];
  if (typeof bearer === 'string') {
    headers.push({
      name: 'Authorization',
      ref: ENV_NAME.test(bearer) && !refLooksLikeToken(bearer) ? bearer : null,
      scheme: 'Bearer',
    });
  }
  const fromEnv = isRecord(raw['env_http_headers']) ? raw['env_http_headers'] : {};
  const fixed = isRecord(raw['http_headers']) ? Object.keys(raw['http_headers']) : [];
  for (const key of [...Object.keys(fromEnv), ...fixed]) {
    if (!HEADER_NAME.test(key)) {
      return {
        ok: false,
        reason: `Serwer MCP „${name}”: nazwa nagłówka HTTP ma znaki spoza tokenu HTTP albo jest za długa. Serwer nie jest importowany.`,
      };
    }
  }
  for (const [key, value] of Object.entries(fromEnv)) {
    if (headers.some((h) => h.name.toLowerCase() === key.toLowerCase())) continue;
    headers.push({
      name: key,
      ref:
        typeof value === 'string' && ENV_NAME.test(value) && !refLooksLikeToken(value)
          ? value
          : null,
      scheme: null,
    });
  }
  const literal: string[] = [];
  // Tu `headers` ma jeszcze tylko odniesienia (bearer i env_http_headers); `null` to wartosc zamiast nazwy.
  if (headers.some((h) => h.ref === null)) {
    warnings.push(
      'Część nagłówków HTTP ma zamiast nazwy zmiennej wartość, która nie jest poprawną nazwą albo wygląda na token. Nie została zaimportowana, a serwer bez odniesienia nie przejdzie eksportu.',
    );
  }
  for (const key of fixed) {
    if (headers.some((h) => h.name.toLowerCase() === key.toLowerCase())) continue;
    literal.push(key);
    headers.push({ name: key, ref: null, scheme: null });
  }
  if (literal.length > 0) {
    warnings.push(
      `Nagłówki HTTP ${literal.join(', ')} z http_headers mają wartość wpisaną wprost, która nie została zaimportowana. Bez odniesienia do zmiennej (env_http_headers) serwer nie przejdzie eksportu.`,
    );
  }
  if (headers.some((h) => h.ref !== null)) {
    warnings.push(
      'Z nagłówków HTTP zaimportowane zostały tylko nazwy i odniesienia do zmiennych, bez wartości.',
    );
  }
  const spec: McpServerSpec = {
    name,
    transport: command !== null ? 'stdio' : 'http',
    command,
    args,
    url,
    env,
    headers,
  };
  const secret = nativeTextProblem(spec);
  if (secret !== null) return { ok: false, reason: `Serwer MCP „${name}”: ${secret}` };
  const unmapped = Object.keys(raw).filter((k) => !known.has(k));
  return { ok: true, spec, unmapped, warnings };
}

/** Wartosc pola tabeli Codeksa: napis, lista napisow albo mapa napisow (tabela inline). */
export type CodexFieldValue = string | readonly string[] | Readonly<Record<string, string>>;

/** Pola tabeli Codeksa w kolejnosci zapisu. */
export function toCodexServer(
  spec: McpServerSpec,
  env: readonly McpEnvRef[],
  headers: readonly McpHeaderRef[] = [],
): readonly (readonly [string, CodexFieldValue])[] {
  if (spec.transport !== 'stdio') {
    const fields: [string, CodexFieldValue][] = [['url', spec.url ?? '']];
    // `checkMcpExport` przepuszcza do Codeksa tylko `Bearer` w Authorization i naglowki bez schematu.
    const bearer = headers.find((h) => h.scheme === 'Bearer' && h.ref !== null);
    if (bearer?.ref !== undefined && bearer.ref !== null) {
      fields.push(['bearer_token_env_var', bearer.ref]);
    }
    const plain = headers.filter((h) => h.scheme === null && h.ref !== null);
    if (plain.length > 0) {
      fields.push([
        'env_http_headers',
        Object.fromEntries(plain.map((h) => [h.name, h.ref ?? ''])),
      ]);
    }
    return fields;
  }
  const fields: [string, CodexFieldValue][] = [['command', spec.command ?? '']];
  if (spec.args.length > 0) fields.push(['args', [...spec.args]]);
  if (env.length > 0) fields.push(['env_vars', env.map((e) => e.name)]);
  return fields;
}

/**
 * Wpis z `mcpServers` Gemini CLI (`~/.gemini/settings.json`, `.gemini/settings.json`, ADR 0062).
 * Transport wynika z pola: `command` to stdio, `url` to sse, `httpUrl` to streamable HTTP. `trust`
 * (pomija potwierdzenia narzedzi) nie jest importowany nigdy, takze jako nazwa pola.
 */
export function fromGeminiServer(name: string, raw: unknown): NativeResult {
  if (!isRecord(raw)) return { ok: false, reason: `Serwer MCP „${name}” nie jest obiektem.` };
  const known = new Set(['command', 'args', 'env', 'url', 'httpUrl', 'headers', 'trust']);
  const command = typeof raw['command'] === 'string' ? raw['command'] : null;
  const sse = typeof raw['url'] === 'string' ? raw['url'] : null;
  const http = typeof raw['httpUrl'] === 'string' ? raw['httpUrl'] : null;
  const present = [command, sse, http].filter((v) => v !== null).length;
  if (present !== 1) {
    return {
      ok: false,
      reason: `Serwer MCP „${name}” musi mieć dokładnie jedno z pól command, url albo httpUrl, więc nie jest importowany.`,
    };
  }
  const args = raw['args'] === undefined ? [] : stringList(raw['args']);
  if (args === null) {
    return { ok: false, reason: `Argumenty serwera MCP „${name}” nie są listą napisów.` };
  }
  const warnings: string[] = [];
  if (raw['trust'] === true) {
    warnings.push(
      'Serwer ma w Gemini CLI trust: true (pomija potwierdzenia wywołań narzędzi). To ustawienie nie zostało zaimportowane i eksport go nie zapisze.',
    );
  }
  const env: McpEnvRef[] = [];
  let literal = false;
  if (isRecord(raw['env'])) {
    for (const [key, value] of Object.entries(raw['env'])) {
      const match = typeof value === 'string' ? GEMINI_REFERENCE.exec(value) : null;
      const found = match === null ? undefined : (match[1] ?? match[2]);
      const ref = found !== undefined && refLooksLikeToken(found) ? undefined : found;
      if (ref === undefined) literal = true;
      env.push({ name: key, ref: ref ?? key });
    }
  }
  if (literal) {
    warnings.push(
      'Wartości zmiennych środowiskowych serwera nie zostały zaimportowane, tylko ich nazwy. Po eksporcie serwer weźmie je ze środowiska.',
    );
  }
  const read = readHeaders(raw['headers'], GEMINI_REFERENCE);
  if (typeof read === 'string') return { ok: false, reason: `Serwer MCP „${name}”: ${read}` };
  warnings.push(...read.warnings);
  const spec: McpServerSpec = {
    name,
    transport: command !== null ? 'stdio' : http !== null ? 'http' : 'sse',
    command,
    args,
    url: http ?? sse,
    env,
    headers: read.headers,
  };
  const secret = nativeTextProblem(spec);
  if (secret !== null) return { ok: false, reason: `Serwer MCP „${name}”: ${secret}` };
  const unmapped = Object.keys(raw).filter((k) => !known.has(k));
  return { ok: true, spec, unmapped, warnings };
}

/** Wpis Gemini CLI z odniesieniami zamiast wartosci; bez `trust`, `cwd` i limitow czasu. */
export function toGeminiServer(
  spec: McpServerSpec,
  env: readonly McpEnvRef[],
  headers: readonly McpHeaderRef[] = [],
): JsonValue {
  if (spec.transport === 'stdio') {
    const out: Record<string, JsonValue> = { command: spec.command ?? '', args: [...spec.args] };
    if (env.length > 0) {
      out['env'] = Object.fromEntries(env.map((e) => [e.name, `\${${e.ref}}`]));
    }
    return out;
  }
  const out: Record<string, JsonValue> =
    spec.transport === 'http' ? { httpUrl: spec.url ?? '' } : { url: spec.url ?? '' };
  if (headers.length > 0) out['headers'] = headerObject(headers);
  return out;
}

/** Opis serwera dla podgladu potwierdzenia (bez wartosci). */
export interface McpPreview {
  readonly itemId: ItemId;
  readonly name: string;
  readonly transport: McpTransport;
  /** Polecenie z argumentami albo adres. */
  readonly launch: string;
  readonly env: readonly string[];
  /** Naglowki jako `Nazwa: Bearer ${ZMIENNA}` (ADR 0062), nigdy wartosci. */
  readonly headers: readonly string[];
  /** Jawne zdania dla naglowkow ze zmienna wygladajaca na dane logowania: wartosc trafi do hosta. */
  readonly headerNotices: readonly string[];
  readonly warnings: readonly string[];
  /** Serwer globalny zapisywany do repozytorium projektu: osobne, jawne potwierdzenie (ADR 0061). */
  readonly globalToProject?: boolean;
}

export function mcpPreview(item: LibraryItem, tool: ToolId): McpPreview | null {
  const read = readMcpServer(item);
  if (!read.ok) return null;
  const check = checkMcpExport(read.spec, tool);
  return {
    itemId: item.id,
    name: read.spec.name,
    transport: read.spec.transport,
    launch: read.spec.transport === 'stdio' ? describeLaunch(read.spec) : (check.url ?? ''),
    env: check.env.map((e) => e.ref),
    headers: check.headers.map(describeHeader),
    headerNotices: check.headerNotices,
    warnings: check.warnings,
  };
}
