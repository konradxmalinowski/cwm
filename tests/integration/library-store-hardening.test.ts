import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, describe, expect, it, type TestContext } from 'vitest';

import {
  MAX_FILE_BYTES,
  MAX_ITEM_JSON_BYTES,
  MAX_OBJECT_BYTES,
  MAX_TREE_DEPTH,
} from '../../src/core/model/library-limits';
import { LibraryOperationError } from '../../src/core/model/library-errors';
import { createUlidGenerator } from '../../src/core/ports/id-generator';
import type { StoredItemFiles } from '../../src/core/ports/library-store';
import { sha256Bytes } from '../../src/core/services/normalization/hash';
import { LibraryService } from '../../src/core/services/library/library-service';
import type { AtomicOps } from '../../src/infra/fs/atomic';
import { AtomicWriteError, writeFileAtomic } from '../../src/infra/fs/atomic';
import { failureCodeFromErrno, type FsOperation } from '../../src/infra/fs/store-error';
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

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const posixOnly = it.skipIf(process.platform === 'win32');
const asRoot = process.getuid?.() === 0;
// Root omija uprawnienia plikow i katalogow, wiec testy z chmod 000 nic by nie dowodzily.
const needsPermissions = it.skipIf(process.platform === 'win32' || asRoot);
const errno = (code: string) => Object.assign(new Error(code), { code });

function setup(atomicOps?: Partial<AtomicOps>) {
  const root = createTempTree('acme-harden-');
  const clock = new FakeClock();
  const store = new FsLibraryStore(join(root, 'library'), {
    ...(atomicOps ? { atomicOps } : {}),
  });
  const objects = new FsObjectStore(join(root, 'objects'));
  const service = new LibraryService({
    store,
    objects,
    log: new MemoryOperationLog(),
    ids: createUlidGenerator(clock, deterministicRandom()),
    clock,
  });
  return {
    root,
    store,
    objects,
    service,
    itemDir: (id: string) => join(root, 'library', 'items', id),
  };
}

function files(overrides: Partial<StoredItemFiles> = {}): StoredItemFiles {
  return {
    itemJson: bytes('{}'),
    body: bytes('acme'),
    assets: [{ relPath: 'ok.txt', bytes: bytes('ok') }],
    snapshotFiles: [{ tool: 'claude-code', relPath: 'SKILL.md', bytes: bytes('zrodlo') }],
    ...overrides,
  };
}

function tryLink(ctx: TestContext, target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    ctx.skip('system nie pozwala utworzyc dowiazania symbolicznego');
    return false;
  }
}

describe('failureCode: errno na przyczyne w jednym miejscu', () => {
  const table: [string, FsOperation, NodeJS.Platform, string][] = [
    ['ENOSPC', 'write', 'linux', 'no-space'],
    ['EDQUOT', 'write', 'linux', 'no-space'],
    ['EACCES', 'read', 'linux', 'permission-denied'],
    ['EPERM', 'replace', 'darwin', 'permission-denied'],
    ['EROFS', 'write', 'linux', 'permission-denied'],
    // Windows: EPERM/EACCES to zajety plik tylko przy rename, unlink i rmdir; przy odczycie to uprawnienia.
    ['EACCES', 'replace', 'win32', 'busy'],
    ['EPERM', 'replace', 'win32', 'busy'],
    ['EACCES', 'read', 'win32', 'permission-denied'],
    ['EPERM', 'write', 'win32', 'permission-denied'],
    ['EBUSY', 'read', 'linux', 'busy'],
    ['ETXTBSY', 'read', 'linux', 'busy'],
    ['ELOOP', 'read', 'linux', 'symlink'],
    ['ENAMETOOLONG', 'write', 'linux', 'path-too-deep'],
    ['EIO', 'read', 'linux', 'unknown'],
    ['ENOENT', 'read', 'linux', 'unknown'],
  ];
  for (const [code, operation, platform, expected] of table) {
    it(`${code} (${operation}) na ${platform} to ${expected}`, () => {
      expect(failureCodeFromErrno(code, platform, operation)).toBe(expected);
    });
  }
  it('brak kodu to unknown', () => {
    expect(failureCodeFromErrno(undefined)).toBe('unknown');
  });
});

