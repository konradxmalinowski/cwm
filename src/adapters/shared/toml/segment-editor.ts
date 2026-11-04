import { parse } from 'smol-toml';

import { dominantEol } from '../marker-block';
import { scanToml, type ScannedLine } from './line-scanner';

/**
 * Edytor segmentowy `config.toml` (ADR 0011, ARCHITECTURE 11). Zarzadza wylacznie trzyliniowymi
 * blokami `[agents.<nazwa>]`; reszta pliku zostaje bajt w bajt. Trzy bezpieczniki: preflight
 * odmawia konstrukcji poza zakresem, a wynik jest parsowany niezaleznym parserem (`smol-toml`)
 * i porownywany z wejsciem na poziomie drzewa, zanim plan trafi do uzytkownika.
 */

export interface AgentRegistration {
  /** Nazwa tabeli `[agents.<nazwa>]`. */
  readonly name: string;
  readonly description: string;
  /** Zachowaj opis istniejacego wpisu; `description` dotyczy wtedy tylko nowego bloku. */
  readonly keepDescription: boolean;
  readonly configFile: string;
}

export interface EditOptions {
  /** Czy istniejacy `config_file` wskazuje ten sam plik co oczekiwany (zapisy `./`, `~/.codex/`). */
  readonly sameConfigFile?: (existing: string, desired: string) => boolean;
}

export type EditResult =
  | { readonly ok: true; readonly text: string; readonly changed: boolean }
  | { readonly ok: false; readonly message: string };

type Tree = Record<string, unknown>;

const BOM = '﻿';

export class SegmentTomlEditor {
  /**
   * Odmowa, gdy plik ma konstrukcje, ktorej segmentacja nie obsluzy zgodnie z semantyka TOML.
   * `touched` to nazwy blokow, ktore edycja ruszy: komentarz oddzielony pusta linia sprawdzamy
   * tylko w nich, bo tylko tam segmentacja moglaby go przypisac inaczej niz TOML.
   */
  preflight(text: string, touched: readonly string[] = []): EditResult {
    const parsed = parseTree(text);
    if (typeof parsed === 'string') return refuse(parsed);
    return this.checkScanned(scanToml(stripBom(text)), touched);
  }

  edit(
    text: string,
    registrations: readonly AgentRegistration[],
    options: EditOptions = {},
  ): EditResult {
    const bom = text.startsWith(BOM) ? BOM : '';
    const body = stripBom(text);
    const before = parseTree(text);
    if (typeof before === 'string') return refuse(before);

    const lines = scanToml(body);
    const touched = registrations.map((r) => r.name);
    const verdict = this.checkScanned(lines, touched);
    if (!verdict.ok) return verdict;

    const same = options.sameConfigFile ?? ((a: string, b: string): boolean => a === b);
    const agents = isTree(before['agents']) ? before['agents'] : {};
    const raw = body.split('\n');
    const eol = dominantEol(body);
    const replacements = new Map<number, string>();
    const insertions: { after: number; line: string }[] = [];
    const appended: AgentRegistration[] = [];
    const expectedAgents: Tree = { ...agents };

    for (const reg of registrations) {
      const existing = agents[reg.name];
      const block = findBlock(lines, reg.name);
      if (block === null) {
        if (existing !== undefined) {
          return refuse(
            `Wpis agents.${reg.name} istnieje w postaci, której edytor nie zmienia (np. tabela inline). Aplikacja nie dopisze drugiego.`,
          );
        }
        appended.push(reg);
        expectedAgents[reg.name] = { description: reg.description, config_file: reg.configFile };
        continue;
      }
      const current = isTree(existing) ? existing : {};
      const wantFile = !(
        typeof current['config_file'] === 'string' && same(current['config_file'], reg.configFile)
      );
      const wantDescription = !reg.keepDescription && current['description'] !== reg.description;
      if (wantFile || wantDescription) {
        const wanted: [string, string][] = [];
        if (wantDescription) wanted.push(['description', reg.description]);
        if (wantFile) wanted.push(['config_file', reg.configFile]);
        const failure = this.planBlockEdit(
          block,
          wanted,
          replacements,
          insertions,
          raw,
          lines,
          reg.name,
        );
        if (failure !== null) return refuse(failure);
        const next = { ...current };
        for (const [key, value] of wanted) next[key] = value;
        expectedAgents[reg.name] = next;
      }
    }

    if (replacements.size === 0 && insertions.length === 0 && appended.length === 0) {
      return { ok: true, text, changed: false };
    }

    const out: string[] = [];
    raw.forEach((line, i) => {
      const hasCr = line.endsWith('\r');
      out.push(replacements.has(i) ? (replacements.get(i) ?? '') + (hasCr ? '\r' : '') : line);
      for (const ins of insertions.filter((x) => x.after === i)) {
        out.push(ins.line + (hasCr ? '\r' : ''));
      }
    });
    let result = out.join('\n');
    if (appended.length > 0) {
      const lastBlank = /(\r?\n){2}$/.test(result);
      let tail = result === '' || result.endsWith('\n') ? '' : eol;
      if (result !== '' && !lastBlank) tail += eol;
      const blocks = appended.map((r) => renderBlock(r, eol)).join(eol);
      result = result + tail + blocks;
    }
    result = bom + result;

    const after = parseTree(result);
    if (typeof after === 'string') {
      return refuse(
        'Weryfikacja semantyczna nie przeszła: wynik edycji nie jest poprawnym TOML-em. Plik zostaje bez zmian.',
      );
    }
    if (canonical(after) !== canonical({ ...before, agents: expectedAgents })) {
      return refuse(
        'Weryfikacja semantyczna nie przeszła: poza wpisami agentów wynik różni się od pliku wejściowego. Plik zostaje bez zmian.',
      );
    }
    return { ok: true, text: result, changed: true };
  }

