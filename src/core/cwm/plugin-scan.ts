import { FORBIDDEN_KEYS } from './safe-keys';

/**
 * Wykonywalne deklaracje wewnatrz drzewa pluginu `local` (SEC-04): silnik uruchamia hooki i serwery
 * MCP pluginu bez wlasnego pytania, wiec to one, a nie tylko lista plikow, decyduja o zatwierdzeniu.
 */
export interface ScanFile {
  readonly rel: string;
  readonly bytes: Uint8Array;
}

export interface PluginMcpServer {
  readonly type: string | null;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly url: string | null;
  readonly cwd: string | null;
  readonly envNames: readonly string[];
  readonly headerNames: readonly string[];
  readonly headersHelper: string | null;
}

export interface PluginExecutables {
  /** Polecenia hookow typu command, posortowane, bez powtorzen. */
  readonly hookCommands: readonly string[];
  /** Hooki innych typow (`http: <adres>`, `prompt`, `agent`): tez wykonuja sie przy zdarzeniach. */
  readonly hookOther: readonly string[];
  readonly mcpServers: Readonly<Record<string, PluginMcpServer>>;
  /** Serwery LSP (`.lsp.json`, `lspServers`): silnik uruchamia je jako procesy. */
  readonly lspServers: Readonly<Record<string, PluginMcpServer>>;
  /** Klucze `plugin.json` wskazujace na kod lub pliki (hooks, mcpServers, lspServers, commands, ...), ze sciezkami po normalizacji. */
  readonly manifestRefs: Readonly<Record<string, readonly string[]>>;
  /** Pliki z deklaracjami, ktorych nie dalo sie odczytac jako JSON: zatwierdzenie je pokazuje. */
  readonly unparsed: readonly string[];
  /**
   * Bledy odrzucajace plugin (fail closed): odwolanie poza drzewo lub do brakujacego pliku, nieznany
   * klucz `plugin.json`, klucz o zlym typie.
   */
  readonly errors: readonly string[];
}

const HOOKS_FILE = 'hooks/hooks.json';
const MCP_FILE = '.mcp.json';
const LSP_FILE = '.lsp.json';
const MANIFEST_FILE = '.claude-plugin/plugin.json';
const MAX_DEPTH = 24;
const ROOT_VARIABLE = /^\$\{CLAUDE_PLUGIN_ROOT\}\/?|^\.\//;

/** Klucze `plugin.json` bez wplywu na wykonanie. Kazdy inny, spoza list ponizej, jest odrzucany. */
const METADATA_KEYS = new Set([
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
]);
/** Klucze z deklaracjami procesow: sciezka do pliku JSON albo obiekt inline. */
const PROCESS_KEYS = ['hooks', 'mcpServers', 'lspServers'] as const;
/** Klucze ze sciezkami do tresci pluginu (pliki lub katalogi), ktora silnik wczyta. */
const CONTENT_KEYS = ['commands', 'agents', 'skills', 'outputStyles'] as const;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const names = (value: unknown): string[] =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.keys(value)
        .filter((key) => !FORBIDDEN_KEYS.has(key))
        .sort()
    : [];

function parseJson(file: ScanFile | undefined): { ok: true; value: unknown } | { ok: false } {
  if (file === undefined) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(file.bytes)) as unknown };
  } catch {
    return { ok: false };
  }
}

function collectHooks(node: unknown, commands: Set<string>, other: Set<string>, depth = 0): void {
  if (depth > MAX_DEPTH || typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node as unknown[]) collectHooks(item, commands, other, depth + 1);
    return;
  }
  const record = node as Record<string, unknown>;
  const type = str(record['type']);
  const command = str(record['command']);
  if (command !== null && (type === null || type === 'command')) commands.add(command);
  else if (type !== null && type !== 'command' && ('url' in record || 'prompt' in record)) {
    other.add(`${type}: ${str(record['url']) ?? str(record['prompt']) ?? ''}`);
  }
  for (const [key, child] of Object.entries(record)) {
    if (!FORBIDDEN_KEYS.has(key)) collectHooks(child, commands, other, depth + 1);
  }
}

function serverOf(raw: unknown): PluginMcpServer | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    type: str(r['type']),
    command: str(r['command']),
    args: Array.isArray(r['args']) ? (r['args'] as unknown[]).map((a) => String(a)) : [],
    url: str(r['url']),
    cwd: str(r['cwd']),
    envNames: names(r['env']),
    headerNames: names(r['headers']),
    headersHelper: str(r['headersHelper']),
  };
}

function collectServers(
  value: unknown,
  into: Record<string, PluginMcpServer>,
  origin: string,
  wrapper: 'mcpServers' | 'lspServers',
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const map =
    typeof record[wrapper] === 'object' && record[wrapper] !== null
      ? (record[wrapper] as Record<string, unknown>)
      : record;
  for (const name of Object.keys(map).sort()) {
    if (FORBIDDEN_KEYS.has(name)) continue;
    const server = serverOf(map[name]);
    if (server !== null) into[`${origin}:${name}`] = server;
  }
}

type Ref =
  { readonly ok: true; readonly rel: string } | { readonly ok: false; readonly why: string };