describe('failureCode na LibraryOperationError przez prawdziwy serwis', () => {
  async function failureOf(task: Promise<unknown>): Promise<string | undefined> {
    const error = await task.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LibraryOperationError);
    return (error as LibraryOperationError).failure;
  }

  const cases: [string, string][] = [
    ['ENOSPC', 'no-space'],
    ['EBUSY', 'busy'],
    ['ELOOP', 'symlink'],
    ['EIO', 'unknown'],
  ];
  for (const [code, expected] of cases) {
    it(`awaria zapisu ${code} daje failure=${expected}`, async () => {
      let broken = false;
      const { service } = setup({
        platform: 'linux',
        rename: async (from, to) => {
          if (broken && from.includes('.work.')) throw errno(code);
          await rename(from, to);
        },
      });
      const { item } = await service.create(draft());
      broken = true;
      expect(await failureOf(service.update(item.id, draft({ body: 'inne\n' })))).toBe(expected);
    });
  }

  posixOnly('EACCES przy zapisie daje failure=permission-denied', async () => {
    let broken = false;
    const { service } = setup({
      platform: 'linux',
      rename: async (from, to) => {
        if (broken && from.includes('.work.')) throw errno('EACCES');
        await rename(from, to);
      },
    });
    const { item } = await service.create(draft());
    broken = true;
    expect(await failureOf(service.update(item.id, draft({ body: 'inne\n' })))).toBe(
      'permission-denied',
    );
  });

  it('dowiazanie w elemencie daje failure=symlink przy odczycie', async (ctx) => {
    const { service, itemDir, root } = setup();
    const { item } = await service.create(
      draft({ assets: [{ relPath: 'ok.txt', bytes: bytes('x') }] }),
    );
    const outside = join(root, 'acme-poza');
    mkdirSync(outside);
    if (!tryLink(ctx, outside, join(itemDir(item.id), 'assets', 'wyjscie'))) return;

    expect(await failureOf(service.get(item.id))).toBe('symlink');
  });

  it('za gleboke drzewo daje failure=path-too-deep przy odczycie', async () => {
    const { service, itemDir } = setup();
    const { item } = await service.create(
      draft({ assets: [{ relPath: 'ok.txt', bytes: bytes('x') }] }),
    );
    mkdirSync(join(itemDir(item.id), 'assets', ...Array<string>(MAX_TREE_DEPTH + 3).fill('d')), {
      recursive: true,
    });

    expect(await failureOf(service.get(item.id))).toBe('path-too-deep');
  });
});

