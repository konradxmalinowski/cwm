import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { TOOL_IDS, type AssetFile, type SnapshotFile, type ToolId } from '../../core/model/item';
import { isAtomicTempName } from '../../core/model/library-file-names';
import {
  MAX_FILE_BYTES,
  MAX_ITEM_BYTES,
  MAX_ITEM_JSON_BYTES,
  MAX_TREE_DEPTH,
} from '../../core/model/library-limits';
import { isPathInside } from '../../core/model/path-containment';
import type {
  LibraryStore,
  SalvageResult,
  SalvagedEntry,
  StoredItemFiles,
  UnreadableEntry,
} from '../../core/ports/library-store';
import type { CodedStoreError, StoreFailureCode } from '../../core/ports/store-failure';
import { checkAssetPath } from '../../core/services/library/validate';
import {
  DEFAULT_OPS,
  ensureDirectory,
  renameWithRetry,
  syncDirectory,
  type AtomicOps,
} from '../fs/atomic';
import { readBounded, readChecked } from '../fs/bounded-read';
import { lstatOrNull } from '../fs/stat';
import { StoreIoError, errnoCode, failureCodeFromErrno, guarded } from '../fs/store-error';

import {
  recoverItem,
  removeTree as defaultRemoveTree,
  sideDirIds,
  sideDirName,
  parseSideDirName,
  bestEffort,
} from './item-swap';

export class LibraryStoreError extends Error implements CodedStoreError {
  readonly failureCode: StoreFailureCode;

  constructor(
    readonly reason:
      | 'invalid-id'
      | 'invalid-name'
      | 'path-escape'
      | 'symlink'
      | 'path-conflict'
      | 'not-a-directory'
      | 'not-a-file'
      | 'temp-name'
      | 'too-deep'
      | 'too-large',
    message: string,
  ) {
    super(message);
    this.failureCode =
      reason === 'symlink'
        ? 'symlink'
        : reason === 'too-deep'
          ? 'path-too-deep'
          : reason === 'not-a-file' || reason === 'path-conflict'
            ? 'not-a-file'
            : reason === 'too-large'
              ? 'too-large'
              : reason === 'path-escape' || reason === 'temp-name' || reason === 'invalid-name'
                ? 'invalid-path'
                : 'unknown';
    this.name = 'LibraryStoreError';
  }
}

export interface FsLibraryStoreOptions {
  /** Szew dla testow: `rename` katalogow, `sleep` i `platform` ponowien (te same co przy plikach). */
  readonly atomicOps?: Partial<AtomicOps>;
  /** Szew dla testow: twarde dowiazanie niezmienionego pliku (domyslnie `fs.link`). */
  readonly link?: (existing: string, created: string) => Promise<void>;
  /** Szew dla testow: usuniecie drzewa (domyslnie `rm -r` z poprawka uprawnien). */
  readonly removeTree?: (path: string) => Promise<void>;
  /** Szew dla testow: zapis nowego pliku w katalogu roboczym (domyslnie `wx`, 0600, fsync). */
  readonly writeNew?: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Szew dla testow: odczyt starego pliku do porownania przy wspoldzieleniu (domyslnie `readBounded`). */
  readonly readExisting?: (path: string, limit: number) => Promise<ReadResult>;
}

type ReadResult = { bytes: Uint8Array; truncated: boolean };

interface PlannedFile {
  /** `item.json` nie jest nigdy wspoldzielony z poprzednia wersja. */
  readonly always?: boolean;
  /** Sciezka wzgledem katalogu elementu, zawsze z `/`. */
  readonly rel: string;
  readonly bytes: Uint8Array;
}

const ITEM_JSON = 'item.json';
const BODY = 'body.md';

/**
 * `library/items/<id>/{item.json, body.md, assets/, snapshots/<tool>/}` (ADR 0014).
 * Zapis buduje nowy stan w katalogu roboczym i zamienia go z `items/<id>` przez rename (ADR 0031):
 * przerwanie w dowolnym momencie zostawia caly stary albo caly nowy element, a `item-swap.ts`
 * naprawia stan miedzy dwoma renameami.
 */
