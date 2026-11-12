import type { Command } from 'commander';

import { escapeControlChars } from '../core/cwm';
import { createLayout, resolveCwmHome, type CwmLayout, type Problem } from '../infra/cwm';

/** 1: bledy walidacji i polityki, stan na dysku. 2: bledne uzycie (flagi, argumenty, brak wartosci). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const usageError = (message: string): CliError => new CliError(message, 2);
export const failure = (message: string): CliError => new CliError(message, 1);

export interface GlobalOptions {
  readonly json?: boolean;
  readonly input?: boolean;
}

export interface Context {
  readonly layout: CwmLayout;
  readonly json: boolean;
  /** Pytania tylko na terminalu, bez --json i bez --no-input. */
  readonly interactive: boolean;
}

export function contextOf(command: Command): Context {
  const options = command.optsWithGlobals<GlobalOptions>();
  const json = options.json === true;
  let home: string;
  try {
    home = resolveCwmHome();
  } catch (error: unknown) {
    throw usageError(error instanceof Error ? error.message : 'Niepoprawny CWM_HOME.');
  }
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  return {
    layout: createLayout(home),
    json,
    interactive: tty && !json && options.input !== false,
  };
}

/**
 * Kazdy tekst z dysku (nazwy plikow, klucze, komunikaty) przechodzi tu przed wypisaniem w trybie
 * czytelnym: znaki sterujace i formatujace (Cc, Cf) wychodza jako `\xNN`. Nowa linia i tabulator zostaja.
 */
export function safeText(text: string): string {
  return escapeControlChars(text, '\n\t');
}

function line(text: string): string {
  const safe = safeText(text);
  return safe.endsWith('\n') ? safe : `${safe}\n`;
}

export function print(text: string): void {
  process.stdout.write(line(text));
}

export function warn(text: string): void {
  process.stderr.write(line(text));
}

/** JSON dla maszyn: bez zmian w tresci, `JSON.stringify` sam zapisuje znaki sterujace jako \uXXXX. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function formatProblem(problem: Problem): string {
  const position = problem.line > 0 ? `:${problem.line}:${problem.col}` : '';
  const field = problem.path === '$' ? '' : `${problem.path}: `;
  return safeText(`${problem.file}${position}: ${field}${problem.message}`);
}

/** Wyrownane kolumny; ostatnia kolumna bez dopelnienia. */
export function table(input: readonly (readonly string[])[]): string {
  const rows = input.map((row) => row.map((cell) => safeText(cell)));
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  '),
    )
    .join('\n');
}
