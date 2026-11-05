import { describe, expect, it } from 'vitest';

import { LibraryError } from '../../src/core/model/library-errors';
import type { ItemId, Sha256 } from '../../src/core/model/item';
import { sha256Text } from '../../src/core/services/normalization/hash';
import { bytes, createHarness, dec, draft } from './library-fakes';

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof LibraryError) return error.reason;
    throw error;
  }
  return 'ok';
}

type Harness = ReturnType<typeof createHarness>;

/** Element w rewizji 2 z jednym assetem, gotowy do zepsucia. */
async function seeded(): Promise<{ h: Harness; id: ItemId }> {
  const h = createHarness();
  const { item } = await h.service.create(
    draft({ body: 'v1\n', assets: [{ relPath: 'refs/a.md', bytes: bytes('A1') }] }),
  );
  await h.service.update(
    item.id,
    draft({ body: 'v2\n', assets: [{ relPath: 'refs/a.md', bytes: bytes('A1') }] }),
  );
  return { h, id: item.id };
}

function files(h: Harness, id: string) {
  return h.store.items.get(id)!;
}

function editBody(h: Harness, id: string, body: string): void {
  h.store.items.set(id, { ...files(h, id), body: bytes(body) });
}

describe('wskaznik na rekord wersji', () => {
  it('item.json wskazuje rekord, ktory lezy w ObjectStore od chwili zapisu', async () => {
    const { h, id } = await seeded();
    const pointer = (JSON.parse(dec(files(h, id).itemJson)) as { versionRecordHash: Sha256 })
      .versionRecordHash;
    expect(await h.objects.has(pointer)).toBe(true);
    expect(pointer).toBe(h.log.records.at(-1)!.after!.versionHash);
  });

  it('create przy niedostepnym ObjectStore nie zapisuje elementu', async () => {
    const h = createHarness();
    h.objects.failPut = new Error('EACCES');
    expect(await reasonOf(h.service.create(draft()))).toBe('backup-failed');
    expect(h.store.writeCalls).toBe(0);
  });
});

describe('list: element niespojny', () => {
  it('jest raportowany z id, slugiem, kindem i lista plikow, a nie w items ani problems', async () => {
    const { h, id } = await seeded();
    const good = await h.service.create(draft({ slug: 'acme-good' }));
    editBody(h, id, 'zmienione poza aplikacja\n');

    const result = await h.service.list();
    expect(result.items.map((i) => i.id)).toEqual([good.item.id]);
    expect(result.problems).toEqual([]);
    expect(result.inconsistent).toMatchObject([
      {
        id,
        slug: 'acme-review',
        kind: 'skill',
        files: [{ path: 'body.md', problem: 'hash-differs' }],
      },
    ]);
  });

  it('rozroznia zmieniony i brakujacy plik oraz podaje je wszystkie', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...files(h, id), assets: [] });
    editBody(h, id, 'x\n');

    const [entry] = (await h.service.list()).inconsistent;
    expect(entry!.files).toEqual([
      { path: 'body.md', problem: 'hash-differs' },
      { path: 'assets/refs/a.md', problem: 'missing' },
    ]);
  });

  it('item.json, ktorego nie da sie sparsowac, zostaje w problems', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...files(h, id), itemJson: bytes('{') });
    const result = await h.service.list();
    expect(result.inconsistent).toEqual([]);
    expect(result.problems.map((p) => p.reason)).toEqual(['item-json-malformed']);
  });

  it('spojny element nie jest raportowany jako niespojny', async () => {
    const { h } = await seeded();
    expect((await h.service.list()).inconsistent).toEqual([]);
  });

  it('get nadal odmawia odczytu niespojnego elementu', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'x\n');
    expect(await reasonOf(h.service.get(id))).toBe('integrity-mismatch');
  });
});