describe('limity rozmiaru przy odczycie z dysku', () => {
  function sparse(path: string, size: number): void {
    writeFileSync(path, '');
    truncateSync(path, size);
  }

  // Bez prawa odczytu assets/ odczyt item.json nadal dziala, wiec readItemJson ich nie dotyka.
  needsPermissions(
    'readItemJson czyta co najwyzej MAX_ITEM_JSON_BYTES + 1 bajtow i nie dotyka assetow',
    async () => {
      const { store, itemDir } = setup();
      await store.write(ID, files());
      writeFileSync(join(itemDir(ID), 'item.json'), Buffer.alloc(MAX_ITEM_JSON_BYTES + 100, 0x20));
      const assets = join(itemDir(ID), 'assets');
      chmodSync(assets, 0o000);
      try {
        expect((await store.readItemJson(ID))?.length).toBe(MAX_ITEM_JSON_BYTES + 1);
      } finally {
        chmodSync(assets, 0o700);
      }
    },
  );

  it('readItemJson: brak elementu i brak pliku to null', async () => {
    const { store, itemDir } = setup();
    expect(await store.readItemJson(ID)).toBeNull();
    await store.write(ID, files());
    const { rmSync } = await import('node:fs');
    rmSync(join(itemDir(ID), 'item.json'));
    expect(await store.readItemJson(ID)).toBeNull();
  });

  it('read odrzuca ogromny asset rozpoznanym bledem, bez czytania go', async () => {
    const { store, itemDir } = setup();
    await store.write(ID, files());
    sparse(join(itemDir(ID), 'assets', 'ogromny.bin'), 256 * 1024 * 1024);

    await expect(store.read(ID)).rejects.toMatchObject({
      name: 'LibraryStoreError',
      reason: 'too-large',
    });
  });

  it('za duzy item.json daje ten sam wynik z read i readItemJson (limit + 1 bajt, ocena w core); za duze body to too-large', async () => {
    const { store, itemDir } = setup();
    await store.write(ID, files());
    sparse(join(itemDir(ID), 'item.json'), MAX_ITEM_JSON_BYTES + 100);
    const viaRead = (await store.read(ID))?.itemJson;
    const viaItemJson = await store.readItemJson(ID);
    expect(viaRead?.length).toBe(MAX_ITEM_JSON_BYTES + 1);
    expect(viaItemJson?.length).toBe(MAX_ITEM_JSON_BYTES + 1);

    writeFileSync(join(itemDir(ID), 'item.json'), '{}');
    sparse(join(itemDir(ID), 'body.md'), MAX_FILE_BYTES + 1);
    await expect(store.read(ID)).rejects.toMatchObject({ reason: 'too-large' });
  });

  it('obiekt o rozmiarze rekordu z body 5 MiB przechodzi put, ponowny put i get', async () => {
    const { objects } = setup();
    // Rekord wersji z body 5 MiB: wiekszy niz MAX_FILE_BYTES, wiec przekracza stary limit obiektu.
    const record = new TextEncoder().encode(JSON.stringify({ body: 'a'.repeat(5 * 1024 * 1024) }));
    expect(record.length).toBeGreaterThan(MAX_FILE_BYTES);
    expect(record.length).toBeLessThanOrEqual(MAX_OBJECT_BYTES);

    const hash = await objects.put(record);
    expect(await objects.put(record)).toBe(hash);
    // Porownanie bajtow bez toEqual: dla kilku MiB glebokie porownanie w vitest trwa sekundy.
    const back = await objects.get(hash);
    expect(back !== null && Buffer.compare(back, record) === 0).toBe(true);
  });

  it('ObjectStore.get i put nie czytaja ogromnego pliku podlozonego pod hash', async () => {
    const { root, objects } = setup();
    const content = bytes('acme');
    const hash = sha256Bytes(content);
    mkdirSync(join(root, 'objects', hash.slice(0, 2)), { recursive: true });
    sparse(join(root, 'objects', hash.slice(0, 2), hash), 256 * 1024 * 1024);

    await expect(objects.get(hash)).rejects.toMatchObject({ reason: 'too-large' });
    // put zna tresc, wiec nadpisuje podlozony plik zamiast go czytac.
    await objects.put(content);
    expect(await objects.get(hash)).toEqual(content);
  });
});

