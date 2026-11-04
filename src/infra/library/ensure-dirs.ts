import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tworzy katalogi biblioteki i content store przy starcie. Zyje w `infra/library`, bo tylko tam
 * i w innych dozwolonych miejscach wolno wolac funkcje zapisujace (regula lintu, ADR 0012).
 */
export function ensureLibraryDirs(libraryDir: string, objectsDir: string): void {
  mkdirSync(join(libraryDir, 'items'), { recursive: true });
  mkdirSync(objectsDir, { recursive: true });
}
