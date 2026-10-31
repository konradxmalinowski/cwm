import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { Sha256 } from '../../src/core/model/item';
import { MAX_FILE_BYTES } from '../../src/core/model/library-limits';
import { createUlidGenerator } from '../../src/core/ports/id-generator';
import { LibraryService } from '../../src/core/services/library/library-service';
import { FsLibraryStore } from '../../src/infra/library/library-store';
import { FsObjectStore } from '../../src/infra/store/object-store';
import { createTempTree, removeTempTrees } from '../harness/isolation';
import {
  FakeClock,
  MemoryOperationLog,
  bytes,
  deterministicRandom,
  draft,
} from '../unit/library-fakes';

afterAll(() => {
  removeTempTrees();
});

describe('LibraryService na prawdziwym LibraryStore i ObjectStore', () => {
  it('create, update, planDelete, applyDelete: historia w objects/ przezywa usuniecie', async () => {
    const root = createTempTree('acme-e2e-');
    const clock = new FakeClock();
    const log = new MemoryOperationLog();
    const objects = new FsObjectStore(join(root, 'objects'));
    const store = new FsLibraryStore(join(root, 'library'));
    const service = new LibraryService({
      store,
      objects,
      log,
      ids: createUlidGenerator(clock, deterministicRandom()),
      clock,
    });

    const created = await service.create(
      draft({
        body: 'wersja 1\n',
        assets: [{ relPath: 'dane/plik.txt', bytes: bytes('asset v1') }],
      }),
    );
    const id = created.item.id;
    expect(created.item.version.revision).toBe(1);

    clock.advance(1000);
    const updated = await service.update(
      id,
      draft({
        body: 'wersja 2\n',
        assets: [{ relPath: 'dane/plik.txt', bytes: bytes('asset v2') }],
      }),
    );
    expect(updated.item.version.revision).toBe(2);

    // Poprzednia wersja jest w objects/ i odtwarza sie z rekordu wersji (ADR 0028, 0031).
    const archived = log.records[1]?.before;
    expect(archived?.revision).toBe(1);
    const record = await objects.get(archived?.versionHash as Sha256);
    expect(record).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(record ?? new Uint8Array()))).toMatchObject({
      version: { revision: 1 },
    });
    const v1Asset = await objects.get(created.item.assets[0]?.bytesHash as Sha256);
    expect(new TextDecoder().decode(v1Asset ?? new Uint8Array())).toBe('asset v1');

    const plan = await service.planDelete(id);
    expect(plan.applicable).toBe(true);
    expect(plan.revision).toBe(2);
    expect(existsSync(join(root, 'library', 'items', id))).toBe(true);

    await service.applyDelete(plan);

    expect(existsSync(join(root, 'library', 'items', id))).toBe(false);
    expect((await service.list()).items).toEqual([]);
    const deleted = log.records[2]?.before;
    expect(deleted?.revision).toBe(2);
    expect(await objects.has(deleted?.versionHash as Sha256)).toBe(true);
    const v2Asset = await objects.get(updated.item.assets[0]?.bytesHash as Sha256);
    expect(new TextDecoder().decode(v2Asset ?? new Uint8Array())).toBe('asset v2');
  });

  it('za duzy body.md cudzego elementu nie blokuje create', async () => {
    const root = createTempTree('acme-big-');
    const clock = new FakeClock();
    const service = new LibraryService({
      store: new FsLibraryStore(join(root, 'library')),
      objects: new FsObjectStore(join(root, 'objects')),
      log: new MemoryOperationLog(),
      ids: createUlidGenerator(clock, deterministicRandom()),
      clock,
    });
    const other = await service.create(draft({ slug: 'acme-other' }));
    writeFileSync(
      join(root, 'library', 'items', other.item.id, 'body.md'),
      Buffer.alloc(MAX_FILE_BYTES + 1, 0x61),
    );

    await expect(service.create(draft({ slug: 'acme-new' }))).resolves.toBeDefined();
    // Cudzy element jest widoczny w list() jako problem, a nie psuje zapisow.
    const listed = await service.list();
    expect(listed.items.map((i) => i.identity.slug)).toContain('acme-new');
  });
});
