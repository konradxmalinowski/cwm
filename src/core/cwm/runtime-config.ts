import type { SettingsBundle } from './merge-settings';
import type { McpServer } from './resource';
import { namespaceOf } from './kinds';

/** Serwery MCP zawsze z przedrostkiem firmy: `--mcp-config` przesiada serwer o tej samej nazwie (V-02), ale tylko prefiks daje pewnosc. */
export function mcpServerName(company: string, id: string): string {
  return `cwm-${company}-${id.slice(namespaceOf(id).length + 1)}`;
}

/** Nazwa pluginu CWM z zasobami obowiazkowymi; silnik poprzedza nia nazwy skilli, agentow i komend. */
export const cwmPluginName = (company: string): string => `cwm-${company}`;

export function formatJson(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function hooksOf(bundle: SettingsBundle): Record<string, unknown> | null {
  const events = Object.keys(bundle.hooks);
  if (events.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const event of events) {
    out[event] = (bundle.hooks[event] ?? []).map((group) => ({
      ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
      hooks: group.hooks.map((hook) => ({
        type: hook.type,
        command: hook.command,
        ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
      })),
    }));
  }
  return out;
}

function permissionsOf(bundle: SettingsBundle): Record<string, unknown> | null {
  const p = bundle.permissions;
  const out: Record<string, unknown> = {};
  if (p.allow.length > 0) out['allow'] = [...p.allow];
  if (p.deny.length > 0) out['deny'] = [...p.deny];
  if (p.ask.length > 0) out['ask'] = [...p.ask];
  if (p.defaultMode !== undefined) out['defaultMode'] = p.defaultMode;
  if (p.additionalDirectories.length > 0)
    out['additionalDirectories'] = [...p.additionalDirectories];
  return Object.keys(out).length > 0 ? out : null;
}

/** Tylko wartosci wpisane wprost. `envRef` trafia wylacznie do srodowiska procesu (SET-02). */
function envValuesOf(bundle: SettingsBundle): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(bundle.env)) {
    if ('value' in entry) out[name] = entry.value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function baseSettings(bundle: SettingsBundle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const hooks = hooksOf(bundle);
  const permissions = permissionsOf(bundle);
  const env = envValuesOf(bundle);
  if (hooks) out['hooks'] = hooks;
  if (permissions) out['permissions'] = permissions;
  if (env) out['env'] = env;
  if (bundle.attribution !== undefined) out['attribution'] = { ...bundle.attribution };
  if (bundle.preferences !== undefined) {
    const { voice, ...rest } = bundle.preferences;
    Object.assign(out, rest);
    if (voice !== undefined) out['voice'] = { ...voice };
  }
  return out;
}

/** `settings.json` profilu (poziom uzytkownika) z Settings bez `enforce`. Null, gdy nie ma czego zapisac. */
export function buildProfileSettings(regular: SettingsBundle): Record<string, unknown> | null {
  const out = baseSettings(regular);
  return Object.keys(out).length > 0 ? out : null;
}

export interface RunSettingsOptions {
  /** Klucze izolacji od konta claude.ai (PRF-08); wylacza je opcja firmy `runtime.isolation: false`. */
  readonly isolation: boolean;
}

/**
 * Jedyny plik `--settings` uruchomienia: Settings z `enforce`, klucze izolacji i, gdy sa hooki
 * enforce, jawne `disableAllHooks: false` (V-05: projektowe `true` wylaczyloby tez hooki firmy).
 */
export function buildRunSettings(
  enforced: SettingsBundle,
  options: RunSettingsOptions,
): Record<string, unknown> {
  const out = baseSettings(enforced);
  if (out['hooks'] !== undefined) out['disableAllHooks'] = false;
  if (options.isolation) {
    out['syncClaudeAiPlugins'] = false;
    out['syncClaudeAiSkills'] = false;
    out['disableClaudeAiConnectors'] = true;
  }
  return out;
}

export interface McpConfigResult {
  readonly document: { readonly mcpServers: Record<string, unknown> };
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** `mcp.json` z samymi odwolaniami `${NAZWA}` (MCP-01, MCP-03): wartosci sekretow nie trafiaja do pliku. */
export function buildMcpConfig(
  company: string,
  servers: readonly McpServer[],
  /** id serwera -> bezwzgledna sciezka pliku polecenia po `realpath` (SEC-01): to ona trafia do pliku, nie sciezka wzgledna. */
  commandPaths: Readonly<Record<string, string>> = {},
): McpConfigResult {
  const mcpServers: Record<string, unknown> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const server of servers) {
    const name = mcpServerName(company, server.id);
    if (Object.hasOwn(mcpServers, name)) {
      errors.push(`Dwa serwery MCP dawalyby nazwe ${name}.`);
      continue;
    }
    if (server.transport === 'stdio') {
      const env: Record<string, string> = {};
      for (const [key, entry] of Object.entries(server.env)) {
        if ('envRef' in entry) env[key] = `\${${entry.envRef}}`;
      }
      mcpServers[name] = {
        type: 'stdio',
        command: commandPaths[server.id] ?? server.command ?? '',
        args: [...server.args],
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    } else {
      if (Object.keys(server.env).length > 0) {
        warnings.push(`${server.id}: env jest pomijane dla transportu ${server.transport}.`);
      }
      mcpServers[name] = { type: server.transport, url: server.url ?? '' };
    }
  }
  return { document: { mcpServers }, errors, warnings };
}

/** Nazwa w silniku -> zmienna u uzytkownika, dla wpisow `Settings.env` z `envRef` (obie paczki). */
export function settingsEnvRefs(bundles: readonly SettingsBundle[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const bundle of bundles) {
    for (const [name, entry] of Object.entries(bundle.env)) {
      if ('envRef' in entry) out[name] = entry.envRef;
    }
  }
  return out;
}

export function mcpEnvRefs(servers: readonly McpServer[]): string[] {
  const refs = new Set<string>();
  for (const server of servers) {
    for (const entry of Object.values(server.env)) if ('envRef' in entry) refs.add(entry.envRef);
  }
  return [...refs].sort();
}
