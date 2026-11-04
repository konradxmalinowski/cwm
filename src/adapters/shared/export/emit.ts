import type { JsonValue } from '../../../core/model/item';
import { tomlString } from '../toml/segment-editor';
import type { FrontmatterResult, YamlValue } from '../frontmatter';

/** Pisanie plikow elementow: frontmatter YAML i agent TOML. Wynik czyta ten sam parser, co import. */

const PLAIN = /^[A-Za-z][A-Za-z0-9 _./()-]*$/;
const RESERVED = /^(null|true|false|yes|no|on|off)$/i;

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (PLAIN.test(value) && !RESERVED.test(value) && !value.endsWith(' ')) return value;
  return JSON.stringify(value);
}

function yamlKey(key: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key) ? key : JSON.stringify(key);
}

function yamlLine(key: string, value: YamlValue): string {
  if (Array.isArray(value)) {
    return `${yamlKey(key)}: [${(value as readonly (string | number | boolean | null)[]).map(yamlScalar).join(', ')}]`;
  }
  const scalar = yamlScalar(value as string | number | boolean | null);
  return scalar === '' ? `${yamlKey(key)}:` : `${yamlKey(key)}: ${scalar}`;
}

/** Zmiany kluczy frontmattera: `undefined` usuwa klucz, wartosc ustawia go. */
export type FrontmatterEdits = ReadonlyMap<string, YamlValue | undefined>;

/**
 * Sklada plik Markdown z frontmatterem. Klucze zrodla (`base`) zachowuja kolejnosc, edycje je
 * nadpisuja albo usuwaja, nowe klucze ida na koniec. Tresc jest doklejana bez zmian, zeby
 * ponowny import dal te sama tresc.
 */
export function renderMarkdown(
  base: FrontmatterResult | null,
  edits: FrontmatterEdits,
  body: string,
): string {
  const entries = new Map<string, YamlValue>();
  if (base !== null) for (const [k, v] of base.data) entries.set(k, v);
  for (const [key, value] of edits) {
    if (value === undefined) entries.delete(key);
    else entries.set(key, value);
  }
  if (entries.size === 0) {
    // Tresc zaczynajaca sie od "---" bylaby wziela za frontmatter, wiec dostaje pusty.
    return /^---[ \t]*(\n|$)/.test(body) ? `---\n---\n${body}` : body;
  }
  const lines = [...entries].map(([k, v]) => yamlLine(k, v));
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** Nazwy kluczy zrodla, ktorych nie da sie odtworzyc (konstrukcje spoza obslugiwanego YAML). */
export function unrepresentableKeys(base: FrontmatterResult | null): string[] {
  return base === null ? [] : base.unsupported.map((u) => u.key);
}

// --- TOML ---

function tomlKey(key: string): string {
  return key
    .split('.')
    .map((p) => (/^[A-Za-z0-9_-]+$/.test(p) ? p : tomlString(p)))
    .join('.');
}

function tomlInline(value: JsonValue): string {
  if (value === null) return '""';
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value))
    return `[${(value as readonly JsonValue[]).map(tomlInline).join(', ')}]`;
  const entries = Object.entries(value as { readonly [k: string]: JsonValue });
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([k, v]) => `${tomlKey(k)} = ${tomlInline(v)}`).join(', ')} }`;
}

function isControl(code: number): boolean {
  // Znaki sterujace poza tabulatorem i LF musza byc w TOML-u zapisane z ucieczka.
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f;
}

/** Wielolinijkowy napis TOML: literalny, gdy to bezpieczne, inaczej z ucieczkami. */
export function tomlMultiline(text: string): string {
  const hasControl = [...text].some((c) => isControl(c.charCodeAt(0)));
  if (!hasControl && !text.includes("'''") && !text.endsWith("'")) return `'''\n${text}'''`;
  let escaped = '';
  for (const c of text.replace(/\\/g, '\\\\')) {
    escaped += isControl(c.charCodeAt(0))
      ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
      : c;
  }
  escaped = escaped.replace(/"""/g, '""\\"');
  if (escaped.endsWith('"')) escaped = `${escaped.slice(0, -1)}\\"`;
  return `"""\n${escaped}"""`;
}

export interface AgentTomlFields {
  readonly name: string;
  readonly description: string;
  readonly effort: string | null;
  readonly instructions: string;
  /** Klucze zrodla bez obrazu w modelu, dopisane po znanych. */
  readonly extras: readonly { readonly key: string; readonly value: JsonValue }[];
}

/** Plik agenta Codeksa w calosci (jedyny, ktory piszemy bez segmentera). */
export function renderAgentToml(f: AgentTomlFields): string {
  const lines = [`name = ${tomlString(f.name)}`, `description = ${tomlString(f.description)}`];
  if (f.effort !== null) lines.push(`model_reasoning_effort = ${tomlString(f.effort)}`);
  for (const e of f.extras) lines.push(`${tomlKey(e.key)} = ${tomlInline(e.value)}`);
  lines.push(`developer_instructions = ${tomlMultiline(f.instructions)}`);
  return `${lines.join('\n')}\n`;
}
