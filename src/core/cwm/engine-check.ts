import { field, isPlainObject } from './check';
import { compareStrings, fail, ok, type Result } from './errors';
import {
  REFUSED_FLAGS,
  ENGINE_SUBCOMMANDS,
  MANAGED_FLAGS,
  REQUIRED_ENGINE_FLAGS,
} from './engine-argv';
import { API_VERSION } from './kinds';
import { HASH64 } from './patterns';

/**
 * Sprawdzenie nowej wersji silnika (ADR 0036 pkt 10, ADR 0052). Czysta ocena tekstu `claude --help`:
 * infra uruchamia silnik i podaje wyniki, tu tylko sie je czyta. Dotyczy wylacznie interfejsu wiersza
 * polecen (flagi i podpolecenia); zachowania w sesji z modelem (V-01 do V-08) to osobny spike.
 */

export const ENGINE_CHECKS_KIND = 'EngineChecks';
export const ENGINE_CHECKS_FILE_NAME = 'engine-checks.json';
export const MAX_ENGINE_CHECKS_BYTES = 64 * 1024;
const MAX_STORED_VERSIONS = 32;
const MAX_NAMES = 64;

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const FLAG_PATTERN = /^--[A-Za-z][\w-]{0,63}$/;
const SUBCOMMAND_PATTERN = /^[a-z][\w-]{0,31}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** Nowa flaga o takiej nazwie moze omijac uprawnienia albo zmieniac katalog konfiguracji lub zrodla rozszerzen. */
const SUSPICIOUS_FLAG =
  /dangerous|permission|bypass|yolo|trust|allow|sandbox|add-dir|hook|config|setting|plugin|mcp|skip/i;

/**
 * Flagi o podejrzanych nazwach, ktore juz sa w `--help` Claude Code 2.1.322 i 2.1.323 (poza
 * `MANAGED_FLAGS` i `REFUSED_FLAGS`): wzorzec jest szeroki, wiec ostrzega tylko o flagach nowych wzgledem tej listy.
 */
export const SUSPICIOUS_FLAG_BASELINE: readonly string[] = [
  '--add-dir',
  '--allowed-tools',
  '--allowedTools',
  '--disallowed-tools',
  '--disallowedTools',
  '--include-hook-events',
  '--permission-mode',
  '--permission-prompts',
];

export interface ParsedHelp {
  /** Czy znaleziono sekcje `Options:` z co najmniej jedna flaga. */
  readonly hasOptions: boolean;
  readonly flags: readonly string[];
  /** Nazwy i aliasy z sekcji `Commands:` (bez `help`). */
  readonly subcommands: readonly string[];
}

/** Nazwy flag i podpolecen z wiersza definicji (wciecie 2 spacje); opisy i ciag dalszy maja wieksze wciecie. */
export function parseHelp(text: string): ParsedHelp {
  const flags = new Set<string>();
  const subcommands = new Set<string>();
  let hasOptions = false;
  let section: 'options' | 'commands' | 'other' = 'other';
  for (const line of text.split(/\r?\n/)) {
    const header = /^([A-Z][A-Za-z ]*):\s*$/.exec(line);
    if (header !== null) {
      const name = header[1]?.toLowerCase();
      section = name === 'options' ? 'options' : name === 'commands' ? 'commands' : 'other';
      if (section === 'options') hasOptions = true;
      continue;
    }
    if (!/^ {2}\S/.test(line)) continue;
    const head = (line.slice(2).split(/\s{2,}/)[0] ?? '').trim();
    if (section === 'options') {
      for (const token of head.split(',')) {
        const name = /^(--[A-Za-z][\w-]*)/.exec(token.trim())?.[1];
        if (name !== undefined && FLAG_PATTERN.test(name)) flags.add(name);
      }
    } else if (section === 'commands') {
      const names = /^([a-z][\w-]*(?:\|[a-z][\w-]*)*)(?:\s|$)/.exec(head)?.[1];
      for (const name of names?.split('|') ?? []) {
        if (name !== 'help' && SUBCOMMAND_PATTERN.test(name)) subcommands.add(name);
      }
    }
  }
  const sorted = [...flags].sort(compareStrings);
  return {
    hasOptions: hasOptions && sorted.length > 0,
    flags: sorted,
    subcommands: [...subcommands].sort(compareStrings),
  };
}

