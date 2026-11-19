import { isSettingsEnvNameDenied, nameLooksSecret, textHasSecret } from '../../cwm/env-policy';
import { redactSecrets } from '../security/secret-redactor';
import type { ItemId, JsonValue, LibraryItem, ToolId } from '../../model/item';

/**
 * Serwer MCP w bibliotece i reguly jego eksportu (ADR 0061). Czyste funkcje, bez I/O: adaptery
 * tlumacza format narzedzia na `McpServerSpec` i z powrotem, a reguly tutaj decyduja, co wolno zapisac.
 *
 * Biblioteka nigdy nie trzyma wartosci zmiennych srodowiskowych ani naglowkow, tylko ich nazwy. Eksport
 * zapisuje odniesienia: `${NAZWA}` w Claude Code, `env_vars = ["NAZWA"]` w Codeksie. Ta sama zasada co
 * `envRef` w manifestach CLI (`core/cwm/resource.ts`), i ten sam test sekretu w tekscie (`textHasSecret`).
 */

export type McpTransport = 'stdio' | 'http' | 'sse';

/** Zmienna srodowiskowa serwera: `name` widzi serwer, `ref` to zmienna u uzytkownika, z ktorej ja bierze. */
export interface McpEnvRef {
  readonly name: string;
  readonly ref: string;
}

export interface McpServerSpec {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly url: string | null;
  readonly env: readonly McpEnvRef[];
  /** Nazwy naglowkow HTTP ze zrodla. Wartosci nie sa importowane. */
  readonly headers: readonly string[];
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
// eslint-disable-next-line no-control-regex -- kontrolujemy dokladnie znaki sterujace
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_TEXT = 4096;
const MAX_ARGS = 128;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Znaki kierunku tekstu i zerowej szerokosci: polecenie wyglada w podgladzie inaczej, niz sie wykona. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
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
    let parsed: URL | null = null;
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
  if (texts.some((t) => INVISIBLE.test(t))) {
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
    headers: [...spec.headers],
  };
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
  const headers = value['headers'] === undefined ? [] : stringList(value['headers']);
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
  /** Ostrzezenia dla planu, po polsku, bez wartosci. */
  readonly warnings: readonly string[];
}

function refuse(reason: string): McpExportCheck {
  return { refusal: reason, url: null, env: [], warnings: [] };
}

