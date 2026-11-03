import type { JsonValue } from '../../core/model/item';
import { normalizeToLf } from '../../core/services/normalization/line-endings';

/**
 * Czytnik TOML tylko do odczytu, w zakresie potrzebnym adapterowi Codeksa: pliki
 * `agents/<nazwa>.toml` i sekcje `[agents.<nazwa>]` w `config.toml` (ARCHITECTURE 1.3).
 * Edycja z zachowaniem formatowania to osobny temat (ADR 0011), tu jej nie ma.
 *
 * `config.toml` moze trzymac sekrety, wiec wartosci zatrzymuje tylko tabela, o ktora poprosil
 * wywolujacy (`wanted`). Reszta jest parsowana wylacznie po to, zeby trafic w poprawne granice
 * wielolinijkowych napisow, a wynik jest wyrzucany.
 */

export type TomlValue =
  string | number | boolean | readonly TomlValue[] | { readonly [key: string]: TomlValue };

export interface TomlTable {
  readonly path: readonly string[];
  /** Klucze z kropka (`a.b = 1`) sa splaszczone do jednego klucza "a.b". */
  readonly values: ReadonlyMap<string, TomlValue>;
  readonly arrayOfTables: boolean;
  readonly line: number;
}

export interface TomlIssue {
  readonly line: number;
  readonly message: string;
}

export interface TomlReadResult {
  readonly tables: readonly TomlTable[];
  readonly issues: readonly TomlIssue[];
}

class TomlSyntaxError extends Error {}

const BARE_KEY = /[A-Za-z0-9_-]/;
const MAX_NESTING = 32;

export function readToml(
  source: string,
  wanted: (path: readonly string[], arrayOfTables: boolean) => boolean,
): TomlReadResult {
  return new Reader(normalizeToLf(source.startsWith('﻿') ? source.slice(1) : source), wanted).run();
}

class Reader {
  private pos = 0;
  private readonly tables: TomlTable[] = [];
  private readonly issues: TomlIssue[] = [];
  private current: { table: TomlTable; values: Map<string, TomlValue> } | null = null;
  private keep = false;

  constructor(
    private readonly text: string,
    private readonly wanted: (path: readonly string[], arrayOfTables: boolean) => boolean,
  ) {
    this.open([], false, 1);
  }