export class FsLibraryStore implements LibraryStore {
  private readonly itemsDir: string;
  private readonly ops: Pick<AtomicOps, 'rename' | 'sleep' | 'platform'>;
  private readonly linkFile: (existing: string, created: string) => Promise<void>;
  private readonly removeTree: (path: string) => Promise<void>;
  private readonly writeNew: (path: string, bytes: Uint8Array) => Promise<void>;
  private readonly readExisting: (path: string, limit: number) => Promise<ReadResult>;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(libraryDir: string, options: FsLibraryStoreOptions = {}) {
    this.itemsDir = join(libraryDir, 'items');
    this.ops = { ...DEFAULT_OPS, ...options.atomicOps };
    this.linkFile = options.link ?? link;
    this.removeTree = options.removeTree ?? defaultRemoveTree;
    this.writeNew = options.writeNew ?? writeNewFile;
    this.readExisting = options.readExisting ?? readBounded;
  }

  async write(id: string, files: StoredItemFiles): Promise<void> {
    return guarded(() => this.doWrite(id, files));
  }

  async read(id: string): Promise<StoredItemFiles | null> {
    return guarded(() => this.locked(id, () => this.doRead(id)));
  }

  async readItemJson(id: string): Promise<Uint8Array | null> {
    return guarded(() => this.locked(id, () => this.doReadItemJson(id)));
  }

  async list(): Promise<readonly string[]> {
    return guarded(() => this.doList());
  }

  async remove(id: string): Promise<void> {
    return guarded(() => this.locked(id, () => this.doRemove(id)));
  }

  async readSalvage(id: string): Promise<SalvageResult | null> {
    return guarded(() => this.locked(id, () => this.doReadSalvage(id)));
  }

  /**
   * Blokada per `id`: zapis, usuniecie, naprawa i kazdy odczyt tego samego elementu ida po kolei,
   * wiec odczyt nie trafi na zamiane w polowie i nie odda mieszanki starego z nowym katalogiem.
   * Port nie zaklada, ze wywolujacy (serwis) sam serializuje. Odczyty innych elementow nie czekaja.
   */
  private withId<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  /** Waliduje `id` (klucz blokady jest nazwa katalogu) i wykonuje zadanie pod blokada tego elementu. */
  private locked<T>(id: string, task: () => Promise<T>): Promise<T> {
    this.itemDir(id);
    return this.withId(id, task);
  }

  private deps() {
    return {
      renameDir: (from: string, to: string) => this.renameDir(from, to),
      removeTree: this.removeTree,
    };
  }

  /**
   * Rename katalogu z ograniczonym ponowieniem na Windowsie (antywirus i indekser trzymaja pliki
   * w srodku). Po wyczerpaniu prob blad ma kod `busy`, a stan na dysku jest taki jak przed wywolaniem.
   */
  private async renameDir(from: string, to: string): Promise<void> {
    try {
      await renameWithRetry(from, to, this.ops);
    } catch (error: unknown) {
      throw new StoreIoError(
        failureCodeFromErrno(errnoCode(error), this.ops.platform, 'replace'),
        error,
      );
    }
  }

  /** Wywolywane pod blokada `id`: brak `items/<id>` moze znaczyc przerwana zamiane, wiec przed `null` probujemy naprawy. */
  private async visibleDir(id: string): Promise<string> {
    const dir = this.itemDir(id);
    if ((await lstatOrNull(dir)) === null) await recoverItem(this.itemsDir, id, this.deps());
    return dir;
  }

  private async doWrite(id: string, files: StoredItemFiles): Promise<void> {
    const target = this.itemDir(id);

    // Cala walidacja sciezek przed pierwszym zapisem, zeby zla sciezka nie zostawila nic na dysku.
    const planned: PlannedFile[] = [{ rel: BODY, bytes: files.body }];
    for (const asset of files.assets) {
      planned.push({ rel: `assets/${asset.relPath}`, bytes: asset.bytes });
    }
    for (const file of files.snapshotFiles) {
      planned.push({ rel: `snapshots/${file.tool}/${file.relPath}`, bytes: file.bytes });
    }
    const last: PlannedFile = { rel: ITEM_JSON, bytes: files.itemJson, always: true };
    assertPlan(target, [...planned, last]);

    await ensureDirectory(this.itemsDir);
    await this.withId(id, async () => {
      await recoverItem(this.itemsDir, id, this.deps());
      const existing = await lstatOrNull(target);
      if (existing?.isSymbolicLink() === true) throw symlinkError('');
      if (existing !== null && !existing.isDirectory()) {
        throw new LibraryStoreError('not-a-directory', 'element nie jest katalogiem');
      }

      const work = join(this.itemsDir, sideDirName(id, 'work', randomSuffix()));
      try {
        await this.buildWork(work, existing === null ? null : target, planned, last);
      } catch (error: unknown) {
        await bestEffort(this.removeTree(work));
        throw error;
      }
      // Dopiero tu, po fsync wszystkiego, katalog dostaje nazwe `ready` i moze byc promowany.
      const ready = join(this.itemsDir, sideDirName(id, 'ready', randomSuffix()));
      try {
        await this.renameDir(work, ready);
      } catch (error: unknown) {
        await bestEffort(this.removeTree(work));
        throw error;
      }
      await this.swap(id, target, ready, existing !== null);
    });
  }

