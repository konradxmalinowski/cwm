import { describe, expect, it } from 'vitest';

import type { ItemId } from '../../src/core/model/item';
import { LibraryError } from '../../src/core/model/library-errors';
import {
  MAX_FILE_BYTES,
  MAX_ITEM_BYTES,
  MAX_ITEM_JSON_BYTES,
  MAX_OBJECT_BYTES,
} from '../../src/core/model/library-limits';
import { encodeVersionRecord } from '../../src/core/services/library/item-codec';
import { sha256Text } from '../../src/core/services/normalization/hash';
import { bytes, createHarness, draft } from './library-fakes';

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

async function seeded(): Promise<{ h: Harness; id: ItemId }> {
  const h = createHarness();
  const { item } = await h.service.create(
    draft({
      body: 'v1\n',
      assets: [
        { relPath: 'refs/a.md', bytes: bytes('asset A') },
        { relPath: 'refs/b.md', bytes: bytes('asset B') },
        { relPath: 'refs/c.md', bytes: bytes('asset C') },
      ],
      source: {
        importedFrom: null,
        snapshots: [
          {
            tool: 'codex',
            files: [{ relPath: 'SKILL.md', bytes: bytes('snapshot'), mode: null }],
            unmappedKeys: [],
          },
        ],
      },
    }),
  );
  return { h, id: item.id };
}

describe('limity spojne z odczytem', () => {
  it('body: limit przechodzi, limit + 1 nie', async () => {
    const ok = createHarness();
    await expect(
      ok.service.create(draft({ body: 'a'.repeat(MAX_FILE_BYTES) })),
    ).resolves.toBeDefined();

    const h = createHarness();
    expect(await reasonOf(h.service.create(draft({ body: 'a'.repeat(MAX_FILE_BYTES + 1) })))).toBe(
      'limit-exceeded',
    );
    expect(h.store.writeCalls).toBe(0);
    expect(h.objects.putCalls).toBe(0);
  });

  it('zakodowany item.json: dokladnie limit przechodzi, limit + 1 nie, komunikat nazywa item.json', async () => {
    const withAlias = (n: number) =>
      draft({ identity: { slug: 'acme-review', declaredName: null, aliases: ['x'.repeat(n)] } });

    // Alias jest ASCII, wiec kazdy znak to jeden bajt item.json; narzut mierzymy na pustym aliasie.
    const probe = createHarness();
    const base = await probe.service.create(withAlias(0));
    const overhead = probe.store.items.get(base.item.id)!.itemJson.length;
    const maxAlias = MAX_ITEM_JSON_BYTES - overhead;

    const exact = createHarness();
    const created = await exact.service.create(withAlias(maxAlias));
    expect(exact.store.items.get(created.item.id)!.itemJson.length).toBe(MAX_ITEM_JSON_BYTES);

    const over = createHarness();
    const attempt = over.service.create(withAlias(maxAlias + 1));
    await expect(attempt).rejects.toMatchObject({ reason: 'limit-exceeded' });
    await expect(attempt).rejects.toMatchObject({
      message: expect.stringContaining('item.json') as string,
    });
    expect(over.store.writeCalls).toBe(0);
  });

  it('suma liczy item.json, body, assety i snapshoty: dokladnie limit przechodzi, limit + 1 nie', async () => {
    const asset = (name: string, size: number) => ({
      relPath: name,
      bytes: new Uint8Array(size),
    });
    const withLast = (size: number) =>
      draft({
        assets: [
          asset('a.bin', MAX_FILE_BYTES),
          asset('b.bin', MAX_FILE_BYTES),
          asset('c.bin', MAX_FILE_BYTES),
          asset('d.bin', MAX_FILE_BYTES),
          asset('e.bin', size),
        ],
      });

    const probe = createHarness();
    const measured = await probe.service.create(withLast(MAX_FILE_BYTES - 5000));
    const itemJsonBytes = probe.store.items.get(measured.item.id)!.itemJson.length;
    const exactSize = MAX_ITEM_BYTES - 4 * MAX_FILE_BYTES - itemJsonBytes;
    const bodyBytes = new TextEncoder().encode('# Acme review\n\nSprawdz zmiany.\n').length;

    const ok = createHarness();
    await expect(ok.service.create(withLast(exactSize - bodyBytes))).resolves.toBeDefined();

    const over = createHarness();
    const attempt = over.service.create(withLast(exactSize - bodyBytes + 1));
    await expect(attempt).rejects.toMatchObject({
      reason: 'limit-exceeded',
      message: expect.stringContaining('Element zajmuje') as string,
    });
    expect(over.store.writeCalls).toBe(0);
  });

  it('rekord wersji: znaki sterujace powiekszaja go szesciokrotnie, granica co do bajtu', async () => {
    const probe = createHarness();
    const empty = (await probe.service.create(draft({ body: '' }))).item;
    const base = encodeVersionRecord(empty).length;
    const maxChars = Math.floor((MAX_OBJECT_BYTES - base) / 6);
    const control = (n: number) => draft({ body: '\u0001'.repeat(n) });

    const ok = createHarness();
    const created = await ok.service.create(control(maxChars));
    expect(encodeVersionRecord(created.item).length).toBeLessThanOrEqual(MAX_OBJECT_BYTES);

    const over = createHarness();
    const attempt = over.service.create(control(maxChars + 1));
    await expect(attempt).rejects.toMatchObject({
      reason: 'limit-exceeded',
      message: expect.stringContaining('Zapis wersji') as string,
    });
    expect(over.store.writeCalls).toBe(0);
    expect(over.objects.putCalls).toBe(0);
  });

  it('body o limicie z samych znakow sterujacych jest odrzucone, a tekst o limicie przechodzi', async () => {
    const h = createHarness();
    expect(await reasonOf(h.service.create(draft({ body: '\u0000'.repeat(MAX_FILE_BYTES) })))).toBe(
      'limit-exceeded',
    );
    expect(await reasonOf(h.service.create(draft({ body: 'zażółć\n'.repeat(100_000) })))).toBe(
      'ok',
    );
  });
});