/** Wyniki czterech polecen metadanych; null, gdy polecenie nie zadzialalo (kod, czas, rozmiar). */
export interface EngineMetadata {
  readonly version: string | null;
  readonly help: string | null;
  readonly pluginHelp: string | null;
  readonly mcpHelp: string | null;
}

export type EngineCheckVerdict = 'ok' | 'missing-flags' | 'unverified';

export interface EngineCheckReport {
  readonly version: string | null;
  /** `missing-flags`: silnik nie zna flagi, ktora CWM mu podaje. `unverified`: nie dalo sie ocenic. */
  readonly verdict: EngineCheckVerdict;
  /** Flagi z `REQUIRED_ENGINE_FLAGS` nieobecne w `--help`. */
  readonly missingFlags: readonly string[];
  /** Podpolecenia w `--help` spoza `ENGINE_SUBCOMMANDS`: `cwm start -- <podpolecenie>` nie jest dla nich blokowane. */
  readonly newSubcommands: readonly string[];
  /** Nowe flagi o nazwach sugerujacych omijanie uprawnien albo zmiane katalogu konfiguracji. */
  readonly suspiciousFlags: readonly string[];
  /** Flagi z `REFUSED_FLAGS` i `MANAGED_FLAGS`, ktorych silnik juz nie ma (informacja, nie ostrzezenie). */
  readonly goneFlags: readonly string[];
  /** Polecenia bez wyniku, np. `plugin --help`. Informacja. */
  readonly unavailable: readonly string[];
  /** Powody, dla ktorych wynik to `unverified`. */
  readonly problems: readonly string[];
}

const capped = (list: readonly string[]): string[] => list.slice(0, MAX_NAMES);

/**
 * `expectedVersion`: wersja ustalona wczesniej (`--version` przed sprawdzeniem). Inna wersja z `--version` w trakcie
 * sprawdzenia (podmiana pliku, aktualizacja) to `unverified`.
 */
export function evaluateEngineHelp(
  meta: EngineMetadata,
  expectedVersion?: string | null,
): EngineCheckReport {
  const problems: string[] = [];
  const version = meta.version !== null && VERSION_PATTERN.test(meta.version) ? meta.version : null;
  if (version === null) problems.push('nie udalo sie odczytac wersji (--version)');
  else if (expectedVersion !== undefined && version !== expectedVersion) {
    problems.push('wersja z --version rozni sie od wykrytej przed sprawdzeniem');
  }
  const unavailable: string[] = [];
  if (meta.pluginHelp === null) unavailable.push('plugin --help');
  if (meta.mcpHelp === null) unavailable.push('mcp --help');

  const help = meta.help === null ? null : parseHelp(meta.help);
  if (help === null) problems.push('nie udalo sie odczytac pomocy (--help)');
  else if (!help.hasOptions) problems.push('pomoc silnika ma nieznany uklad (brak sekcji Options)');

  const base = { version, unavailable, newSubcommands: [], suspiciousFlags: [], goneFlags: [] };
  if (help === null || !help.hasOptions || problems.length > 0) {
    return { ...base, verdict: 'unverified', missingFlags: [], problems };
  }
  const present = new Set(help.flags);
  const missingFlags = REQUIRED_ENGINE_FLAGS.filter((flag) => !present.has(flag));
  const known = new Set([...MANAGED_FLAGS, ...REFUSED_FLAGS]);
  return {
    version,
    verdict: missingFlags.length > 0 ? 'missing-flags' : 'ok',
    missingFlags,
    newSubcommands: capped(help.subcommands.filter((name) => !ENGINE_SUBCOMMANDS.includes(name))),
    suspiciousFlags: capped(
      help.flags.filter(
        (flag) =>
          !known.has(flag) &&
          !SUSPICIOUS_FLAG_BASELINE.includes(flag) &&
          SUSPICIOUS_FLAG.test(flag),
      ),
    ),
    goneFlags: [...REFUSED_FLAGS, ...MANAGED_FLAGS].filter((flag) => !present.has(flag)).sort(),
    unavailable,
    problems,
  };
}

