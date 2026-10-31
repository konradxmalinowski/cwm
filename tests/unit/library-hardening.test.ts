import { describe, expect, it } from 'vitest';

import type { ItemId } from '../../src/core/model/item';
import { LibraryError, LibraryOperationError } from '../../src/core/model/library-errors';
import { isAtomicTempName, isJunkFileName } from '../../src/core/model/library-file-names';
import {
  MAX_ASSETS_PER_ITEM,
  MAX_ASSET_PATH_SEGMENTS,
  MAX_FILE_BYTES,
  MAX_ITEM_BYTES,
  MAX_ITEM_JSON_BYTES,
  MAX_SNAPSHOT_FILES_PER_TOOL,
  MAX_TREE_DEPTH,
} from '../../src/core/model/library-limits';
import { STORE_FAILURE_CODES, STORE_FAILURE_TEXT } from '../../src/core/ports/store-failure';
import { LibraryService } from '../../src/core/services/library/library-service';
import { checkSizeLimits } from '../../src/core/services/library/validate';
import { sha256Bytes, sha256Text } from '../../src/core/services/normalization/hash';
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

async function seeded(): Promise<{ h: Harness; id: ItemId }> {
  const h = createHarness();
  const { item } = await h.service.create(
    draft({ body: 'v1\n', assets: [{ relPath: 'refs/a.md', bytes: bytes('A1') }] }),
  );
  return { h, id: item.id };
}

function files(h: Harness, id: string) {
  return h.store.items.get(id)!;
}

function addAsset(h: Harness, id: string, relPath: string, content: string | Uint8Array): void {
  const f = files(h, id);
  const data = typeof content === 'string' ? bytes(content) : content;
  h.store.items.set(id, { ...f, assets: [...f.assets, { relPath, bytes: data }] });
}

