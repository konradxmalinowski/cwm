import { dominantEol } from '../marker-block';
import { scanToml, type ScannedLine } from './line-scanner';
import { canonical, parseTree, tomlString } from './segment-editor';

/**
 * Segmenty `[mcp_servers.<nazwa>]` w `config.toml` Codeksa (ADR 0061), ten sam mechanizm co bloki
 * agentow (ADR 0011): preflight, edycja tylko zarzadzanych blokow, a wynik parsowany niezaleznym
 * parserem i porownany z wejsciem. Poza edytowanymi serwerami drzewo musi zostac identyczne.
 */

export type McpTomlValue = string | readonly string[];

export interface McpSegment {
  readonly name: string;
  readonly fields: readonly (readonly [string, McpTomlValue])[];
  /** Istniejacy blok o tej nazwie jest zastepowany w calosci; bez tej flagi istniejacy serwer to odmowa. */
  readonly replace: boolean;
}

export type McpSegmentResult =
  | { readonly ok: true; readonly text: string; readonly changed: boolean }
  | { readonly ok: false; readonly message: string };

type Tree = Record<string, unknown>;

const BOM = '\uFEFF';
const AREA = 'mcp_servers';

function isTree(value: unknown): value is Tree {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function refuse(message: string): McpSegmentResult {
  return { ok: false, message };
}

function renderValue(value: McpTomlValue): string {
  return typeof value === 'string' ? tomlString(value) : `[${value.map(tomlString).join(', ')}]`;
}

/** Linie bloku bez znakow konca linii; nazwa jest juz sprawdzona jako goly klucz TOML. */
function renderBlock(segment: McpSegment): string[] {
  return [
    `[${AREA}.${segment.name}]`,
    ...segment.fields.map(([key, value]) => `${key} = ${renderValue(value)}`),
  ];
}

function preflight(lines: readonly ScannedLine[]): string | null {
  for (const line of lines) {
    if (line.kind === 'array-table' && line.path[0] === AREA) {
      return `Linia ${line.index + 1}: tablica tabel [[${line.path.join('.')}]] w obszarze serwerów MCP. Edytor segmentowy jej nie obsługuje, więc aplikacja nie zmieni pliku.`;
    }
    if (line.kind === 'key') {
      const full = [...line.table, ...line.path];
      const dotted = line.path.length > 1;
      if (
        (line.table.length === 0 && full[0] === AREA) ||
        (line.table[0] === AREA && line.table.length <= 2 && dotted)
      ) {
        return `Linia ${line.index + 1}: klucz z kropką (${full.join('.')}) w obszarze serwerów MCP. Edytor segmentowy go nie obsługuje, więc aplikacja nie zmieni pliku.`;
      }
    }
  }
  return null;
}

interface Block {
  readonly header: number;
  readonly last: number;
}

function findBlock(lines: readonly ScannedLine[], name: string): Block | null {
  const header = lines.find(
    (l) => l.kind === 'table' && l.path.length === 2 && l.path[0] === AREA && l.path[1] === name,
  );
  if (header === undefined) return null;
  let last = header.index;
  for (let i = header.index + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.kind === 'table' || line.kind === 'array-table') break;
    if (line.kind === 'key' || line.kind === 'cont') last = i;
  }
  return { header: header.index, last };
}

function hasSubtables(lines: readonly ScannedLine[], name: string): boolean {
  return lines.some(
    (l) =>
      (l.kind === 'table' || l.kind === 'array-table') &&
      l.path.length > 2 &&
      l.path[0] === AREA &&
      l.path[1] === name,
  );
}

export function editMcpSegments(text: string, segments: readonly McpSegment[]): McpSegmentResult {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = bom === '' ? text : text.slice(1);
  const before = parseTree(text);
  if (typeof before === 'string') return refuse(before);
  const lines = scanToml(body);
  const problem = preflight(lines);
  if (problem !== null) return refuse(problem);

  const area = before[AREA];
  if (area !== undefined && !isTree(area)) {
    return refuse('Klucz mcp_servers w config.toml nie jest tabelą, więc aplikacja go nie zmieni.');
  }
  const servers: Tree = isTree(area) ? area : {};
  const eol = dominantEol(body);
  const raw = body.split('\n');
  const replaced = new Map<number, { last: number; block: string[] }>();
  const appended: McpSegment[] = [];
  const expected: Tree = { ...servers };

  for (const segment of segments) {
    const desired: Tree = Object.fromEntries(
      segment.fields.map(([k, v]) => [k, typeof v === 'string' ? v : [...v]]),
    );
    const existing = Object.hasOwn(servers, segment.name) ? servers[segment.name] : undefined;
    if (existing === undefined) {
      appended.push(segment);
      expected[segment.name] = desired;
      continue;
    }
    if (!segment.replace) {
      return refuse(`Serwer mcp_servers.${segment.name} już istnieje w config.toml.`);
    }
    const block = findBlock(lines, segment.name);
    if (block === null || hasSubtables(lines, segment.name)) {
      return refuse(
        `Serwer mcp_servers.${segment.name} ma postać, której edytor segmentowy nie zmienia (tabela inline albo podtabele, np. [mcp_servers.${segment.name}.env]). Zmień go ręcznie albo usuń, a potem przygotuj plan jeszcze raz.`,
      );
    }
    replaced.set(block.header, { last: block.last, block: renderBlock(segment) });
    expected[segment.name] = desired;
  }

  if (replaced.size === 0 && appended.length === 0) return { ok: true, text, changed: false };

  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const swap = replaced.get(i);
    if (swap === undefined) {
      out.push(raw[i] ?? '');
      continue;
    }
    const cr = (raw[i] ?? '').endsWith('\r') ? '\r' : '';
    for (const line of swap.block) out.push(line + cr);
    i = swap.last;
  }
  let result = out.join('\n');
  if (appended.length > 0) {
    const lastBlank = /(\r?\n){2}$/.test(result);
    let tail = result === '' || result.endsWith('\n') ? '' : eol;
    if (result !== '' && !lastBlank) tail += eol;
    const blocks = appended.map((s) => renderBlock(s).join(eol) + eol).join(eol);
    result = result + tail + blocks;
  }
  result = bom + result;

  const after = parseTree(result);
  if (typeof after === 'string') {
    return refuse(
      'Weryfikacja semantyczna nie przeszła: wynik edycji nie jest poprawnym TOML-em. Plik zostaje bez zmian.',
    );
  }
  if (canonical(after) !== canonical({ ...before, [AREA]: expected })) {
    return refuse(
      'Weryfikacja semantyczna nie przeszła: poza serwerami MCP z planu wynik różni się od pliku wejściowego. Plik zostaje bez zmian.',
    );
  }
  return { ok: true, text: result, changed: true };
}
