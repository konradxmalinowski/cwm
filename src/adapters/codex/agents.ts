import type { ItemAttributes, ItemDraft, JsonValue, ReasoningDepth } from '../../core/model/item';
import { isIgnoredPath } from '../../core/model/library-file-names';
import {
  SourceReadError,
  type SourceEntry,
  type SourceReader,
} from '../../core/ports/source-reader';
import type { ImportWarning } from '../../core/ports/tool-adapter';
import { slugDeclaredNameWarning } from '../../core/services/library/validate';
import { deriveDescription, deriveSlug } from '../shared/slug';
import { ScanContext } from '../shared/scan-context';
import { TextDecodeError, toParsableText } from '../shared/text';
import { readToml, tomlString, tomlToJson, type TomlIssue, type TomlValue } from '../shared/toml';

const CONFIG_FILE = 'config.toml';
const TOML_EXTENSION = /\.toml$/i;
const KNOWN_AGENT_KEYS = new Set([
  'name',
  'description',
  'developer_instructions',
  'model_reasoning_effort',
]);

// Przyblizenie, bo poziomow Codeksa jest wiecej niz trzy (ADR 0023). Nieznana wartosc zostaje
// w `unmappedKeys`, a dokladny tekst i tak jest w snapshocie.
export const EFFORT_DEPTH: Readonly<Record<string, ReasoningDepth>> = {
  minimal: 'routine',
  low: 'routine',
  medium: 'deep',
  high: 'deep',
  xhigh: 'deepest',
};

export interface RegistryEntry {
  readonly name: string;
  readonly description: string | null;
  readonly configFile: string | null;
  readonly extra: readonly { readonly key: string; readonly value: JsonValue }[];
}

export interface Registry {
  readonly entries: readonly RegistryEntry[];
}

/**
 * Wpis `[agents.<nazwa>]` jest jedynym fragmentem `config.toml`, jaki importujemy. Reszta pliku
 * (serwery MCP z `env`, tokeny, projekty) jest parsowana tylko po to, zeby trafic w granice
 * sekcji, i nie trafia ani do snapshotu, ani do szkicu.
 */
export async function readRegistry(ctx: ScanContext): Promise<Registry | null> {
  let bytes: Uint8Array;
  try {
    bytes = await ctx.read('');
  } catch (error) {
    if (error instanceof SourceReadError && error.failure === 'not-found') return { entries: [] };
    ctx.skipFromError(error, CONFIG_FILE);
    return null;
  }
  let text: string;
  try {
    text = toParsableText(bytes);
  } catch (error) {
    if (!(error instanceof TextDecodeError)) throw error;
    ctx.skip(CONFIG_FILE, 'malformed', `Plik "${CONFIG_FILE}" nie jest poprawnym tekstem UTF-8.`);
    return null;
  }
  const result = readToml(
    text,
    (path, array) => path[0] === 'agents' && !array && path.length <= 2,
  );
  reportTomlIssues(ctx, CONFIG_FILE, result.issues);

  const entries: RegistryEntry[] = [];
  for (const table of result.tables) {
    if (table.path.length === 2) {
      entries.push(entryFrom(table.path[1] ?? '', table.values));
    } else if (table.path.length === 1) {
      // `[agents]` z wpisami inline: `acme = { description = "...", config_file = "..." }`.
      for (const [name, value] of table.values) {
        if (typeof value === 'object' && !Array.isArray(value)) {
          const inner = new Map(Object.entries(value as { readonly [k: string]: TomlValue }));
          entries.push(entryFrom(name, inner));
        } else {
          ctx.skip(
            `${CONFIG_FILE}#agents.${name}`,
            'unsupported',
            `Wpis agents.${name} w "${CONFIG_FILE}" ma postać, której importer nie czyta.`,
          );
        }
      }
    }
  }
  return { entries };
}

