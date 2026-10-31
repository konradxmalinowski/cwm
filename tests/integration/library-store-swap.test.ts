import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createUlidGenerator } from '../../src/core/ports/id-generator';
import type { StoredItemFiles } from '../../src/core/ports/library-store';
import { LibraryService } from '../../src/core/services/library/library-service';
import type { AtomicOps } from '../../src/infra/fs/atomic';
import { parseSideDirName, sideDirName } from '../../src/infra/library/item-swap';
import { FsLibraryStore, type FsLibraryStoreOptions } from '../../src/infra/library/library-store';
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
const text = (data: Uint8Array | undefined) => Buffer.from(data ?? []).toString('utf8');
const errno = (code: string) => Object.assign(new Error(code), { code });

function version(body: string, extra: Record<string, string> = {}): StoredItemFiles {
  return {
    itemJson: bytes(`{"body":"${body}"}`),
    body: bytes(body),
    assets: Object.entries(extra).map(([relPath, content]) => ({
      relPath,
      bytes: bytes(content),
    })),
    snapshotFiles: [],
  };
}

function setup(options: FsLibraryStoreOptions = {}) {
  const root = createTempTree('acme-swap-');
  const itemsDir = join(root, 'library', 'items');
  const store = new FsLibraryStore(join(root, 'library'), options);
  return { root, itemsDir, store, itemDir: join(itemsDir, ID) };
}

let planted = 0;

/** Stan po zabiciu procesu: katalog pomocniczy z podana zawartoscia obok `items/<id>`. */
async function plantSideDir(
  root: string,
  kind: 'work' | 'ready' | 'old',
  files: StoredItemFiles,
  suffix = '0a1b2c3d4e5f',
): Promise<string> {
  planted++;
  const scratchLibrary = join(root, `scratch-${planted}`);
  await new FsLibraryStore(scratchLibrary).write(ID, files);
  const itemsDir = join(root, 'library', 'items');
  mkdirSync(itemsDir, { recursive: true });
  const to = join(itemsDir, sideDirName(ID, kind, suffix));
  renameSync(join(scratchLibrary, 'items', ID), to);
  return to;
}

describe('format nazw katalogow pomocniczych', () => {
  it('zawiera id, odroznia roboczy od odsunietego i nie jest poprawnym ULID', () => {
    const work = sideDirName(ID, 'work', '0a1b2c3d4e5f');
    const old = sideDirName(ID, 'old', '0a1b2c3d4e5f');
    const ready = sideDirName(ID, 'ready', '0a1b2c3d4e5f');
    expect(parseSideDirName(ready)).toEqual({ id: ID, kind: 'ready' });
    expect(parseSideDirName(work)).toEqual({ id: ID, kind: 'work' });
    expect(parseSideDirName(old)).toEqual({ id: ID, kind: 'old' });
    expect(work.startsWith('.')).toBe(true);
    for (const name of [
      ID,
      'acme-obcy-katalog',
      '.DS_Store',
      `.${ID}.work.x.0a1b2c3d4e5f`,
      `${ID}.work.1.0a1b2c3d4e5f`,
    ]) {
      expect(parseSideDirName(name), name).toBeNull();
    }
  });

  it('list() pomija katalogi pomocnicze, a serwis nie widzi ich w problems', async () => {
    const root = createTempTree('acme-swap-');
    const clock = new FakeClock();
    const service = new LibraryService({
      store: new FsLibraryStore(join(root, 'library')),
      objects: new FsObjectStore(join(root, 'objects')),
      log: new MemoryOperationLog(),
      ids: createUlidGenerator(clock, deterministicRandom()),
      clock,
    });
    const { item } = await service.create(draft());
    const itemsDir = join(root, 'library', 'items');
    mkdirSync(join(itemsDir, sideDirName(item.id, 'work', 'aaaaaaaaaaaa')));
    mkdirSync(join(itemsDir, sideDirName(item.id, 'old', 'bbbbbbbbbbbb')));

    const list = await service.list();

    expect(list.items.map((i) => i.id)).toEqual([item.id]);
    expect(list.problems).toEqual([]);
    expect(list.inconsistent).toEqual([]);
  });
});