/** Sciezka z `plugin.json` po zdjeciu `${CLAUDE_PLUGIN_ROOT}`: wzgledna, bez `..`, bez wyjscia z drzewa. */
function resolveRef(text: string): Ref {
  const stripped = text.replace(ROOT_VARIABLE, '');
  if (
    stripped === '' ||
    stripped.startsWith('/') ||
    stripped.includes('\\') ||
    stripped.includes('\0') ||
    stripped.includes('$')
  ) {
    return { ok: false, why: 'sciezka poza drzewem pluginu' };
  }
  const parts = stripped.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    return { ok: false, why: 'sciezka poza drzewem pluginu' };
  }
  return { ok: true, rel: parts.join('/') };
}

/**
 * Czyta `hooks/hooks.json`, `.mcp.json`, `.lsp.json` i `.claude-plugin/plugin.json` oraz pliki, na ktore
 * wskazuje manifest. Nazwy plikow dopasowujemy bez rozroznienia wielkosci liter (APFS i NTFS tak je
 * widza, a `readTree` odrzuca kolizje). Odwolanie poza drzewo, brakujacy plik, nieznany klucz
 * manifestu i klucz o zlym typie to bledy, a nie ciche pominiecie.
 */
export function extractPluginExecutables(files: readonly ScanFile[]): PluginExecutables {
  const byLower = new Map(files.map((file) => [file.rel.toLowerCase(), file]));
  const commands = new Set<string>();
  const other = new Set<string>();
  const mcp: Record<string, PluginMcpServer> = Object.create(null) as Record<
    string,
    PluginMcpServer
  >;
  const lsp: Record<string, PluginMcpServer> = Object.create(null) as Record<
    string,
    PluginMcpServer
  >;
  const unparsed = new Set<string>();
  const errors: string[] = [];
  const refs: Record<string, string[]> = Object.create(null) as Record<string, string[]>;

  const find = (rel: string): ScanFile | undefined => byLower.get(rel.toLowerCase());
  const load = (rel: string): unknown => {
    const file = find(rel);
    const parsed = parseJson(file);
    if (!parsed.ok) {
      if (file !== undefined) unparsed.add(file.rel);
      return undefined;
    }
    return parsed.value;
  };
  const collect = (kind: (typeof PROCESS_KEYS)[number], value: unknown, origin: string): void => {
    if (kind === 'hooks') collectHooks(value, commands, other);
    else if (kind === 'mcpServers') collectServers(value, mcp, origin, 'mcpServers');
    else collectServers(value, lsp, origin, 'lspServers');
  };

  collect('hooks', load(HOOKS_FILE), HOOKS_FILE);
  collect('mcpServers', load(MCP_FILE), MCP_FILE);
  collect('lspServers', load(LSP_FILE), LSP_FILE);

  const manifestFile = find(MANIFEST_FILE);
  const manifest = load(MANIFEST_FILE);
  if (manifestFile !== undefined && (typeof manifest !== 'object' || manifest === null)) {
    errors.push(`${MANIFEST_FILE}: manifest pluginu nie jest obiektem JSON.`);
  }
  if (typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)) {
    const m = manifest as Record<string, unknown>;
    const listOf = (key: string): string[] | null => {
      const value = m[key];
      const items = Array.isArray(value) ? (value as unknown[]) : [value];
      return items.every((item) => typeof item === 'string') ? items : null;
    };
    const reference = (key: string, text: string, kind: 'file' | 'content'): string | null => {
      const ref = resolveRef(text);
      if (!ref.ok) {
        errors.push(`plugin.json ${key}: ${ref.why} (${text}).`);
        return null;
      }
      const lower = ref.rel.toLowerCase();
      const exists =
        kind === 'file'
          ? byLower.has(lower)
          : byLower.has(lower) || [...byLower.keys()].some((k) => k.startsWith(`${lower}/`));
      if (!exists) {
        errors.push(`plugin.json ${key}: brak pliku w drzewie pluginu (${ref.rel}).`);
        return null;
      }
      (refs[key] ??= []).push(ref.rel);
      return ref.rel;
    };

    for (const key of Object.keys(m).sort()) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const value = m[key];
      if (METADATA_KEYS.has(key)) continue;
      if ((PROCESS_KEYS as readonly string[]).includes(key)) {
        const kind = key as (typeof PROCESS_KEYS)[number];
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          (refs[key] ??= []).push('(inline)');
          collect(kind, kind === 'hooks' ? value : { [kind]: value }, MANIFEST_FILE);
          continue;
        }
        const list = listOf(key);
        if (list === null || value === undefined) {
          errors.push(`plugin.json ${key}: oczekiwano sciezki, listy sciezek albo obiektu.`);
          continue;
        }
        for (const text of list) {
          const rel = reference(key, text, 'file');
          if (rel !== null) collect(kind, load(rel), rel);
        }
      } else if ((CONTENT_KEYS as readonly string[]).includes(key)) {
        const list = listOf(key);
        if (list === null || value === undefined) {
          errors.push(`plugin.json ${key}: oczekiwano sciezki albo listy sciezek.`);
          continue;
        }
        for (const text of list) reference(key, text, 'content');
      } else {
        errors.push(
          `plugin.json: nieznany klucz "${key}" (moze uruchamiac procesy); plugin odrzucony.`,
        );
      }
    }
  }
  return {
    hookCommands: [...commands].sort(),
    hookOther: [...other].sort(),
    mcpServers: mcp,
    lspServers: lsp,
    manifestRefs: refs,
    unparsed: [...unparsed].sort(),
    errors,
  };
}
