import { mkdirSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it, type TestContext } from 'vitest';

import type { Sha256 } from '../../src/core/model/item';
import { sha256Bytes } from '../../src/core/services/normalization/hash';
import { AtomicWriteError, type AtomicOps } from '../../src/infra/fs/atomic';
import { FsObjectStore, ObjectStoreError } from '../../src/infra/store/object-store';
import { createTempTree, removeTempTrees } from '../harness/isolation';

afterAll(() => {
  removeTempTrees();
});

const bytes = (s: string) => new TextEncoder().encode(s);
const posixOnly = it.skipIf(process.platform === 'win32');

function setup() {
  const dir = join(createTempTree('acme-objects-'), 'objects');
  return { dir, store: new FsObjectStore(dir) };
}

function pathOf(dir: string, hash: string): string {
  return join(dir, hash.slice(0, 2), hash);
}

describe('content store na dysku (ADR 0019, 0027)', () => {
  it('put zapisuje pod objects/<aa>/<sha256> i get zwraca te same bajty', async () => {
    const { dir, store } = setup();
    const content = bytes('acme: tresc wersji');

    const hash = await store.put(content);

    expect(hash).toBe(sha256Bytes(content));
    expect(readdirSync(join(dir, hash.slice(0, 2)))).toEqual([hash]);
    expect(await store.get(hash)).toEqual(content);
    expect(await store.has(hash)).toBe(true);
  });

  it('put jest idempotentny: istniejacy obiekt nie jest przepisywany', async () => {
    const { dir, store } = setup();
    const content = bytes('acme: ta sama tresc');

    const hash = await store.put(content);
    const before = statSync(pathOf(dir, hash), { bigint: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.put(content)).toBe(hash);
    const after = statSync(pathOf(dir, hash), { bigint: true });

    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  it('identyczne bajty z roznych wywolan to jeden plik', async () => {
    const { dir, store } = setup();
    const a = await store.put(bytes('acme'));
    const b = await store.put(Uint8Array.from(bytes('acme')));
    await store.put(bytes('acme-inne'));

    expect(a).toBe(b);
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) =>
      e.isFile(),
    );
    expect(files).toHaveLength(2);
  });

  it('get nieistniejacego obiektu daje null, has daje false', async () => {
    const { store } = setup();
    const missing = sha256Bytes(bytes('nie ma mnie'));
    expect(await store.get(missing)).toBeNull();
    expect(await store.has(missing)).toBe(false);
  });

  it('uszkodzony obiekt to blad, nie cicha zla tresc', async () => {
    const { dir, store } = setup();
    const hash = await store.put(bytes('oryginal'));
    writeFileSync(pathOf(dir, hash), 'podmieniona tresc');

    await expect(store.get(hash)).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(store.get(hash)).rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('put naprawia uszkodzony obiekt, bo zna wlasciwa tresc', async () => {
    const { dir, store } = setup();
    const content = bytes('oryginal');
    const hash = await store.put(content);
    writeFileSync(pathOf(dir, hash), 'podmieniona tresc');

    await store.put(content);
    expect(await store.get(hash)).toEqual(content);
  });

  it('hash niebedacy 64 znakami hex nie dociera do sciezki', async () => {
    const { store } = setup();
    for (const bad of ['', '../../etc/passwd', 'ab', `${'A'.repeat(64)}`, `${'a'.repeat(63)}/`]) {
      await expect(store.get(bad as Sha256)).rejects.toMatchObject({ reason: 'invalid-hash' });
      await expect(store.has(bad as Sha256)).rejects.toMatchObject({ reason: 'invalid-hash' });
    }
  });

  // Tryby to pojecie POSIX; na Windowsie nie udajemy chmod (ADR 0018).
  posixOnly('katalogi maja 0700, pliki 0600 od utworzenia', async () => {
    const { dir, store } = setup();
    const hash = await store.put(bytes('acme'));

    expect(statSync(join(dir, hash.slice(0, 2))).mode & 0o777).toBe(0o700);
    expect(statSync(pathOf(dir, hash)).mode & 0o777).toBe(0o600);
  });
});

describe('content store: dowiazania i typ wpisu (SEC-006)', () => {
  function tryLink(ctx: TestContext, target: string, path: string): boolean {
    try {
      symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch {
      ctx.skip('system nie pozwala utworzyc dowiazania symbolicznego');
      return false;
    }
  }

  it('katalog <aa> jako dowiazanie: put, get i has odrzucaja, nic nie trafia poza store', async (ctx) => {
    const { dir, store } = setup();
    const hash = sha256Bytes(bytes('acme'));
    const outside = join(createTempTree('acme-poza-'), 'cel');
    mkdirSync(outside);
    mkdirSync(dir, { recursive: true });
    if (!tryLink(ctx, outside, join(dir, hash.slice(0, 2)))) return;

    await expect(store.put(bytes('acme'))).rejects.toMatchObject({ reason: 'symlink' });
    await expect(store.get(hash)).rejects.toMatchObject({ reason: 'symlink' });
    await expect(store.has(hash)).rejects.toMatchObject({ reason: 'symlink' });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('plik obiektu jako dowiazanie: get i has odrzucaja, put nie pisze przez nie', async (ctx) => {
    const { dir, store } = setup();
    const hash = await store.put(bytes('acme'));
    const decoy = join(createTempTree('acme-poza-'), 'cudzy.txt');
    writeFileSync(decoy, 'cudzy plik');
    renameSync(join(dir, hash.slice(0, 2), hash), join(dir, 'odsuniety'));
    try {
      symlinkSync(decoy, join(dir, hash.slice(0, 2), hash), 'file');
    } catch {
      ctx.skip('system nie pozwala utworzyc dowiazania symbolicznego');
      return;
    }

    await expect(store.get(hash)).rejects.toMatchObject({ reason: 'symlink' });
    await expect(store.has(hash)).rejects.toMatchObject({ reason: 'symlink' });
    await expect(store.put(bytes('acme'))).rejects.toMatchObject({ reason: 'symlink' });
  });

  it('has zwraca false dla katalogu pod hashem i true dla zwyklego pliku', async () => {
    const { dir, store } = setup();
    const hash = sha256Bytes(bytes('acme'));
    mkdirSync(join(dir, hash.slice(0, 2), hash), { recursive: true });
    expect(await store.has(hash)).toBe(false);
    await expect(store.get(hash)).rejects.toMatchObject({ reason: 'not-regular-file' });
  });

  it('has nie weryfikuje tresci: uszkodzony obiekt nadal "istnieje", get go odrzuca', async () => {
    const { dir, store } = setup();
    const hash = await store.put(bytes('acme'));
    writeFileSync(join(dir, hash.slice(0, 2), hash), 'podmieniona');
    expect(await store.has(hash)).toBe(true);
    await expect(store.get(hash)).rejects.toMatchObject({ reason: 'corrupt' });
  });
});

describe('content store: awaria zapisu nie zostawia pliku tymczasowego z trescia (SEC-010)', () => {
  const failing = (code: string) => () => Promise.reject(Object.assign(new Error(code), { code }));

  it('awaria rename, odczytu kontrolnego i zapisu: w objects/ nie zostaje nic oprocz poprzednich obiektow', async () => {
    const dir = join(createTempTree('acme-objects-'), 'objects');
    const survivor = await new FsObjectStore(dir).put(bytes('poprzedni'));

    const cases: Partial<AtomicOps>[] = [
      { rename: failing('EIO') },
      { rename: failing('ENOSPC') },
      { readFile: () => Promise.resolve(bytes('inne bajty')) },
    ];
    for (const atomicOps of cases) {
      const store = new FsObjectStore(dir, { atomicOps });
      await expect(store.put(bytes('sekret ze snapshotu'))).rejects.toBeInstanceOf(
        AtomicWriteError,
      );
    }

    const left = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    expect(left).toEqual([survivor]);
  });
});
