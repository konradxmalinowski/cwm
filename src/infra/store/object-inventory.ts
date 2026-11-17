import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Sha256 } from '../../core/model/item';
import { isAtomicTempName } from '../../core/model/library-file-names';
import type { ObjectInventory, ObjectListing } from '../../core/ports/retention';
import { lstatOrNull } from '../fs/stat';
import { errnoCode, guarded } from '../fs/store-error';
import { ObjectStoreError } from './object-store';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SHARD_PATTERN = /^[0-9a-f]{2}$/;

/**
 * Spis i usuwanie plikow w `objects/<aa>/<sha256>` dla retencji (ADR 0056). Nie idzie za dowiazaniami:
 * katalog <aa> albo plik bedacy dowiazaniem jest pomijany w spisie i odmowa przy usuwaniu, a
 * `unlink` zdejmuje tylko wpis o nazwie hasha w katalogu store. Pliki tymczasowe zapisu
 * (`.nazwa.pid.sufiks.tmp`) nie sa obiektami i zostaja po stronie `FsObjectStore`.
 */
export class FsObjectInventory implements ObjectInventory {
  constructor(private readonly objectsDir: string) {}

  list(): Promise<ObjectListing> {
    return guarded(() => this.doList());
  }

  remove(hash: Sha256): Promise<boolean> {
    return guarded(() => this.doRemove(hash));
  }

  private async doList(): Promise<ObjectListing> {
    const objects = new Map<Sha256, number>();
    let skipped = 0;

    const root = await lstatOrNull(this.objectsDir);
    if (root === null) return { objects, skipped };
    if (root.isSymbolicLink()) throw new ObjectStoreError('symlink', 'dowiazanie w content store');
    if (!root.isDirectory()) {
      throw new ObjectStoreError('not-regular-file', 'content store nie jest katalogiem');
    }

    for (const shard of await readdir(this.objectsDir)) {
      if (!SHARD_PATTERN.test(shard)) {
        skipped += 1;
        continue;
      }
      const shardDir = join(this.objectsDir, shard);
      const shardInfo = await lstatOrNull(shardDir);
      if (shardInfo === null) continue;
      if (shardInfo.isSymbolicLink() || !shardInfo.isDirectory()) {
        skipped += 1;
        continue;
      }
      for (const name of await readdir(shardDir)) {
        if (isAtomicTempName(name)) continue;
        if (!HASH_PATTERN.test(name) || !name.startsWith(shard)) {
          skipped += 1;
          continue;
        }
        const info = await lstatOrNull(join(shardDir, name));
        if (info === null) continue;
        if (info.isSymbolicLink() || !info.isFile()) {
          skipped += 1;
          continue;
        }
        objects.set(name as Sha256, info.size);
      }
    }
    return { objects, skipped };
  }

  private async doRemove(hash: Sha256): Promise<boolean> {
    if (!HASH_PATTERN.test(hash)) {
      throw new ObjectStoreError('invalid-hash', 'hash obiektu nie jest 64 znakami hex');
    }
    const shardDir = join(this.objectsDir, hash.slice(0, 2));
    const shardInfo = await lstatOrNull(shardDir);
    if (shardInfo === null) return false;
    if (shardInfo.isSymbolicLink()) {
      throw new ObjectStoreError('symlink', 'dowiazanie w content store');
    }
    if (!shardInfo.isDirectory()) {
      throw new ObjectStoreError('not-regular-file', 'wpis content store ma zly typ');
    }

    const path = join(shardDir, hash);
    const info = await lstatOrNull(path);
    if (info === null) return false;
    if (info.isSymbolicLink()) throw new ObjectStoreError('symlink', 'dowiazanie w content store');
    if (!info.isFile()) {
      throw new ObjectStoreError('not-regular-file', 'wpis content store ma zly typ');
    }
    try {
      await unlink(path);
    } catch (error: unknown) {
      if (errnoCode(error) === 'ENOENT') return false;
      throw error;
    }
    return true;
  }
}