describe('zapis przez katalog roboczy: awarie w kazdym punkcie', () => {
  /** Rename zawodzi dla wywolan spelniajacych warunek; reszta idzie do systemu. */
  function failing(
    when: (from: string, to: string, call: number) => boolean,
    code = 'EIO',
  ): Partial<AtomicOps> {
    let call = 0;
    return {
      rename: async (from, to) => {
        call++;
        if (when(from, to, call)) throw errno(code);
        await rename(from, to);
      },
    };
  }

  it('po zbudowaniu roboczego, przed odsunieciem starego: stary element, brak katalogow roboczych', async () => {
    const { store, itemsDir } = setup({ atomicOps: failing((_from, to) => to.includes('.old.')) });
    await store.write(ID, version('v1'));

    await expect(store.write(ID, version('v2'))).rejects.toMatchObject({ failureCode: 'unknown' });

    expect(text((await store.read(ID))?.body)).toBe('v1');
    expect(readdirSync(itemsDir)).toEqual([ID]);
  });

  it('po odsunieciu starego, przed wejsciem nowego, z udanym cofnieciem: stary element, brak smieci', async () => {
    let armed = false;
    const { store, itemsDir } = setup({
      atomicOps: failing((from) => armed && from.includes('.work.')),
    });
    await store.write(ID, version('v1'));
    armed = true;

    await expect(store.write(ID, version('v2'))).rejects.toBeInstanceOf(Error);

    expect(text((await store.read(ID))?.body)).toBe('v1');
    expect(readdirSync(itemsDir)).toEqual([ID]);
  });

  it('obie awarie (wejscie nowego i cofniecie): zapis zgloszony jako nieudany nie zostaje zatwierdzony, wraca stary', async () => {
    // Rename nr 1 (work na ready) i nr 2 (stary na bok) przechodza, wszystkie dalsze zawodza:
    // stan jak po zabiciu procesu miedzy dwoma renameami, z nieudanym cofnieciem.
    const { root, itemsDir, store } = setup();
    await store.write(ID, version('v1'));
    const failing = new FsLibraryStore(join(root, 'library'), {
      atomicOps: {
        rename: (() => {
          let call = 0;
          return async (from: string, to: string) => {
            call++;
            if (call > 2) throw errno('EIO');
            await rename(from, to);
          };
        })(),
      },
    });

    await expect(failing.write(ID, version('v2'))).rejects.toBeInstanceOf(Error);

    // Katalog `ready` zostal usuniety zanim blad wyszedl, wiec nie ma czego promowac.
    const names = readdirSync(itemsDir);
    expect(names.some((n) => parseSideDirName(n)?.kind === 'ready')).toBe(false);
    expect(names).not.toContain(ID);
    const fresh = new FsLibraryStore(join(root, 'library'));
    expect(text((await fresh.read(ID))?.body)).toBe('v1');
    expect(readdirSync(itemsDir)).toEqual([ID]);
  });

  it('obie awarie, gdy nie da sie ani usunac, ani cofnac: katalog traci oznaczenie ready (wraca do work)', async () => {
    const { root, itemsDir, store } = setup();
    await store.write(ID, version('v1'));
    let call = 0;
    const failing = new FsLibraryStore(join(root, 'library'), {
      removeTree: (path) =>
        parseSideDirName(path.split(/[\\/]/).pop() ?? '')?.kind === 'ready'
          ? Promise.reject(errno('EBUSY'))
          : Promise.resolve(rmSync(path, { recursive: true, force: true })),
      atomicOps: {
        rename: async (from, to) => {
          call++;
          // 1: work na ready, 2: stary na bok, 3: ready na miejsce (zawodzi), 4: cofniecie (zawodzi),
          // 5: odebranie oznaczenia ready (przechodzi).
          if (call === 3 || call === 4) throw errno('EIO');
          await rename(from, to);
        },
      },
    });

    await expect(failing.write(ID, version('v2'))).rejects.toBeInstanceOf(Error);

    const names = readdirSync(itemsDir).map((n) => parseSideDirName(n)?.kind);
    expect(names).not.toContain('ready');
    const fresh = new FsLibraryStore(join(root, 'library'));
    expect(text((await fresh.read(ID))?.body)).toBe('v1');
  });

  it('po wejsciu nowego, przed usunieciem starego: zapis udany, odsuniety zostaje i znika przy nastepnym zapisie', async () => {
    let failRemove = true;
    const { store, itemsDir } = setup({
      removeTree: (path) => {
        const name = path.split(/[\\/]/).pop() ?? '';
        if (failRemove && parseSideDirName(name)?.kind === 'old') {
          return Promise.reject(errno('EBUSY'));
        }
        rmSync(path, { recursive: true, force: true });
        return Promise.resolve();
      },
    });
    await store.write(ID, version('v1'));

    await expect(store.write(ID, version('v2'))).resolves.toBeUndefined();

    expect(text((await store.read(ID))?.body)).toBe('v2');
    expect(readdirSync(itemsDir).filter((n) => parseSideDirName(n)?.kind === 'old')).toHaveLength(
      1,
    );
    expect(await store.list()).toEqual([ID]);

    failRemove = false;
    await store.write(ID, version('v3'));
    expect(readdirSync(itemsDir)).toEqual([ID]);
  });

  it('odsuniety po udanej zamianie znika tez przy list() i przy remove()', async () => {
    const { root, itemsDir, store } = setup();
    await store.write(ID, version('v1'));
    await plantSideDir(root, 'old', version('v0'));

    expect(await store.list()).toEqual([ID]);
    expect(readdirSync(itemsDir)).toEqual([ID]);

    await plantSideDir(root, 'old', version('v0'), 'cccccccccccc');
    await store.remove(ID);
    expect(readdirSync(itemsDir)).toEqual([]);
    expect(await store.read(ID)).toBeNull();
  });
});

