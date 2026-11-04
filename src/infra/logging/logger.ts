import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { redactSecrets } from '../../core/services/security/secret-redactor';
import { redactHomeInText } from './redact';

/**
 * Minimalny logger procesu glownego (ADR 0014, ARCHITECTURE 8.4). Kazda linia przechodzi przez
 * redakcje sekretow wedlug klasyfikatora i katalogu domowego, wiec serwis nie moze zalogowac
 * sekretu, nawet gdyby chcial. Zapis do pliku jest best-effort: awaria logu nie przerywa pracy.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LoggerOptions {
  readonly logFile: string;
  readonly homeDir: string;
  /** Drugi kanal (stderr) dla CI i uruchomienia z terminala; domyslnie `process.stderr`. */
  readonly echo?: ((line: string) => void) | null;
  readonly now?: () => Date;
  readonly maxBytes?: number;
}

export interface Logger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

export function logFilePath(userDataDir: string): string {
  return join(userDataDir, 'logs', 'app.log');
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[nieserializowalne]';
  }
}

/** Redakcja jednej linii: sekrety, potem katalog domowy, potem lamanie linii (wstrzykniecie wpisu). */
export function redactLogLine(line: string, homeDir: string): string {
  const withoutSecrets = redactSecrets(line).text;
  return redactHomeInText(withoutSecrets, homeDir).replace(/[\r\n]+/g, ' ');
}

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? ((): Date => new Date());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const echo =
    options.echo === undefined
      ? (line: string): void => void process.stderr.write(`${line}\n`)
      : options.echo;

  function rotateIfNeeded(): void {
    try {
      if (statSync(options.logFile).size >= maxBytes) {
        renameSync(options.logFile, `${options.logFile}.1`);
      }
    } catch {
      // Brak pliku to normalny stan przy pierwszym wpisie.
    }
  }

  function write(level: LogLevel, message: string, details: readonly unknown[]): void {
    const text = [message, ...details.map(describe)].join(' ');
    const line = `${now().toISOString()} ${level.toUpperCase()} ${redactLogLine(text, options.homeDir)}`;
    try {
      mkdirSync(dirname(options.logFile), { recursive: true, mode: 0o700 });
      rotateIfNeeded();
      appendFileSync(options.logFile, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Log, ktorego nie da sie zapisac, nie moze zabic aplikacji.
    }
    echo?.(line);
  }

  return {
    info: (message, ...details) => write('info', message, details),
    warn: (message, ...details) => write('warn', message, details),
    error: (message, ...details) => write('error', message, details),
  };
}
