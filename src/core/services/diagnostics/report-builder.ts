import type { DiagnosticsReport } from '../../model/diagnostics';
import { REDACTION_CATEGORIES, type ReportRedactor } from './report-redactor';

/**
 * Sklada tekst raportu diagnostycznego do zgloszenia bledu (ADR 0053). Funkcja jest czysta:
 * dostaje gotowe dane i redaktor, zwraca Markdown. Redakcja obejmuje cala tresc raportu, a
 * nie wybrane pola, wiec nowa sekcja nie moze jej ominac. Naglowek z lista regul stoi poza
 * redakcja, bo opisuje znaczniki, ktore redakcja wstawia.
 */

export const REPORT_LOG_LINES = 200;
/** Linia logu jest skracana dopiero po redakcji: obciecie przed nia moglo rozciac sekret. */
export const MAX_LOG_LINE_LENGTH = 600;

export interface ReportLibrarySummary {
  readonly total: number;
  readonly countsByKind: Readonly<Record<string, number>>;
  readonly problems: number;
  readonly inconsistent: number;
}

export interface ReportTool {
  readonly tool: string;
  readonly kind: string;
  readonly label: string;
  readonly exists: boolean;
  readonly active: boolean;
}

export interface ReportInput {
  readonly diagnostics: DiagnosticsReport;
  /** `null`, gdy biblioteka jest niedostepna; raport mowi o tym wprost. */
  readonly library: ReportLibrarySummary | null;
  /** `null`, gdy wykrywanie lokalizacji sie nie udalo. */
  readonly tools: readonly ReportTool[] | null;
  readonly logLines: readonly string[];
}

export interface BuiltReport {
  readonly text: string;
  readonly logLineCount: number;
}

const PLATFORM_NAME: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

/**
 * Wartosc spoza bloku logu idzie do zgloszenia jako zwykly Markdown, wiec trafia do znacznika kodu:
 * `@nazwa`, `#123` i odnosniki nie tworza wtedy wzmianek ani linkow.
 */
