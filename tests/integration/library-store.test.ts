import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it, type TestContext } from 'vitest';

import { LibraryOperationError } from '../../src/core/model/library-errors';
import { createUlidGenerator } from '../../src/core/ports/id-generator';
import type { StoredItemFiles } from '../../src/core/ports/library-store';
import { LibraryService } from '../../src/core/services/library/library-service';
import type { AssetInput } from '../../src/core/model/item';
import { FsLibraryStore, LibraryStoreError } from '../../src/infra/library/library-store';
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

const posixOnly = it.skipIf(process.platform === 'win32');

function setup(options: ConstructorParameters<typeof FsLibraryStore>[1] = {}) {
  const root = createTempTree('acme-library-');
  const libraryDir = join(root, 'library');
  const store = new FsLibraryStore(libraryDir, options);
  const clock = new FakeClock();
  const service = new LibraryService({
    store,
    objects: new FsObjectStore(join(root, 'objects')),
    log: new MemoryOperationLog(),
    ids: createUlidGenerator(clock, deterministicRandom()),
    clock,
  });
  const itemDir = (id: string) => join(libraryDir, 'items', id);
  return { root, libraryDir, store, service, clock, itemDir };
}

function files(overrides: Partial<StoredItemFiles> = {}): StoredItemFiles {
  return {
    itemJson: bytes('{}'),
    body: bytes('acme'),
    assets: [],
    snapshotFiles: [],
    ...overrides,
  };
}

/** Dowiazania wymagaja uprawnien na Windowsie bez trybu dewelopera, wtedy test sie pomija. */
function link(ctx: TestContext, target: string, path: string, kind: 'dir' | 'file'): boolean {
  try {
    symlinkSync(target, path, kind === 'dir' && process.platform === 'win32' ? 'junction' : kind);
    return true;
  } catch {
    ctx.skip('system nie pozwala utworzyc dowiazania symbolicznego');
    return false;
  }
}

function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(dir.length + 1)
        .split('\\')
        .join('/'),
    )
    .sort();
}

const asset = (relPath: string, content: string): AssetInput => ({
  relPath,
  bytes: bytes(content),
});