describe('adoptDisk: bajty z dysku staja sie nowa rewizja', () => {
  it('przyjmuje reczna edycje, normalizuje do LF i podnosi rewizje', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'reczna\r\nedycja\r\n');
    const pointerBefore = (JSON.parse(dec(files(h, id).itemJson)) as { versionRecordHash: Sha256 })
      .versionRecordHash;

    const { item } = await h.service.adoptDisk(id);

    expect(item.version.revision).toBe(3);
    expect(item.content.body).toBe('reczna\nedycja\n');
    expect(item.version.contentHash).toBe(sha256Text('reczna\nedycja\n'));
    expect(dec(files(h, id).body)).toBe('reczna\nedycja\n');
    expect((await h.service.get(id)).item.version.revision).toBe(3);
    expect((await h.service.list()).inconsistent).toEqual([]);

    expect(await h.objects.has(pointerBefore)).toBe(true);
    expect(await h.objects.has(sha256Text('reczna\r\nedycja\r\n'))).toBe(true);
    const record = h.log.records.at(-1)!;
    expect(record).toMatchObject({
      operation: 'adopt-disk',
      itemId: id,
      slug: 'acme-review',
      before: { revision: 2 },
      after: { revision: 3, contentHash: item.version.contentHash },
    });
    expect(await h.objects.has(record.before!.versionHash)).toBe(true);
  });

  it('przyjmuje zmieniony, nowy i brakujacy plik pomocniczy', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, {
      ...files(h, id),
      assets: [
        { relPath: 'refs/b.md', bytes: bytes('nowy plik') },
        { relPath: 'refs/a.md', bytes: bytes('A2 zmieniony') },
      ],
    });

    const loaded = (await h.service.adoptDisk(id), await h.service.get(id));
    expect(loaded.assets.map((a) => a.relPath).sort()).toEqual(['refs/a.md', 'refs/b.md']);
    expect(loaded.item.assets.find((a) => a.relPath === 'refs/a.md')!.bytesHash).toBe(
      sha256Text('A2 zmieniony'),
    );

    h.store.items.set(id, { ...files(h, id), assets: [] });
    await h.service.adoptDisk(id);
    expect((await h.service.get(id)).assets).toEqual([]);
  });

  it('odmawia dla elementu spojnego i niczego nie zapisuje', async () => {
    const { h, id } = await seeded();
    const writes = h.store.writeCalls;
    expect(await reasonOf(h.service.adoptDisk(id))).toBe('not-inconsistent');
    expect(h.store.writeCalls).toBe(writes);
  });

  it('odmawia, gdy asset z dysku ma niedozwolona nazwe, i nie zapisuje', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...files(h, id), assets: [{ relPath: 'aux.txt', bytes: bytes('x') }] });
    const writes = h.store.writeCalls;
    expect(await reasonOf(h.service.adoptDisk(id))).toBe('asset-path-reserved-name');
    expect(h.store.writeCalls).toBe(writes);
  });

  it('awaria ObjectStore blokuje zapis, plik zostaje taki, jaki byl na dysku', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'reczna edycja\n');
    const before = structuredClone(files(h, id));
    const writes = h.store.writeCalls;
    const logged = h.log.records.length;
    h.objects.failPut = new Error('ENOSPC');

    expect(await reasonOf(h.service.adoptDisk(id))).toBe('backup-failed');
    expect(h.store.writeCalls).toBe(writes);
    expect(files(h, id)).toEqual(before);
    expect(h.log.records).toHaveLength(logged);
  });

  it('kolizja sluga z innym elementem blokuje przyjecie stanu', async () => {
    const { h, id } = await seeded();
    await h.service.create(draft({ slug: 'acme-other' }));
    editBody(h, id, 'x\n');
    h.store.items.set(id, {
      ...files(h, id),
      itemJson: bytes(dec(files(h, id).itemJson).replace('"acme-review"', '"Acme-Other"')),
    });
    expect(await reasonOf(h.service.adoptDisk(id))).toBe('slug-collision');
  });
});