describe('SEC-002: kopia z readSalvage obejmuje cale drzewo', () => {
  const extras = () => [
    { relPath: 'notes.md', bytes: bytes('notatka w korzeniu') },
    { relPath: 'snapshots/cursor/x.md', bytes: bytes('snapshot nieznanego narzedzia') },
  ];

  it('pliki spoza modelu sa odzyskiwalne z objects/ po update', async () => {
    const { h, id } = await seeded();
    h.store.salvageExtra.set(id, extras());
    await h.service.update(id, draft({ body: 'v2\n' }));
    for (const e of extras())
      expect(await h.objects.has(sha256Text(new TextDecoder().decode(e.bytes)))).toBe(true);
  });

  it('pliki spoza modelu sa odzyskiwalne z objects/ po applyDelete', async () => {
    const { h, id } = await seeded();
    h.store.salvageExtra.set(id, extras());
    const plan = await h.service.planDelete(id);
    h.objects.objects.clear();
    await h.service.applyDelete(plan);
    for (const e of extras())
      expect(await h.objects.has(sha256Text(new TextDecoder().decode(e.bytes)))).toBe(true);
    expect(h.store.items.has(id)).toBe(false);
  });

  it('zmiana takiego pliku przeterminowuje plan usuniecia', async () => {
    const { h, id } = await seeded();
    h.store.salvageExtra.set(id, extras());
    const plan = await h.service.planDelete(id);
    h.store.salvageExtra.set(id, [
      { relPath: 'notes.md', bytes: bytes('zmieniona notatka') },
      extras()[1]!,
    ]);
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('stale-plan');
    expect(h.store.removeCalls).toBe(0);
  });

  it('nowy plik w korzeniu po planie tez przeterminowuje plan', async () => {
    const { h, id } = await seeded();
    const plan = await h.service.planDelete(id);
    h.store.salvageExtra.set(id, extras());
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('stale-plan');
  });

  it('nieczytelny wpis blokuje update z lista, a dysk zostaje bez zmian', async () => {
    const { h, id } = await seeded();
    h.store.salvageUnreadable.set(id, [{ relPath: 'notes.md', failure: 'permission-denied' }]);
    const before = structuredClone(h.store.items.get(id));
    const writes = h.store.writeCalls;

    const attempt = h.service.update(id, draft({ body: 'v2\n' }));
    await expect(attempt).rejects.toMatchObject({
      reason: 'backup-failed',
      failure: 'permission-denied',
      message: expect.stringContaining('notes.md') as string,
    });
    expect(h.store.writeCalls).toBe(writes);
    expect(h.store.items.get(id)).toEqual(before);
  });

  it('nieczytelny wpis przy spojnym elemencie daje plan partial i wymaga potwierdzenia', async () => {
    const { h, id } = await seeded();
    h.store.salvageUnreadable.set(id, [{ relPath: 'notes.md', failure: 'busy' }]);
    const plan = await h.service.planDelete(id);

    expect(plan.recoverability.status).toBe('partial');
    expect(plan.unrecoverable).toEqual([{ relPath: 'notes.md', failure: 'busy' }]);
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('unrecoverable-unacknowledged');
    expect(h.store.removeCalls).toBe(0);
    await h.service.applyDelete(plan, { acknowledgeUnrecoverable: true });
    expect(h.store.items.has(id)).toBe(false);
  });

  it('adoptDisk i restoreVersion tez odmawiaja przy nieczytelnym wpisie', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...h.store.items.get(id)!, body: bytes('reczna edycja\n') });
    h.store.salvageUnreadable.set(id, [{ relPath: 'notes.md', failure: 'unknown' }]);
    const writes = h.store.writeCalls;
    expect(await reasonOf(h.service.adoptDisk(id))).toBe('backup-failed');
    expect(await reasonOf(h.service.restoreVersion(id))).toBe('backup-failed');
    expect(h.store.writeCalls).toBe(writes);
  });

  it('awaria ObjectStore z plikami spoza modelu blokuje update i plan', async () => {
    const { h, id } = await seeded();
    h.store.salvageExtra.set(id, extras());
    h.objects.failPut = new Error('EACCES');
    expect(await reasonOf(h.service.update(id, draft({ body: 'v2\n' })))).toBe('backup-failed');
    expect((await h.service.planDelete(id)).applicable).toBe(false);
  });
});