describe('odzyskanie po przerwaniu: stan zbudowany recznie', () => {
  it('porzucony katalog roboczy przy istniejacym elemencie jest usuwany, element zostaje', async () => {
    const { root, itemsDir, store } = setup();
    await store.write(ID, version('v1'));
    await plantSideDir(root, 'work', version('v2'));

    expect(text((await store.read(ID))?.body)).toBe('v1');
    expect(await store.list()).toEqual([ID]);
    expect(readdirSync(itemsDir)).toEqual([ID]);
  });

  it('brak elementu, ready i odsuniety: wchodzi ready (nowy stan)', async () => {
    const { root, itemsDir, store } = setup();
    await plantSideDir(root, 'old', version('stary'));
    await plantSideDir(root, 'ready', version('nowy'), 'dddddddddddd');

    expect(text((await store.read(ID))?.body)).toBe('nowy');
    expect(readdirSync(itemsDir)).toEqual([ID]);
  });

  it('brak elementu, work z pustym item.json (przerwany zapis pliku): nie jest promowany, wraca odsuniety', async () => {
    const { root, itemsDir, store } = setup();
    await plantSideDir(root, 'old', version('stary'));
    const work = await plantSideDir(root, 'work', version('polowiczny'), 'dddddddddddd');
    writeFileSync(join(work, 'item.json'), '');

    expect(text((await store.read(ID))?.body)).toBe('stary');
    expect(readdirSync(itemsDir)).toEqual([ID]);
  });

  it('brak elementu i tylko odsuniety: wraca odsuniety', async () => {
    const { root, store } = setup();
    await plantSideDir(root, 'old', version('stary'));

    expect(text((await store.read(ID))?.body)).toBe('stary');
  });

  it('naprawa przy kazdym rodzaju odczytu: read, readItemJson, readSalvage, list i write', async () => {
    const readers: Record<string, [(store: FsLibraryStore) => Promise<unknown>, unknown]> = {
      read: [async (s) => text((await s.read(ID))?.body), 'nowy'],
      readItemJson: [async (s) => text((await s.readItemJson(ID)) ?? undefined), '{"body":"nowy"}'],
      readSalvage: [
        async (s) =>
          text((await s.readSalvage(ID))?.entries.find((e) => e.relPath === 'body.md')?.bytes),
        'nowy',
      ],
      list: [async (s) => (await s.list()).join(','), ID],
      write: [
        async (s) => {
          await s.write(ID, version('po-zapisie'));
          return text((await s.read(ID))?.body);
        },
        'po-zapisie',
      ],
    };
    for (const [name, [run, expected]] of Object.entries(readers)) {
      const { root, itemsDir, store } = setup();
      await plantSideDir(root, 'old', version('stary'));
      await plantSideDir(root, 'ready', version('nowy'), 'dddddddddddd');

      expect(await run(store), name).toBe(expected);
      expect(readdirSync(itemsDir), name).toEqual([ID]);
    }
  });

  it('readSalvage obejmuje pliki o nazwie jak tymczasowa, ktore remove i tak usunie', async () => {
    const { store, itemDir } = setup();
    await store.write(ID, version('v1', { 'a.txt': 'A' }));
    writeFileSync(join(itemDir, 'assets', '.a.txt.4242.0a1b2c3d4e5f.tmp'), 'resztka');

    const salvage = await store.readSalvage(ID);

    expect(salvage?.entries.map((e) => e.relPath)).toContain('assets/.a.txt.4242.0a1b2c3d4e5f.tmp');
  });
});

