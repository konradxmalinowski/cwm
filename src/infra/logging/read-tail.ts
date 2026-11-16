import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

/**
 * Ostatnie linie logu aplikacji do raportu diagnostycznego (ADR 0053). Czyta biezacy plik, a gdy
 * ma za malo linii, dopelnia z poprzedniego (`.1`, po rotacji). Brak pliku to pusty wynik, nie
 * blad: raport ma sie zrobic takze przy pierwszym uruchomieniu. Czyta tylko zwykle pliki (ani
 * dowiazanie, ani urzadzenie) i tylko koncowke, wiec rozmiar logu nie wplywa na pamiec. Linie
 * wracaja nieskrocone: skraca je dopiero raport, po redakcji.
 */

const MAX_READ_BYTES = 256 * 1024;

function readTailLines(file: string): string[] {
  try {
    if (!lstatSync(file).isFile()) return [];
    const fd = openSync(file, 'r');
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return [];
      const size = Math.min(stat.size, MAX_READ_BYTES);
      const start = stat.size - size;
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const read = readSync(fd, buffer, offset, size - offset, start + offset);
        if (read === 0) break;
        offset += read;
      }
      const lines = buffer.subarray(0, offset).toString('utf8').split(/\r?\n/);
      // Odciety od poczatku plik zaczyna sie w srodku linii: pierwszy kawalek odpada.
      return (start > 0 ? lines.slice(1) : lines).filter((line) => line.trim().length > 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function readLogTail(logFile: string, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const current = readTailLines(logFile);
  const lines =
    current.length >= maxLines ? current : [...readTailLines(`${logFile}.1`), ...current];
  return lines.slice(-maxLines);
}