describe('SEC-005: limity rozmiaru', () => {
  const none = { bodyBytes: 0, assets: [], snapshots: [] };
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ relPath: `f${i}.md`, size: 1 }));
  const reasons = (input: Parameters<typeof checkSizeLimits>[0]) =>
    checkSizeLimits(input).map((i) => i.reason);

  it('liczba assetow: limit przechodzi, limit + 1 nie', () => {
    expect(reasons({ ...none, assets: many(MAX_ASSETS_PER_ITEM) })).toEqual([]);
    expect(reasons({ ...none, assets: many(MAX_ASSETS_PER_ITEM + 1) })).toEqual(['limit-exceeded']);
  });

  it('liczba plikow snapshotu jednego narzedzia: limit przechodzi, limit + 1 nie', () => {
    const snap = (n: number) => [{ tool: 'codex', files: many(n) }];
    expect(reasons({ ...none, snapshots: snap(MAX_SNAPSHOT_FILES_PER_TOOL) })).toEqual([]);
    expect(reasons({ ...none, snapshots: snap(MAX_SNAPSHOT_FILES_PER_TOOL + 1) })).toEqual([
      'limit-exceeded',
    ]);
  });

  it('rozmiar pojedynczego pliku: limit przechodzi, limit + 1 nie (asset i snapshot)', () => {
    const file = (size: number) => [{ relPath: 'big.bin', size }];
    expect(reasons({ ...none, assets: file(MAX_FILE_BYTES) })).toEqual([]);
    expect(reasons({ ...none, assets: file(MAX_FILE_BYTES + 1) })).toEqual(['limit-exceeded']);
    expect(
      reasons({ ...none, snapshots: [{ tool: 'codex', files: file(MAX_FILE_BYTES) }] }),
    ).toEqual([]);
    expect(
      reasons({ ...none, snapshots: [{ tool: 'codex', files: file(MAX_FILE_BYTES + 1) }] }),
    ).toEqual(['limit-exceeded']);
  });

  it('laczny rozmiar elementu liczy body, assety i snapshoty: limit przechodzi, limit + 1 nie', () => {
    const five = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({ relPath: `${prefix}${i}`, size: MAX_FILE_BYTES }));
    const exactly = {
      bodyBytes: 0,
      assets: five(3, 'a'),
      snapshots: [{ tool: 'codex', files: five(2, 's') }],
    };
    expect(MAX_FILE_BYTES * 5).toBe(MAX_ITEM_BYTES);
    expect(reasons(exactly)).toEqual([]);
    expect(reasons({ ...exactly, bodyBytes: 1 })).toEqual(['limit-exceeded']);
  });

  it('komunikaty sa po polsku i podaja limit', () => {
    const [problem] = checkSizeLimits({ ...none, assets: many(MAX_ASSETS_PER_ITEM + 1) });
    expect(problem!.message).toContain(String(MAX_ASSETS_PER_ITEM));
    expect(problem!.message).toContain('plików pomocniczych');
  });

  it('serwis odrzuca za duzy asset przed zapisem, a asset o limicie przechodzi', async () => {
    const h = createHarness();
    const tooBig = new Uint8Array(MAX_FILE_BYTES + 1);
    expect(
      await reasonOf(h.service.create(draft({ assets: [{ relPath: 'big.bin', bytes: tooBig }] }))),
    ).toBe('limit-exceeded');
    expect(h.store.writeCalls).toBe(0);

    const exact = new Uint8Array(MAX_FILE_BYTES);
    await expect(
      h.service.create(draft({ assets: [{ relPath: 'big.bin', bytes: exact }] })),
    ).resolves.toBeDefined();
  });

  it('serwis odrzuca za wiele assetow, a limit przechodzi', async () => {
    const h = createHarness();
    const assets = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ relPath: `f${i}.md`, bytes: bytes('x') }));
    expect(
      await reasonOf(h.service.create(draft({ assets: assets(MAX_ASSETS_PER_ITEM + 1) }))),
    ).toBe('limit-exceeded');
    expect(await reasonOf(h.service.create(draft({ assets: assets(MAX_ASSETS_PER_ITEM) })))).toBe(
      'ok',
    );
  });

  it('update bez assets liczy limit na zachowanych plikach', async () => {
    const { h, id } = await seeded();
    await expect(h.service.update(id, draft({ body: 'v2\n' }))).resolves.toBeDefined();
  });

  it('item.json wiekszy niz limit to item-json-malformed, o limicie czyta sie normalnie', async () => {
    const { h, id } = await seeded();
    const f = files(h, id);
    const padded = new Uint8Array(MAX_ITEM_JSON_BYTES + 1).fill(0x20);
    padded.set(f.itemJson);
    h.store.items.set(id, { ...f, itemJson: padded });
    expect(await reasonOf(h.service.get(id))).toBe('item-json-malformed');

    const atLimit = new Uint8Array(MAX_ITEM_JSON_BYTES).fill(0x20);
    atLimit.set(f.itemJson);
    h.store.items.set(id, { ...f, itemJson: atLimit });
    await expect(h.service.get(id)).resolves.toBeDefined();
  });
});

describe('SEC-001: limit glebokosci i odpornosc na nieczytelny element', () => {
  it('limit sciezki assetu mieści sie w tym, co infra umie przeczytac', () => {
    expect(MAX_ASSET_PATH_SEGMENTS + 2).toBeLessThan(MAX_TREE_DEPTH);
  });

  it('serwis odrzuca glebokie drzewo assetow i snapshotow przed zapisem', async () => {
    const h = createHarness();
    const deep = `${Array.from({ length: MAX_ASSET_PATH_SEGMENTS }, () => 'a').join('/')}/f.txt`;
    expect(
      await reasonOf(h.service.create(draft({ assets: [{ relPath: deep, bytes: bytes('x') }] }))),
    ).toBe('asset-path-too-long');
    expect(h.store.writeCalls).toBe(0);
  });

  it('existingSlugs czyta tylko item.json, nie caly element', async () => {
    const { h } = await seeded();
    h.store.readCalls = 0;
    await h.service.create(draft({ slug: 'acme-second' }));
    expect(h.store.readItemJsonCalls).toBeGreaterThan(0);
    expect(h.store.readCalls).toBe(0); // wolne id sprawdza list(), nie read()
  });

  it('element z nieczytelnymi assetami nie blokuje create ani update (existingSlugs nie czyta assetow)', async () => {
    const { h, id } = await seeded();
    const poisoned = await h.service.create(draft({ slug: 'acme-poisoned' }));
    h.store.unreadable.set(poisoned.item.id, new Error('za gleboko'));

    await expect(h.service.create(draft({ slug: 'acme-next' }))).resolves.toBeDefined();
    await expect(h.service.update(id, draft({ body: 'v2\n' }))).resolves.toBeDefined();
  });

  it('list zglasza nieczytelny element w problems i zwraca pozostale', async () => {
    const { h, id } = await seeded();
    const other = await h.service.create(draft({ slug: 'acme-other' }));
    h.store.unreadable.set(other.item.id, new Error('za gleboko'));
    const result = await h.service.list();
    expect(result.items.map((i) => i.id)).toEqual([id]);
    expect(result.problems.map((p) => [p.id, p.reason])).toEqual([[other.item.id, 'store-failed']]);
  });

  it('planDelete elementu nieczytelnego bez mozliwosci salvage daje plan zablokowany z powodem', async () => {
    const { h, id } = await seeded();
    h.store.unreadable.set(
      id,
      Object.assign(new Error('/Users/x/secret/path'), { failureCode: 'path-too-deep' }),
    );
    h.store.salvageFailure = new Error('/Users/x/secret/path');
    const plan = await h.service.planDelete(id);

    expect(plan.applicable).toBe(false);
    expect(plan.recoverability.status).toBe('blocked');
    expect(plan.recoverability.reason).not.toContain('/Users');
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('plan-blocked');
    expect(h.store.removeCalls).toBe(0);
  });
});