describe('Windows: ponowienia rename katalogu i blad busy', () => {
  it('przeczekuje chwilowe EPERM przy zamianie katalogow', async () => {
    let failures = 3;
    const sleeps: number[] = [];
    const { store } = setup({
      atomicOps: {
        platform: 'win32',
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        rename: async (from, to) => {
          if (failures > 0) {
            failures--;
            throw errno('EPERM');
          }
          await rename(from, to);
        },
      },
    });
    await store.write(ID, version('v1'));
    expect(sleeps).toEqual([25, 50, 100]);
    expect(text((await store.read(ID))?.body)).toBe('v1');
  });

  it('po wyczerpaniu prob: blad busy, stary stan na miejscu, brak katalogow roboczych', async () => {
    let block = false;
    const { store, itemsDir } = setup({
      atomicOps: {
        platform: 'win32',
        sleep: () => Promise.resolve(),
        rename: async (from, to) => {
          if (block) throw errno('EBUSY');
          await rename(from, to);
        },
      },
    });
    await store.write(ID, version('v1'));
    block = true;

    await expect(store.write(ID, version('v2'))).rejects.toMatchObject({ failureCode: 'busy' });
    block = false;

    expect(text((await store.read(ID))?.body)).toBe('v1');
    expect(readdirSync(itemsDir)).toEqual([ID]);
  });

  it('EPERM przy rename katalogu to busy tylko na win32; na POSIX permission-denied', async () => {
    const make = (platform: NodeJS.Platform) =>
      setup({
        atomicOps: {
          platform,
          sleep: () => Promise.resolve(),
          rename: () => Promise.reject(errno('EPERM')),
        },
      });
    await expect(make('win32').store.write(ID, version('v1'))).rejects.toMatchObject({
      failureCode: 'busy',
    });
    await expect(make('linux').store.write(ID, version('v1'))).rejects.toMatchObject({
      failureCode: 'permission-denied',
    });
  });
});