/** Ostrzezenia z wyniku sprawdzenia (bez `missing-flags`, ktore jest odmowa, i bez informacji). */
export function engineCheckWarnings(report: EngineCheckReport): string[] {
  const out: string[] = [];
  const version = report.version ?? 'nieznana';
  if (report.verdict === 'unverified') {
    out.push(`Sprawdzenie silnika ${version} nie powiodlo sie: ${report.problems.join('; ')}.`);
  }
  if (report.newSubcommands.length > 0) {
    out.push(
      `Silnik ${version} ma podpolecenia spoza listy CWM: ${report.newSubcommands.join(', ')}. ` +
        '`cwm start -- <podpolecenie>` nie jest dla nich blokowane; lista ENGINE_SUBCOMMANDS wymaga aktualizacji.',
    );
  }
  if (report.suspiciousFlags.length > 0) {
    out.push(
      `Silnik ${version} ma nowe flagi o nazwach zwiazanych z uprawnieniami, konfiguracja lub rozszerzeniami: ${report.suspiciousFlags.join(', ')}. ` +
        'CWM ich nie zna i przekazuje je bez zmian po "--".',
    );
  }
  return out;
}

export function missingFlagsMessage(report: EngineCheckReport): string {
  return (
    `Silnik ${report.version ?? 'nieznanej wersji'} nie ma flag, ktore CWM mu podaje: ${report.missingFlags.join(', ')}. ` +
    'Start odmowiony, bo silnik nie zrozumie argumentow. Zaktualizuj CWM albo uzyj wersji silnika z `cwm engine status`.'
  );
}

/** Zapisany wynik udanego sprawdzenia jednej wersji. Skroty to SHA-256 tekstu pomocy; nie ma tu sciezek ani czasu poza `checkedAt`. */
/** Plik silnika, ktorego dotyczy wynik: sciezka po `realpath`, rozmiar i czas modyfikacji (ADR 0052). */
export interface EngineBinaryId {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface EngineCheckEntry {
  readonly binary: EngineBinaryId;
  readonly checkedAt: string;
  readonly helpSha256: string;
  readonly pluginHelpSha256: string | null;
  readonly mcpHelpSha256: string | null;
  readonly newSubcommands: readonly string[];
  readonly suspiciousFlags: readonly string[];
}

export interface EngineChecksFile {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: typeof ENGINE_CHECKS_KIND;
  readonly checks: Readonly<Record<string, EngineCheckEntry>>;
}

export const emptyEngineChecks = (): EngineChecksFile => ({
  apiVersion: API_VERSION,
  kind: ENGINE_CHECKS_KIND,
  checks: {},
});

function nameList(value: unknown, pattern: RegExp): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_NAMES) return null;
  const out: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || !pattern.test(item)) return null;
    out.push(item);
  }
  return out;
}

const hashOrNull = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' && HASH64.test(value) ? value : undefined;

function parseBinary(raw: unknown): EngineBinaryId | null {
  if (!isPlainObject(raw)) return null;
  if (Object.keys(raw).some((key) => !['path', 'size', 'mtimeMs'].includes(key))) return null;
  const path = field(raw, 'path');
  const size = field(raw, 'size');
  const mtimeMs = field(raw, 'mtimeMs');
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 1024 ||
    !path.startsWith('/') ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof mtimeMs !== 'number' ||
    !Number.isFinite(mtimeMs) ||
    mtimeMs < 0
  ) {
    return null;
  }
  return { path, size, mtimeMs };
}

function parseEntry(raw: unknown): EngineCheckEntry | null {
  if (!isPlainObject(raw)) return null;
  const binary = parseBinary(field(raw, 'binary'));
  const checkedAt = field(raw, 'checkedAt');
  const helpSha256 = field(raw, 'helpSha256');
  const pluginHelpSha256 = hashOrNull(field(raw, 'pluginHelpSha256'));
  const mcpHelpSha256 = hashOrNull(field(raw, 'mcpHelpSha256'));
  const newSubcommands = nameList(field(raw, 'newSubcommands'), SUBCOMMAND_PATTERN);
  const suspiciousFlags = nameList(field(raw, 'suspiciousFlags'), FLAG_PATTERN);
  if (
    binary === null ||
    typeof checkedAt !== 'string' ||
    !TIMESTAMP_PATTERN.test(checkedAt) ||
    typeof helpSha256 !== 'string' ||
    !HASH64.test(helpSha256) ||
    pluginHelpSha256 === undefined ||
    mcpHelpSha256 === undefined ||
    newSubcommands === null ||
    suspiciousFlags === null
  ) {
    return null;
  }
  return {
    binary,
    checkedAt,
    helpSha256,
    pluginHelpSha256,
    mcpHelpSha256,
    newSubcommands,
    suspiciousFlags,
  };
}