describe('SEC-002: kopia obejmuje wszystko, co lezy w katalogu elementu', () => {
  it('reczny plik w assets/ jest odzyskiwalny po update', async () => {
    const { h, id } = await seeded();
    addAsset(h, id, 'notes.txt', 'dopisane recznie');
    await h.service.update(id, draft({ body: 'v2\n', assets: [] }));
    expect(await h.objects.has(sha256Text('dopisane recznie'))).toBe(true);
  });

  it('reczny plik w assets/ jest odzyskiwalny po applyDelete', async () => {
    const { h, id } = await seeded();
    addAsset(h, id, 'notes.txt', 'dopisane recznie');
    const plan = await h.service.planDelete(id);
    h.objects.objects.clear();
    await h.service.applyDelete(plan);
    expect(await h.objects.has(sha256Text('dopisane recznie'))).toBe(true);
  });

  it('reczny plik snapshotu spoza item.json tez jest archiwizowany', async () => {
    const { h, id } = await seeded();
    const f = files(h, id);
    h.store.items.set(id, {
      ...f,
      snapshotFiles: [
        ...f.snapshotFiles,
        { tool: 'codex', relPath: 'extra.md', bytes: bytes('snap') },
      ],
    });
    await h.service.update(id, draft({ body: 'v2\n' }));
    expect(await h.objects.has(sha256Text('snap'))).toBe(true);
  });

  it('awaria ObjectStore z recznym plikiem blokuje update i plan usuniecia', async () => {
    const { h, id } = await seeded();
    addAsset(h, id, 'notes.txt', 'dopisane recznie');
    const before = structuredClone(files(h, id));
    h.objects.failPut = new Error('EACCES');

    expect(await reasonOf(h.service.update(id, draft({ body: 'v2\n' })))).toBe('backup-failed');
    expect(files(h, id)).toEqual(before);
    const plan = await h.service.planDelete(id);
    expect(plan.applicable).toBe(false);
  });
});