describe('katalog roboczy jest budowany od zera', () => {
  // Tryby to pojecie POSIX (ADR 0018); na Windowsie nie udajemy chmod.
  it.skipIf(process.platform === 'win32')(
    'katalogi 0700 i pliki 0600, takze zagniezdzone',
    async () => {
      const { store, itemDir } = setup();
      await store.write(ID, version('v1', { 'a/b/c.txt': 'x' }));
      await store.write(ID, version('v2', { 'a/b/c.txt': 'x' }));

      for (const dir of [itemDir, join(itemDir, 'assets'), join(itemDir, 'assets/a/b')]) {
        expect(statSync(dir).mode & 0o777, dir).toBe(0o700);
      }
      for (const file of ['item.json', 'body.md', 'assets/a/b/c.txt']) {
        expect(statSync(join(itemDir, file)).mode & 0o777, file).toBe(0o600);
      }
    },
  );

  it('plik na katalog, katalog na plik i zmiana wielkosci liter nie zostawiaja sladow starego stanu', async () => {
    const { store, itemDir } = setup();
    await store.write(ID, version('v1', { a: 'plik', 'Ref.md': 'r' }));
    await store.write(ID, version('v2', { 'a/b.txt': 'w katalogu', 'ref.md': 'r' }));

    expect(readdirSync(join(itemDir, 'assets')).sort()).toEqual(['a', 'ref.md']);
    await store.write(ID, version('v3', { a: 'znowu plik' }));
    expect(readFileSync(join(itemDir, 'assets', 'a'), 'utf8')).toBe('znowu plik');
    expect(readdirSync(join(itemDir, '..'))).toEqual([ID]);
    expect(existsSync(itemDir)).toBe(true);
  });
});

describe('przerwanie w trakcie zapisu item.json nie promuje katalogu roboczego', () => {
  /** Zapis, ktory pada po utworzeniu pustego pliku, czyli stan widziany po zabiciu procesu w trakcie `item.json`. */
  const partialItemJson: FsLibraryStoreOptions['writeNew'] = async (path, content) => {
    const { writeFile } = await import('node:fs/promises');
    if (path.endsWith('item.json')) {
      await writeFile(path, '');
      throw errno('EIO');
    }
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  };

  it('create: blad, brak elementu i brak katalogow pomocniczych', async () => {
    const { store, itemsDir } = setup({ writeNew: partialItemJson });

    await expect(store.write(ID, version('v1'))).rejects.toBeInstanceOf(Error);

    expect(await store.read(ID)).toBeNull();
    expect(readdirSync(itemsDir)).toEqual([]);
  });

  it('update: blad, zostaje caly stary element', async () => {
    const root = createTempTree('acme-swap-');
    await new FsLibraryStore(join(root, 'library')).write(ID, version('v1'));
    const store = new FsLibraryStore(join(root, 'library'), { writeNew: partialItemJson });

    await expect(store.write(ID, version('v2'))).rejects.toBeInstanceOf(Error);

    expect(text((await store.read(ID))?.body)).toBe('v1');
    expect(text((await store.readItemJson(ID)) ?? undefined)).toBe('{"body":"v1"}');
    expect(readdirSync(join(root, 'library', 'items'))).toEqual([ID]);
  });

  it('zabity proces przy create: work z pustym item.json zostaje, ale odczyt go nie promuje i sprzata', async () => {
    const { root, itemsDir, store } = setup();
    const work = await plantSideDir(root, 'work', version('v1'));
    writeFileSync(join(work, 'item.json'), '');

    expect(await store.read(ID)).toBeNull();
    expect(readdirSync(itemsDir)).toEqual([]);
  });

  it('zabity proces przy update: stary element przy porzuconym work z pustym item.json', async () => {
    const { root, itemsDir, store } = setup();
    await store.write(ID, version('v1'));
    const work = await plantSideDir(root, 'work', version('v2'));
    writeFileSync(join(work, 'item.json'), '');

    expect(text((await store.read(ID))?.body)).toBe('v1');
    expect(await store.list()).toEqual([ID]);
    expect(readdirSync(itemsDir)).toEqual([ID]);
  });
});

