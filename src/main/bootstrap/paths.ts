import { join, resolve } from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'bundle';
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/** Katalog zbudowanego renderera: `dist/renderer`, obok `dist/main`. */
export function rendererRoot(): string {
  return resolve(join(__dirname, '..', '..', 'renderer'));
}

/** Ikona okna na Linuksie i Windowsie; plik leży w bundlu renderera (resources/icons/src/build.py). */
export function windowIcon(): string {
  return join(rendererRoot(), 'assets', 'icons', 'app-icon.png');
}

export function preloadScript(): string {
  return resolve(join(__dirname, '..', '..', 'preload', 'bridge.js'));
}

export function databaseFile(userDataDir: string): string {
  return join(userDataDir, 'index.db');
}

/** Katalog, do ktorego trafia stary indeks przed odbudowa (ADR 0029). */
export function quarantineRoot(userDataDir: string): string {
  return join(userDataDir, 'quarantine');
}

/** Biblioteka elementow na dysku (`items/<id>`), ADR 0014. */
export function libraryRoot(userDataDir: string): string {
  return join(userDataDir, 'library');
}

/** Content store z poprzednimi wersjami (`objects/<aa>/<sha256>`), ADR 0019. */
export function objectsRoot(userDataDir: string): string {
  return join(userDataDir, 'objects');
}