describe('SEC-004: bajty przechodza przez port, UTF-8 sprawdza core', () => {
  const latin1 = Uint8Array.from([0x63, 0xe9, 0x0a]);

  it('body.md w Latin-1 to niespojnosc invalid-utf8, a nie podmiana na U+FFFD', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...files(h, id), body: latin1 });

    expect(await reasonOf(h.service.get(id))).toBe('integrity-mismatch');
    const [entry] = (await h.service.list()).inconsistent;
    expect(entry!.files).toEqual([{ path: 'body.md', problem: 'invalid-utf8' }]);
  });

  it('adoptDisk odmawia nieprawidlowego UTF-8 i niczego nie zapisuje', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...files(h, id), body: latin1 });
    const writes = h.store.writeCalls;
    const attempt = h.service.adoptDisk(id);
    await expect(attempt).rejects.toMatchObject({
      reason: 'integrity-mismatch',
      message: expect.stringContaining('UTF-8') as string,
    });
    expect(h.store.writeCalls).toBe(writes);
  });

  it('restoreVersion i applyDelete archiwizuja oryginalne bajty, nie przekodowany tekst', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...files(h, id), body: latin1 });
    await h.service.restoreVersion(id);
    expect(await h.objects.has(sha256Bytes(latin1))).toBe(true);

    h.store.items.set(id, { ...files(h, id), body: latin1 });
    const plan = await h.service.planDelete(id);
    h.objects.objects.clear();
    await h.service.applyDelete(plan);
    expect(await h.objects.has(sha256Bytes(latin1))).toBe(true);
  });

  it('item.json nie bedacy UTF-8 to item-json-malformed', async () => {
    const { h, id } = await seeded();
    h.store.items.set(id, { ...files(h, id), itemJson: Uint8Array.from([0x7b, 0xff, 0x7d]) });
    expect(await reasonOf(h.service.get(id))).toBe('item-json-malformed');
  });

  it('poprawny UTF-8 z polskimi znakami i CJK czyta sie bez bledu', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft({ body: 'zażółć gęślą jaźń 日本語\n' }));
    expect(dec(files(h, item.id).body)).toBe('zażółć gęślą jaźń 日本語\n');
    expect((await h.service.get(item.id)).item.content.body).toBe('zażółć gęślą jaźń 日本語\n');
  });
});

describe('SEC-009: kolizja identyfikatora', () => {
  function withIds(h: Harness, ids: string[]): LibraryService {
    return new LibraryService({
      store: h.store,
      objects: h.objects,
      log: h.log,
      clock: h.clock,
      ids: { next: () => ids.shift() as ItemId },
    });
  }

  it('create odmawia, gdy katalog o wylosowanym id istnieje, i nie rusza istniejacego', async () => {
    const h = createHarness();
    const service = withIds(h, ['01JAAAAAAAAAAAAAAAAAAAAAAA', '01JAAAAAAAAAAAAAAAAAAAAAAA']);
    await service.create(draft({ slug: 'acme-one' }));
    const before = structuredClone(files(h, '01JAAAAAAAAAAAAAAAAAAAAAAA'));
    const writes = h.store.writeCalls;

    expect(await reasonOf(service.create(draft({ slug: 'acme-two' })))).toBe('id-collision');
    expect(h.store.writeCalls).toBe(writes);
    expect(files(h, '01JAAAAAAAAAAAAAAAAAAAAAAA')).toEqual(before);
  });

  it('rozne id przechodza', async () => {
    const h = createHarness();
    const service = withIds(h, ['01JAAAAAAAAAAAAAAAAAAAAAAA', '01JBBBBBBBBBBBBBBBBBBBBBBB']);
    await service.create(draft({ slug: 'acme-one' }));
    await expect(service.create(draft({ slug: 'acme-two' }))).resolves.toBeDefined();
  });
});

describe('update zachowuje pominiete pola', () => {
  const hook = {
    event: 'PreToolUse',
    matcher: 'Bash',
    command: 'echo acme',
    pathStyle: 'absolute' as const,
    timeoutSeconds: 5,
  };

  async function hookItem() {
    const h = createHarness();
    const { item } = await h.service.create(
      draft({
        kind: 'hook',
        attributes: { hook, memoryScope: 'user' },
        classification: {
          scope: 'public',
          secretFindings: [{ rule: 'acme-token', relPath: 'a.md', line: 3 }],
        },
      }),
    );
    return { h, id: item.id };
  }

  it('pominiete attributes i classification zostaja z poprzedniej wersji', async () => {
    const { h, id } = await hookItem();
    const { item } = await h.service.update(id, draft({ kind: 'hook', body: 'nowa tresc\n' }));
    expect(item.attributes).toEqual({ hook, memoryScope: 'user' });
    expect(item.classification).toEqual({
      scope: 'public',
      secretFindings: [{ rule: 'acme-token', relPath: 'a.md', line: 3 }],
    });
  });

  it('podane pola zastepuja poprzednie, a puste attributes je czysci', async () => {
    const { h, id } = await hookItem();
    const { item } = await h.service.update(
      id,
      draft({
        kind: 'hook',
        attributes: {},
        classification: { scope: 'private', secretFindings: [] },
      }),
    );
    expect(item.attributes).toEqual({});
    expect(item.classification).toEqual({ scope: 'private', secretFindings: [] });
  });

  it('create bez tych pol uzywa pustych attributes i zakresu private', async () => {
    const h = createHarness();
    const { item } = await h.service.create(draft());
    expect(item.attributes).toEqual({});
    expect(item.classification.scope).toBe('private');
  });
});

