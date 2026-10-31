import { describe, expect, it } from 'vitest';

import { LibraryError, LibraryValidationError } from '../../src/core/model/library-errors';
import type { Sha256 } from '../../src/core/model/item';
import {
  cryptoRandomBytes,
  createUlidGenerator,
  isItemId,
} from '../../src/core/ports/id-generator';
import { sha256Text } from '../../src/core/services/normalization/hash';
import { bytes, createHarness, dec, draft, FakeClock, deterministicRandom } from './library-fakes';

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof LibraryError) return error.reason;
    throw error;
  }
  return 'ok';
}

describe('create', () => {
  it('zapisuje element z rewizja 1, hashem tresci i wpisem w logu', async () => {
    const h = createHarness();
    const { item, warnings } = await h.service.create(draft());

    expect(isItemId(item.id)).toBe(true);
    expect(item.version.revision).toBe(1);
    expect(item.version.contentHash).toBe(sha256Text('# Acme review\n\nSprawdz zmiany.\n'));
    expect(warnings).toEqual([]);
    expect(h.store.items.has(item.id)).toBe(true);
    expect(h.log.records).toHaveLength(1);
    expect(h.log.records[0]).toMatchObject({
      operation: 'create',
      itemId: item.id,
      slug: 'acme-review',
      before: null,
      after: { revision: 1, contentHash: item.version.contentHash },
    });
  });

  it('nie zapisuje niczego, gdy walidacja odrzuca', async () => {
    const h = createHarness();
    const reason = await reasonOf(h.service.create(draft({ slug: 'bad slug' })));
    expect(reason).toBe('slug-invalid');
    expect(h.store.writeCalls).toBe(0);
    expect(h.log.records).toEqual([]);
  });

  it('rozjechanie slug i declaredName daje ostrzezenie, nie blad', async () => {
    const h = createHarness();
    const { warnings } = await h.service.create(
      draft({ identity: { slug: 'acme-review', declaredName: 'acme-code-review', aliases: [] } }),
    );
    expect(warnings.map((w) => w.code)).toEqual(['slug-differs-from-declared-name']);
  });

  it('awaria logu daje ostrzezenie, a element zostaje zapisany', async () => {
    const h = createHarness();
    h.log.fail = true;
    const { item, warnings } = await h.service.create(draft());
    expect(warnings.map((w) => w.code)).toEqual(['operation-log-failed']);
    expect(h.store.items.has(item.id)).toBe(true);
  });

  it('awaria zapisu na dysku to store-failed z przyczyna', async () => {
    const h = createHarness();
    h.store.failWrite = new Error('ENOSPC');
    await expect(h.service.create(draft())).rejects.toMatchObject({
      reason: 'store-failed',
      cause: expect.objectContaining({ message: 'ENOSPC' }) as Error,
    });
    expect(h.log.records).toEqual([]);
  });

  it('niepoprawny kind z zewnatrz jest odrzucony przed zapisem', async () => {
    const h = createHarness();
    const bad = { ...draft(), kind: 'plugin' } as unknown as ReturnType<typeof draft>;
    expect(await reasonOf(h.service.create(bad))).toBe('unknown-kind');
    expect(h.store.writeCalls).toBe(0);
  });
});

describe('A4: LF i CRLF tego samego elementu', () => {
  it('daje identyczny contentHash i identyczny body.md', async () => {
    const lf = createHarness();
    const crlf = createHarness();
    const a = await lf.service.create(draft({ body: 'linia 1\nlinia 2\n\nlinia 4\n' }));
    const b = await crlf.service.create(draft({ body: 'linia 1\r\nlinia 2\r\n\r\nlinia 4\r\n' }));

    expect(b.item.version.contentHash).toBe(a.item.version.contentHash);
    expect(crlf.store.items.get(b.item.id)?.body).toEqual(lf.store.items.get(a.item.id)?.body);
    expect(dec(crlf.store.items.get(b.item.id)!.body)).not.toContain('\r');
  });

  it('plik mixed i z samymi CR sa normalizowane tak samo', async () => {
    const h = createHarness();
    const a = await h.service.create(draft({ slug: 'one', body: 'a\r\nb\nc\rd' }));
    const b = await h.service.create(draft({ slug: 'two', body: 'a\nb\nc\nd' }));
    expect(a.item.version.contentHash).toBe(b.item.version.contentHash);
  });

  it('pusty body jest poprawny', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft({ body: '' }));
    expect(item.version.contentHash).toBe(sha256Text(''));
    expect((await h.service.get(item.id)).item.content.body).toBe('');
  });

  it('body.md z CRLF na dysku (checkout z autocrlf) czyta sie bez bledu', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft({ body: 'a\nb\n' }));
    const files = h.store.items.get(item.id)!;
    h.store.items.set(item.id, { ...files, body: bytes('a\r\nb\r\n') });

    expect((await h.service.get(item.id)).item.content.body).toBe('a\nb\n');
  });
});