describe('zapis i odczyt elementu na dysku', () => {
  it('round-trip z assetami: spacje, polskie znaki, CJK, glebokie zagniezdzenie, brak rozszerzenia', async () => {
    const { service, store, libraryDir } = setup();
    const inputs = [
      asset('plik ze spacjami.txt', 'spacje'),
      asset('zażółć/gęślą jaźń.md', 'polski'),
      asset('日本語/テスト.txt', 'cjk'),
      asset('a/b/c/d/e/f/g/h/glebokie.bin', 'gleboko'),
      asset('LICENSE', 'bez rozszerzenia'),
    ];

    const { item } = await service.create(draft({ assets: inputs }));

    // Czytamy swiezym serwisem na tym samym dysku: nic nie pochodzi z pamieci zapisujacego.
    const reader = new LibraryService({
      store: new FsLibraryStore(libraryDir),
      objects: new FsObjectStore(join(libraryDir, '..', 'objects')),
      log: new MemoryOperationLog(),
      ids: createUlidGenerator(new FakeClock(), deterministicRandom()),
      clock: new FakeClock(),
    });
    const loaded = await reader.get(item.id);

    expect(loaded.item).toEqual(item);
    expect(loaded.assets.map((a) => a.relPath).sort()).toEqual(
      inputs.map((a) => a.relPath.normalize('NFC')).sort(),
    );
    for (const input of inputs) {
      const read = loaded.assets.find((a) => a.relPath === input.relPath.normalize('NFC'));
      expect(read?.bytes).toEqual(input.bytes);
    }
    expect(await store.list()).toEqual([item.id]);
  });

  it('snapshoty trafiaja do snapshots/<tool>/ i wracaja z odczytem', async () => {
    const { service, itemDir } = setup();
    const { item } = await service.create(
      draft({
        source: {
          importedFrom: null,
          snapshots: [
            {
              tool: 'claude-code',
              files: [{ relPath: 'SKILL.md', bytes: bytes('zrodlo\r\n'), mode: null }],
              unmappedKeys: [],
            },
          ],
        },
      }),
    );

    expect(
      readFileSync(join(itemDir(item.id), 'snapshots', 'claude-code', 'SKILL.md'), 'utf8'),
    ).toBe('zrodlo\r\n');
    const loaded = await service.get(item.id);
    expect(loaded.snapshotFiles).toEqual([
      { tool: 'claude-code', relPath: 'SKILL.md', bytes: bytes('zrodlo\r\n') },
    ]);
  });

  it('write usuwa pliki spoza nowego stanu razem z pustymi katalogami i osieroconymi tmp', async () => {
    const { service, itemDir } = setup();
    const { item } = await service.create(
      draft({ assets: [asset('x/y/stary.txt', '1'), asset('zostaje.txt', '2')] }),
    );
    writeFileSync(join(itemDir(item.id), '.item.json.1234.abcdef.tmp'), 'smiec po awarii');

    await service.update(item.id, draft({ assets: [asset('zostaje.txt', '2')] }));

    expect(tree(itemDir(item.id))).toEqual([
      'assets',
      'assets/zostaje.txt',
      'body.md',
      'item.json',
    ]);
  });

  it('zmiana pliku w katalog i katalogu w plik w tej samej sciezce', async () => {
    const { service } = setup();
    const { item } = await service.create(draft({ assets: [asset('a', 'plik')] }));

    await service.update(item.id, draft({ assets: [asset('a/b.txt', 'w katalogu')] }));
    expect((await service.get(item.id)).assets.map((a) => a.relPath)).toEqual(['a/b.txt']);

    await service.update(item.id, draft({ assets: [asset('a', 'znowu plik')] }));
    expect((await service.get(item.id)).assets.map((a) => a.relPath)).toEqual(['a']);
  });

  it('katalog bez item.json czyta sie jako uszkodzony element, nie jako brak elementu', async () => {
    const { service, itemDir } = setup();
    const { item } = await service.create(draft());
    const { rmSync } = await import('node:fs');
    rmSync(join(itemDir(item.id), 'item.json'));

    await expect(service.get(item.id)).rejects.toMatchObject({ reason: 'item-json-malformed' });
  });

  it('read pomija pliki tymczasowe prymitywu, a zwykle pliki .tmp uzytkownika zostaja assetami', async () => {
    const { store, itemDir } = setup();
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    await store.write(
      id,
      files({
        assets: [
          { relPath: 'notes.tmp', bytes: bytes('1') },
          { relPath: 'refs/.hidden.tmp', bytes: bytes('2') },
          { relPath: 'refs/a.md', bytes: bytes('3') },
        ],
        snapshotFiles: [{ tool: 'codex', relPath: 'x.md', bytes: bytes('4') }],
      }),
    );
    writeFileSync(join(itemDir(id), 'assets', 'refs', '.a.md.4242.0a1b2c3d4e5f.tmp'), 'urwane');
    writeFileSync(join(itemDir(id), 'snapshots', 'codex', '.x.md.4242.0a1b2c3d4e5f.tmp'), 'urwane');

    const read = await store.read(id);

    expect(read?.assets.map((a) => a.relPath).sort()).toEqual([
      'notes.tmp',
      'refs/.hidden.tmp',
      'refs/a.md',
    ]);
    expect(read?.snapshotFiles.map((f) => f.relPath)).toEqual(['x.md']);
  });

  it('nie zapisze assetu o nazwie jak plik tymczasowy, bo zniknalby przy odczycie', async () => {
    const { store } = setup();
    await expect(
      store.write(
        '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        files({ assets: [{ relPath: 'a/.x.md.4242.0a1b2c3d4e5f.tmp', bytes: bytes('x') }] }),
      ),
    ).rejects.toMatchObject({ reason: 'temp-name' });
  });

  it('read nieistniejacego elementu daje null, remove jest idempotentne', async () => {
    const { store, service, itemDir } = setup();
    expect(await store.read('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeNull();
    await store.remove('01ARZ3NDEKTSV4RRFFQ69G5FAV');

    const { item } = await service.create(draft({ assets: [asset('a/b.txt', 'x')] }));
    await store.remove(item.id);
    await store.remove(item.id);
    expect(existsSync(itemDir(item.id))).toBe(false);
  });

  it('list zwraca nazwy katalogow, pomija luzne pliki i nie pada bez katalogu items', async () => {
    const { store, libraryDir } = setup();
    expect(await store.list()).toEqual([]);

    mkdirSync(join(libraryDir, 'items', 'acme-obcy-katalog'), { recursive: true });
    writeFileSync(join(libraryDir, 'items', '.DS_Store'), 'x');
    expect(await store.list()).toEqual(['acme-obcy-katalog']);
  });

  // Tryby to pojecie POSIX; na Windowsie nie udajemy chmod (ADR 0018).
  posixOnly('katalogi maja 0700, pliki 0600 od utworzenia', async () => {
    const { service, itemDir, libraryDir } = setup();
    const { item } = await service.create(draft({ assets: [asset('a/b.txt', 'x')] }));
    const dir = itemDir(item.id);

    for (const d of [
      libraryDir,
      join(libraryDir, 'items'),
      dir,
      join(dir, 'assets'),
      join(dir, 'assets', 'a'),
    ]) {
      expect(statSync(d).mode & 0o777, d).toBe(0o700);
    }
    for (const f of ['item.json', 'body.md', 'assets/a/b.txt']) {
      expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
    }
  });
});

describe('kontrola zawierania sciezek (obrona w glab)', () => {
  const bad = [
    '../evil.txt',
    'a/../../evil.txt',
    '/etc/evil.txt',
    'C:\\evil.txt',
    'a\\..\\evil.txt',
    'a//b',
    './x',
    'z\0.txt',
  ];

  for (const relPath of bad) {
    it(`odrzuca asset ${JSON.stringify(relPath)} przed pierwszym zapisem`, async () => {
      const { store, root, libraryDir } = setup();
      const before = tree(root);

      await expect(
        store.write(
          '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          files({ assets: [{ relPath, bytes: bytes('x') }] }),
        ),
      ).rejects.toMatchObject({ name: 'LibraryStoreError', reason: 'path-escape' });

      expect(tree(root)).toEqual(before);
      expect(existsSync(join(libraryDir, 'items'))).toBe(false);
    });
  }

  it('odrzuca tez snapshot z wyjsciem w gore', async () => {
    const { store } = setup();
    await expect(
      store.write(
        '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        files({ snapshotFiles: [{ tool: 'codex', relPath: '../../x', bytes: bytes('x') }] }),
      ),
    ).rejects.toMatchObject({ reason: 'path-escape' });
  });

  it('odrzuca id, ktore nie jest nazwa katalogu', async () => {
    const { store } = setup();
    for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a\0b']) {
      await expect(store.write(id, files())).rejects.toMatchObject({ reason: 'invalid-id' });
      await expect(store.read(id)).rejects.toBeInstanceOf(LibraryStoreError);
      await expect(store.remove(id)).rejects.toBeInstanceOf(LibraryStoreError);
    }
  });

  it('odrzuca plik i katalog o tej samej sciezce oraz duplikaty', async () => {
    const { store } = setup();
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    await expect(
      store.write(
        id,
        files({
          assets: [
            { relPath: 'a', bytes: bytes('1') },
            { relPath: 'a/b', bytes: bytes('2') },
          ],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'path-conflict' });
    await expect(
      store.write(
        id,
        files({
          assets: [
            { relPath: 'a', bytes: bytes('1') },
            { relPath: 'a', bytes: bytes('2') },
          ],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'path-conflict' });
  });
});

describe('dowiazania symboliczne', () => {
  it('dowiazanie do katalogu poza elementem jest odrzucane przy odczycie', async (ctx) => {
    const { service, itemDir, root } = setup();
    const { item } = await service.create(draft({ assets: [asset('ok.txt', 'ok')] }));
    const outside = join(root, 'acme-poza');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sekret.txt'), 'nie dla biblioteki');
    if (!link(ctx, outside, join(itemDir(item.id), 'assets', 'wyjscie'), 'dir')) return;

    await expect(service.get(item.id)).rejects.toMatchObject({ reason: 'store-failed' });
    const cause = await service.get(item.id).catch((e: LibraryOperationError) => e.cause);
    expect(cause).toMatchObject({ name: 'LibraryStoreError', reason: 'symlink' });
  });

  // Nowy stan powstaje od zera w katalogu roboczym (ADR 0031), wiec dowiazanie w starym elemencie
  // nie ma jak sie w nim znalezc i nic poza elementem nie jest dotykane.
  it('zapis elementu z dowiazaniem do katalogu poza nim: dowiazanie znika, cel nietkniety', async (ctx) => {
    const { store, itemDir, root } = setup();
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    await store.write(id, files({ assets: [{ relPath: 'ok.txt', bytes: bytes('ok') }] }));
    const outside = join(root, 'acme-poza');
    mkdirSync(outside);
    writeFileSync(join(outside, 'cudzy.txt'), 'cudzy');
    if (!link(ctx, outside, join(itemDir(id), 'assets', 'wyjscie'), 'dir')) return;

    await store.write(id, files({ assets: [{ relPath: 'wyjscie/nowy.txt', bytes: bytes('x') }] }));

    expect(readdirSync(outside)).toEqual(['cudzy.txt']);
    expect(tree(itemDir(id))).toEqual([
      'assets',
      'assets/wyjscie',
      'assets/wyjscie/nowy.txt',
      'body.md',
      'item.json',
    ]);
    expect(lstatSync(join(itemDir(id), 'assets', 'wyjscie')).isSymbolicLink()).toBe(false);
  });

  it('zapis elementu z dowiazaniem do pliku poza nim: cel nietkniety, w elemencie zwykly plik', async (ctx) => {
    const { store, itemDir, root } = setup();
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    await store.write(id, files({ assets: [{ relPath: 'ok.txt', bytes: bytes('ok') }] }));
    const secret = join(root, 'acme-sekret.txt');
    writeFileSync(secret, 'oryginal');
    if (!link(ctx, secret, join(itemDir(id), 'assets', 'link.txt'), 'file')) return;

    await store.write(id, files({ assets: [{ relPath: 'link.txt', bytes: bytes('x') }] }));

    expect(readFileSync(secret, 'utf8')).toBe('oryginal');
    const inside = join(itemDir(id), 'assets', 'link.txt');
    expect(lstatSync(inside).isSymbolicLink()).toBe(false);
    expect(readFileSync(inside, 'utf8')).toBe('x');
  });

  it('dowiazanie jako katalog elementu jest odrzucane przy odczycie i zapisie', async (ctx) => {
    const { store, libraryDir, root } = setup();
    const outside = join(root, 'acme-poza');
    mkdirSync(outside);
    mkdirSync(join(libraryDir, 'items'), { recursive: true });
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    if (!link(ctx, outside, join(libraryDir, 'items', id), 'dir')) return;

    await expect(store.read(id)).rejects.toMatchObject({ reason: 'symlink' });
    await expect(store.write(id, files())).rejects.toMatchObject({ reason: 'symlink' });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('remove usuwa samo dowiazanie, nie jego cel', async (ctx) => {
    const { store, libraryDir, root } = setup();
    const outside = join(root, 'acme-poza');
    mkdirSync(outside);
    writeFileSync(join(outside, 'zostaje.txt'), 'x');
    mkdirSync(join(libraryDir, 'items'), { recursive: true });
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    if (!link(ctx, outside, join(libraryDir, 'items', id), 'dir')) return;

    await store.remove(id);
    expect(readdirSync(outside)).toEqual(['zostaje.txt']);
  });
});

describe('dowiazania w katalogach strukturalnych (read i write)', () => {
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const withSnapshot = () =>
    files({
      assets: [{ relPath: 'ok.txt', bytes: bytes('ok') }],
      snapshotFiles: [{ tool: 'claude-code', relPath: 'SKILL.md', bytes: bytes('zrodlo') }],
    });

  function outsideDir(root: string): string {
    const outside = join(root, 'acme-poza');
    mkdirSync(join(outside, 'refs'), { recursive: true });
    writeFileSync(join(outside, 'cudzy.txt'), 'cudzy plik');
    writeFileSync(join(outside, 'refs', 'cudzy.md'), 'cudzy plik');
    return outside;
  }

  it('assets jako dowiazanie: read odrzuca, nie wylicza cudzych plikow', async (ctx) => {
    const { store, itemDir, root } = setup();
    await store.write(id, withSnapshot());
    rmSync(join(itemDir(id), 'assets'), { recursive: true });
    if (!link(ctx, outsideDir(root), join(itemDir(id), 'assets'), 'dir')) return;

    await expect(store.read(id)).rejects.toMatchObject({
      name: 'LibraryStoreError',
      reason: 'symlink',
    });
  });

  it('snapshots jako dowiazanie: read odrzuca', async (ctx) => {
    const { store, itemDir, root } = setup();
    await store.write(id, withSnapshot());
    rmSync(join(itemDir(id), 'snapshots'), { recursive: true });
    const outside = outsideDir(root);
    mkdirSync(join(outside, 'claude-code'));
    writeFileSync(join(outside, 'claude-code', 'cudzy.md'), 'cudzy plik');
    if (!link(ctx, outside, join(itemDir(id), 'snapshots'), 'dir')) return;

    await expect(store.read(id)).rejects.toMatchObject({ reason: 'symlink' });
  });

  it('snapshots/claude-code jako dowiazanie: read odrzuca', async (ctx) => {
    const { store, itemDir, root } = setup();
    await store.write(id, withSnapshot());
    rmSync(join(itemDir(id), 'snapshots', 'claude-code'), { recursive: true });
    if (!link(ctx, outsideDir(root), join(itemDir(id), 'snapshots', 'claude-code'), 'dir')) return;

    await expect(store.read(id)).rejects.toMatchObject({ reason: 'symlink' });
  });

  it('zapis elementu z dowiazaniem w assets, snapshots i snapshots/<tool>: dowiazanie znika, cel nietkniety', async (ctx) => {
    const targets = [['assets'], ['snapshots'], ['snapshots', 'claude-code']] as const;
    for (const target of targets) {
      const { store, itemDir, root } = setup();
      await store.write(id, withSnapshot());
      const outside = outsideDir(root);
      const before = tree(outside);
      rmSync(join(itemDir(id), ...target), { recursive: true });
      if (!link(ctx, outside, join(itemDir(id), ...target), 'dir')) return;

      await store.write(id, withSnapshot());

      expect(tree(outside), target.join('/')).toEqual(before);
      const read = await store.read(id);
      expect(
        read?.assets.map((a) => a.relPath),
        target.join('/'),
      ).toEqual(['ok.txt']);
      expect(
        read?.snapshotFiles.map((f) => f.relPath),
        target.join('/'),
      ).toEqual(['SKILL.md']);
    }
  });
});

describe('zmiany nazw miedzy wersjami (SEC-003, APFS i NTFS)', () => {
  // Na systemie z rozrozniajacym wielkosc liter te testy sprawdzaja zwykle zastapienie pliku;
  // na APFS i NTFS sprawdzaja to, co SEC-003 opisuje: ten sam wpis pod nowa nazwa.
  const consistent = async (service: ReturnType<typeof setup>['service'], id: string) => {
    const loaded = await service.get(id);
    return loaded.assets.map((a) => a.relPath).sort();
  };

  it('zmiana samej wielkosci liter nazwy assetu zostawia element spojny', async () => {
    const { service, itemDir } = setup();
    const { item } = await service.create(draft({ assets: [asset('Ref.md', 'tresc')] }));

    await service.update(item.id, draft({ assets: [asset('ref.md', 'tresc')] }));

    expect(await consistent(service, item.id)).toEqual(['ref.md']);
    expect(tree(itemDir(item.id))).toEqual(['assets', 'assets/ref.md', 'body.md', 'item.json']);
  });

  it('zmiana wielkosci liter katalogu i pliku w srodku zostawia element spojny', async () => {
    const { service, itemDir } = setup();
    const { item } = await service.create(
      draft({
        assets: [asset('Refs/A.md', 'a'), asset('Refs/b.md', 'b'), asset('Refs/sub/c.md', 'c')],
      }),
    );

    await service.update(
      item.id,
      draft({
        assets: [asset('refs/a.md', 'a'), asset('refs/b.md', 'b'), asset('refs/sub/c.md', 'c')],
      }),
    );

    expect(await consistent(service, item.id)).toEqual(['refs/a.md', 'refs/b.md', 'refs/sub/c.md']);
    expect(tree(itemDir(item.id))).toEqual([
      'assets',
      'assets/refs',
      'assets/refs/a.md',
      'assets/refs/b.md',
      'assets/refs/sub',
      'assets/refs/sub/c.md',
      'body.md',
      'item.json',
    ]);
  });

  it('nazwa zapisana na dysku w NFD, nowy stan w NFC: element spojny, nic nie skasowane', async () => {
    const { service, itemDir } = setup();
    const nfc = 'zażółć.md'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    const { item } = await service.create(draft({ assets: [asset(nfc, 'tresc')] }));
    renameSync(join(itemDir(item.id), 'assets', nfc), join(itemDir(item.id), 'assets', nfd));

    await service.update(item.id, draft({ body: 'nowe body\n', assets: [asset(nfc, 'tresc')] }));

    expect(await consistent(service, item.id)).toEqual([nfc]);
    expect(readdirSync(join(itemDir(item.id), 'assets'))).toHaveLength(1);
  });

  it('nieudana zamiana przy zmianie katalogu w plik zostawia caly stary element', async () => {
    let failSwap = false;
    const { service, itemDir } = setup({
      atomicOps: {
        rename: async (from, to) => {
          if (failSwap && from.includes('.work.')) throw new Error('zabity proces');
          await (await import('node:fs/promises')).rename(from, to);
        },
      },
    });
    const { item } = await service.create(
      draft({ assets: [asset('a/b.md', 'stary plik w katalogu')] }),
    );

    failSwap = true;
    await expect(
      service.update(item.id, draft({ assets: [asset('a', 'nowy plik')] })),
    ).rejects.toBeInstanceOf(LibraryOperationError);
    failSwap = false;

    const loaded = await service.get(item.id);
    expect(loaded.assets.map((a) => a.relPath)).toEqual(['a/b.md']);
    expect(tree(itemDir(item.id))).toEqual([
      'assets',
      'assets/a',
      'assets/a/b.md',
      'body.md',
      'item.json',
    ]);
    expect(readdirSync(join(itemDir(item.id), '..'))).toEqual([item.id]);
  });

  it('pomyslna zmiana katalogu w plik i z powrotem konczy sie spojnym elementem bez resztek', async () => {
    const { service, itemDir } = setup();
    const { item } = await service.create(draft({ assets: [asset('a/b.md', 'x')] }));
    await service.update(item.id, draft({ assets: [asset('a', 'plik')] }));
    await service.update(item.id, draft({ assets: [asset('a/b.md', 'x')] }));

    expect(tree(itemDir(item.id))).toEqual([
      'assets',
      'assets/a',
      'assets/a/b.md',
      'body.md',
      'item.json',
    ]);
  });
});