describe('odczyty stoja w kolejce zapisow', () => {
  it('list i get rownolegle z update nigdy nie widza polowy zapisu', async () => {
    const { h, id } = await seeded();
    // Zapis w dwoch krokach z przerwa, jak niepodzielny zapis wielu plikow na dysku.
    const realWrite = h.store.write.bind(h.store);
    h.store.write = async (itemId, f) => {
      const cur = h.store.items.get(itemId)!;
      h.store.items.set(itemId, { ...cur, body: f.body });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await realWrite(itemId, f);
    };

    const updating = h.service.update(
      id,
      draft({ body: 'v2\n', assets: [{ relPath: 'refs/a.md', bytes: bytes('A1') }] }),
    );
    // Odczyty startuja w srodku zapisu, gdy na dysku jest juz nowe body, a jeszcze stary item.json.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const results = [
      await Promise.all([updating, h.service.list(), h.service.get(id), h.service.list()]),
    ][0]!;

    expect(results[1].inconsistent).toEqual([]);
    expect(results[1].problems).toEqual([]);
    expect(results[3].inconsistent).toEqual([]);
    expect(results[2].item.version.revision).toBe(2);
  });
});

describe('przyczyny awarii magazynu w bledach serwisu', () => {
  it.each(STORE_FAILURE_CODES.filter((c) => c !== 'unknown'))(
    'zapis elementu z przyczyna %s',
    async (code) => {
      const h = createHarness();
      h.store.failWrite = Object.assign(new Error('EIO /Users/ktos/library/items/x'), {
        failureCode: code,
      });
      const attempt = h.service.create(draft());
      await expect(attempt).rejects.toMatchObject({ reason: 'store-failed', failure: code });
      await expect(attempt).rejects.toMatchObject({
        message: expect.stringContaining(STORE_FAILURE_TEXT[code]) as string,
      });
    },
  );

  it('awaria ObjectStore przenosi przyczyne do backup-failed', async () => {
    const { h, id } = await seeded();
    h.objects.failPut = Object.assign(new Error('ENOSPC'), { failureCode: 'no-space' });
    const attempt = h.service.update(id, draft({ body: 'v2\n' }));
    await expect(attempt).rejects.toMatchObject({ reason: 'backup-failed', failure: 'no-space' });
    await expect(attempt).rejects.toMatchObject({
      message: expect.stringContaining('brak miejsca na dysku') as string,
    });
  });

  it('komunikat nie zawiera sciezki z przyczyny', async () => {
    const h = createHarness();
    h.store.failWrite = Object.assign(new Error("EACCES: open '/Users/ktos/.config/app/library'"), {
      failureCode: 'permission-denied',
    });
    try {
      await h.service.create(draft());
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(LibraryOperationError);
      expect((error as Error).message).not.toMatch(/\/Users|\.config|library/);
    }
  });

  it('nieznany blad daje failure unknown i komunikat bez przyczyny', async () => {
    const h = createHarness();
    h.store.failWrite = new Error('dziwny blad');
    await expect(h.service.create(draft())).rejects.toMatchObject({
      reason: 'store-failed',
      failure: 'unknown',
      message: 'Nie udało się zapisać elementu na dysku.',
    });
  });
});