  private checkScanned(lines: readonly ScannedLine[], touched: readonly string[]): EditResult {
    for (const line of lines) {
      if (line.kind === 'array-table' && line.path[0] === 'agents') {
        return refuse(
          `Linia ${line.index + 1}: tablica tabel [[${line.path.join('.')}]] w obszarze agentów. Edytor segmentowy jej nie obsługuje, więc aplikacja nie zmieni pliku.`,
        );
      }
      if (line.kind === 'key') {
        const full = [...line.table, ...line.path];
        const dotted = line.path.length > 1;
        const outside = line.table.length === 0 && full[0] === 'agents';
        const insideDotted = line.table[0] === 'agents' && line.table.length <= 2 && dotted;
        if (outside || insideDotted) {
          return refuse(
            `Linia ${line.index + 1}: klucz z kropką (${full.join('.')}) poza własną tabelą w obszarze agentów. Edytor segmentowy go nie obsługuje, więc aplikacja nie zmieni pliku.`,
          );
        }
      }
    }
    for (const name of touched) {
      const block = findBlock(lines, name);
      if (block === null) continue;
      for (let i = block.header + 1; i <= block.last; i++) {
        const line = lines[i];
        const prev = lines[i - 1];
        if (line?.kind === 'comment' && prev?.kind === 'blank') {
          return refuse(
            `Linia ${i + 1}: komentarz oddzielony pustą linią w bloku [agents.${name}]. Edytor nie wie, do którego segmentu należy, więc aplikacja nie zmieni pliku.`,
          );
        }
      }
    }
    return { ok: true, text: '', changed: false };
  }

  private planBlockEdit(
    block: Block,
    wanted: readonly (readonly [string, string])[],
    replacements: Map<number, string>,
    insertions: { after: number; line: string }[],
    raw: readonly string[],
    lines: readonly ScannedLine[],
    name: string,
  ): string | null {
    let anchor = block.last;
    for (const [key, value] of wanted) {
      const keyLine = lines
        .slice(block.header + 1, block.last + 1)
        .find((l) => l.kind === 'key' && l.path.length === 1 && l.path[0] === key);
      const rendered = `${key} = ${tomlString(value)}`;
      if (keyLine === undefined) {
        insertions.push({ after: anchor, line: rendered });
        continue;
      }
      const next = lines[keyLine.index + 1];
      if (next?.kind === 'cont') {
        return `Blok [agents.${name}] ma wielolinijkową wartość klucza ${key}. Edytor segmentowy jej nie zmienia, więc aplikacja nie zmieni pliku.`;
      }
      const indent = /^[ \t]*/.exec(raw[keyLine.index] ?? '')?.[0] ?? '';
      replacements.set(keyLine.index, indent + rendered);
      anchor = Math.max(anchor, keyLine.index);
    }
    return null;
  }
}

interface Block {
  readonly header: number;
  /** Ostatnia linia klucza lub jej kontynuacji w bloku (albo sam naglowek). */
  readonly last: number;
}

function findBlock(lines: readonly ScannedLine[], name: string): Block | null {
  const header = lines.find(
    (l) =>
      l.kind === 'table' && l.path.length === 2 && l.path[0] === 'agents' && l.path[1] === name,
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

function renderBlock(reg: AgentRegistration, eol: string): string {
  const key = /^[A-Za-z0-9_-]+$/.test(reg.name) ? reg.name : tomlString(reg.name);
  return [
    `[agents.${key}]`,
    `description = ${tomlString(reg.description)}`,
    `config_file = ${tomlString(reg.configFile)}`,
    '',
  ].join(eol);
}

/** Napis TOML w cudzyslowach. JSON i TOML zgadzaja sie poza znakiem DEL. */
export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

function refuse(message: string): EditResult {
  return { ok: false, message };
}

function parseTree(text: string): Tree | string {
  try {
    const tree: Tree = parse(stripBom(text));
    return tree;
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : 'błąd składni';
    return `Plik konfiguracyjny nie jest poprawnym TOML-em (${detail ?? 'błąd składni'}), więc aplikacja go nie zmieni.`;
  }
}

function isTree(value: unknown): value is Tree {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** Postac kanoniczna drzewa do porownania: klucze posortowane, daty i bigint jawnie oznaczone. */
export function canonical(value: unknown): string {
  if (value instanceof Date) return `D${value.toISOString()}`;
  if (typeof value === 'bigint') return `B${value.toString()}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Tree)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