  /**
   * Buduje nowy stan od zera, wiec nie ma w nim dowiazan ani resztek starego. Katalog jest prywatny
   * do chwili zamiany, dlatego pliki ida zwyklym zapisem z fsync (`wx`, 0600), bez pliku tymczasowego
   * i rename: nikt nie widzi polowy pliku, a przerwanie odrzuca caly katalog roboczy.
   */
  private async buildWork(
    work: string,
    previous: string | null,
    planned: readonly PlannedFile[],
    last: PlannedFile,
  ): Promise<void> {
    await mkdir(work, { mode: 0o700 });
    const dirs = new Set<string>([work]);
    const inventory = previous === null ? new Set<string>() : await inventoryOf(previous, '', 0);

    for (const file of [...planned, last]) {
      const segments = file.rel.split('/');
      let current = work;
      for (const segment of segments.slice(0, -1)) {
        current = join(current, segment);
        if (!dirs.has(current)) {
          await mkdir(current, { mode: 0o700 });
          dirs.add(current);
        }
      }
      const destination = join(work, ...segments);
      if (
        file.always !== true &&
        previous !== null &&
        inventory.has(file.rel) &&
        (await this.shareUnchanged(join(previous, ...segments), destination, file.bytes))
      ) {
        continue;
      }
      await this.writeNew(destination, file.bytes);
    }

    for (const dir of dirs) await syncDirectory(dir, this.ops.platform);
  }

  /**
   * Niezmieniony plik: twarde dowiazanie ze starego katalogu zamiast kopii. Pliki nigdy nie sa
   * modyfikowane w miejscu (zapis zawsze tworzy nowy), wiec wspolny inode jest bezpieczny. Gdy
   * dowiazanie sie nie uda (EXDEV, EPERM, FAT, EMLINK), plik jest po prostu zapisany od nowa.
   */
  private async shareUnchanged(
    existing: string,
    destination: string,
    bytes: Uint8Array,
  ): Promise<boolean> {
    // Kazdy blad przy probie wspoldzielenia (odczyt starego pliku, link) to zwykly zapis nowych bajtow.
    try {
      if (!(await sameContent(existing, bytes, this.readExisting))) return false;
      await this.linkFile(existing, destination);
      return true;
    } catch {
      return false;
    }
  }

  private async swap(id: string, target: string, ready: string, hadOld: boolean): Promise<void> {
    let old: string | null = null;
    if (hadOld) {
      if ((await lstatOrNull(target))?.isSymbolicLink() === true) {
        await bestEffort(this.removeTree(ready));
        throw symlinkError('');
      }
      old = join(this.itemsDir, sideDirName(id, 'old', randomSuffix()));
      await restoreOwnerAccess(target);
      try {
        await this.renameDir(target, old);
      } catch (error: unknown) {
        // Stary stan zostal na miejscu.
        await bestEffort(this.removeTree(ready));
        throw error;
      }
    }

    try {
      await this.renameDir(ready, target);
    } catch (error: unknown) {
      if (old !== null) {
        try {
          await this.renameDir(old, target);
        } catch {
          // Cofniecie tez sie nie udalo: stary stan wroci przy nastepnej operacji.
        }
      }
      // Zapis zgloszony jako nieudany nie moze zostac zatwierdzony przy odzyskaniu, wiec `ready`
      // musi przestac sie kwalifikowac, zanim blad wyjdzie: usuwamy go, a gdy sie nie da, odbieramy
      // oznaczenie (powrot do nazwy `work`). Przy awarii obu krokow z rzedu zostaje tylko
      // podwojna usterka dysku, ktorej ten mechanizm nie pokrywa.
      try {
        await this.removeTree(ready);
      } catch {
        await bestEffort(
          this.renameDir(ready, join(this.itemsDir, sideDirName(id, 'work', randomSuffix()))),
        );
      }
      throw error;
    }

    await syncDirectory(this.itemsDir, this.ops.platform);
    // Nowy stan jest juz na dysku, wiec nieudane usuniecie starego nie jest bledem zapisu.
    if (old !== null) await bestEffort(this.removeTree(old));
  }