describe('kryterium 8: kolizja lower(slug) + kind', () => {
  it('Acme-Review po acme-review tego samego typu blokuje czytelnym komunikatem', async () => {
    const h = createHarness();
    await h.service.create(draft({ slug: 'acme-review' }));

    const attempt = h.service.create(draft({ slug: 'Acme-Review' }));
    await expect(attempt).rejects.toBeInstanceOf(LibraryValidationError);
    await expect(attempt).rejects.toMatchObject({
      reason: 'slug-collision',
      message: expect.stringContaining('wielkością liter') as string,
    });
    expect(h.store.items.size).toBe(1);
  });

  it('ten sam slug innego typu przechodzi', async () => {
    const h = createHarness();
    await h.service.create(draft({ slug: 'acme-review' }));
    await expect(
      h.service.create(draft({ kind: 'agent', slug: 'acme-review' })),
    ).resolves.toBeDefined();
    expect(h.store.items.size).toBe(2);
  });

  it('update bez zmiany sluga nie koliduje ze soba', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft({ slug: 'acme-review' }));
    await expect(
      h.service.update(item.id, draft({ slug: 'acme-review', body: 'nowa tresc\n' })),
    ).resolves.toBeDefined();
  });

  it('update zmieniajacy tylko wielkosc liter wlasnego sluga przechodzi', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft({ slug: 'acme-review' }));
    const updated = await h.service.update(item.id, draft({ slug: 'Acme-Review' }));
    expect(updated.item.identity.slug).toBe('Acme-Review');
  });

  it('update zmieniajacy slug na cudzy blokuje i nie dotyka dysku', async () => {
    const h = createHarness();
    await h.service.create(draft({ slug: 'acme-review' }));
    const other = await h.service.create(draft({ slug: 'acme-deploy' }));
    const before = structuredClone(h.store.items.get(other.item.id));
    const writes = h.store.writeCalls;

    expect(await reasonOf(h.service.update(other.item.id, draft({ slug: 'ACME-review' })))).toBe(
      'slug-collision',
    );
    expect(h.store.writeCalls).toBe(writes);
    expect(h.store.items.get(other.item.id)).toEqual(before);
  });

  it('rownolegle tworzenie dwoch kolidujacych elementow: dokladnie jeden przechodzi', async () => {
    const h = createHarness();
    const results = await Promise.allSettled([
      h.service.create(draft({ slug: 'acme-review' })),
      h.service.create(draft({ slug: 'Acme-Review' })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(h.store.items.size).toBe(1);
  });

  it('uszkodzony cudzy element nie blokuje zapisu', async () => {
    const h = createHarness();
    const broken = await h.service.create(draft({ slug: 'acme-broken' }));
    h.store.items.set(broken.item.id, {
      ...h.store.items.get(broken.item.id)!,
      itemJson: bytes('{nie json'),
    });

    await expect(h.service.create(draft({ slug: 'acme-ok' }))).resolves.toBeDefined();
  });
});

describe('update', () => {
  it('podnosi rewizje o 1, zmienia updatedAt i zachowuje id', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    h.clock.advance(60_000);
    const updated = await h.service.update(item.id, draft({ body: 'zmieniona tresc\n' }));

    expect(updated.item.id).toBe(item.id);
    expect(updated.item.version.revision).toBe(2);
    expect(updated.item.version.updatedAt).not.toBe(item.version.updatedAt);
    expect(updated.item.version.contentHash).toBe(sha256Text('zmieniona tresc\n'));
    expect((await h.service.get(item.id)).item.version.revision).toBe(2);
  });

  it('A2 pozytywny: poprzednia wersja jest w ObjectStore przed zapisem i wskazana w logu', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft({ body: 'wersja pierwsza\n' }));

    let archivedBeforeWrite = false;
    const originalWrite = h.store.write.bind(h.store);
    h.store.write = async (id, files) => {
      archivedBeforeWrite = h.objects.putCalls > 0;
      return originalWrite(id, files);
    };
    await h.service.update(item.id, draft({ body: 'wersja druga\n' }));

    expect(archivedBeforeWrite).toBe(true);
    const record = h.log.records[1]!;
    expect(record.operation).toBe('update');
    const archived = await h.objects.get(record.before!.versionHash);
    expect(archived).not.toBeNull();
    const restored = JSON.parse(new TextDecoder().decode(archived!)) as {
      content: { body: string };
      version: { revision: number };
    };
    expect(restored.content.body).toBe('wersja pierwsza\n');
    expect(restored.version.revision).toBe(1);
  });

  it('A2 negatywny: awaria ObjectStore nie wywoluje zapisu, element jest nietkniety', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft({ body: 'oryginal\n' }));
    const before = structuredClone(h.store.items.get(item.id));
    const writes = h.store.writeCalls;
    const logged = h.log.records.length;
    h.objects.failPut = new Error('ENOSPC: brak miejsca');

    const attempt = h.service.update(item.id, draft({ body: 'proba nadpisania\n' }));
    await expect(attempt).rejects.toMatchObject({ reason: 'backup-failed' });
    await expect(attempt).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'ENOSPC: brak miejsca' }) as Error,
    });

    expect(h.store.writeCalls).toBe(writes);
    expect(h.store.items.get(item.id)).toEqual(before);
    expect(h.log.records).toHaveLength(logged);
  });

  it('ObjectStore zwracajacy zly hash jest traktowany jak awaria', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    h.objects.put = () => Promise.resolve('f'.repeat(64) as Sha256);
    const writes = h.store.writeCalls;

    expect(await reasonOf(h.service.update(item.id, draft({ body: 'x\n' })))).toBe('backup-failed');
    expect(h.store.writeCalls).toBe(writes);
  });

  it('nieistniejacy element i id niebedace ULID to not-found, bez dotykania portu', async () => {
    const h = createHarness();
    expect(await reasonOf(h.service.update('01JAAAAAAAAAAAAAAAAAAAAAAA', draft()))).toBe(
      'not-found',
    );
    for (const id of ['../../etc', 'a/b', '', 'acme-review', '01jaaaaaaaaaaaaaaaaaaaaaaa']) {
      expect(await reasonOf(h.service.update(id, draft()))).toBe('not-found');
      expect(await reasonOf(h.service.get(id))).toBe('not-found');
    }
  });

  it('nie pozwala zmienic typu', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    expect(await reasonOf(h.service.update(item.id, draft({ kind: 'agent' })))).toBe(
      'kind-immutable',
    );
  });

  it('brak assets i source w drafcie zachowuje dotychczasowe pliki', async () => {
    const h = createHarness();
    const { item } = await h.service.create(
      draft({
        assets: [{ relPath: 'refs/a.md', bytes: bytes('A') }],
        source: {
          importedFrom: null,
          snapshots: [
            {
              tool: 'codex',
              files: [{ relPath: 'SKILL.md', bytes: bytes('x'), mode: 0o644 }],
              unmappedKeys: [],
            },
          ],
        },
      }),
    );
    await h.service.update(item.id, draft({ body: 'tylko tresc\n' }));

    const loaded = await h.service.get(item.id);
    expect(loaded.assets.map((a) => a.relPath)).toEqual(['refs/a.md']);
    expect(loaded.snapshotFiles.map((f) => f.relPath)).toEqual(['SKILL.md']);
  });

  it('podane assets zastepuja dotychczasowe, a stare bajty zostaja w ObjectStore razem z nowymi', async () => {
    const h = createHarness();
    const { item } = await h.service.create(
      draft({ assets: [{ relPath: 'old.md', bytes: bytes('stare') }] }),
    );
    await h.service.update(
      item.id,
      draft({ assets: [{ relPath: 'new.md', bytes: bytes('nowe') }] }),
    );

    const loaded = await h.service.get(item.id);
    expect(loaded.assets.map((a) => a.relPath)).toEqual(['new.md']);
    expect(await h.objects.has(loaded.item.assets[0]!.bytesHash)).toBe(true);
    const oldHash = h.log.records[1]!.before!.versionHash;
    expect(await h.objects.has(oldHash)).toBe(true);
    expect(await h.objects.has(sha256Text('stare'))).toBe(true);
  });
});

