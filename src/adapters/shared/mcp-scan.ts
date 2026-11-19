import { SourceReadError } from '../../core/ports/source-reader';
import type { JsonValue } from '../../core/model/item';
import type { ImportWarning } from '../../core/ports/tool-adapter';
import {
  describeLaunch,
  fromClaudeServer,
  fromCodexServer,
  fromGeminiServer,
  mcpSettingKey,
  mcpSettingValue,
  type NativeResult,
} from '../../core/services/mcp/mcp-server';
import { isRecord } from './hooks';
import type { ScanContext } from './scan-context';
import { deriveSlug } from './slug';
import { TextDecodeError, encodeUtf8, toParsableText } from './text';
import { parseTree } from './toml/segment-editor';

/**
 * Import serwerow MCP (ADR 0061, ADR 0062): jeden serwer to jeden element `tool-setting`. Do biblioteki trafia
 * struktura (transport, polecenie, argumenty, adres) i nazwy zmiennych oraz naglowkow, nigdy ich wartosci.
 * Serwer, ktorego polecenie, argument albo adres wyglada na sekret, nie jest importowany wcale.
 * Snapshot to `server.json` z tym samym opisem bez wartosci: z pliku zrodla (np. `~/.claude.json`) nic
 * poza tym wpisem nie jest kopiowane.
 */

function addServers(
  ctx: ScanContext,
  servers: Record<string, unknown>,
  file: string,
  area: string,
  read: (name: string, raw: unknown) => NativeResult,
): void {
  for (const [name, raw] of Object.entries(servers)) {
    const relPath = `${file}#${area}/${name}`;
    const result = read(name, raw);
    if (!result.ok) {
      ctx.skip(relPath, 'unsupported', result.reason);
      continue;
    }
    const { spec } = result;
    const warnings: ImportWarning[] = result.warnings.map((message) => ({
      code: 'mcp-values-not-imported',
      message,
    }));
    const slug = deriveSlug(`mcp-${name}`);
    const value = mcpSettingValue(spec);
    const snapshot = `${JSON.stringify({ name, ...(value as Record<string, JsonValue>) }, null, 2)}\n`;
    if (slug.changed) {
      warnings.push({
        code: 'slug-derived',
        message: `Nazwa serwera "${name}" nie nadaje się na bezpieczną nazwę elementu. Użyto "${slug.slug}".`,
      });
    }
    ctx.add({
      relPath,
      kind: 'tool-setting',
      draft: {
        kind: 'tool-setting',
        identity: {
          slug: slug.slug,
          declaredName: null,
          aliases: slug.changed ? [`mcp-${name}`] : [],
        },
        content: {
          title: `Serwer MCP ${name}`,
          description: `${spec.transport}: ${describeLaunch(spec)}`,
          descriptionOrigin: 'derived',
          body: '',
        },
        attributes: {
          toolSetting: {
            tool: ctx.tool,
            key: mcpSettingKey(ctx.tool, name),
            value,
          },
        },
        assets: [],
        source: {
          snapshots: [
            {
              tool: ctx.tool,
              files: [{ relPath: 'server.json', bytes: encodeUtf8(snapshot), mode: null }],
              // Same nazwy pol: wartosci (np. `oauth`, `timeout`) moga niesc dane logowania.
              unmappedKeys: result.unmapped.map((key) => ({ path: `server.${key}`, value: null })),
            },
          ],
          importedFrom: null,
        },
      },
      warnings,
      aliasKey: null,
    });
  }
}

async function readText(ctx: ScanContext, file: string): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = await ctx.read('');
  } catch (error) {
    if (error instanceof SourceReadError && error.failure === 'not-found') return null;
    ctx.skipFromError(error, file);
    return null;
  }
  try {
    return toParsableText(bytes);
  } catch (error) {
    if (!(error instanceof TextDecodeError)) throw error;
    ctx.skip(file, 'malformed', `Plik "${file}" nie jest poprawnym tekstem UTF-8.`);
    return null;
  }
}

/** `~/.claude.json` albo `.mcp.json`: czytany jest wylacznie klucz `mcpServers`. */
export function scanClaudeMcp(ctx: ScanContext, file: string): Promise<void> {
  return scanJsonMcp(ctx, file, fromClaudeServer);
}

/**
 * `settings.json` Gemini CLI (ADR 0062), globalny albo projektu: wylacznie klucz `mcpServers`. Reszta
 * pliku (ustawienia, uwierzytelnianie, hooki) nie trafia do elementu ani do snapshotu.
 */
export function scanGeminiMcp(ctx: ScanContext): Promise<void> {
  return scanJsonMcp(ctx, 'settings.json', fromGeminiServer);
}

async function scanJsonMcp(
  ctx: ScanContext,
  file: string,
  read: (name: string, raw: unknown) => NativeResult,
): Promise<void> {
  const text = await readText(ctx, file);
  if (text === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    ctx.skip(file, 'malformed', `Plik "${file}" nie jest poprawnym JSON-em.`);
    return;
  }
  if (!isRecord(parsed)) {
    ctx.skip(file, 'malformed', `Plik "${file}" nie zawiera obiektu JSON.`);
    return;
  }
  const servers = parsed['mcpServers'];
  if (servers === undefined) return;
  if (!isRecord(servers)) {
    ctx.skip(file, 'malformed', `Klucz "mcpServers" w "${file}" nie jest obiektem.`);
    return;
  }
  addServers(ctx, servers, file, 'mcpServers', read);
}

/** `config.toml` Codeksa: tabele `[mcp_servers.<nazwa>]`. */
export async function scanCodexMcp(ctx: ScanContext, file: string): Promise<void> {
  const text = await readText(ctx, file);
  if (text === null) return;
  const tree = parseTree(text);
  if (typeof tree === 'string') return;
  const servers = tree['mcp_servers'];
  if (servers === undefined) return;
  if (!isRecord(servers)) {
    ctx.skip(`${file}#mcp_servers`, 'malformed', `Klucz mcp_servers w "${file}" nie jest tabelą.`);
    return;
  }
  addServers(ctx, servers, file, 'mcp_servers', fromCodexServer);
}