  private async doRead(id: string): Promise<StoredItemFiles | null> {
    const dir = await this.visibleDir(id);
    const info = await lstatOrNull(dir);
    if (info === null) return null;
    if (info.isSymbolicLink()) throw symlinkError('');
    if (!info.isDirectory()) {
      throw new LibraryStoreError('not-a-directory', 'element nie jest katalogiem');
    }

    // Brakujacy plik czytany jako pusty: `item.json` bez tresci to `item-json-malformed`,
    // a body o innym hashu to `integrity-mismatch`. Ocene robi core, nie ten adapter.
    const budget = { used: 0 };
    // Ten sam odczyt co `readItemJson` (limit + 1 bajt): nadmiar ocenia core po dlugosci, wiec za duzy
    // `item.json` daje ten sam wynik z obu metod.
    const itemJson =
      (await readCapped(join(dir, ITEM_JSON), ITEM_JSON, MAX_ITEM_JSON_BYTES + 1, null)) ??
      new Uint8Array();
    budget.used += itemJson.length;
    const body =
      (await readCapped(join(dir, BODY), BODY, MAX_FILE_BYTES, budget)) ?? new Uint8Array();

    const assets: AssetFile[] = [];
    for (const rel of await listFiles(join(dir, 'assets'), '', 0, 'assets')) {
      // NFC, bo drzewo skopiowane z systemu z NFD (HFS+) ma inne bajty nazwy niz `relPath` w item.json.
      assets.push({
        relPath: rel.normalize('NFC'),
        bytes: await readListed(join(dir, 'assets', rel), `assets/${rel}`, budget),
      });
    }

    const snapshotFiles: SnapshotFile[] = [];
    for (const tool of await listToolDirs(join(dir, 'snapshots'))) {
      const base = join(dir, 'snapshots', tool);
      for (const rel of await listFiles(base, '', 0, `snapshots/${tool}`)) {
        snapshotFiles.push({
          tool,
          relPath: rel.normalize('NFC'),
          bytes: await readListed(join(base, rel), `snapshots/${tool}/${rel}`, budget),
        });
      }
    }

    return { itemJson, body, assets, snapshotFiles };
  }

  /** Czyta co najwyzej `MAX_ITEM_JSON_BYTES + 1` bajtow: nadmiar wykrywa core po dlugosci. */
  private async doReadItemJson(id: string): Promise<Uint8Array | null> {
    const dir = await this.visibleDir(id);
    const info = await lstatOrNull(dir);
    if (info === null) return null;
    if (info.isSymbolicLink()) throw symlinkError('');
    return readCapped(join(dir, ITEM_JSON), ITEM_JSON, MAX_ITEM_JSON_BYTES + 1, null);
  }

  private async doList(): Promise<readonly string[]> {
    const readNames = async () => {
      try {
        return await readdir(this.itemsDir, { withFileTypes: true });
      } catch (error: unknown) {
        if (errnoCode(error) === 'ENOENT') return [];
        throw error;
      }
    };
    let entries = await readNames();
    const pending = sideDirIds(entries.map((e) => e.name));
    if (pending.length > 0) {
      for (const id of pending) {
        await this.withId(id, () => recoverItem(this.itemsDir, id, this.deps()));
      }
      entries = await readNames();
    }
    // Dowiazania wchodza na liste, zeby odczyt je odrzucil, a nie zeby po cichu znikly.
    return entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .filter((name) => parseSideDirName(name) === null)
      .sort();
  }