describe('kryterium 9: elementy z plikami pomocniczymi', () => {
  it('zapisuje i odczytuje bajty razem, takze dla nazw ze spacjami, polskich i CJK', async () => {
    const h = createHarness();
    const files = [
      { relPath: 'my notes/read me.md', bytes: bytes('spacje') },
      { relPath: 'dokumentacja/zażółć gęślą jaźń.md', bytes: bytes('polskie') },
      { relPath: '日本語/メモ.md', bytes: bytes('cjk') },
      { relPath: 'a/b/c/d/e/f/g/h/i/j/k/l/deep.txt', bytes: bytes('gleboko') },
      { relPath: 'LICENSE', bytes: bytes('bez rozszerzenia') },
      { relPath: 'bin/data', bytes: Uint8Array.from([0, 255, 13, 10, 13, 7]) },
    ];
    const { item } = await h.service.create(draft({ assets: files }));
    const loaded = await h.service.get(item.id);

    expect(loaded.assets.map((a) => a.relPath).sort()).toEqual(files.map((f) => f.relPath).sort());
    for (const file of files) {
      const back = loaded.assets.find((a) => a.relPath === file.relPath)!;
      expect([...back.bytes]).toEqual([...file.bytes]);
    }
  });

  it('pliki binarne z CR i LF nie sa normalizowane', async () => {
    const h = createHarness();
    const raw = Uint8Array.from([0x61, 0x0d, 0x0a, 0x62, 0x0d]);
    const { item } = await h.service.create(
      draft({ assets: [{ relPath: 'crlf.bin', bytes: raw }] }),
    );
    expect([...(await h.service.get(item.id)).assets[0]!.bytes]).toEqual([...raw]);
  });

  it('sciezka assetu w NFD jest zapisana jako NFC', async () => {
    const h = createHarness();
    const { item } = await h.service.create(
      draft({ assets: [{ relPath: 'ó.md', bytes: bytes('x') }] }),
    );
    expect(item.assets[0]!.relPath).toBe('ó.md');
    expect((await h.service.get(item.id)).assets[0]!.relPath).toBe('ó.md');
  });

  it.each([
    ['../x', 'asset-path-traversal'],
    ['/abs', 'asset-path-absolute'],
    ['a\\b', 'asset-path-backslash'],
    ['aux.txt', 'asset-path-reserved-name'],
    ['a\u0000b', 'asset-path-control-char'],
    ['a.', 'asset-path-trailing-dot-or-space'],
  ])('odrzuca asset %j przed zapisem', async (relPath, reason) => {
    const h = createHarness();
    expect(
      await reasonOf(h.service.create(draft({ assets: [{ relPath, bytes: bytes('x') }] }))),
    ).toBe(reason);
    expect(h.store.writeCalls).toBe(0);
  });

  it('odrzuca kolizje wielkosci liter i NFD/NFC miedzy assetami elementu', async () => {
    const h = createHarness();
    const caseClash = draft({
      assets: [
        { relPath: 'Readme.md', bytes: bytes('1') },
        { relPath: 'README.md', bytes: bytes('2') },
      ],
    });
    expect(await reasonOf(h.service.create(caseClash))).toBe('asset-path-collision');

    const normalizationClash = draft({
      assets: [
        { relPath: 'ó.md', bytes: bytes('1') },
        { relPath: 'ó.md', bytes: bytes('2') },
      ],
    });
    expect(await reasonOf(h.service.create(normalizationClash))).toBe('asset-path-collision');
    expect(h.store.writeCalls).toBe(0);
  });

  it('sciezki snapshotu zrodla podlegaja tej samej walidacji', async () => {
    const h = createHarness();
    const bad = draft({
      source: {
        importedFrom: null,
        snapshots: [
          {
            tool: 'claude-code',
            files: [{ relPath: '../SKILL.md', bytes: bytes('x'), mode: null }],
            unmappedKeys: [],
          },
        ],
      },
    });
    expect(await reasonOf(h.service.create(bad))).toBe('asset-path-traversal');
  });

  it('snapshot zachowuje bajty zrodla, a lineEnding jest wykryty z oryginalu', async () => {
    const h = createHarness();
    const original = bytes('---\r\nname: acme\r\n---\r\ntresc\r\n');
    const { item } = await h.service.create(
      draft({
        body: 'tresc\r\n',
        source: {
          importedFrom: null,
          snapshots: [
            {
              tool: 'claude-code',
              files: [{ relPath: 'SKILL.md', bytes: original, mode: 0o644 }],
              unmappedKeys: [],
            },
          ],
        },
      }),
    );
    const file = item.source.snapshots[0]!.files[0]!;
    expect(file.lineEnding).toBe('crlf');
    expect(file.bytesHash).not.toBe(item.version.contentHash);
    expect([...(await h.service.get(item.id)).snapshotFiles[0]!.bytes]).toEqual([...original]);
  });
});