describe('existingSlugs nie polyka bledow I/O', () => {
  it.each(['busy', 'no-space'] as const)(
    'blad przejsciowy %s na cudzym item.json blokuje create rozpoznanym bledem z id elementu',
    async (code) => {
      const { h } = await seeded();
      const other = await h.service.create(draft({ slug: 'acme-other' }));
      h.store.unreadableItemJson.set(
        other.item.id,
        Object.assign(new Error("EBUSY: open '/Users/x/lib/items/y/item.json'"), {
          failureCode: code,
        }),
      );

      const attempt = h.service.create(draft({ slug: 'acme-new' }));
      await expect(attempt).rejects.toMatchObject({ reason: 'store-failed', failure: code });
      await expect(attempt).rejects.toMatchObject({
        message: expect.stringContaining(other.item.id) as string,
      });
      await expect(attempt).rejects.toMatchObject({
        message: expect.not.stringMatching(/\/Users|item\.json'/) as string,
      });
    },
  );

  it('nieznany blad I/O tez blokuje (failure unknown)', async () => {
    const { h } = await seeded();
    const other = await h.service.create(draft({ slug: 'acme-other' }));
    h.store.unreadableItemJson.set(other.item.id, new Error('dziwny'));
    await expect(
      h.service.update(other.item.id, draft({ slug: 'acme-other' })),
    ).rejects.toMatchObject({
      reason: 'store-failed',
      failure: 'unknown',
    });
  });

  it('przeczytany, ale nieparsowalny item.json nie blokuje', async () => {
    const { h } = await seeded();
    for (const broken of ['{', '[]', '{"formatVersion":1}', 'tekst']) {
      const other = await h.service.create(draft({ slug: `acme-broken-${broken.length}` }));
      h.store.items.set(other.item.id, {
        ...h.store.items.get(other.item.id)!,
        itemJson: bytes(broken),
      });
    }
    await expect(h.service.create(draft({ slug: 'acme-fine' }))).resolves.toBeDefined();
  });

  it('brak item.json (null) nie blokuje', async () => {
    const { h } = await seeded();
    h.store.items.delete((await h.service.create(draft({ slug: 'acme-gone' }))).item.id);
    await expect(h.service.create(draft({ slug: 'acme-fine' }))).resolves.toBeDefined();
  });
});

describe('existingSlugs: bledy trwale pomijaja element', () => {
  it.each([
    'symlink',
    'permission-denied',
    'path-too-deep',
    'not-a-file',
    'too-large',
    'invalid-path',
  ] as const)('blad trwaly %s na cudzym item.json nie blokuje create ani update', async (code) => {
    const { h, id } = await seeded();
    const other = await h.service.create(draft({ slug: 'acme-other' }));
    h.store.unreadableItemJson.set(
      other.item.id,
      Object.assign(new Error('trwaly'), { failureCode: code }),
    );

    await expect(h.service.create(draft({ slug: 'acme-new' }))).resolves.toBeDefined();
    await expect(h.service.update(id, draft({ body: 'v2\n' }))).resolves.toBeDefined();
  });

  it('pominiety element nie chroni juz swojego sluga (znane ograniczenie, element jest w problems)', async () => {
    const { h } = await seeded();
    const other = await h.service.create(draft({ slug: 'acme-other' }));
    h.store.unreadableItemJson.set(
      other.item.id,
      Object.assign(new Error('trwaly'), { failureCode: 'permission-denied' }),
    );
    await expect(h.service.create(draft({ slug: 'ACME-OTHER' }))).resolves.toBeDefined();
  });
});

describe('requireFreeId przez list()', () => {
  it('awaria list() przerywa create rozpoznanym bledem', async () => {
    const h = createHarness();
    h.store.list = () => Promise.reject(Object.assign(new Error('x'), { failureCode: 'busy' }));
    await expect(h.service.create(draft())).rejects.toMatchObject({
      reason: 'store-failed',
      failure: 'busy',
    });
    expect(h.store.writeCalls).toBe(0);
  });
});

describe('deduplikacja put w obrebie operacji', () => {
  function expectNoDuplicates(h: Harness): void {
    const seen = new Set<string>();
    for (const hash of h.objects.putHashes) {
      expect(seen.has(hash), `hash ${hash} wlozony wiecej niz raz`).toBe(false);
      seen.add(hash);
    }
  }

  it('update', async () => {
    const { h, id } = await seeded();
    h.objects.putHashes.length = 0;
    await h.service.update(id, draft({ body: 'v2\n' }));
    expect(h.objects.putHashes.length).toBeGreaterThan(0);
    expectNoDuplicates(h);
  });

  it('create', async () => {
    const h = createHarness();
    await h.service.create(
      draft({
        assets: [
          { relPath: 'a.md', bytes: bytes('ten sam') },
          { relPath: 'b.md', bytes: bytes('ten sam') },
        ],
      }),
    );
    expectNoDuplicates(h);
  });

  it('planDelete i applyDelete (kazde osobno)', async () => {
    const { h, id } = await seeded();
    h.objects.putHashes.length = 0;
    const plan = await h.service.planDelete(id);
    expectNoDuplicates(h);
    h.objects.putHashes.length = 0;
    await h.service.applyDelete(plan);
    expectNoDuplicates(h);
  });

  it('adoptDisk i restoreVersion', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...h.store.items.get(id)!, body: bytes('reczna\n') });
    h.objects.putHashes.length = 0;
    await h.service.adoptDisk(id);
    expectNoDuplicates(h);

    h.store.items.set(id, { ...h.store.items.get(id)!, body: bytes('reczna 2\n') });
    h.objects.putHashes.length = 0;
    await h.service.restoreVersion(id);
    expectNoDuplicates(h);
  });

  it('dedup nie oslabia kopii: awaria put nadal blokuje zapis, a hash nieudany nie jest uznany za wlozony', async () => {
    const { h, id } = await seeded();
    h.objects.failPut = new Error('EACCES');
    expect(await reasonOf(h.service.update(id, draft({ body: 'v2\n' })))).toBe('backup-failed');
    h.objects.failPut = null;
    await expect(h.service.update(id, draft({ body: 'v2\n' }))).resolves.toBeDefined();
    expect(await h.objects.has(sha256Text('asset A'))).toBe(true);
  });
});