  run(): TomlReadResult {
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.text.length) break;
      try {
        if (this.text[this.pos] === '[') this.header();
        else this.keyValue();
        this.endOfLine();
      } catch (error) {
        if (!(error instanceof TomlSyntaxError)) throw error;
        if (this.issues.length < 50) {
          this.issues.push({ line: this.lineAt(this.pos), message: error.message });
        }
        this.skipLine();
      }
    }
    return { tables: this.tables, issues: this.issues };
  }

  private open(path: readonly string[], arrayOfTables: boolean, line: number): void {
    this.keep = this.wanted(path, arrayOfTables);
    const values = new Map<string, TomlValue>();
    const table: TomlTable = { path, values, arrayOfTables, line };
    this.current = { table, values };
    if (this.keep) this.tables.push(table);
  }

  private lineAt(pos: number): number {
    let line = 1;
    for (let i = 0; i < pos && i < this.text.length; i++) if (this.text[i] === '\n') line++;
    return line;
  }

  private fail(message: string): never {
    throw new TomlSyntaxError(message);
  }

  private peek(offset = 0): string {
    return this.text[this.pos + offset] ?? '';
  }

  private skipSpaces(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }

  private skipLine(): void {
    while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++;
  }

  private skipBlank(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\n') this.pos++;
      else if (c === '#') this.skipLine();
      else break;
    }
  }

  private endOfLine(): void {
    this.skipSpaces();
    if (this.peek() === '#') this.skipLine();
    if (this.pos < this.text.length && this.peek() !== '\n') this.fail('Oczekiwano końca linii.');
  }

  private header(): void {
    const line = this.lineAt(this.pos);
    const array = this.peek(1) === '[';
    this.pos += array ? 2 : 1;
    const path = this.keyPath();
    this.skipSpaces();
    const close = array ? ']]' : ']';
    if (!this.text.startsWith(close, this.pos)) this.fail('Nagłówek tabeli nie jest zamknięty.');
    this.pos += close.length;
    this.open(path, array, line);
  }

  private keyValue(): void {
    const keys = this.keyPath();
    this.skipSpaces();
    if (this.peek() !== '=') this.fail('Oczekiwano znaku "=".');
    this.pos++;
    this.skipSpaces();
    const value = this.value(0);
    if (this.keep && this.current !== null) this.current.values.set(keys.join('.'), value);
  }

  private keyPath(): string[] {
    const keys: string[] = [];
    for (;;) {
      this.skipSpaces();
      keys.push(this.key());
      this.skipSpaces();
      if (this.peek() === '.') this.pos++;
      else return keys;
    }
  }

  private key(): string {
    const c = this.peek();
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    const start = this.pos;
    while (BARE_KEY.test(this.peek())) this.pos++;
    if (this.pos === start) this.fail('Oczekiwano klucza.');
    return this.text.slice(start, this.pos);
  }

  private value(depth: number): TomlValue {
    if (depth > MAX_NESTING) this.fail('Wartość jest zagnieżdżona zbyt głęboko.');
    const c = this.peek();
    if (c === '"')
      return this.text.startsWith('"""', this.pos) ? this.multiBasic() : this.basicString();
    if (c === "'")
      return this.text.startsWith("'''", this.pos) ? this.multiLiteral() : this.literalString();
    if (c === '[') return this.array(depth);
    if (c === '{') return this.inlineTable(depth);
    return this.scalar();
  }

  private scalar(): TomlValue {
    const start = this.pos;
    while (this.pos < this.text.length && !/[\s,\]}#]/.test(this.peek())) this.pos++;
    let token = this.text.slice(start, this.pos);
    // Data z godzina ma spacje miedzy dniem a czasem.
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(token) &&
      /^ \d{2}:\d{2}/.test(this.text.slice(this.pos, this.pos + 7))
    ) {
      this.pos++;
      const timeStart = this.pos;
      while (this.pos < this.text.length && !/[\s,\]}#]/.test(this.peek())) this.pos++;
      token = `${token} ${this.text.slice(timeStart, this.pos)}`;
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(token)) return token;
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(token)) return Number(token.replace(/_/g, ''));
    if (/^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$/.test(token)) return Number(token.replace(/_/g, ''));
    if (/^0o[0-7](_?[0-7])*$/.test(token)) return Number(token.replace(/_/g, ''));
    if (/^0b[01](_?[01])*$/.test(token)) return Number(token.replace(/_/g, ''));
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(token)) {
      return Number(token.replace(/_/g, ''));
    }
    if (
      /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?$/.test(token)
    )
      return token;
    if (/^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(token)) return token;
    return this.fail('Nierozpoznana wartość.');
  }

  private array(depth: number): TomlValue[] {
    this.pos++;
    const items: TomlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.peek() === ']') {
        this.pos++;
        return items;
      }
      items.push(this.value(depth + 1));
      this.skipBlank();
      if (this.peek() === ',') this.pos++;
      else if (this.peek() !== ']') this.fail('Oczekiwano "," lub "]" w tablicy.');
    }
  }

  private inlineTable(depth: number): TomlValue {
    this.pos++;
    const table: Record<string, TomlValue> = {};
    this.skipSpaces();
    if (this.peek() === '}') {
      this.pos++;
      return table;
    }
    for (;;) {
      const keys = this.keyPath();
      this.skipSpaces();
      if (this.peek() !== '=') this.fail('Oczekiwano znaku "=".');
      this.pos++;
      this.skipSpaces();
      // defineProperty: klucz "__proto__" z pliku ma byc zwyklym polem, nie zmiana prototypu.
      Object.defineProperty(table, keys.join('.'), {
        value: this.value(depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipSpaces();
      if (this.peek() === ',') {
        this.pos++;
        this.skipSpaces();
      } else if (this.peek() === '}') {
        this.pos++;
        return table;
      } else this.fail('Oczekiwano "," lub "}" w tabeli inline.');
    }
  }

  private literalString(): string {
    const end = this.text.indexOf("'", this.pos + 1);
    const nl = this.text.indexOf('\n', this.pos);
    if (end === -1 || (nl !== -1 && nl < end))
      this.fail('Napis nie jest zamknięty w tej samej linii.');
    const value = this.text.slice(this.pos + 1, end);
    this.pos = end + 1;
    return value;
  }

  private multiLiteral(): string {
    this.pos += 3;
    if (this.peek() === '\n') this.pos++;
    const end = this.text.indexOf("'''", this.pos);
    if (end === -1) this.fail('Napis wielolinijkowy nie jest zamknięty.');
    let stop = end;
    while (this.text[stop + 3] === "'" && stop - end < 2) stop++;
    const value = this.text.slice(this.pos, stop);
    this.pos = stop + 3;
    return value;
  }

  private basicString(): string {
    this.pos++;
    let out = '';
    for (;;) {
      const c = this.peek();
      if (c === '' || c === '\n') this.fail('Napis nie jest zamknięty w tej samej linii.');
      this.pos++;
      if (c === '"') return out;
      out += c === '\\' ? this.escape(false) : c;
    }
  }

  private multiBasic(): string {
    this.pos += 3;
    if (this.peek() === '\n') this.pos++;
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) this.fail('Napis wielolinijkowy nie jest zamknięty.');
      if (this.text.startsWith('"""', this.pos)) {
        // Do dwoch cudzyslowow tuz przed zamknieciem nalezy do tresci.
        let extra = 0;
        while (extra < 2 && this.text[this.pos + 3 + extra] === '"') extra++;
        out += '"'.repeat(extra);
        this.pos += 3 + extra;
        return out;
      }
      const c = this.peek();
      this.pos++;
      out += c === '\\' ? this.escape(true) : c;
    }
  }

  private escape(multiline: boolean): string {
    const c = this.peek();
    this.pos++;
    switch (c) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
      case 'U': {
        const len = c === 'u' ? 4 : 8;
        const hex = this.text.slice(this.pos, this.pos + len);
        if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) this.fail('Niepoprawna sekwencja \\u.');
        this.pos += len;
        const code = parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
          this.fail('Niepoprawny punkt kodowy.');
        return String.fromCodePoint(code);
      }
      default:
        if (multiline && /[ \t\n]/.test(c)) {
          // "\" na koncu linii wycina biale znaki az do nastepnego widocznego znaku.
          const rest = /^[ \t]*\n\s*/.exec(this.text.slice(this.pos - 1));
          if (rest !== null) {
            this.pos += rest[0].length - 1;
            return '';
          }
        }
        return this.fail('Nieznana sekwencja ucieczki.');
    }
  }
}

export function tomlToJson(value: TomlValue): JsonValue {
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return (value as readonly TomlValue[]).map(tomlToJson);
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(value as { readonly [key: string]: TomlValue })) {
    Object.defineProperty(out, k, {
      value: tomlToJson(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function tomlString(value: TomlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