describe('odczyt niezaufanych plikow elementu', () => {
  async function seeded() {
    const h = createHarness();
    const { item } = await h.service.create(
      draft({ assets: [{ relPath: 'refs/a.md', bytes: bytes('A') }], body: 'v1\n' }),
    );
    return { h, id: item.id };
  }

  it('wszystko spojne: odczyt przechodzi', async () => {
    const { h, id } = await seeded();
    await expect(h.service.get(id)).resolves.toBeDefined();
  });

  it('zly JSON', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...h.store.items.get(id)!, itemJson: bytes('{nie json') });
    expect(await reasonOf(h.service.get(id))).toBe('item-json-malformed');
  });

  it('JSON z BOM na poczatku jest czytelny', async () => {
    const { h, id } = await seeded();
    const files = h.store.items.get(id)!;
    h.store.items.set(id, {
      ...files,
      itemJson: bytes(String.fromCharCode(0xfeff) + dec(files.itemJson)),
    });
    await expect(h.service.get(id)).resolves.toBeDefined();
  });

  it('item.json innego elementu pod nazwa tego katalogu: id-mismatch', async () => {
    const { h, id } = await seeded();
    const other = await h.service.create(draft({ slug: 'acme-other' }));
    h.store.items.set(id, {
      ...h.store.items.get(id)!,
      itemJson: h.store.items.get(other.item.id)!.itemJson,
    });
    expect(await reasonOf(h.service.get(id))).toBe('id-mismatch');
  });

  it('przerwany zapis: nowy item.json ze starym body.md', async () => {
    const { h, id } = await seeded();
    const oldBody = h.store.items.get(id)!.body;
    await h.service.update(
      id,
      draft({ body: 'v2\n', assets: [{ relPath: 'refs/a.md', bytes: bytes('A') }] }),
    );
    h.store.items.set(id, { ...h.store.items.get(id)!, body: oldBody });
    expect(await reasonOf(h.service.get(id))).toBe('integrity-mismatch');
  });

  it('przerwany zapis: stary item.json z nowym assetem', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, {
      ...h.store.items.get(id)!,
      assets: [{ relPath: 'refs/a.md', bytes: bytes('INNA TRESC') }],
    });
    expect(await reasonOf(h.service.get(id))).toBe('integrity-mismatch');
  });

  it('brakujacy asset wymieniony w item.json', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...h.store.items.get(id)!, assets: [] });
    expect(await reasonOf(h.service.get(id))).toBe('integrity-mismatch');
  });

  it('dodatkowy plik nieopisany w item.json nie psuje odczytu', async () => {
    const { h, id } = await seeded();
    const files = h.store.items.get(id)!;
    h.store.items.set(id, {
      ...files,
      assets: [...files.assets, { relPath: 'leftover.tmp', bytes: bytes('?') }],
    });
    const loaded = await h.service.get(id);
    expect(loaded.assets.map((a) => a.relPath)).toEqual(['refs/a.md']);
  });

  it('list zglasza zepsuty element i zwraca pozostale', async () => {
    const { h, id } = await seeded();
    const good = await h.service.create(draft({ slug: 'acme-good' }));
    h.store.items.set(id, { ...h.store.items.get(id)!, itemJson: bytes('[]') });
    h.store.items.set('katalog-bez-ulid', h.store.items.get(good.item.id)!);

    const { items, problems } = await h.service.list();
    expect(items.map((i) => i.id)).toEqual([good.item.id]);
    expect(problems.map((p) => [p.id, p.reason])).toEqual(
      expect.arrayContaining([
        [id, 'item-shape-invalid'],
        ['katalog-bez-ulid', 'id-mismatch'],
      ]),
    );
  });

  it('list sortuje po slugu bez wzgledu na wielkosc liter', async () => {
    const h = createHarness();
    await h.service.create(draft({ slug: 'beta' }));
    await h.service.create(draft({ slug: 'Alfa' }));
    await h.service.create(draft({ slug: 'gamma' }));
    expect((await h.service.list()).items.map((i) => i.identity.slug)).toEqual([
      'Alfa',
      'beta',
      'gamma',
    ]);
  });
});