describe('restoreVersion: powrot do wersji wskazanej przez item.json', () => {
  it('przywraca wersje po recznej edycji i archiwizuje surowe bajty z dysku', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'reczna edycja\r\n');

    const { item } = await h.service.restoreVersion(id);

    expect(item.content.body).toBe('v2\n');
    expect(item.version.revision).toBe(3);
    expect(dec(files(h, id).body)).toBe('v2\n');
    expect((await h.service.get(id)).assets.map((a) => a.relPath)).toEqual(['refs/a.md']);
    expect(await h.objects.has(sha256Text('reczna edycja\r\n'))).toBe(true);
    expect(h.log.records.at(-1)).toMatchObject({
      operation: 'restore',
      before: { revision: 2 },
      after: { revision: 3, contentHash: sha256Text('v2\n') },
    });
  });

  it('przerwany zapis (nowy item.json, stare body.md) wraca do nowej wersji z rekordu', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'v1\n');
    expect(await reasonOf(h.service.get(id))).toBe('integrity-mismatch');

    const { item } = await h.service.restoreVersion(id);
    expect(item.content.body).toBe('v2\n');
  });

  it('przywraca takze zmieniony asset i snapshot zrodla', async () => {
    const h = createHarness();
    const original = bytes('---\r\nname: acme\r\n---\r\n');
    const { item } = await h.service.create(
      draft({
        assets: [{ relPath: 'a.md', bytes: bytes('A') }],
        source: {
          importedFrom: null,
          snapshots: [
            {
              tool: 'codex',
              files: [{ relPath: 'SKILL.md', bytes: original, mode: 0o644 }],
              unmappedKeys: [],
            },
          ],
        },
      }),
    );
    h.store.items.set(item.id, {
      ...files(h, item.id),
      assets: [{ relPath: 'a.md', bytes: bytes('zmieniony') }],
      snapshotFiles: [{ tool: 'codex', relPath: 'SKILL.md', bytes: bytes('inny') }],
    });

    await h.service.restoreVersion(item.id);
    const loaded = await h.service.get(item.id);
    expect(new TextDecoder().decode(loaded.assets[0]!.bytes)).toBe('A');
    expect([...loaded.snapshotFiles[0]!.bytes]).toEqual([...original]);
  });

  it('odmawia dla elementu spojnego', async () => {
    const { h, id } = await seeded();
    expect(await reasonOf(h.service.restoreVersion(id))).toBe('not-inconsistent');
  });

  it('brak rekordu w objects/: rozpoznany blad, dysk bez zmian', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'reczna edycja\n');
    h.objects.objects.clear();
    const before = structuredClone(files(h, id));
    const writes = h.store.writeCalls;

    const attempt = h.service.restoreVersion(id);
    await expect(attempt).rejects.toMatchObject({
      reason: 'version-record-missing',
      message: expect.stringContaining('rekordu wersji') as string,
    });
    expect(h.store.writeCalls).toBe(writes);
    expect(files(h, id)).toEqual(before);
    expect(h.objects.putCalls).toBeGreaterThan(0);
    expect(h.objects.objects.size).toBe(0);
  });

  it('element zapisany bez wskaznika na rekord: rozpoznany blad', async () => {
    const { h, id } = await seeded();
    const json = JSON.parse(dec(files(h, id).itemJson)) as Record<string, unknown>;
    delete json['versionRecordHash'];
    h.store.items.set(id, {
      ...files(h, id),
      itemJson: bytes(JSON.stringify(json)),
      body: bytes('x\n'),
    });
    expect(await reasonOf(h.service.restoreVersion(id))).toBe('version-record-missing');
  });

  it('rekord uszkodzony w ObjectStore (bajty niezgodne z hashem) to brak rekordu', async () => {
    const { h, id } = await seeded();
    const pointer = (JSON.parse(dec(files(h, id).itemJson)) as { versionRecordHash: Sha256 })
      .versionRecordHash;
    h.objects.objects.set(pointer, bytes('{"uszkodzone": true}'));
    editBody(h, id, 'x\n');
    expect(await reasonOf(h.service.restoreVersion(id))).toBe('version-record-missing');
  });

  it('brak bajtow assetu wymienionego w rekordzie to brak rekordu', async () => {
    const { h, id } = await seeded();
    h.objects.objects.delete(sha256Text('A1'));
    editBody(h, id, 'x\n');
    const attempt = h.service.restoreVersion(id);
    await expect(attempt).rejects.toMatchObject({ reason: 'version-record-missing' });
    await expect(attempt).rejects.toMatchObject({
      message: expect.stringContaining('assets/refs/a.md') as string,
    });
  });

  it('awaria ObjectStore przy archiwizacji surowych bajtow blokuje zapis', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'reczna edycja\n');
    const before = structuredClone(files(h, id));
    const writes = h.store.writeCalls;
    h.objects.failPut = new Error('EACCES');

    expect(await reasonOf(h.service.restoreVersion(id))).toBe('backup-failed');
    expect(h.store.writeCalls).toBe(writes);
    expect(files(h, id)).toEqual(before);
  });
});