function textProblem(label: string, text: string): string | null {
  if (text.length === 0 || text.length > MAX_TEXT || CONTROL_CHARS.test(text)) {
    return `${label} jest puste, za długie albo zawiera znak sterujący.`;
  }
  if (INVISIBLE.test(text)) {
    return `${label} zawiera niewidoczny znak (kierunek tekstu albo zerowa szerokość).`;
  }
  if (text.includes('$')) {
    return `${label} zawiera znak $. Narzędzia rozwijają zmienne w różny sposób, więc eksport przenosi zmienne wyłącznie przez env.`;
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

/**
 * Reguly eksportu jednego serwera do jednego narzedzia (ADR 0061, punkty 2 i 3). Zakres (projekt czy
 * katalog globalny) sprawdza wczesniej `project-scope.ts`, a wybor pliku adapter.
 */
export function checkMcpExport(spec: McpServerSpec, tool: ToolId): McpExportCheck {
  const nameProblem = mcpNameProblem(spec.name);
  if (nameProblem !== null) return refuse(nameProblem);
  if (tool === 'gemini-cli') {
    return refuse('Eksport serwerów MCP do Gemini CLI nie jest jeszcze dostępny (ADR 0061).');
  }
  const warnings: string[] = [];
  let url: string | null = null;
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
    if (spec.headers.length > 0) {
      return refuse(
        `Serwer MCP „${spec.name}” ma nagłówki HTTP (${spec.headers.join(', ')}). Ich wartości to zwykle dane logowania, których eksport nie kopiuje, a serwer bez nich nie zadziała.`,
      );
    }
    warnings.push(`Serwer MCP „${spec.name}” łączy się z adresem: ${url}`);
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
  return { refusal: null, url, env, warnings };
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

/** Te same pola po obu stronach: nazwa, transport, polecenie, argumenty, adres, zmienne i naglowki. */
export function sameMcpServer(a: McpServerSpec, b: McpServerSpec): boolean {
  const key = (s: McpServerSpec): string =>
    JSON.stringify([
      s.transport,
      s.command,
      s.args,
      normalUrl(s.url),
      [...s.env].map((e) => `${e.name}=${e.ref}`).sort(),
      [...s.headers].sort(),
    ]);
  return key(a) === key(b);
}

/** Roznica do pokazania w konflikcie nadpisania: same pola opisu, nigdy wartosci zmiennych. */
export function describeMcpDifference(current: McpServerSpec, next: McpServerSpec): string {
  const lines: string[] = [];
  const show = (s: McpServerSpec): string => `${s.transport}: ${describeLaunch(s)}`;
  if (show(current) !== show(next)) lines.push(`teraz ${show(current)}; po zamianie ${show(next)}`);
  const envOf = (s: McpServerSpec): string =>
    s.env.length === 0 ? 'brak' : s.env.map((e) => e.name).join(', ');
  if (envOf(current) !== envOf(next)) {
    lines.push(`zmienne teraz: ${envOf(current)}; po zamianie: ${envOf(next)}`);
  }
  if (current.headers.length > 0) lines.push(`nagłówki znikną: ${current.headers.join(', ')}`);
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
      const ref = typeof value === 'string' ? ENV_REFERENCE.exec(value)?.[1] : undefined;
      if (ref === undefined) literal = true;
      env.push({ name: key, ref: ref ?? key });
    }
  }
  if (literal) {
    warnings.push(
      'Wartości zmiennych środowiskowych serwera nie zostały zaimportowane, tylko ich nazwy. Po eksporcie serwer weźmie je ze środowiska.',
    );
  }
  const headers = isRecord(raw['headers']) ? Object.keys(raw['headers']) : [];
  if (headers.length > 0) {
    warnings.push('Wartości nagłówków HTTP nie zostały zaimportowane, tylko ich nazwy.');
  }
  const spec: McpServerSpec = {
    name,
    transport,
    command: typeof raw['command'] === 'string' ? raw['command'] : null,
    args,
    url: typeof raw['url'] === 'string' ? raw['url'] : null,
    env,
    headers,
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
export function toClaudeServer(spec: McpServerSpec, env: readonly McpEnvRef[]): JsonValue {
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
  return { type: spec.transport, url: spec.url ?? '' };
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
  const headers = [
    ...(isRecord(raw['http_headers']) ? Object.keys(raw['http_headers']) : []),
    ...(isRecord(raw['env_http_headers']) ? Object.keys(raw['env_http_headers']) : []),
    ...(typeof raw['bearer_token_env_var'] === 'string' ? ['Authorization'] : []),
  ];
  if (headers.length > 0) {
    warnings.push('Wartości nagłówków HTTP nie zostały zaimportowane, tylko ich nazwy.');
  }
  const spec: McpServerSpec = {
    name,
    transport: command !== null ? 'stdio' : 'http',
    command,
    args,
    url,
    env,
    headers: [...new Set(headers)],
  };
  const secret = nativeTextProblem(spec);
  if (secret !== null) return { ok: false, reason: `Serwer MCP „${name}”: ${secret}` };
  const unmapped = Object.keys(raw).filter((k) => !known.has(k));
  return { ok: true, spec, unmapped, warnings };
}

/** Pola tabeli Codeksa w kolejnosci zapisu; wartosci to napisy albo listy napisow. */
export function toCodexServer(
  spec: McpServerSpec,
  env: readonly McpEnvRef[],
): readonly (readonly [string, string | readonly string[]])[] {
  if (spec.transport !== 'stdio') return [['url', spec.url ?? '']];
  const fields: [string, string | readonly string[]][] = [['command', spec.command ?? '']];
  if (spec.args.length > 0) fields.push(['args', [...spec.args]]);
  if (env.length > 0) fields.push(['env_vars', env.map((e) => e.name)]);
  return fields;
}

/** Opis serwera dla podgladu potwierdzenia (bez wartosci). */
export interface McpPreview {
  readonly itemId: ItemId;
  readonly name: string;
  readonly transport: McpTransport;
  /** Polecenie z argumentami albo adres. */
  readonly launch: string;
  readonly env: readonly string[];
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
    warnings: check.warnings,
  };
}