/** Plik z dysku to niezaufane wejscie: obca wersja formatu, nieznane pole albo zly wpis to blad, nie cichy sukces. */
export function parseEngineChecks(text: string): Result<EngineChecksFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail([{ path: '$', message: 'Plik nie jest poprawnym JSON.' }]);
  }
  if (!isPlainObject(raw)) return fail([{ path: '$', message: 'Oczekiwano obiektu.' }]);
  const extra = Object.keys(raw).filter((key) => !['apiVersion', 'kind', 'checks'].includes(key));
  if (extra.length > 0) return fail([{ path: '$', message: 'Nieznane pole.' }]);
  if (field(raw, 'apiVersion') !== API_VERSION || field(raw, 'kind') !== ENGINE_CHECKS_KIND) {
    return fail([{ path: '$', message: 'Inna wersja albo rodzaj dokumentu.' }]);
  }
  const rawChecks = field(raw, 'checks');
  if (!isPlainObject(rawChecks)) return fail([{ path: 'checks', message: 'Oczekiwano obiektu.' }]);
  const keys = Object.keys(rawChecks);
  if (keys.length > MAX_STORED_VERSIONS) {
    return fail([{ path: 'checks', message: 'Za duzo wpisow.' }]);
  }
  const checks: Record<string, EngineCheckEntry> = {};
  for (const key of keys) {
    const entry = VERSION_PATTERN.test(key) ? parseEntry(field(rawChecks, key)) : null;
    if (entry === null) return fail([{ path: 'checks', message: 'Niepoprawny wpis wersji.' }]);
    checks[key] = entry;
  }
  return ok({ apiVersion: API_VERSION, kind: ENGINE_CHECKS_KIND, checks });
}

export function formatEngineChecks(file: EngineChecksFile): string {
  const checks: Record<string, EngineCheckEntry> = {};
  for (const key of Object.keys(file.checks).sort(compareStrings)) {
    const entry = file.checks[key];
    if (entry !== undefined) checks[key] = entry;
  }
  return `${JSON.stringify({ apiVersion: file.apiVersion, kind: file.kind, checks }, null, 2)}\n`;
}

/** Dodaje albo zastepuje wpis wersji; najstarsze wpisy ponad limit wypadaja. */
export function withEngineCheck(
  file: EngineChecksFile,
  version: string,
  entry: EngineCheckEntry,
): EngineChecksFile {
  const merged = { ...file.checks, [version]: entry };
  const keep = Object.keys(merged)
    .sort((a, b) => compareStrings(merged[b]?.checkedAt ?? '', merged[a]?.checkedAt ?? ''))
    .slice(0, MAX_STORED_VERSIONS);
  const checks: Record<string, EngineCheckEntry> = {};
  for (const key of keep) {
    const item = merged[key];
    if (item !== undefined) checks[key] = item;
  }
  return { ...file, checks };
}

export type EngineVersionState = 'expected' | 'checked' | 'other-binary' | 'unchecked';

export const engineBinaryEquals = (a: EngineBinaryId, b: EngineBinaryId): boolean =>
  a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * Wersja przetestowana w ADR 0036, wersja z udanym sprawdzeniem tego samego pliku (sciezka, rozmiar, czas
 * modyfikacji), wersja sprawdzona dla innego pliku (`other-binary`: traktowana jak niesprawdzona) albo nieznana.
 * To zgodnosc z uczciwym dryfem, nie obrona przed wrogim plikiem (ADR 0052).
 */
export function engineVersionState(
  version: string,
  expected: string,
  file: EngineChecksFile,
  binary: EngineBinaryId | null,
): EngineVersionState {
  if (version === expected) return 'expected';
  const entry = Object.hasOwn(file.checks, version) ? file.checks[version] : undefined;
  if (entry === undefined) return 'unchecked';
  return binary !== null && engineBinaryEquals(entry.binary, binary) ? 'checked' : 'other-binary';
}

export function uncheckedVersionWarning(version: string, expected: string): string {
  return (
    `Wersja silnika ${version} rozni sie od przetestowanej ${expected} i nie ma udanego sprawdzenia flag tego pliku; ` +
    'zachowanie moze sie roznic. Sprawdz: cwm engine check'
  );
}