describe('usuniecie elementu niespojnego', () => {
  it('plan jest mozliwy, opisuje element i apply usuwa go po zarchiwizowaniu surowych bajtow', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'reczna edycja\r\n');
    const plan = await h.service.planDelete(id);

    expect(plan).toMatchObject({
      itemId: id,
      slug: 'acme-review',
      kind: 'skill',
      consistent: false,
      applicable: true,
      assetCount: 1,
    });

    h.objects.objects.clear();
    let archivedAtRemoval = false;
    h.store.onRemove = () => {
      archivedAtRemoval = h.objects.objects.has(sha256Text('reczna edycja\r\n'));
    };
    await h.service.applyDelete(plan);

    expect(archivedAtRemoval).toBe(true);
    expect(h.store.items.has(id)).toBe(false);
    const record = h.log.records.at(-1)!;
    expect(record).toMatchObject({ operation: 'delete', slug: 'acme-review', after: null });
    expect(await h.objects.has(record.before!.versionHash)).toBe(true);
  });

  it('element z nieczytelnym item.json tez da sie usunac', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...files(h, id), itemJson: bytes('to nie jest json') });
    const plan = await h.service.planDelete(id);

    expect(plan).toMatchObject({ kind: null, slug: null, title: null, consistent: false });
    await h.service.applyDelete(plan);
    expect(h.store.items.has(id)).toBe(false);
    expect(h.log.records.at(-1)).toMatchObject({ operation: 'delete', itemKind: null, slug: null });
    expect(await h.objects.has(sha256Text('to nie jest json'))).toBe(true);
  });

  it('plan niespojnego elementu przeterminowuje zmiana bajtow na dysku', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'pierwsza edycja\n');
    const plan = await h.service.planDelete(id);
    editBody(h, id, 'druga edycja\n');

    expect(await reasonOf(h.service.applyDelete(plan))).toBe('stale-plan');
    expect(h.store.removeCalls).toBe(0);
    expect(h.store.items.has(id)).toBe(true);
  });

  it('zmiana assetu na dysku tez przeterminowuje plan', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'x\n');
    const plan = await h.service.planDelete(id);
    h.store.items.set(id, {
      ...files(h, id),
      assets: [{ relPath: 'refs/a.md', bytes: bytes('inne') }],
    });
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('stale-plan');
  });

  it('plan spojnego elementu przeterminowuje sie takze po recznej edycji body.md', async () => {
    const { h, id } = await seeded();
    const plan = await h.service.planDelete(id);
    editBody(h, id, 'reczna edycja\n');
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('stale-plan');
    expect(h.store.removeCalls).toBe(0);
  });

  it('plan spojnego elementu bez zmian dalej dziala', async () => {
    const { h, id } = await seeded();
    const plan = await h.service.planDelete(id);
    expect(plan.consistent).toBe(true);
    await h.service.applyDelete(plan);
    expect(h.store.items.has(id)).toBe(false);
  });

  it('awaria ObjectStore blokuje plan usuniecia niespojnego elementu', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'x\n');
    h.objects.failPut = new Error('EACCES');
    const plan = await h.service.planDelete(id);

    expect(plan.applicable).toBe(false);
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('plan-blocked');
    expect(h.store.removeCalls).toBe(0);
  });

  it('awaria ObjectStore miedzy planem a apply nie usuwa niczego', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'x\n');
    const plan = await h.service.planDelete(id);
    h.objects.failPut = new Error('EACCES');
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('backup-failed');
    expect(h.store.items.has(id)).toBe(true);
  });
});

describe('kolizja sluga z elementem niespojnym', () => {
  it('niespojny, ale parsowalny element nadal blokuje lower(slug) + kind', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'x\n');
    expect(await reasonOf(h.service.create(draft({ slug: 'ACME-REVIEW' })))).toBe('slug-collision');
    expect(await reasonOf(h.service.create(draft({ kind: 'agent', slug: 'ACME-REVIEW' })))).toBe(
      'ok',
    );
  });

  it('element z nieparsowalnym item.json nie blokuje', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...files(h, id), itemJson: bytes('{') });
    expect(await reasonOf(h.service.create(draft({ slug: 'acme-review' })))).toBe('ok');
  });

  it('po naprawie slug nadal jest zajety przez ten sam element', async () => {
    const { h, id } = await seeded();
    editBody(h, id, 'x\n');
    await h.service.adoptDisk(id);
    expect(await reasonOf(h.service.create(draft({ slug: 'Acme-Review' })))).toBe('slug-collision');
  });
});

describe('manifest stanu dysku', () => {
  it('nie zalezy od kolejnosci plikow', async () => {
    const { h, id } = await seeded();
    const a = { relPath: 'refs/a.md', bytes: bytes('1') };
    const b = { relPath: 'refs/b.md', bytes: bytes('2') };
    editBody(h, id, 'x\n');
    h.store.items.set(id, { ...files(h, id), assets: [a, b] });
    const first = await h.service.planDelete(id);
    h.store.items.set(id, { ...files(h, id), assets: [b, a] });
    const second = await h.service.planDelete(id);
    expect(second.stateHash).toBe(first.stateHash);
  });
});