  private async doRemove(id: string): Promise<void> {
    const target = this.itemDir(id);
    try {
      // Katalogi pomocnicze najpierw: po przerwaniu usuwania nie wroca jako "naprawa" skasowanego elementu.
      let names: string[] = [];
      try {
        names = await readdir(this.itemsDir);
      } catch (error: unknown) {
        if (errnoCode(error) !== 'ENOENT') throw error;
      }
      for (const name of names) {
        if (parseSideDirName(name)?.id === id) await this.removeTree(join(this.itemsDir, name));
      }
      // `rm` nie idzie za dowiazaniami: usuwa samo dowiazanie, nie jego cel.
      await this.removeTree(target);
    } catch (error: unknown) {
      throw new StoreIoError(
        failureCodeFromErrno(errnoCode(error), this.ops.platform, 'replace'),
        error,
      );
    }
  }

  /** `id` to nazwa katalogu: jeden segment, bez separatorow i bez wyjscia w gore. */
  private itemDir(id: string): string {
    if (id === '' || id === '.' || id === '..' || /[\\/\0]/.test(id) || !isPortableName(id)) {
      throw new LibraryStoreError('invalid-id', 'id elementu nie jest nazwa katalogu');
    }
    return join(this.itemsDir, id);
  }

  private async doReadSalvage(id: string): Promise<SalvageResult | null> {
    const dir = await this.visibleDir(id);
    const info = await lstatOrNull(dir);
    if (info === null) return null;
    const entries: SalvagedEntry[] = [];
    const unreadable: UnreadableEntry[] = [];
    // `relPath` pusty oznacza sam katalog elementu.
    if (info.isSymbolicLink())
      return { entries, unreadable: [{ relPath: '', failure: 'symlink' }] };
    if (!info.isDirectory())
      return { entries, unreadable: [{ relPath: '', failure: 'not-a-file' }] };

    await salvageDirectory(dir, '', 0, { used: 0 }, entries, unreadable);
    entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
    unreadable.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { entries, unreadable };
  }
}

/**
 * Przeniesienie katalogu wymaga prawa zapisu do niego samego (macOS aktualizuje wpis `..`). Biblioteka
 * nalezy do aplikacji, a ADR 0018 wymaga dla jej katalogow 0700, wiec zwykly katalog elementu
 * nalezacy do biezacego uzytkownika dostaje 0700 przed odsunieciem. Gdy `chmod` sie nie uda,
 * zostaje blad z `rename` (`permission-denied`). Nie dotyczy Windowsa ani dowiazan.
 */
async function restoreOwnerAccess(dir: string): Promise<void> {
  if (process.platform === 'win32' || process.getuid === undefined) return;
  const info = await lstatOrNull(dir);
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) return;
  if (info.uid !== process.getuid() || (info.mode & 0o700) === 0o700) return;
  try {
    await chmod(dir, 0o700);
  } catch {
    // Zostaje obecny blad z rename.
  }
}

function randomSuffix(): string {
  return randomBytes(6).toString('hex');
}

/** Zwykly plik, ktorego nie ma jeszcze w katalogu roboczym: `wx`, 0600 przy tworzeniu, fsync. */
async function writeNewFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Zwykle pliki starego katalogu (sciezki z `/`), bez wchodzenia w dowiazania. Blad to pusty wynik: brak wspolnych plikow. */
async function inventoryOf(root: string, prefix: string, depth: number): Promise<Set<string>> {
  const out = new Set<string>();
  if (depth > MAX_TREE_DEPTH) return out;
  let children;
  try {
    children = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const child of children) {
    const rel = prefix === '' ? child.name : `${prefix}/${child.name}`;
    if (child.isDirectory()) {
      for (const nested of await inventoryOf(root, rel, depth + 1)) out.add(nested);
    } else if (child.isFile()) {
      out.add(rel);
    }
  }
  return out;
}

/** Zwykly plik, ten sam rozmiar, tryb 0600 (POSIX) i te same bajty. */
async function sameContent(
  path: string,
  bytes: Uint8Array,
  read: (path: string, limit: number) => Promise<ReadResult>,
): Promise<boolean> {
  const info = await lstatOrNull(path);
  if (info === null || !info.isFile() || info.size !== bytes.length) return false;
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) return false;
  const { bytes: existing, truncated } = await read(path, bytes.length + 1);
  return !truncated && Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) === 0;
}