describe('usuwanie: plan i apply', () => {
  it('plan opisuje element i odcisk stanu, bez zmiany na dysku', async () => {
    const h = createHarness();
    const { item } = await h.service.create(
      draft({ assets: [{ relPath: 'a.md', bytes: bytes('A') }] }),
    );
    const plan = await h.service.planDelete(item.id);

    expect(plan).toMatchObject({
      itemId: item.id,
      slug: 'acme-review',
      revision: 1,
      contentHash: item.version.contentHash,
      assetCount: 1,
      applicable: true,
      recoverability: { status: 'recoverable', reason: null },
    });
    expect(h.store.items.has(item.id)).toBe(true);
    expect(h.store.removeCalls).toBe(0);
  });

  it('A3 pozytywny: swiezy plan usuwa element, a tresc jest w ObjectStore przed usunieciem', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft({ body: 'do usuniecia\n' }));
    const plan = await h.service.planDelete(item.id);

    // Plan juz zapisal kopie; czyscimy store, zeby dowod pochodzil z samego apply.
    h.objects.objects.clear();
    let archivedAtRemoval = false;
    h.store.onRemove = () => {
      archivedAtRemoval = h.objects.objects.size > 0;
    };
    await h.service.applyDelete(plan);

    expect(archivedAtRemoval).toBe(true);
    expect(h.store.items.has(item.id)).toBe(false);
    const record = h.log.records.at(-1)!;
    expect(record).toMatchObject({ operation: 'delete', after: null, itemId: item.id });
    const archived = JSON.parse(
      new TextDecoder().decode((await h.objects.get(record.before!.versionHash))!),
    ) as {
      content: { body: string };
    };
    expect(archived.content.body).toBe('do usuniecia\n');
  });

  it('A3 negatywny: plan przeterminowany po edycji jest odrzucony i nic nie jest usuwane', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    const plan = await h.service.planDelete(item.id);
    await h.service.update(item.id, draft({ body: 'ktos to zmienil\n' }));

    expect(await reasonOf(h.service.applyDelete(plan))).toBe('stale-plan');
    expect(h.store.removeCalls).toBe(0);
    expect(h.store.items.has(item.id)).toBe(true);
  });

  it('plan przeterminowany takze po zmianie samych metadanych (ta sama tresc)', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    const plan = await h.service.planDelete(item.id);
    await h.service.update(
      item.id,
      draft({ identity: { slug: 'acme-review', declaredName: 'inna', aliases: [] } }),
    );
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('stale-plan');
  });

  it('plan dla elementu usunietego w miedzyczasie to not-found', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    const plan = await h.service.planDelete(item.id);
    await h.service.applyDelete(plan);
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('not-found');
  });

  it('awaria ObjectStore w planDelete blokuje plan, a apply odmawia', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    h.objects.failPut = new Error('EACCES');
    const plan = await h.service.planDelete(item.id);

    expect(plan.applicable).toBe(false);
    expect(plan.recoverability.status).toBe('blocked');
    expect(plan.recoverability.reason).toBeTruthy();
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('plan-blocked');
    expect(h.store.removeCalls).toBe(0);
  });

  it('awaria ObjectStore miedzy planem a apply: kopia nie powstala, wiec element zostaje', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    const plan = await h.service.planDelete(item.id);
    h.objects.failPut = new Error('EACCES');

    expect(await reasonOf(h.service.applyDelete(plan))).toBe('backup-failed');
    expect(h.store.removeCalls).toBe(0);
    expect(h.store.items.has(item.id)).toBe(true);
  });

  it('podrobiony plan z id spoza ULID nie dociera do portu', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    const plan = await h.service.planDelete(item.id);
    expect(
      await reasonOf(h.service.applyDelete({ ...plan, itemId: '../..' as typeof plan.itemId })),
    ).toBe('not-found');
    expect(h.store.removeCalls).toBe(0);
  });

  it('podrobiony plan z cudzym odciskiem jest przeterminowany', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    const plan = await h.service.planDelete(item.id);
    expect(
      await reasonOf(h.service.applyDelete({ ...plan, contentHash: sha256Text('inne') })),
    ).toBe('stale-plan');
  });

  it('awaria usuwania na dysku to store-failed', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    const plan = await h.service.planDelete(item.id);
    h.store.remove = () => Promise.reject(new Error('EBUSY'));
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('store-failed');
    expect(h.log.records.at(-1)?.operation).toBe('create');
  });
});