function code(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ');
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

function clipLine(line: string): string {
  return line.length > MAX_LOG_LINE_LENGTH ? `${line.slice(0, MAX_LOG_LINE_LENGTH)}...` : line;
}

function fence(lines: readonly string[]): string[] {
  // Trzy apostrofy zamiast potrojnego backticka: linia logu nie moze zamknac bloku.
  const safe = lines.map((line) => line.replaceAll('```', "'''"));
  return ['```text', ...safe, '```'];
}

function databaseLines(report: DiagnosticsReport): string[] {
  const db = report.database;
  if (db.status === 'ok') {
    return [
      '- stan: działa',
      `- silnik: ${db.engine} ${db.engineVersion}`,
      `- SQLite: ${db.sqliteVersion}`,
      `- wyszukiwanie pełnotekstowe: ${db.fts5Available ? 'dostępne' : 'niedostępne'}`,
      `- tryb dziennika: ${db.journalMode}`,
      `- wersja schematu: ${db.schemaVersion}`,
    ];
  }
  if (db.status === 'failed') return ['- stan: błąd odczytu', `- powód: ${code(db.reason)}`];
  return ['- stan: niedostępna', `- powód: ${code(db.reason)}`];
}

function indexLines(report: DiagnosticsReport): string[] {
  const { index, dataMigration } = report;
  const lines = [`- wynik startu: ${code(index.outcome)}`];
  if (index.reason !== undefined) lines.push(`- przyczyna: ${code(index.reason)}`);
  if (index.message !== undefined && index.message !== '')
    lines.push(`- komunikat: ${code(index.message)}`);
  if (index.quarantinedAs !== undefined)
    lines.push(`- plik w kwarantannie: ${code(index.quarantinedAs)}`);
  if (index.restoredItems !== undefined) {
    lines.push(`- elementów odtworzonych z plików: ${index.restoredItems}`);
  }
  for (const line of index.notRestored ?? []) lines.push(`- nie odzyskano: ${code(line)}`);
  if (dataMigration !== undefined) {
    lines.push(`- migracja danych z v0.1.0: ${code(dataMigration.outcome)}`);
    if (dataMigration.errorCode !== undefined) {
      lines.push(`- kod błędu migracji: ${code(dataMigration.errorCode)}`);
    }
    if (dataMigration.message !== undefined) {
      lines.push(`- komunikat migracji: ${code(dataMigration.message)}`);
    }
  }
  return lines;
}

function libraryLines(library: ReportLibrarySummary | null): string[] {
  if (library === null) return ['- biblioteka była niedostępna przy tworzeniu raportu'];
  const lines = [`- elementów razem: ${library.total}`];
  for (const [kind, count] of Object.entries(library.countsByKind)) {
    if (count > 0) lines.push(`- ${kind}: ${count}`);
  }
  lines.push(`- elementy z problemem przy odczycie: ${library.problems}`);
  lines.push(`- elementy z plikami niezgodnymi z zapisem: ${library.inconsistent}`);
  return lines;
}

function toolLines(tools: readonly ReportTool[] | null): string[] {
  if (tools === null) return ['- wykrywanie lokalizacji nie powiodło się'];
  if (tools.length === 0) return ['- nie wykryto żadnej lokalizacji'];
  return tools.map(
    (t) =>
      `- ${code(t.tool)}, ${code(t.kind)}: ${t.exists ? 'jest' : 'brak'}, ${t.active ? 'czytana przez narzędzie' : 'nieaktywna'} (${code(t.label)})`,
  );
}

function header(generatedAt: string, warnings: readonly string[]): string[] {
  return [
    '# Raport diagnostyczny CWM',
    '',
    `Wygenerowany: ${generatedAt}`,
    '',
    '## Co zostało zredagowane',
    '',
    ...REDACTION_CATEGORIES.map((c) => `- ${c.label}: ${c.replacement}`),
    '',
    'Redakcja jest automatyczna i nie daje gwarancji. Przeczytaj raport przed wysłaniem. Aplikacja',
    'niczego nie wysyła sama: plik zapisuje się tylko tam, gdzie go wskażesz.',
    '',
    ...warnings.flatMap((w) => [`Uwaga: ${w}`, '']),
  ];
}

export function buildReport(input: ReportInput, redactor: ReportRedactor): BuiltReport {
  const { diagnostics } = input;
  const { runtime } = diagnostics;
  const platform = PLATFORM_NAME[runtime.platform] ?? runtime.platform;
  const logLines = input.logLines.slice(-REPORT_LOG_LINES);

  const body = [
    '## Aplikacja i środowisko',
    '',
    `- wersja aplikacji: ${runtime.appVersion}`,
    `- Electron: ${runtime.electronVersion}`,
    `- Chromium: ${runtime.chromeVersion}`,
    `- Node: ${runtime.nodeVersion}`,
    `- system: ${platform}, ${runtime.arch}`,
    `- wydanie: ${runtime.packaged ? 'zapakowana aplikacja' : 'uruchomienie deweloperskie'}`,
    '',
    '## Start indeksu',
    '',
    ...indexLines(diagnostics),
    '',
    '## Baza',
    '',
    ...databaseLines(diagnostics),
    '',
    '## Biblioteka (same liczby)',
    '',
    ...libraryLines(input.library),
    '',
    '## Wykryte narzędzia',
    '',
    ...toolLines(input.tools),
    '',
    '## Ustawienia aplikacji',
    '',
    '- jedyne trwałe ustawienia to limity retencji historii (ADR 0056); ich wartości nie są dołączane',
    '',
    '## Ograniczenia',
    '',
    `- ikona aplikacji: ${diagnostics.appIcon === 'placeholder' ? 'tymczasowa' : 'ustawiona'}`,
    `- etap: ${diagnostics.stage}`,
    `- stan ekranu Diagnostyka z: ${diagnostics.generatedAt}`,
    '',
  ].join('\n');

  // Log redagujemy jako jeden tekst (blok klucza prywatnego rozciaga sie na wiele linii), a
  // dopiero potem skracamy linie: obciecie przed redakcja moglo rozciac sekret na pol.
  const redactedLog =
    logLines.length === 0 ? [] : redactor.redact(logLines.join('\n')).split('\n').map(clipLine);
  const logSection = [
    `## Ostatnie linie logu (${logLines.length}, najwyżej ${REPORT_LOG_LINES})`,
    '',
    ...(redactedLog.length === 0 ? ['Log jest pusty albo nie istnieje.'] : fence(redactedLog)),
    '',
  ];

  const text = [
    ...header(diagnostics.generatedAt, redactor.warnings),
    redactor.redact(body),
    ...logSection,
  ].join('\n');
  return { text, logLineCount: logLines.length };
}

export function reportFileName(generatedAt: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(generatedAt)?.[0] ?? 'raport';
  return `cwm-raport-${day}.md`;
}