function symlinkError(rel: string): LibraryStoreError {
  return new LibraryStoreError(
    'symlink',
    rel === '' ? 'katalog elementu jest dowiazaniem' : `dowiazanie symboliczne w elemencie: ${rel}`,
  );
}

/**
 * Obrona w glab: core waliduje `relPath`, ale ten adapter nie zaklada, ze ktos to zrobil.
 * Kontrola zawierania to `isPathInside` z core: jedna funkcja dla `main` i `infra`.
 */
export function assertPlan(dir: string, files: readonly PlannedFile[]): void {
  const seen = new Set<string>();
  for (const { rel } of files) {
    const segments = rel.split('/');
    const malformed =
      rel.includes('\0') ||
      rel.includes('\\') ||
      isAbsolute(rel) ||
      /^[a-zA-Z]:/.test(rel) ||
      segments.some((s) => s === '' || s === '.' || s === '..');
    if (malformed) {
      throw new LibraryStoreError('path-escape', `sciezka wychodzi poza element: ${rel}`);
    }
    // Plik o takiej nazwie znikalby przy odczycie jako slad przerwanego zapisu.
    if (segments.some(isAtomicTempName)) {
      throw new LibraryStoreError('temp-name', `nazwa pasuje do pliku tymczasowego: ${rel}`);
    }
    // Reguly nazw przed kontrola zawierania: na Windowsie `resolve` traktuje segment `C:` jako dysk
    // i zwrocilby `path-escape`, wiec `reason` zalezalby od systemu.
    if (!segments.every(isPortableName)) {
      throw new LibraryStoreError('invalid-name', `nazwa niedozwolona na Windowsie: ${rel}`);
    }
    // Kontrola zawierania wspolna z `main` (core/model/path-containment): wynik musi lezec pod katalogiem elementu.
    if (!isPathInside(resolve(dir, ...segments), dir)) {
      throw new LibraryStoreError('path-escape', `sciezka wychodzi poza element: ${rel}`);
    }
    if (seen.has(rel)) {
      throw new LibraryStoreError('path-conflict', `sciezka podana dwa razy: ${rel}`);
    }
    seen.add(rel);
  }
  for (const rel of seen) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) {
        throw new LibraryStoreError('path-conflict', `plik i katalog o tej samej sciezce: ${rel}`);
      }
    }
  }
}

/**
 * Obrona w glab (SEC-008): reguly nazw Windowsa z jednego zrodla, `checkAssetPath` z core (znaki
 * zakazane, `:`, sterujace, koncowa kropka i spacja, nazwy zarezerwowane z `CONIN$` i cyframi
 * w indeksie gornym). Adapter nie zaklada, ze ktos juz wywolal walidator.
 */
export function isPortableName(name: string): boolean {
  return checkAssetPath(name.normalize('NFC')) === null;
}

interface Budget {
  used: number;
}

/**
 * Odczyt pliku elementu z limitem. Brak pliku to `null`, dowiazanie i plik specjalny to blad.
 * Z `budget` egzekwuje limit pliku i sumy (`MAX_FILE_BYTES`, `MAX_ITEM_BYTES`) i rzuca `too-large`;
 * bez `budget` zwraca co najwyzej `limit` bajtow i pozwala wywolujacemu ocenic nadmiar po dlugosci.
 */
async function readCapped(
  path: string,
  label: string,
  limit: number,
  budget: Budget | null,
): Promise<Uint8Array | null> {
  const result = await readChecked(path, limit, { strict: budget !== null });
  switch (result.kind) {
    case 'missing':
      return null;
    case 'symlink':
      throw symlinkError(label);
    case 'not-file':
      throw new LibraryStoreError('not-a-file', `wpis nie jest plikiem: ${label}`);
    case 'too-large':
      throw new LibraryStoreError('too-large', `plik za duzy: ${label}`);
    case 'other-size':
      return null;
    case 'ok':
      if (budget !== null) {
        budget.used += result.size;
        if (budget.used > MAX_ITEM_BYTES) {
          throw new LibraryStoreError('too-large', `plik za duzy: ${label}`);
        }
      }
      return result.bytes;
  }
}