describe('plik tymczasowy po awarii (SEC-010)', () => {
  it('nieudane sprzatanie pliku tymczasowego idzie dalej w bledzie', async () => {
    const dir = createTempTree('acme-atomic-');
    const failure = await writeFileAtomic(join(dir, 'acme.txt'), bytes('sekret'), {
      ops: {
        rename: () => Promise.reject(errno('EIO')),
        rm: () => Promise.reject(errno('EBUSY')),
      },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(AtomicWriteError);
    const leftover = (failure as AtomicWriteError).leftover;
    expect(leftover?.name).toMatch(/^\.acme\.txt\.\d+\.[0-9a-f]{12}\.tmp$/);
    expect(leftover?.cause).toMatchObject({ code: 'EBUSY' });
  });

  it('udane sprzatanie nie ustawia leftover', async () => {
    const dir = createTempTree('acme-atomic-');
    const failure = await writeFileAtomic(join(dir, 'acme.txt'), bytes('x'), {
      ops: { rename: () => Promise.reject(errno('EIO')) },
    }).catch((e: unknown) => e);
    expect((failure as AtomicWriteError).leftover).toBeUndefined();
  });

  it('put sprzata stare pliki tymczasowe w swoim katalogu <aa>, nie rusza swiezych', async () => {
    const { root, objects } = setup();
    const hash = sha256Bytes(bytes('acme'));
    const shard = join(root, 'objects', hash.slice(0, 2));
    mkdirSync(shard, { recursive: true });
    const old = join(shard, `.${hash}.4242.0a1b2c3d4e5f.tmp`);
    const fresh = join(shard, `.${hash}.4243.0a1b2c3d4e5f.tmp`);
    const notTemp = join(shard, 'notes.tmp');
    for (const file of [old, fresh, notTemp]) writeFileSync(file, 'tresc');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(notTemp, longAgo, longAgo);

    await objects.put(bytes('acme'));

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(notTemp)).toBe(true);
  });
});

describe('readSalvage', () => {
  it('zwraca null dla brakujacego elementu', async () => {
    const { store } = setup();
    expect(await store.readSalvage(ID)).toBeNull();
  });

  it('zbiera cale drzewo: relPath z / i w NFC, takze pliki o nazwie jak tymczasowe', async () => {
    const { store, itemDir } = setup();
    const nfc = 'zażółć.md'.normalize('NFC');
    await store.write(
      ID,
      files({
        assets: [
          { relPath: `glebokie/${nfc}`, bytes: bytes('a') },
          { relPath: 'x y.txt', bytes: bytes('b') },
        ],
      }),
    );
    writeFileSync(join(itemDir(ID), 'assets', '.x.4242.0a1b2c3d4e5f.tmp'), 'smiec');
    writeFileSync(join(itemDir(ID), 'reczny-plik.txt'), 'dodany recznie');

    const result = await store.readSalvage(ID);

    expect(result?.unreadable).toEqual([]);
    expect(result?.entries.map((e) => e.relPath)).toEqual(
      [
        'assets/glebokie/' + nfc,
        'assets/.x.4242.0a1b2c3d4e5f.tmp',
        'assets/x y.txt',
        'body.md',
        'item.json',
        'reczny-plik.txt',
        'snapshots/claude-code/SKILL.md',
      ].sort((a, b) => a.localeCompare(b)),
    );
    expect(result?.entries.find((e) => e.relPath === 'body.md')?.bytes).toEqual(bytes('acme'));
  });

  needsPermissions('nieczytelny plik to wpis unreadable, reszta jest zebrana', async () => {
    const { store, itemDir } = setup();
    await store.write(ID, files());
    const secret = join(itemDir(ID), 'assets', 'ok.txt');
    chmodSync(secret, 0o000);
    try {
      const result = await store.readSalvage(ID);
      expect(result?.unreadable).toEqual([
        { relPath: 'assets/ok.txt', failure: 'permission-denied' },
      ]);
      expect(result?.entries.map((e) => e.relPath)).toContain('item.json');
      expect(result?.entries.map((e) => e.relPath)).not.toContain('assets/ok.txt');
    } finally {
      chmodSync(secret, 0o600);
    }
  });

  needsPermissions('katalog bez prawa odczytu to wpis unreadable dla tego katalogu', async () => {
    const { store, itemDir } = setup();
    await store.write(ID, files());
    const dir = join(itemDir(ID), 'snapshots', 'claude-code');
    chmodSync(dir, 0o000);
    try {
      const result = await store.readSalvage(ID);
      expect(result?.unreadable).toEqual([
        { relPath: 'snapshots/claude-code', failure: 'permission-denied' },
      ]);
      expect(result?.entries.map((e) => e.relPath)).toContain('assets/ok.txt');
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('dowiazanie zamiast assets/ to unreadable symlink, reszta jest zebrana', async (ctx) => {
    const { store, itemDir, root } = setup();
    await store.write(ID, files());
    const outside = join(root, 'acme-poza');
    mkdirSync(outside);
    writeFileSync(join(outside, 'cudzy.txt'), 'cudzy');
    const { rmSync } = await import('node:fs');
    rmSync(join(itemDir(ID), 'assets'), { recursive: true });
    if (!tryLink(ctx, outside, join(itemDir(ID), 'assets'))) return;

    const result = await store.readSalvage(ID);

    expect(result?.unreadable).toEqual([{ relPath: 'assets', failure: 'symlink' }]);
    expect(result?.entries.map((e) => e.relPath)).toEqual([
      'body.md',
      'item.json',
      'snapshots/claude-code/SKILL.md',
    ]);
  });

  it('dowiazanie do pliku w srodku drzewa nie jest czytane', async (ctx) => {
    const { store, itemDir, root } = setup();
    await store.write(ID, files());
    const secret = join(root, 'acme-sekret.txt');
    writeFileSync(secret, 'sekret');
    try {
      symlinkSync(secret, join(itemDir(ID), 'assets', 'link.txt'), 'file');
    } catch {
      ctx.skip('system nie pozwala utworzyc dowiazania symbolicznego');
      return;
    }

    const result = await store.readSalvage(ID);

    expect(result?.unreadable).toEqual([{ relPath: 'assets/link.txt', failure: 'symlink' }]);
    expect(result?.entries.some((e) => new TextDecoder().decode(e.bytes) === 'sekret')).toBe(false);
  });

  it('dowiazanie jako katalog elementu to jedyny wpis unreadable', async (ctx) => {
    const { store, root } = setup();
    const outside = join(root, 'acme-poza');
    mkdirSync(outside);
    writeFileSync(join(outside, 'cudzy.txt'), 'cudzy');
    mkdirSync(join(root, 'library', 'items'), { recursive: true });
    if (!tryLink(ctx, outside, join(root, 'library', 'items', ID))) return;

    expect(await store.readSalvage(ID)).toEqual({
      entries: [],
      unreadable: [{ relPath: '', failure: 'symlink' }],
    });
  });

  it('za glebokie poddrzewo to path-too-deep tylko dla niego', async () => {
    const { store, itemDir } = setup();
    await store.write(ID, files());
    const deepDir = join(itemDir(ID), 'assets', ...Array<string>(MAX_TREE_DEPTH + 3).fill('d'));
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(join(deepDir, 'gleboko.txt'), 'x');

    const result = await store.readSalvage(ID);

    expect(result?.unreadable).toHaveLength(1);
    expect(result?.unreadable[0]?.failure).toBe('path-too-deep');
    expect(result?.unreadable[0]?.relPath.startsWith('assets/d/d/')).toBe(true);
    expect(result?.entries.map((e) => e.relPath)).toContain('assets/ok.txt');
  });

  it('ogromny plik to wpis unreadable, nie alokacja', async () => {
    const { store, itemDir } = setup();
    await store.write(ID, files());
    const huge = join(itemDir(ID), 'assets', 'ogromny.bin');
    writeFileSync(huge, '');
    truncateSync(huge, 256 * 1024 * 1024);

    const result = await store.readSalvage(ID);

    expect(result?.unreadable).toEqual([{ relPath: 'assets/ogromny.bin', failure: 'unknown' }]);
    expect(result?.entries.map((e) => e.relPath)).toContain('assets/ok.txt');
  });

  posixOnly('plik specjalny (FIFO) nie jest otwierany, bo zawiesilby odczyt', async (ctx) => {
    const { store, itemDir } = setup();
    await store.write(ID, files());
    const made = spawnSync('mkfifo', [join(itemDir(ID), 'assets', 'rura')]);
    if (made.status !== 0) {
      ctx.skip('mkfifo niedostepne');
      return;
    }

    const result = await store.readSalvage(ID);

    expect(result?.unreadable).toEqual([{ relPath: 'assets/rura', failure: 'not-a-file' }]);
  });
});

describe('remove elementu, ktorego nie da sie w calosci odczytac', () => {
  it('usuwa dowiazanie w srodku, nie jego cel', async (ctx) => {
    const { store, itemDir, root } = setup();
    await store.write(ID, files());
    const outside = join(root, 'acme-poza');
    mkdirSync(outside);
    writeFileSync(join(outside, 'zostaje.txt'), 'x');
    if (!tryLink(ctx, outside, join(itemDir(ID), 'assets', 'wyjscie'))) return;

    await store.remove(ID);

    expect(existsSync(itemDir(ID))).toBe(false);
    expect(readFileSync(join(outside, 'zostaje.txt'), 'utf8')).toBe('x');
  });

  needsPermissions(
    'usuwa katalog bez prawa odczytu (przywraca 0700 tylko w drzewie elementu)',
    async () => {
      const { store, itemDir } = setup();
      await store.write(ID, files());
      chmodSync(join(itemDir(ID), 'snapshots', 'claude-code'), 0o000);
      chmodSync(join(itemDir(ID), 'assets'), 0o000);

      await store.remove(ID);

      expect(existsSync(itemDir(ID))).toBe(false);
    },
  );
});

describe('plik specjalny w miejscu pliku elementu nie zawiesza odczytu', () => {
  // mkfifo istnieje tylko na POSIX; na Windowsie nie ma plikow FIFO. Zawieszenie wyszloby jako
  // przekroczenie limitu czasu testu, wiec kazdy test konczy sie rozpoznanym bledem albo wpisem.
  function fifo(ctx: TestContext, path: string): boolean {
    rmSync(path, { force: true });
    if (spawnSync('mkfifo', [path]).status === 0) return true;
    ctx.skip('mkfifo niedostepne');
    return false;
  }

  posixOnly('readItemJson z FIFO zamiast item.json', async (ctx) => {
    const { store, itemDir } = setup();
    await store.write(ID, files());
    if (!fifo(ctx, join(itemDir(ID), 'item.json'))) return;

    await expect(store.readItemJson(ID)).rejects.toMatchObject({ reason: 'not-a-file' });
  });

  posixOnly('read z FIFO zamiast body.md i w assets/', async (ctx) => {
    const { store, itemDir } = setup();
    await store.write(ID, files());
    if (!fifo(ctx, join(itemDir(ID), 'body.md'))) return;
    await expect(store.read(ID)).rejects.toMatchObject({ reason: 'not-a-file' });

    // Plik specjalny w assets/ nie jest wyliczany jako asset; odczyt nie otwiera go ani nie wisi.
    await store.write(ID, files());
    if (!fifo(ctx, join(itemDir(ID), 'assets', 'ok.txt'))) return;
    expect((await store.read(ID))?.assets).toEqual([]);
  });

  posixOnly('ObjectStore: FIFO pod hashem to rozpoznany blad, nie zawieszenie', async (ctx) => {
    const { root, objects } = setup();
    const hash = sha256Bytes(bytes('acme'));
    mkdirSync(join(root, 'objects', hash.slice(0, 2)), { recursive: true });
    if (!fifo(ctx, join(root, 'objects', hash.slice(0, 2), hash))) return;

    await expect(objects.get(hash)).rejects.toMatchObject({ reason: 'not-regular-file' });
  });
});

describe('zmiana wielkosci liter nazwy bez sladu po starej nazwie', () => {
  // Nowy stan powstaje od zera, wiec wynik nie zalezy od tego, czy system rozroznia wielkosc liter,
  // ani od tego, czy ma numery inode (FAT, czesc SMB): nie ma co porownywac ani odsuwac.
  it('zmiana wielkosci liter assetu zostawia element spojny', async () => {
    const { service, itemDir } = setup();
    const asset = (relPath: string) => ({ relPath, bytes: bytes('tresc') });
    const { item } = await service.create(draft({ assets: [asset('Ref.md'), asset('Dir/A.md')] }));

    await service.update(item.id, draft({ assets: [asset('ref.md'), asset('dir/a.md')] }));

    expect((await service.get(item.id)).assets.map((a) => a.relPath).sort()).toEqual([
      'dir/a.md',
      'ref.md',
    ]);
    expect(readFileSync(join(itemDir(item.id), 'assets', 'ref.md'), 'utf8')).toBe('tresc');
    expect(readdirSync(join(itemDir(item.id), 'assets')).sort()).toEqual(['dir', 'ref.md']);
  });
});

describe('niezmienione pliki: twarde dowiazanie albo kopia', () => {
  const asset = (relPath: string, content: string) => ({ relPath, bytes: bytes(content) });
  const inode = (path: string) => statSync(path, { bigint: true }).ino;

  /** Twarde dowiazania nie dzialaja na kazdym systemie plikow (FAT, czesc SMB): wtedy testy sprawdzaja kopie. */
  function hardLinksWork(root: string): boolean {
    try {
      writeFileSync(join(root, 'probe-a'), 'x');
      linkSync(join(root, 'probe-a'), join(root, 'probe-b'));
      return true;
    } catch {
      return false;
    }
  }

  it('niezmieniony asset i body zachowuja inode, zmieniony dostaje nowy; item.json zawsze nowy', async (ctx) => {
    const { service, itemDir, root } = setup();
    if (!hardLinksWork(root)) return ctx.skip('system plikow nie obsluguje twardych dowiazan');
    const { item } = await service.create(
      draft({ assets: [asset('a.txt', 'A'), asset('sub/b.txt', 'B')] }),
    );
    const dir = itemDir(item.id);
    const rels = ['body.md', 'assets/a.txt', 'assets/sub/b.txt', 'item.json'];
    const before = rels.map((r) => inode(join(dir, r)));

    const base = draft({ assets: [asset('a.txt', 'A'), asset('sub/b.txt', 'B zmienione')] });
    await service.update(item.id, {
      ...base,
      content: { ...base.content, description: 'Nowy opis.' },
    });

    const after = rels.map((r) => inode(join(dir, r)));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(after[3]).not.toBe(before[3]);
    expect(readFileSync(join(dir, 'assets/sub/b.txt'), 'utf8')).toBe('B zmienione');
    // Stary katalog zniknal, wiec wspolny plik ma jedno dowiazanie.
    expect(statSync(join(dir, 'assets/a.txt')).nlink).toBe(1);
  });

  it('gdy dowiazanie sie nie udaje (EXDEV), plik jest kopia z poprawna trescia i trybem', async () => {
    const root = createTempTree('acme-link-');
    const store = new FsLibraryStore(join(root, 'library'), {
      link: () => Promise.reject(errno('EXDEV')),
    });
    await store.write(ID, files());
    const dir = join(root, 'library', 'items', ID);
    const before = inode(join(dir, 'assets', 'ok.txt'));

    await store.write(ID, files({ itemJson: bytes('{"v":2}') }));

    expect(inode(join(dir, 'assets', 'ok.txt'))).not.toBe(before);
    expect(readFileSync(join(dir, 'assets', 'ok.txt'), 'utf8')).toBe('ok');
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'assets', 'ok.txt')).mode & 0o777).toBe(0o600);
    }
  });

  // Tryby to pojecie POSIX (ADR 0018): plik 0644 nie jest wspoldzielony, tylko zapisany od nowa jako 0600.
  posixOnly('plik o trybie innym niz 0600 nie jest dowiazywany, wraca jako 0600', async () => {
    const { service, itemDir } = setup();
    const { item } = await service.create(draft({ assets: [asset('a.txt', 'A')] }));
    const path = join(itemDir(item.id), 'assets', 'a.txt');
    chmodSync(path, 0o644);

    await service.update(item.id, draft({ assets: [asset('a.txt', 'A')], body: 'inne\n' }));

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('AtomicWriteError: reason i failureCode z jednego mapowania', () => {
  const cases: [string, NodeJS.Platform, string, string][] = [
    ['EACCES', 'linux', 'permission-denied', 'permission-denied'],
    ['EROFS', 'linux', 'read-only', 'permission-denied'],
    ['EPERM', 'win32', 'busy', 'busy'],
    ['EBUSY', 'linux', 'busy', 'busy'],
    ['ENOSPC', 'linux', 'no-space', 'no-space'],
    ['ENOENT', 'linux', 'missing-directory', 'unknown'],
    ['ELOOP', 'linux', 'io', 'symlink'],
    ['EIO', 'linux', 'io', 'unknown'],
  ];
  for (const [code, platform, reason, failureCode] of cases) {
    it(`${code} na ${platform}: reason=${reason}, failureCode=${failureCode}`, async () => {
      const dir = createTempTree('acme-atomic-');
      const error = await writeFileAtomic(join(dir, 'acme.txt'), bytes('x'), {
        ops: {
          platform,
          sleep: () => Promise.resolve(),
          rename: () => Promise.reject(errno(code)),
        },
      }).catch((e: unknown) => e);

      expect(error).toMatchObject({ name: 'AtomicWriteError', reason, failureCode });
    });
  }
});

describe('item.json, ktory nie jest plikiem, w cudzym elemencie (not-a-file)', () => {
  const FOREIGN = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

  async function scenario(ctx: TestContext, makeEntry: (path: string) => boolean) {
    const { store, service, itemDir } = setup();
    await store.write(FOREIGN, files());
    const jsonPath = join(itemDir(FOREIGN), 'item.json');
    rmSync(jsonPath);
    if (!makeEntry(jsonPath)) {
      ctx.skip('nie da sie utworzyc wpisu tego typu');
      return;
    }

    // Cudzy, nieczytelny element nie blokuje zapisu innego i jest widoczny jako problem.
    const created = await service.create(draft({ slug: 'acme-inny' }));
    expect(created.item.identity.slug).toBe('acme-inny');
    const list = await service.list();
    expect(list.items.map((i) => i.id)).toEqual([created.item.id]);
    expect(list.problems.map((p) => p.id)).toContain(FOREIGN);
    await expect(store.readItemJson(FOREIGN)).rejects.toMatchObject({ failureCode: 'not-a-file' });
  }

  it('item.json jako katalog', async (ctx) => {
    await scenario(ctx, (path) => {
      mkdirSync(path);
      return true;
    });
  });

  // mkfifo istnieje tylko na POSIX; na Windowsie nie ma plikow FIFO.
  posixOnly('item.json jako FIFO', async (ctx) => {
    await scenario(ctx, (path) => spawnSync('mkfifo', [path]).status === 0);
  });
});
