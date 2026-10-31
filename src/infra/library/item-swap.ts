import { chmod, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_TREE_DEPTH } from '../../core/model/library-limits';
import { errnoCode } from '../fs/store-error';
import { lstatOrNull } from '../fs/stat';

/**
 * Zamiana katalogu elementu (ADR 0031). Nowy stan powstaje w katalogu roboczym obok `items/<id>`,
 * potem stary katalog idzie na bok, roboczy wchodzi na jego miejsce, a stary jest usuwany.
 *
 * Nazwa katalogu pomocniczego: `.<id>.<work|ready|old>.<pid>.<12 znakow hex>`. Zaczyna sie od kropki
 * i konczy sufiksem, wiec nie jest poprawnym ULID ani nazwa elementu; `list()` je pomija. Id w nazwie
 * pozwala odtworzyc, do ktorego elementu katalog nalezy, a pid i sufiks losowy rozdzielaja zapisy.
 * Rozpoznaje je tylko `parseSideDirName`.
 *
 * Kompletnosc jest oznaczana nazwa: katalog budowany to `work`, a dopiero po fsync wszystkich plikow
 * i katalogow dostaje (jednym renamem) nazwe `ready`. Tylko `ready` kwalifikuje sie do wejscia
 * na miejsce elementu, wiec przerwanie w trakcie zapisu pliku (np. pusty `item.json` po `open`)
 * nie moze dac promocji niekompletnego stanu.
 */
export type SideKind = 'work' | 'ready' | 'old';

const SIDE_NAME = /^\.(.+)\.(work|ready|old)\.(\d+)\.([0-9a-f]{12})$/;

export function sideDirName(id: string, kind: SideKind, suffix: string): string {
  return `.${id}.${kind}.${process.pid}.${suffix}`;
}

export function parseSideDirName(name: string): { id: string; kind: SideKind } | null {
  const match = SIDE_NAME.exec(name);
  if (match === null) return null;
  const kind = match[2];
  return { id: match[1] ?? '', kind: kind === 'old' ? 'old' : kind === 'ready' ? 'ready' : 'work' };
}

export interface SwapDeps {
  readonly renameDir: (from: string, to: string) => Promise<void>;
  readonly removeTree: (path: string) => Promise<void>;
}

/** Usuwa drzewo; na POSIX katalog bez prawa odczytu lub zapisu wymaga najpierw 0700 (tylko w drzewie elementu). */
export async function removeTree(path: string): Promise<void> {
  const attempt = () => rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  try {
    await attempt();
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (process.platform === 'win32' || (code !== 'EACCES' && code !== 'EPERM')) throw error;
    await openUpDirectories(path, 0);
    await attempt();
  }
}

/** Przywraca 0700 katalogom drzewa (bez dowiazan), zeby `rm` mogl je przejsc. */
async function openUpDirectories(path: string, depth: number): Promise<void> {
  if (depth > MAX_TREE_DEPTH) return;
  const info = await lstatOrNull(path);
  if (info === null || !info.isDirectory()) return;
  await chmod(path, 0o700);
  for (const child of await readdir(path, { withFileTypes: true })) {
    if (child.isDirectory()) await openUpDirectories(join(path, child.name), depth + 1);
  }
}

async function bestEffort(task: Promise<void>): Promise<void> {
  try {
    await task;
  } catch {
    // Zostaje do nastepnego zapisu albo odczytu tego elementu: stan na dysku jest spojny.
  }
}

async function newestFirst(paths: readonly string[]): Promise<string[]> {
  const dated: { path: string; mtime: number }[] = [];
  for (const path of paths) {
    dated.push({ path, mtime: (await lstatOrNull(path))?.mtimeMs ?? 0 });
  }
  return dated.sort((a, b) => b.mtime - a.mtime).map((d) => d.path);
}

/**
 * Doprowadza element do stanu bez katalogow pomocniczych. Reguła:
 *
 * - `items/<id>` istnieje: jest kompletny (stary albo juz nowy), bo wchodzi na miejsce dopiero
 *   z nazwy `ready`. Katalogi `work` (porzucone budowanie), `ready` (nieudana zamiana) i `old`
 *   (pozostalosc po udanej zamianie) sa nadmiarowe i znikaja.
 * - `items/<id>` nie ma (przerwanie miedzy dwoma renameami, na Windowsie nie da sie ich zlaczyc):
 *   wchodzi najnowszy `ready`, a gdy go nie ma, wraca najnowszy `old`. Katalog `work` nigdy nie
 *   wchodzi, bo mogl zostac przerwany w polowie zapisu pliku.
 *
 * Dane nie przepadaja: `ready` powstaje dopiero po zapisie i fsync wszystkiego, a `old` jest
 * nietknietym starym stanem (jego tresc jest dodatkowo w `objects/` od `LibraryService.update`).
 * Usuwamy tylko to, co nie zostalo wybrane, i dopiero po udanym przywroceniu.
 */
export async function recoverItem(itemsDir: string, id: string, deps: SwapDeps): Promise<void> {
  let names: string[];
  try {
    names = await readdir(itemsDir);
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }
  const works: string[] = [];
  const readies: string[] = [];
  const olds: string[] = [];
  for (const name of names) {
    const side = parseSideDirName(name);
    if (side?.id !== id) continue;
    (side.kind === 'work' ? works : side.kind === 'ready' ? readies : olds).push(
      join(itemsDir, name),
    );
  }
  if (works.length === 0 && readies.length === 0 && olds.length === 0) return;

  const target = join(itemsDir, id);
  let discard = [...works, ...readies, ...olds];
  if ((await lstatOrNull(target)) === null) {
    const chosen = (await newestFirst(readies))[0] ?? (await newestFirst(olds))[0];
    if (chosen !== undefined) {
      await deps.renameDir(chosen, target);
      discard = discard.filter((path) => path !== chosen);
    }
  }
  for (const path of discard) await bestEffort(deps.removeTree(path));
}

/** Id elementow, dla ktorych w `items/` leza katalogi pomocnicze. */
export function sideDirIds(names: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const name of names) {
    const side = parseSideDirName(name);
    if (side !== null) ids.add(side.id);
  }
  return [...ids];
}

export { bestEffort };