async function readListed(path: string, label: string, budget: Budget): Promise<Uint8Array> {
  const bytes = await readCapped(path, label, MAX_FILE_BYTES, budget);
  if (bytes === null) throw Object.assign(new Error(`plik zniknal: ${label}`), { code: 'ENOENT' });
  return bytes;
}

/** Pliki pod `base` jako sciezki z `/`. Dowiazanie gdziekolwiek w drzewie to blad, nie pominiecie. */
async function listFiles(
  base: string,
  prefix: string,
  depth: number,
  label: string,
): Promise<string[]> {
  if (depth > MAX_TREE_DEPTH) {
    throw new LibraryStoreError('too-deep', 'drzewo plikow jest za glebokie');
  }
  // `readdir` idzie za dowiazaniem, wiec sam katalog bazowy (assets/, snapshots/<tool>/) sprawdzamy wprost.
  if (prefix === '' && (await lstatOrNull(base))?.isSymbolicLink() === true) {
    throw symlinkError(label);
  }
  let entries;
  try {
    entries = await readdir(join(base, prefix), { withFileTypes: true });
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT' && prefix === '') return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw symlinkError(`${label}/${rel}`);
    // Wpis o nazwie jak tymczasowa nie jest assetem (core takich nazw nie przyjmuje); salvage go jednak zbiera.
    if (isAtomicTempName(entry.name)) continue;
    if (entry.isDirectory()) out.push(...(await listFiles(base, rel, depth + 1, label)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function listToolDirs(snapshotsDir: string): Promise<ToolId[]> {
  if ((await lstatOrNull(snapshotsDir))?.isSymbolicLink() === true) throw symlinkError('snapshots');
  let entries;
  try {
    entries = await readdir(snapshotsDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
  const tools: ToolId[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw symlinkError(`snapshots/${entry.name}`);
    // Katalog narzedzia spoza znanej listy nie ma jak trafic do `SnapshotFile`; zapis go posprzata.
    const tool = TOOL_IDS.find((t) => t === entry.name);
    if (entry.isDirectory() && tool !== undefined) tools.push(tool);
  }
  return tools.sort();
}

/**
 * Zbiera wszystko, co da sie odczytac, nigdy nie rzucajac na pojedynczym wpisie. Nie idzie za
 * dowiazaniami i czyta tylko zwykle pliki. Bierze tez pliki o nazwie jak tymczasowe: `remove`
 * usunie kazdy wpis, wiec kazdy czytelny musi trafic do kopii.
 */
async function salvageDirectory(
  root: string,
  prefix: string,
  depth: number,
  budget: Budget,
  entries: SalvagedEntry[],
  unreadable: UnreadableEntry[],
): Promise<void> {
  if (depth > MAX_TREE_DEPTH) {
    unreadable.push({ relPath: prefix, failure: 'path-too-deep' });
    return;
  }
  let children;
  try {
    children = await readdir(join(root, prefix), { withFileTypes: true });
  } catch (error: unknown) {
    unreadable.push({ relPath: prefix, failure: failureCodeFromErrno(errnoCode(error)) });
    return;
  }
  for (const child of children) {
    const rel = prefix === '' ? child.name : `${prefix}/${child.name}`;
    const relPath = rel.normalize('NFC');
    if (child.isDirectory()) {
      await salvageDirectory(root, rel, depth + 1, budget, entries, unreadable);
      continue;
    }
    try {
      const result = await readChecked(join(root, rel), MAX_FILE_BYTES, { strict: true });
      switch (result.kind) {
        case 'ok':
          // Wyczerpany budzet elementu to wpis `unreadable`, nie dalsza alokacja.
          if (budget.used + result.bytes.length > MAX_ITEM_BYTES) {
            unreadable.push({ relPath, failure: 'unknown' });
          } else {
            budget.used += result.bytes.length;
            entries.push({ relPath, bytes: result.bytes });
          }
          break;
        case 'symlink':
          unreadable.push({ relPath, failure: 'symlink' });
          break;
        case 'not-file':
          // FIFO, gniazdo, urzadzenie: wpis ma byc plikiem, a nie jest.
          unreadable.push({ relPath, failure: 'not-a-file' });
          break;
        default:
          unreadable.push({ relPath, failure: 'unknown' });
      }
    } catch (error: unknown) {
      unreadable.push({ relPath, failure: failureCodeFromErrno(errnoCode(error)) });
    }
  }
}