describe('generator ULID', () => {
  it('daje poprawne id, rosnace w obrebie jednej milisekundy', () => {
    const ids = createUlidGenerator(new FakeClock(), deterministicRandom());
    const generated = Array.from({ length: 50 }, () => ids.next());
    expect(generated.every((id) => isItemId(id))).toBe(true);
    expect([...generated].sort()).toEqual(generated);
    expect(new Set(generated).size).toBe(50);
  });

  it('jest deterministyczny przy tym samym zegarze i losowosci', () => {
    const a = createUlidGenerator(new FakeClock(), deterministicRandom()).next();
    const b = createUlidGenerator(new FakeClock(), deterministicRandom()).next();
    expect(a).toBe(b);
  });

  it('czas zapisany w prefiksie rosnie z zegarem', () => {
    const clock = new FakeClock();
    const ids = createUlidGenerator(clock, deterministicRandom());
    const first = ids.next();
    clock.advance(1000);
    expect(ids.next() > first).toBe(true);
  });

  it('cofniety zegar nie psuje monotonicznosci', () => {
    const clock = new FakeClock();
    const ids = createUlidGenerator(clock, deterministicRandom());
    const first = ids.next();
    clock.advance(-5000);
    expect(ids.next() > first).toBe(true);
  });

  it('losowosc systemowa tez daje poprawne id', () => {
    expect(isItemId(createUlidGenerator(new FakeClock(), cryptoRandomBytes).next())).toBe(true);
  });

  it('isItemId odrzuca traversal, male litery, zla dlugosc i niedozwolone litery', () => {
    for (const bad of [
      '../../x',
      '',
      'a'.repeat(26),
      '01jaaaaaaaaaaaaaaaaaaaaaaa',
      '01JAAAAAAAAAAAAAAAAAAAAAAU',
      '81JAAAAAAAAAAAAAAAAAAAAAAA',
      42,
      null,
    ]) {
      expect(isItemId(bad)).toBe(false);
    }
    expect(isItemId('01JAAAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
  });
});
