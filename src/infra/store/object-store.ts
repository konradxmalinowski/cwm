import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Sha256 } from '../../core/model/item';
import { isAtomicTempName } from '../../core/model/library-file-names';
import { MAX_OBJECT_BYTES } from '../../core/model/library-limits';
import type { ObjectStore } from '../../core/ports/object-store';
import type { CodedStoreError, StoreFailureCode } from '../../core/ports/store-failure';
import { sha256Bytes } from '../../core/services/normalization/hash';
import { ensureDirectory, errnoCode, writeFileAtomic, type AtomicOps } from '../fs/atomic';
import { readChecked } from '../fs/bounded-read';
import { lstatOrNull } from '../fs/stat';
import { guarded } from '../fs/store-error';

export class ObjectStoreError extends Error implements CodedStoreError {
  readonly failureCode: StoreFailureCode;

  constructor(
    readonly reason: 'corrupt' | 'invalid-hash' | 'symlink' | 'not-regular-file' | 'too-large',
    message: string,
  ) {
    super(message);
    this.failureCode =
      reason === 'symlink'
        ? 'symlink'
        : reason === 'not-regular-file'
          ? 'not-a-file'
          : reason === 'too-large'
            ? 'too-large'
            : 'unknown';
    this.name = 'ObjectStoreError';
  }
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Katalogi `<aa>` posprzatane w tym procesie: pliki porzucone przez zabity proces czeka sie raz, nie przy kazdym `put`. */
const sweptShards = new Set<string>();

/** Pozostalosc po zabitym procesie jest starsza niz zapis w toku; zapis trwa milisekundy. */
const STALE_TEMP_AGE_MS = 10 * 60 * 1000;

/** Content store `objects/<aa>/<sha256>` (ADR 0019, 0027). Obiekty sa niezmienne i nigdy nie sa czyszczone. */
export class FsObjectStore implements ObjectStore {
  constructor(
    private readonly objectsDir: string,
    private readonly options: { readonly atomicOps?: Partial<AtomicOps> } = {},
  ) {}

  async put(bytes: Uint8Array): Promise<Sha256> {
    return guarded(() => this.doPut(bytes));
  }

  async get(hash: Sha256): Promise<Uint8Array | null> {
    return guarded(() => this.doGet(hash));
  }

  async has(hash: Sha256): Promise<boolean> {
    return guarded(() => this.doHas(hash));
  }

  private async doPut(bytes: Uint8Array): Promise<Sha256> {
    // Obiekt wiekszy niz limit nie dalby sie potem odczytac, wiec nie trafia na dysk.
    if (bytes.length > MAX_OBJECT_BYTES) {
      throw new ObjectStoreError('too-large', 'obiekt przekracza limit rozmiaru');
    }
    const hash = sha256Bytes(bytes);
    const path = await this.locate(hash);

    // Dobry obiekt zostaje, jak jest. Uszkodzony ma pod soba zla tresc, a my trzymamy wlasciwa,
    // wiec zapis go naprawia - inaczej kopia z ADR 0028 byla by tylko z nazwy.
    const existing = await readIfPresent(path, bytes.length);
    if (existing !== null && sha256Bytes(existing) === hash) return hash;

    const shard = join(this.objectsDir, hash.slice(0, 2));
    await ensureDirectory(shard);
    // `mkdir -p` przechodzi przez dowiazanie, wiec katalog <aa> sprawdzamy po utworzeniu (SEC-006).
    await assertNotLink(shard, 'directory');
    if (!sweptShards.has(shard)) {
      sweptShards.add(shard);
      await sweepStaleTemp(shard);
    }
    await writeFileAtomic(path, bytes, {
      mode: 0o600,
      ...(this.options.atomicOps === undefined ? {} : { ops: this.options.atomicOps }),
    });
    return hash;
  }

  private async doGet(hash: Sha256): Promise<Uint8Array | null> {
    const bytes = await readIfPresent(await this.locate(hash));
    if (bytes === null) return null;
    if (sha256Bytes(bytes) !== hash) {
      throw new ObjectStoreError('corrupt', `obiekt ${hash} ma tresc o innym hashu`);
    }
    return bytes;
  }

  /** Tylko istnienie zwyklego pliku pod hashem, bez weryfikacji tresci; tresc sprawdza `get`. */
  private async doHas(hash: Sha256): Promise<boolean> {
    const info = await lstatOrNull(await this.locate(hash));
    if (info === null) return false;
    if (info.isSymbolicLink())
      throw new ObjectStoreError('symlink', `obiekt ${hash} jest dowiazaniem`);
    return info.isFile();
  }

  /** Sciezka obiektu po sprawdzeniu, ze katalog <aa> nie jest dowiazaniem (SEC-006). */
  private async locate(hash: string): Promise<string> {
    const path = this.pathOf(hash);
    await assertNotLink(join(this.objectsDir, hash.slice(0, 2)), 'directory');
    return path;
  }

  /** Hash trafia do sciezki, wiec forma jest sprawdzana przed `join`. */
  private pathOf(hash: string): string {
    if (!HASH_PATTERN.test(hash)) {
      throw new ObjectStoreError('invalid-hash', 'hash obiektu nie jest 64 znakami hex');
    }
    return join(this.objectsDir, hash.slice(0, 2), hash);
  }
}

async function assertNotLink(path: string, kind: 'directory' | 'file'): Promise<void> {
  const info = await lstatOrNull(path);
  if (info === null) return;
  if (info.isSymbolicLink()) throw new ObjectStoreError('symlink', 'dowiazanie w content store');
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) {
    throw new ObjectStoreError('not-regular-file', 'wpis content store ma zly typ');
  }
}

/**
 * Sprzata pliki tymczasowe porzucone przez zabity proces (SEC-010): maja pelna tresc, a store nigdy
 * niczego nie czysci. Najlepszym wysilkiem, bo nieudane sprzatanie nie moze zablokowac zapisu.
 */
async function sweepStaleTemp(shard: string): Promise<void> {
  try {
    for (const name of await readdir(shard)) {
      if (!isAtomicTempName(name)) continue;
      const info = await lstatOrNull(join(shard, name));
      if (info?.isFile() === true && Date.now() - info.mtimeMs > STALE_TEMP_AGE_MS) {
        await unlink(join(shard, name));
      }
    }
  } catch {
    // Zostanie do nastepnego zapisu w tym katalogu.
  }
}

/** `expectedSize`: plik o innym rozmiarze nie moze byc tym obiektem, wiec go nie czytamy (`null` = do zapisu). */
async function readIfPresent(path: string, expectedSize?: number): Promise<Uint8Array | null> {
  // Plik moze zniknac miedzy `lstat` a `open`; dla zapisu to to samo co brak.
  const result = await readChecked(path, MAX_OBJECT_BYTES, {
    strict: true,
    ...(expectedSize === undefined ? {} : { expectedSize }),
  }).catch((error: unknown) => {
    if (errnoCode(error) === 'ENOENT') return { kind: 'missing' as const };
    throw error;
  });
  switch (result.kind) {
    case 'missing':
    case 'other-size':
      return null;
    case 'symlink':
      throw new ObjectStoreError('symlink', 'dowiazanie w content store');
    case 'not-file':
      throw new ObjectStoreError('not-regular-file', 'wpis content store ma zly typ');
    case 'too-large':
      throw new ObjectStoreError('too-large', 'obiekt przekracza limit rozmiaru');
    case 'ok':
      return result.bytes;
  }
}