function entryFrom(name: string, values: ReadonlyMap<string, TomlValue>): RegistryEntry {
  const extra: { key: string; value: JsonValue }[] = [];
  for (const [key, value] of values) {
    if (key !== 'description' && key !== 'config_file')
      extra.push({ key, value: tomlToJson(value) });
  }
  return {
    name,
    description: tomlString(values.get('description')),
    configFile: tomlString(values.get('config_file')),
    extra,
  };
}

/**
 * `config_file` bywa zapisany jako `agents/x.toml`, `./agents/x.toml`, `~/.codex/agents/x.toml`
 * albo sciezka bezwzgledna. Sprowadzamy go do sciezki w obrebie roota albo `null`, gdy wskazuje
 * gdzie indziej. Adapter nie wyprowadza sciezek z domu, wiec wystarcza przyrostek po `.codex/`.
 */
export function registryTarget(configFile: string): string | null {
  const normalized = configFile.trim().replace(/\\/g, '/');
  const home = /(?:^|\/)\.codex\/(.+)$/.exec(normalized);
  let rel: string;
  if (home !== null) rel = home[1] ?? '';
  else if (/^([A-Za-z]:|\/|~)/.test(normalized)) return null;
  else rel = normalized.replace(/^(\.\/)+/, '');
  const segments = rel.split('/');
  if (rel === '' || segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return rel;
}

function reportTomlIssues(ctx: ScanContext, file: string, issues: readonly TomlIssue[]): void {
  if (issues.length === 0) return;
  const shown = issues
    .slice(0, 3)
    .map((i) => `linia ${i.line}: ${i.message}`)
    .join('; ');
  ctx.skip(
    file,
    'malformed',
    `Plik "${file}" zawiera składnię, której importer nie rozumie (${shown}). Część wpisów może być pominięta.`,
  );
}

/**
 * Agenci Codeksa z katalogu `agents/`. Root `agents` nie widzi `config.toml` (to osobny root),
 * wiec rejestracji tu nie sprawdzamy, tylko to mowimy. Zwraca nazwy plikow `.toml`, zeby skan
 * rejestru mogl je zestawic z wpisami.
 */
export async function scanCodexAgents(ctx: ScanContext): Promise<ReadonlySet<string>> {
  let entries: readonly SourceEntry[];
  try {
    entries = await ctx.list('');
  } catch (error) {
    ctx.skipFromError(error, '');
    return new Set();
  }
  const listed = new Set<string>();
  for (const entry of entries) {
    if (isIgnoredPath(entry.name)) continue;
    if (entry.type === 'directory' || !TOML_EXTENSION.test(entry.name)) {
      ctx.skip(entry.name, 'not-an-element', `"${entry.name}" nie jest plikiem agenta (.toml).`);
      continue;
    }
    listed.add(entry.name);
    try {
      let readPath = entry.name;
      if (entry.type === 'symlink') {
        const target = await ctx.follow(entry.name);
        if (target.outside) {
          ctx.skip(
            entry.name,
            'symlink-outside',
            `"${entry.name}" wskazuje poza wybrany katalog i nie jest śledzone.`,
          );
          continue;
        }
        if (target.type !== 'file') {
          ctx.skip(
            entry.name,
            'unsupported',
            `"${entry.name}" jest dowiązaniem do czegoś, co nie jest plikiem.`,
          );
          continue;
        }
        readPath = target.relPath;
      }
      const bytes = await ctx.read(readPath);
      buildAgent(ctx, {
        display: entry.name,
        stem: entry.name.replace(TOML_EXTENSION, ''),
        bytes,
        mode: await ctx.mode(readPath),
        aliasKey: ctx.aliasKey(readPath),
      });
    } catch (error) {
      ctx.skipFromError(error, entry.name);
    }
  }
  return listed;
}

/** Problemy samego rejestru oraz wpisy bez pliku (gdy znamy pliki z katalogu agentow). */
export function reportRegistry(
  ctx: ScanContext,
  registry: Registry,
  agentFiles: ReadonlySet<string> | null,
): void {
  const targets = new Set<string>();
  for (const entry of registry.entries) {
    const shown = `${CONFIG_FILE}#agents.${entry.name}`;
    if (entry.configFile === null) {
      ctx.skip(
        shown,
        'malformed',
        `Wpis agents.${entry.name} nie ma klucza config_file, więc Codex nie znajdzie pliku agenta.`,
      );
      continue;
    }
    const target = registryTarget(entry.configFile);
    if (target === null || !/^agents\/[^/]+$/.test(target)) {
      ctx.skip(
        shown,
        'unsupported',
        `Wpis agents.${entry.name} wskazuje plik poza katalogiem agents Codeksa i nie jest sprawdzany.`,
      );
      continue;
    }
    const file = target.slice('agents/'.length);
    if (targets.has(file)) {
      ctx.skip(shown, 'malformed', `Wpis agents.${entry.name} wskazuje ten sam plik co inny wpis.`);
      continue;
    }
    targets.add(file);
    if (agentFiles !== null && !agentFiles.has(file)) {
      ctx.skip(
        shown,
        'malformed',
        `Wpis agents.${entry.name} wskazuje plik "${target}", którego nie ma. Codex nie załaduje tego agenta.`,
      );
    }
  }
}

interface AgentInput {
  readonly display: string;
  readonly stem: string;
  readonly bytes: Uint8Array;
  readonly mode: number | null;
  readonly aliasKey: string;
}

function buildAgent(ctx: ScanContext, input: AgentInput): void {
  let text: string;
  try {
    text = toParsableText(input.bytes);
  } catch (error) {
    if (!(error instanceof TextDecodeError)) throw error;
    ctx.skip(
      input.display,
      'malformed',
      `Plik "${input.display}" nie jest poprawnym tekstem UTF-8.`,
    );
    return;
  }
  const parsed = readToml(text, (path, array) => path.length === 0 && !array);
  const values = parsed.tables[0]?.values ?? new Map<string, TomlValue>();
  if (parsed.issues.length > 0 && values.size === 0) {
    const first = parsed.issues[0];
    ctx.skip(
      input.display,
      'malformed',
      `Plik "${input.display}" nie jest poprawnym TOML-em (linia ${first?.line ?? 1}: ${first?.message ?? 'błąd składni'}).`,
    );
    return;
  }

  const warnings: ImportWarning[] = parsed.issues.slice(0, 5).map((i) => ({
    code: 'toml-syntax',
    message: `Linia ${i.line} pliku agenta: ${i.message} Pominięto ją.`,
  }));
  const unmapped: { path: string; value: JsonValue }[] = [];

  const declaredName = textOrNull(values.get('name'));
  const instructions = tomlString(values.get('developer_instructions'));
  if (instructions === null) {
    warnings.push({
      code: 'agent-no-instructions',
      message: 'Plik agenta nie ma developer_instructions, więc treść agenta jest pusta.',
    });
  }
  const body = instructions ?? '';
  const sourceDescription = textOrNull(values.get('description'));
  const description = sourceDescription ?? deriveDescription(body);
  if (sourceDescription === null) {
    warnings.push({
      code: 'description-derived',
      message: 'Plik agenta nie ma opisu. Opis wyliczono z pierwszego akapitu treści.',
    });
  }

  const attributes: { -readonly [K in keyof ItemAttributes]: ItemAttributes[K] } = {};
  const effort = textOrNull(values.get('model_reasoning_effort'));
  const depth = effort === null ? undefined : EFFORT_DEPTH[effort.toLowerCase()];
  if (depth !== undefined) attributes.reasoningDepth = depth;
  else if (effort !== null) unmapped.push({ path: 'toml.model_reasoning_effort', value: effort });

  for (const key of ['name', 'description', 'developer_instructions'] as const) {
    const v = values.get(key);
    if (v !== undefined && typeof v !== 'string') {
      unmapped.push({ path: `toml.${key}`, value: tomlToJson(v) });
      warnings.push({
        code: 'toml-field-not-text',
        message: `Pole "${key}" agenta nie jest tekstem, więc nie zostało użyte.`,
      });
    }
  }
  for (const [key, value] of values) {
    if (!KNOWN_AGENT_KEYS.has(key))
      unmapped.push({ path: `toml.${key}`, value: tomlToJson(value) });
  }

  const slug = deriveSlug(input.stem);
  if (slug.changed) {
    warnings.push({
      code: 'slug-derived',
      message: `Nazwa "${input.stem}" nie nadaje się na bezpieczną nazwę elementu. Użyto "${slug.slug}"; oryginał zostaje jako alias.`,
    });
  }
  const identity = { slug: slug.slug, declaredName, aliases: slug.changed ? [input.stem] : [] };
  const mismatch = slugDeclaredNameWarning(identity);
  if (mismatch !== null) warnings.push(mismatch);

  warnings.push({
    code: 'agent-registration-unchecked',
    message:
      'Rejestracji agenta w config.toml nie sprawdzono: to osobna lokalizacja. Codex nie załaduje agenta bez wpisu [agents.<nazwa>].',
  });

  ctx.add({
    relPath: input.display,
    kind: 'agent',
    draft: {
      kind: 'agent',
      identity,
      content: {
        title: declaredName ?? slug.slug,
        description,
        descriptionOrigin: sourceDescription === null ? 'derived' : 'source',
        body,
      },
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      assets: [],
      source: {
        snapshots: [
          {
            tool: ctx.tool,
            files: [{ relPath: input.display, bytes: input.bytes, mode: input.mode }],
            unmappedKeys: unmapped,
          },
        ],
        importedFrom: null,
      },
    },
    warnings,
    aliasKey: input.aliasKey,
  });
}

function textOrNull(value: TomlValue | undefined): string | null {
  const s = tomlString(value);
  return s === null || s.trim() === '' ? null : s.trim();
}

/** Nazwa pliku w katalogu agents, na ktory wskazuje wpis, albo `null`. */
export function registeredFile(entry: RegistryEntry): string | null {
  if (entry.configFile === null) return null;
  const target = registryTarget(entry.configFile);
  return target !== null && /^agents\/[^/]+$/.test(target) ? target.slice('agents/'.length) : null;
}

/** Czytnik, ktory nigdy nie jest wolany: `buildAgent` dostaje bajty, nie czyta zrodla. */
const NO_READER: SourceReader = {
  list: () => Promise.reject(new Error('Czytnik nie jest uzywany przy parsowaniu bajtow.')),
  read: () => Promise.reject(new Error('Czytnik nie jest uzywany przy parsowaniu bajtow.')),
  resolveSymlink: () =>
    Promise.reject(new Error('Czytnik nie jest uzywany przy parsowaniu bajtow.')),
  mode: () => Promise.resolve(null),
};

/** Szkic agenta z samych bajtow pliku `.toml` (eksport porownuje nim snapshot z elementem). */
export function parseAgentDraft(bytes: Uint8Array, stem: string): ItemDraft | null {
  const ctx = new ScanContext(
    'codex',
    { rootId: 'parse', tool: 'codex', kind: 'agents', label: 'agents', exists: true, active: true },
    NO_READER,
  );
  buildAgent(ctx, { display: `${stem}.toml`, stem, bytes, mode: null, aliasKey: '' });
  return ctx.candidates[0]?.draft ?? null;
}

/** `model_reasoning_effort` z pliku agenta albo null. */
export function agentEffort(bytes: Uint8Array): string | null {
  try {
    const parsed = readToml(toParsableText(bytes), (path, array) => path.length === 0 && !array);
    return textOrNull(parsed.tables[0]?.values.get('model_reasoning_effort'));
  } catch {
    return null;
  }
}
