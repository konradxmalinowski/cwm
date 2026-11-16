import { readFileSync } from 'node:fs';

/**
 * Ostatnie linie logu aplikacji do raportu diagnostycznego (ADR 0053). Czyta biezacy plik, a gdy
 * ma za malo linii, dopelnia z poprzedniego (`.1`, po rotacji). Brak pliku to pusty wynik, nie
 * blad: raport ma sie zrobic takze przy pierwszym uruchomieniu. Zwraca linie takie, jakie logger
 * zapisal, czyli juz po jego redakcji; raport redaguje je jeszcze raz wlasnymi regulami.
 */

const MAX_LINE_LENGTH = 600;

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

function clip(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line;
}

export function readLogTail(logFile: string, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const current = readLines(logFile);
  const lines = current.length >= maxLines ? current : [...readLines(`${logFile}.1`), ...current];
  return lines.slice(-maxLines).map(clip);
}