describe('blad przy probie wspoldzielenia pliku nie przerywa zapisu', () => {
  it('odczyt starego pliku konczy sie EACCES, ENOENT albo ELOOP: nowe bajty sa zapisane zwyklym zapisem', async () => {
    for (const code of ['EACCES', 'ENOENT', 'ELOOP']) {
      const { store, itemDir } = setup({ readExisting: () => Promise.reject(errno(code)) });
      await store.write(ID, version('v1', { 'a.txt': 'A' }));

      await store.write(ID, version('v2', { 'a.txt': 'A' }));

      expect(readFileSync(join(itemDir, 'assets', 'a.txt'), 'utf8'), code).toBe('A');
      expect(text((await store.read(ID))?.body), code).toBe('v2');
    }
  });
});

describe('odczyt czeka na trwajaca zamiane tego samego elementu', () => {
  it('read, readItemJson i readSalvage rownolegle do zapisu oddaja kompletny nowy stan; inne elementy nie czekaja', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = false;
    let reached: () => void = () => undefined;
    const atSwap = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { store } = setup({
      atomicOps: {
        rename: async (from, to) => {
          // Zatrzymanie miedzy odsunieciem starego a wejsciem nowego: `items/<id>` nie ma.
          if (armed && parseSideDirName(to.split(/[\\/]/).pop() ?? '')?.kind === 'old') {
            await rename(from, to);
            reached();
            await gate;
            return;
          }
          await rename(from, to);
        },
      },
    });
    const other = '01ARZ3NDEKTSV4RRFFQ69G5FAY';
    await store.write(ID, version('v1'));
    await store.write(other, version('inny'));
    armed = true;

    const writing = store.write(ID, version('v2'));
    await atSwap;
    const pending = ['read', 'readItemJson', 'readSalvage'].map((name) => {
      if (name === 'read') return store.read(ID).then((r) => text(r?.body));
      if (name === 'readItemJson') return store.readItemJson(ID).then((r) => text(r ?? undefined));
      return store
        .readSalvage(ID)
        .then((r) => text(r?.entries.find((e) => e.relPath === 'body.md')?.bytes));
    });
    let settled = false;
    void Promise.all(pending).then(() => {
      settled = true;
    });

    // Odczyt innego elementu nie stoi na zamianie.
    expect(text((await store.read(other))?.body)).toBe('inny');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    release();
    await writing;
    expect(await Promise.all(pending)).toEqual(['v2', '{"body":"v2"}', 'v2']);
  });
});

describe('klasyfikacja bledow magazynu (failureCode)', () => {
  it('path-conflict to not-a-file, a bledy walidacji sciezek to invalid-path', async () => {
    const { store } = setup();
    const rejected = async (files: StoredItemFiles) =>
      store.write(ID, files).then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(await rejected(version('v', { a: '1', 'a/b': '2' }))).toMatchObject({
      reason: 'path-conflict',
      failureCode: 'not-a-file',
    });
    expect(await rejected(version('v', { '../x': '1' }))).toMatchObject({
      reason: 'path-escape',
      failureCode: 'invalid-path',
    });
    expect(await rejected(version('v', { 'CON.txt': '1' }))).toMatchObject({
      reason: 'invalid-name',
      failureCode: 'invalid-path',
    });
  });
});

describe('sprzatanie plikow tymczasowych w objects/ raz na katalog', () => {
  it('drugi put do tego samego katalogu <aa> nie skanuje go ponownie', async () => {
    const root = createTempTree('acme-sweep-');
    const objects = new FsObjectStore(join(root, 'objects'));
    const { sha256Bytes } = await import('../../src/core/services/normalization/hash');

    const first = await objects.put(bytes('pierwszy'));
    const shard = join(root, 'objects', first.slice(0, 2));
    // Szukamy tresci z tym samym prefiksem hasha, zeby trafic w ten sam katalog.
    let second = '';
    for (let i = 0; second === ''; i++) {
      if (sha256Bytes(bytes(`drugi-${i}`)).startsWith(first.slice(0, 2))) second = `drugi-${i}`;
    }
    const stale = join(shard, `.${first}.4242.0a1b2c3d4e5f.tmp`);
    writeFileSync(stale, 'resztka');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(stale, longAgo, longAgo);

    await objects.put(bytes(second));

    expect(existsSync(stale)).toBe(true);
  });
});