describe('pliki systemowe (.DS_Store, Thumbs.db, desktop.ini)', () => {
  it('rozpoznawanie nazw bez wzgledu na wielkosc liter, bez falszywych trafien', () => {
    for (const name of [
      '.DS_Store',
      '.ds_store',
      'Thumbs.db',
      'THUMBS.DB',
      'desktop.ini',
      'Desktop.INI',
    ]) {
      expect(isJunkFileName(name)).toBe(true);
    }
    for (const name of ['notes.md', 'thumbs.db.bak', 'my.DS_Store', 'desktop.ini.txt']) {
      expect(isJunkFileName(name)).toBe(false);
    }
  });

  it('wzorzec pliku tymczasowego: negatyw i pozytywy', () => {
    expect(isAtomicTempName('.x.md.4242.0a1b2c3d4e5f.tmp')).toBe(true);
    for (const name of ['notes.tmp', '.hidden.tmp', '.a.tmp', '.x.md.abc.123456.tmp']) {
      expect(isAtomicTempName(name)).toBe(false);
    }
  });

  it('plik systemowy w katalogu nie przeterminowuje planu usuniecia, ale jest archiwizowany', async () => {
    const { h, id } = await seeded();
    const plan = await h.service.planDelete(id);
    addAsset(h, id, '.DS_Store', 'finder');
    addAsset(h, id, 'sub/Thumbs.db', 'windows');

    h.objects.objects.clear();
    await h.service.applyDelete(plan);
    expect(h.store.items.has(id)).toBe(false);
    expect(await h.objects.has(sha256Text('finder'))).toBe(true);
    expect(await h.objects.has(sha256Text('windows'))).toBe(true);
  });

  it('zmiana zwyklego pliku nadal przeterminowuje plan', async () => {
    const { h, id } = await seeded();
    const plan = await h.service.planDelete(id);
    addAsset(h, id, 'notes.txt', 'dopisane');
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('stale-plan');
  });

  it('adoptDisk pomija pliki systemowe zamiast odrzucac element', async () => {
    const { h, id } = await seeded();
    addAsset(h, id, '.DS_Store', 'finder');
    h.store.items.set(id, { ...files(h, id), body: bytes('reczna edycja\n') });

    await h.service.adoptDisk(id);
    const loaded = await h.service.get(id);
    expect(loaded.assets.map((a) => a.relPath)).toEqual(['refs/a.md']);
    expect(await h.objects.has(sha256Text('finder'))).toBe(true);
  });

  it('restoreVersion archiwizuje plik systemowy razem z reszta', async () => {
    const { h, id } = await seeded();
    addAsset(h, id, '.DS_Store', 'finder');
    h.store.items.set(id, { ...files(h, id), body: bytes('reczna edycja\n') });
    await h.service.restoreVersion(id);
    expect(await h.objects.has(sha256Text('finder'))).toBe(true);
  });

  it('serwis odrzuca plik systemowy jako asset', async () => {
    const h = createHarness();
    expect(
      await reasonOf(
        h.service.create(draft({ assets: [{ relPath: 'refs/.DS_Store', bytes: bytes('x') }] })),
      ),
    ).toBe('asset-path-junk-name');
  });
});

describe('osierocone pliki tymczasowe zapisu', () => {
  const temp = '.x.md.4242.0a1b2c3d4e5f.tmp';

  it('adoptDisk pomija je jako assety, a kopia je obejmuje', async () => {
    const { h, id } = await seeded();
    addAsset(h, id, `refs/${temp}`, 'osierocony');
    h.store.items.set(id, { ...files(h, id), body: bytes('reczna edycja\n') });
    await h.service.adoptDisk(id);
    const loaded = await h.service.get(id);
    expect(loaded.assets.map((a) => a.relPath)).toEqual(['refs/a.md']);
    expect(await h.objects.has(sha256Text('osierocony'))).toBe(true);
  });

  it('plik tymczasowy w katalogu nie przeterminowuje planu usuniecia, ale jest archiwizowany', async () => {
    const { h, id } = await seeded();
    const plan = await h.service.planDelete(id);
    addAsset(h, id, temp, 'osierocony');
    addAsset(h, id, `${temp}/inner.md`, 'w katalogu tymczasowym');

    h.objects.objects.clear();
    await h.service.applyDelete(plan);
    expect(h.store.items.has(id)).toBe(false);
    expect(await h.objects.has(sha256Text('osierocony'))).toBe(true);
    expect(await h.objects.has(sha256Text('w katalogu tymczasowym'))).toBe(true);
  });

  it('zwykly plik o podobnej nazwie (notes.tmp) nadal przeterminowuje plan i jest przyjmowany', async () => {
    const { h, id } = await seeded();
    const plan = await h.service.planDelete(id);
    addAsset(h, id, 'notes.tmp', 'zwykly');
    expect(await reasonOf(h.service.applyDelete(plan))).toBe('stale-plan');

    h.store.items.set(id, { ...files(h, id), body: bytes('reczna edycja\n') });
    await h.service.adoptDisk(id);
    expect((await h.service.get(id)).assets.map((a) => a.relPath).sort()).toEqual([
      'notes.tmp',
      'refs/a.md',
    ]);
  });
});
