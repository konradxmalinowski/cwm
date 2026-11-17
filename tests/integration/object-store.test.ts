import { mkdirSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it, type TestContext } from 'vitest';

import type { Sha256 } from '../../src/core/model/item';
import { NO_RETENTION_LIMITS, type RetentionSettings } from '../../src/core/model/retention';
import type { BackupManifestView } from '../../src/core/ports/backup-reader';
import type { OperationRecord } from '../../src/core/ports/operation-log';
import type {
  ObjectInventory,
  RetentionLog,
  RetentionLogRow,
} from '../../src/core/ports/retention';
import {
  groupLogRows,
  planRetention,
  type RetentionGroup,
} from '../../src/core/services/retention/retention-plan';
import { RetentionService } from '../../src/core/services/retention/retention-service';
import { sha256Bytes } from '../../src/core/services/normalization/hash';
import { AtomicWriteError, type AtomicOps } from '../../src/infra/fs/atomic';
import { FsObjectInventory } from '../../src/infra/store/object-inventory';
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

describe('spis i usuwanie obiektow (FsObjectInventory, ADR 0056)', () => {
  it('spis niesie rozmiary, pomija pliki tymczasowe i liczy obce wpisy jako pominiete', async () => {
    const { dir, store } = setup();
    const a = await store.put(bytes('acme-a'));
    const b = await store.put(bytes('acme-bb'));
    writeFileSync(join(dir, a.slice(0, 2), 'notes.txt'), 'x');
    writeFileSync(join(dir, a.slice(0, 2), '.x.123.abcdef.tmp'), 'x');
    mkdirSync(join(dir, 'zz'));

    const listing = await new FsObjectInventory(dir).list();

    expect(listing.objects.get(a)).toBe(6);
    expect(listing.objects.get(b)).toBe(7);
    expect(listing.objects.size).toBe(2);
    expect(listing.skipped).toBe(2);
  });

  it('brak katalogu store to pusty spis', async () => {
    const dir = join(createTempTree('acme-objects-'), 'objects');
    const listing = await new FsObjectInventory(dir).list();
    expect(listing.objects.size).toBe(0);
    expect(listing.skipped).toBe(0);
  });

  it('remove usuwa tylko wskazany plik, a powtorzenie daje false', async () => {
    const { dir, store } = setup();
    const keep = await store.put(bytes('acme-zostaje'));
    const drop = await store.put(bytes('acme-znika'));
    const inventory = new FsObjectInventory(dir);

    expect(await inventory.remove(drop)).toBe(true);
    expect(await inventory.remove(drop)).toBe(false);
    expect(await store.has(drop)).toBe(false);
    expect(await store.has(keep)).toBe(true);
  });

  it('remove odrzuca hash o zlej formie', async () => {
    const { dir } = setup();
    await expect(new FsObjectInventory(dir).remove('../x' as Sha256)).rejects.toMatchObject({
      reason: 'invalid-hash',
    });
  });

  posixOnly(
    'dowiazanie pod nazwa hasha nie jest obiektem: spis je pomija, remove odmawia',
    async () => {
      const { dir, store } = setup();
      const real = await store.put(bytes('acme-prawdziwy'));
      const decoy = join(createTempTree('acme-poza-'), 'cudzy.txt');
      writeFileSync(decoy, 'cudzy plik');
      const linkHash = `${real.slice(0, 2)}${'0'.repeat(62)}` as Sha256;
      symlinkSync(decoy, join(dir, real.slice(0, 2), linkHash), 'file');
      const inventory = new FsObjectInventory(dir);

      const listing = await inventory.list();
      expect([...listing.objects.keys()]).toEqual([real]);
      expect(listing.skipped).toBe(1);
      await expect(inventory.remove(linkHash)).rejects.toMatchObject({ reason: 'symlink' });
      expect(readdirSync(join(decoy, '..'))).toEqual(['cudzy.txt']);
    },
  );

  posixOnly('katalog <aa> jako dowiazanie nie jest przechodzony ani czyszczony', async () => {
    const { dir } = setup();
    const outside = join(createTempTree('acme-poza-'), 'cel');
    mkdirSync(outside);
    const victim = 'a'.repeat(64) as Sha256;
    writeFileSync(join(outside, victim), 'nie ruszaj');
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, 'aa'), 'dir');
    const inventory = new FsObjectInventory(dir);

    const listing = await inventory.list();
    expect(listing.objects.size).toBe(0);
    expect(listing.skipped).toBe(1);
    await expect(inventory.remove(victim)).rejects.toMatchObject({ reason: 'symlink' });
    expect(readdirSync(outside)).toEqual([victim]);
  });
});

const MIB = 1024 * 1024;
const hashOf = (char: string): Sha256 => char.repeat(64) as Sha256;

function logRow(overrides: Partial<RetentionLogRow> & { seq: number }): RetentionLogRow {
  return {
    operation: 'update',
    at: '2026-11-01T00:00:00.000Z',
    backupId: null,
    reverts: null,
    versionHashes: [],
    ...overrides,
  };
}

function groupsOf(rows: readonly RetentionLogRow[], hashes: Record<string, Sha256[]> = {}) {
  return groupLogRows(rows).map((g): RetentionGroup => ({
    ...g,
    hashes: hashes[g.key] ?? [...g.rootHashes],
  }));
}

const NOW_MS = Date.parse('2026-11-17T12:00:00.000Z');

describe('planRetention: wybor wpisow i obiektow do usuniecia (ADR 0056)', () => {
  it('grupuje wiersze po backup_id tak jak historia, a wiersz bez kopii to osobna grupa', () => {
    const groups = groupLogRows([
      logRow({ seq: 1, operation: 'export', backupId: 'b1' }),
      logRow({ seq: 2, operation: 'sync', backupId: 'b1' }),
      logRow({ seq: 3 }),
    ]);
    expect(groups.map((g) => [g.key, g.seqs, g.revertibleWrite])).toEqual([
      ['backup:b1', [1, 2], true],
      ['seq:3', [3], false],
    ]);
  });

  it('limit liczby wpisow przycina najstarsze, a obiekt wspolny z zachowanym wpisem zostaje', () => {
    const [h1, h2, h3, shared] = [hashOf('1'), hashOf('2'), hashOf('3'), hashOf('4')];
    const groups = groupsOf([logRow({ seq: 1 }), logRow({ seq: 2 }), logRow({ seq: 3 })], {
      'seq:1': [h1, shared],
      'seq:2': [h2],
      'seq:3': [h3, shared],
    });
    const sizes = new Map<Sha256, number>(
      [h1, h2, h3, shared].map((h): [Sha256, number] => [h, 10]),
    );

    const plan = planRetention({
      settings: { ...NO_RETENTION_LIMITS, maxEntries: 2 },
      nowMs: NOW_MS,
      minKeepGroups: 0,
      groups,
      libraryHashes: [],
      objectSizes: sizes,
    });

    expect(plan.pruneKeys).toEqual(['seq:1']);
    expect(plan.pruneSeqs).toEqual([1]);
    expect(plan.sweep).toEqual([h1]);
    expect(plan.bytesToFree).toBe(10);
    expect(plan.bytesBefore).toBe(40);
  });

  it('limit wieku dotyczy wpisow i nie rusza wpisu bez czytelnej daty', () => {
    const groups = groupsOf([
      logRow({ seq: 1, at: '2026-01-01T00:00:00.000Z' }),
      logRow({ seq: 2, at: 'nie-data' }),
      logRow({ seq: 3, at: '2026-11-16T00:00:00.000Z' }),
    ]);
    const plan = planRetention({
      settings: { ...NO_RETENTION_LIMITS, maxAgeDays: 30 },
      nowMs: NOW_MS,
      minKeepGroups: 0,
      groups,
      libraryHashes: [],
      objectSizes: new Map(),
    });
    expect(plan.pruneKeys).toEqual(['seq:1']);
  });

  it('obiekt biblioteki nie jest usuwany nawet wtedy, gdy zaden zachowany wpis do niego nie prowadzi', () => {
    const inLibrary = hashOf('a');
    const orphan = hashOf('b');
    const plan = planRetention({
      settings: NO_RETENTION_LIMITS,
      nowMs: NOW_MS,
      minKeepGroups: 0,
      groups: groupsOf([logRow({ seq: 1 })]),
      libraryHashes: [inLibrary],
      objectSizes: new Map<Sha256, number>([
        [inLibrary, 5],
        [orphan, 7],
      ]),
    });
    expect(plan.sweep).toEqual([orphan]);
    expect(plan.pruneKeys).toEqual([]);
  });

  it('ostatnia operacja do cofniecia jest chroniona przed przycieciem', () => {
    const groups = groupsOf([
      logRow({ seq: 1, operation: 'export', backupId: 'b1' }),
      logRow({ seq: 2 }),
    ]);
    const plan = planRetention({
      settings: { ...NO_RETENTION_LIMITS, maxEntries: 1 },
      nowMs: NOW_MS,
      minKeepGroups: 0,
      groups,
      libraryHashes: [],
      objectSizes: new Map(),
    });
    expect(plan.protectedKeys).toEqual(['backup:b1']);
    expect(plan.pruneKeys).toEqual(['seq:2']);
  });

  it('wpis cofajacy zostaje, dopoki zostaje cofnieta operacja, nawet gdy jest przeterminowany', () => {
    const rows = [
      logRow({ seq: 1, operation: 'export', backupId: 'b1', at: '2026-11-16T00:00:00.000Z' }),
      logRow({
        seq: 2,
        operation: 'rollback',
        backupId: 'b2',
        reverts: 'b1',
        at: '2026-01-01T00:00:00.000Z',
      }),
      logRow({ seq: 3, operation: 'export', backupId: 'b3', at: '2026-11-16T12:00:00.000Z' }),
    ];
    const plan = planRetention({
      settings: { ...NO_RETENTION_LIMITS, maxAgeDays: 30 },
      nowMs: NOW_MS,
      minKeepGroups: 0,
      groups: groupsOf(rows),
      libraryHashes: [],
      objectSizes: new Map(),
    });
    // b3 to ostatni zapis do cofniecia (chroniony), b1 jest swiezy, wiec przeterminowany b2 musi zostac.
    expect(plan.protectedKeys).toEqual(['backup:b3']);
    expect(plan.pruneKeys).toEqual([]);
  });

  it('limit rozmiaru przycina kolejne najstarsze wpisy az do osiagniecia limitu', () => {
    const [h1, h2, h3, lib] = [hashOf('1'), hashOf('2'), hashOf('3'), hashOf('f')];
    const groups = groupsOf([logRow({ seq: 1 }), logRow({ seq: 2 }), logRow({ seq: 3 })], {
      'seq:1': [h1],
      'seq:2': [h2],
      'seq:3': [h3],
    });
    const sizes = new Map<Sha256, number>([h1, h2, h3, lib].map((h): [Sha256, number] => [h, MIB]));
    const base = { nowMs: NOW_MS, groups, objectSizes: sizes, minKeepGroups: 0 };

    const trimmed = planRetention({
      ...base,
      settings: { ...NO_RETENTION_LIMITS, maxStoreMiB: 3 },
      libraryHashes: [lib],
    });
    expect(trimmed.pruneKeys).toEqual(['seq:1']);
    expect(trimmed.sweep).toEqual([h1]);
    expect(trimmed.sizeLimitUnmet).toBe(false);

    const allGone = planRetention({
      ...base,
      settings: { ...NO_RETENTION_LIMITS, maxStoreMiB: 1 },
      libraryHashes: [lib],
    });
    expect(allGone.pruneKeys).toEqual(['seq:1', 'seq:2', 'seq:3']);
    expect(allGone.sizeLimitUnmet).toBe(false);

    const unreachable = planRetention({
      ...base,
      settings: { ...NO_RETENTION_LIMITS, maxStoreMiB: 1 },
      libraryHashes: [lib, h1],
    });
    expect(unreachable.sizeLimitUnmet).toBe(true);
    expect(unreachable.sweep).toEqual([h2, h3]);
  });
});

interface RetentionWorld {
  readonly dir: string;
  readonly store: FsObjectStore;
  readonly shared: Sha256;
  readonly assetOld: Sha256;
  readonly assetNew: Sha256;
  readonly oldRecord: Sha256;
  readonly newRecord: Sha256;
  readonly orphan: Sha256;
}

/** Rekord wersji w ksztalcie z `encodeVersionRecord`: liczy sie tylko to, co wskazuje na inne obiekty. */
const record = (assets: readonly Sha256[]): Uint8Array =>
  bytes(
    JSON.stringify({
      assets: assets.map((bytesHash, i) => ({ relPath: `a${i}`, bytesHash, sizeBytes: 1 })),
      source: { snapshots: [] },
    }),
  );

async function seedWorld(): Promise<RetentionWorld> {
  const { dir, store } = setup();
  const shared = await store.put(bytes('acme: asset wspolny'));
  const assetOld = await store.put(bytes('acme: asset starej wersji'));
  const assetNew = await store.put(bytes('acme: asset biezacej wersji'));
  const oldRecord = await store.put(record([assetOld, shared]));
  const newRecord = await store.put(record([assetNew, shared]));
  const orphan = await store.put(bytes('acme: sierota po przerwanym przebiegu'));
  return { dir, store, shared, assetOld, assetNew, oldRecord, newRecord, orphan };
}

class FakeRetentionLog implements RetentionLog {
  constructor(
    private current: RetentionLogRow[],
    private readonly trace: string[],
  ) {}

  rows(): Promise<readonly RetentionLogRow[]> {
    return Promise.resolve([...this.current]);
  }

  deleteRows(seqs: readonly number[]): Promise<number> {
    this.trace.push('log');
    this.current = this.current.filter((r) => !seqs.includes(r.seq));
    return Promise.resolve(seqs.length);
  }

  get seqs(): number[] {
    return this.current.map((r) => r.seq);
  }
}

interface ServiceOptions {
  readonly settings?: Partial<RetentionSettings>;
  readonly libraryHashes?: readonly Sha256[];
  readonly libraryUnreadable?: number;
  readonly libraryMissing?: boolean;
  /** Domyslnie podloga jest wylaczona; `true` uzywa wartosci produkcyjnej. */
  readonly productionFloor?: boolean;
  readonly failRemove?: Sha256;
  readonly manifests?: Readonly<Record<string, BackupManifestView>>;
}

function retentionService(world: RetentionWorld, rows: RetentionLogRow[], o: ServiceOptions = {}) {
  const trace: string[] = [];
  const log = new FakeRetentionLog(rows, trace);
  const audited: OperationRecord[] = [];
  const inventory = new FsObjectInventory(world.dir);
  const tracing: ObjectInventory = {
    list: () => inventory.list(),
    remove: (hash) => {
      trace.push('object');
      if (hash === o.failRemove) return Promise.reject(new Error('EBUSY'));
      return inventory.remove(hash);
    },
  };
  const service = new RetentionService({
    log,
    objects: world.store,
    inventory: tracing,
    backups: {
      readManifest: (id) => {
        const manifest = o.manifests?.[id];
        return manifest === undefined
          ? Promise.reject(Object.assign(new Error('brak kopii'), { code: 'ENOENT' }))
          : Promise.resolve(manifest);
      },
      readFile: () => Promise.reject(new Error('nie uzywane')),
    },
    library: {
      roots: () =>
        Promise.resolve({
          hashes: o.libraryHashes ?? [world.newRecord],
          unreadable: o.libraryUnreadable ?? 0,
          rootMissing: o.libraryMissing ?? false,
        }),
    },
    settings: {
      load: () => Promise.resolve({ ...NO_RETENTION_LIMITS, ...o.settings }),
      save: () => Promise.resolve(),
    },
    audit: () => ({
      append: (r) => {
        audited.push(r);
        return Promise.resolve();
      },
    }),
    clock: { now: () => new Date(NOW_MS) },
    ...(o.productionFloor === true ? {} : { minKeepGroups: 0 }),
  });
  return { service, trace, log, audited };
}

const oldRow = (w: RetentionWorld): RetentionLogRow =>
  logRow({ seq: 1, at: '2026-01-01T00:00:00.000Z', versionHashes: [w.oldRecord] });
const newRow = (w: RetentionWorld): RetentionLogRow =>
  logRow({ seq: 2, at: '2026-11-16T00:00:00.000Z', versionHashes: [w.newRecord] });

describe('RetentionService na prawdziwym content store (ADR 0056)', () => {
  it('bez limitow usuwa tylko obiekty bez odwolan, a suchy przebieg niczego nie rusza', async () => {
    const w = await seedWorld();
    const { service, trace, log } = retentionService(w, [oldRow(w), newRow(w)]);

    const preview = await service.run({ apply: false });
    expect(preview).toMatchObject({ applied: false, blocked: null, entriesRemoved: 0 });
    expect(preview.objectsRemoved).toBe(1);
    expect(preview.bytesFreed).toBe(bytes('acme: sierota po przerwanym przebiegu').length);
    expect(await w.store.has(w.orphan)).toBe(true);
    expect(trace).toEqual([]);

    const applied = await service.run({ apply: true });
    expect(applied).toMatchObject({ applied: true, entriesRemoved: 0, objectsRemoved: 1 });
    expect(await w.store.has(w.orphan)).toBe(false);
    for (const kept of [w.shared, w.assetOld, w.assetNew, w.oldRecord, w.newRecord]) {
      expect(await w.store.has(kept)).toBe(true);
    }
    expect(trace).toEqual(['object']);
    expect(log.seqs).toEqual([1, 2]);
  });

  it('przyciecie wpisu: najpierw wiersze logu, potem pliki, a obiekt wspolny z biblioteka zostaje', async () => {
    const w = await seedWorld();
    const { service, trace, log, audited } = retentionService(w, [oldRow(w), newRow(w)], {
      settings: { maxAgeDays: 30 },
    });

    const preview = await service.run({ apply: false });
    expect(preview).toMatchObject({ entriesRemoved: 1, objectsRemoved: 3, entriesBefore: 2 });
    expect(trace).toEqual([]);

    const applied = await service.run({ apply: true });
    expect(applied).toMatchObject({ entriesRemoved: 1, objectsRemoved: 3, objectsFailed: 0 });
    expect(trace).toEqual(['log', 'object', 'object', 'object']);
    expect(log.seqs).toEqual([2]);
    for (const gone of [w.oldRecord, w.assetOld, w.orphan]) {
      expect(await w.store.has(gone)).toBe(false);
    }
    for (const kept of [w.newRecord, w.assetNew, w.shared]) {
      expect(await w.store.has(kept)).toBe(true);
    }
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ operation: 'prune-history', itemId: 'retention' });
    expect(audited[0]?.note).toBe(`wpisow: 1, obiektow: 3, bajtow: ${applied.bytesFreed}`);
  });

  it('plik, ktorego nie udalo sie usunac, zostaje bez odwolan i znika w nastepnym przebiegu', async () => {
    const w = await seedWorld();
    const rows = [oldRow(w), newRow(w)];
    const first = retentionService(w, rows, {
      settings: { maxAgeDays: 30 },
      failRemove: w.assetOld,
    });

    const report = await first.service.run({ apply: true });
    expect(report.objectsFailed).toBe(1);
    expect(report.objectsRemoved).toBe(2);
    expect(await w.store.has(w.assetOld)).toBe(true);

    const remaining = rows.filter((r) => first.log.seqs.includes(r.seq));
    const second = retentionService(w, remaining, { settings: { maxAgeDays: 30 } });
    const next = await second.service.run({ apply: true });
    expect(next).toMatchObject({ entriesRemoved: 0, objectsRemoved: 1, objectsFailed: 0 });
    expect(await w.store.has(w.assetOld)).toBe(false);
  });

  it('element biblioteki, ktorego nie da sie odczytac, blokuje przebieg: nic nie jest usuwane', async () => {
    const w = await seedWorld();
    const { service, trace, log } = retentionService(w, [oldRow(w), newRow(w)], {
      settings: { maxAgeDays: 30 },
      libraryUnreadable: 1,
    });

    const report = await service.run({ apply: true });

    expect(report).toMatchObject({ applied: false, blocked: 'library-unreadable' });
    expect(report.entriesRemoved).toBe(0);
    expect(trace).toEqual([]);
    expect(log.seqs).toEqual([1, 2]);
    expect(await w.store.has(w.orphan)).toBe(true);
  });

  it('uszkodzony obiekt, z ktorego wynikaja dalsze odwolania, blokuje przebieg', async () => {
    const w = await seedWorld();
    writeFileSync(pathOf(w.dir, w.oldRecord), 'zepsuta tresc');
    const { service, trace } = retentionService(w, [oldRow(w), newRow(w)]);

    const report = await service.run({ apply: true });

    expect(report).toMatchObject({ applied: false, blocked: 'object-unreadable' });
    expect(trace).toEqual([]);
    expect(await w.store.has(w.orphan)).toBe(true);
  });

  it('kopia z MANIFEST zachowanego wpisu chroni swoj obiekt, a ostatnie cofniecie nie jest przycinane', async () => {
    const w = await seedWorld();
    const backupObject = await w.store.put(bytes('acme: plik przed zapisem do narzedzia'));
    const manifest: BackupManifestView = {
      backupId: 'b1',
      tool: 'codex',
      entries: [
        {
          rootId: 'root',
          relPath: 'AGENTS.md',
          before: { state: 'file', sha256: backupObject, backupFile: 'files/0' },
          after: { state: 'missing' },
        },
      ],
    };
    const rows = [
      logRow({ seq: 1, operation: 'export', backupId: 'b1', at: '2026-01-01T00:00:00.000Z' }),
      newRow(w),
    ];
    const { service, log } = retentionService(w, rows, {
      settings: { maxEntries: 1 },
      manifests: { b1: manifest },
    });

    const report = await service.run({ apply: true });

    expect(report.entriesRemoved).toBe(1);
    expect(log.seqs).toEqual([1]);
    expect(await w.store.has(backupObject)).toBe(true);
    expect(await w.store.has(w.orphan)).toBe(false);
  });

  it('po przycieciu wpisu jego kopia z MANIFEST przestaje chronic obiekt', async () => {
    const w = await seedWorld();
    const backupObject = await w.store.put(bytes('acme: plik sprzed starego zapisu'));
    const manifest: BackupManifestView = {
      backupId: 'b1',
      tool: 'codex',
      entries: [
        {
          rootId: 'root',
          relPath: 'AGENTS.md',
          before: { state: 'file', sha256: backupObject, backupFile: 'files/0' },
          after: { state: 'missing' },
        },
      ],
    };
    const rows = [
      logRow({ seq: 1, operation: 'export', backupId: 'b1', at: '2026-01-01T00:00:00.000Z' }),
      logRow({ seq: 2, operation: 'export', backupId: 'b2', at: '2026-11-16T00:00:00.000Z' }),
    ];
    const { service } = retentionService(w, rows, {
      settings: { maxEntries: 1 },
      manifests: { b1: manifest },
    });

    const report = await service.run({ apply: true });

    expect(report.entriesRemoved).toBe(1);
    expect(await w.store.has(backupObject)).toBe(false);
  });
});

describe('podloga, zegar i bezpieczniki przebiegu (ADR 0056)', () => {
  it('plan: najnowsze grupy zostaja bez wzgledu na limit liczby wpisow', () => {
    const rows = Array.from({ length: 12 }, (_, i) => logRow({ seq: i + 1 }));
    const plan = planRetention({
      settings: { ...NO_RETENTION_LIMITS, maxEntries: 1 },
      nowMs: NOW_MS,
      minKeepGroups: 10,
      groups: groupsOf(rows),
      libraryHashes: [],
      objectSizes: new Map(),
    });
    expect(plan.pruneKeys).toEqual(['seq:1', 'seq:2']);
  });

  it('serwis uzywa podlogi 10 grup, gdy nie podano innej', async () => {
    const w = await seedWorld();
    const rows = Array.from({ length: 11 }, (_, i) =>
      logRow({ seq: i + 1, at: '2026-01-01T00:00:00.000Z' }),
    );
    const { service, log } = retentionService(w, rows, {
      settings: { maxAgeDays: 30 },
      productionFloor: true,
    });

    const report = await service.run({ apply: true });

    expect(report.entriesRemoved).toBe(1);
    expect(log.seqs).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('zegar sprzed najnowszego wpisu wylacza limit wieku', async () => {
    const w = await seedWorld();
    const future = logRow({ seq: 2, at: '2027-06-01T00:00:00.000Z', versionHashes: [w.newRecord] });
    const { service, log } = retentionService(w, [oldRow(w), future], {
      settings: { maxAgeDays: 30 },
    });

    const report = await service.run({ apply: true });

    expect(report).toMatchObject({ ageRuleSkipped: true, entriesRemoved: 0 });
    expect(log.seqs).toEqual([1, 2]);
  });

  it('przebieg bez nadzoru na pustym logu nie czysci store, a reczny przebieg tak', async () => {
    const w = await seedWorld();
    const { service } = retentionService(w, []);

    const unattended = await service.run({ apply: true, unattended: true });
    expect(unattended).toMatchObject({ applied: false, blocked: 'empty-log' });
    expect(await w.store.has(w.orphan)).toBe(true);

    const manual = await service.run({ apply: true });
    expect(manual.blocked).toBeNull();
    expect(await w.store.has(w.orphan)).toBe(false);
  });

  it('przebieg bez nadzoru odmawia usuniecia ponad 90% wpisow', async () => {
    const w = await seedWorld();
    const rows = [1, 2, 3].map((seq) => logRow({ seq, at: '2026-01-01T00:00:00.000Z' }));
    const { service, log } = retentionService(w, rows, { settings: { maxAgeDays: 30 } });

    const unattended = await service.run({ apply: true, unattended: true });
    expect(unattended).toMatchObject({ applied: false, blocked: 'mass-prune' });
    expect(log.seqs).toEqual([1, 2, 3]);

    expect((await service.run({ apply: true })).entriesRemoved).toBe(3);
  });

  it('wykonanie z pulapem przerywa sie, gdy plan usuwa wiecej, niz pokazal podglad', async () => {
    const w = await seedWorld();
    const { service, trace } = retentionService(w, [oldRow(w), newRow(w)], {
      settings: { maxAgeDays: 30 },
    });

    const aborted = await service.run({ apply: true, ceiling: { entries: 0, objects: 3 } });
    expect(aborted).toMatchObject({ applied: false, blocked: 'plan-changed' });
    expect(trace).toEqual([]);

    const allowed = await service.run({ apply: true, ceiling: { entries: 1, objects: 3 } });
    expect(allowed).toMatchObject({ applied: true, entriesRemoved: 1 });
  });

  it('podglad z innymi limitami niz zapisane liczy na podanych', async () => {
    const w = await seedWorld();
    const { service } = retentionService(w, [oldRow(w), newRow(w)]);

    const report = await service.run({
      apply: false,
      settings: { ...NO_RETENTION_LIMITS, maxAgeDays: 30 },
    });

    expect(report.entriesRemoved).toBe(1);
  });
});

describe('fail closed: brakujace i nieczytelne korzenie (ADR 0056)', () => {
  it('brak katalogu kopii (ENOENT) nie blokuje, inny blad odczytu MANIFEST blokuje', async () => {
    const w = await seedWorld();
    const rows = [logRow({ seq: 1, operation: 'export', backupId: 'b1' }), newRow(w)];
    const make = (error: Error) =>
      new RetentionService({
        log: new FakeRetentionLog(rows, []),
        objects: w.store,
        inventory: new FsObjectInventory(w.dir),
        backups: {
          readManifest: () => Promise.reject(error),
          readFile: () => Promise.reject(new Error('nie uzywane')),
        },
        library: {
          roots: () =>
            Promise.resolve({ hashes: [w.newRecord], unreadable: 0, rootMissing: false }),
        },
        settings: {
          load: () => Promise.resolve(NO_RETENTION_LIMITS),
          save: () => Promise.resolve(),
        },
        audit: () => null,
        clock: { now: () => new Date(NOW_MS) },
        minKeepGroups: 0,
      });

    const missing = await make(Object.assign(new Error('brak'), { code: 'ENOENT' })).run({
      apply: false,
    });
    expect(missing.blocked).toBeNull();

    const denied = await make(Object.assign(new Error('brak praw'), { code: 'EACCES' })).run({
      apply: false,
    });
    expect(denied.blocked).toBe('object-unreadable');
    const broken = await make(new SyntaxError('zly JSON')).run({ apply: false });
    expect(broken.blocked).toBe('object-unreadable');
  });

  it('korzen zachowanego wpisu, ktorego nie ma w store, blokuje; w przycietym wpisie nie', async () => {
    const w = await seedWorld();
    const ghost = hashOf('9');
    const ghostRow = logRow({
      seq: 1,
      at: '2026-01-01T00:00:00.000Z',
      versionHashes: [ghost],
    });

    const retained = retentionService(w, [ghostRow, newRow(w)]);
    expect((await retained.service.run({ apply: true })).blocked).toBe('object-unreadable');
    expect(await w.store.has(w.orphan)).toBe(true);

    const pruned = retentionService(w, [ghostRow, newRow(w)], { settings: { maxAgeDays: 30 } });
    const report = await pruned.service.run({ apply: true });
    expect(report.blocked).toBeNull();
    expect(report.entriesRemoved).toBe(1);
  });

  it('korzen elementu biblioteki, ktorego nie ma w store, blokuje przebieg', async () => {
    const w = await seedWorld();
    const { service } = retentionService(w, [newRow(w)], { libraryHashes: [hashOf('8')] });
    expect((await service.run({ apply: true })).blocked).toBe('object-unreadable');
  });

  it('brak katalogu biblioteki i pusta biblioteka przy niepustym logu i store blokuja', async () => {
    const w = await seedWorld();
    const missing = retentionService(w, [newRow(w)], { libraryMissing: true });
    expect((await missing.service.run({ apply: true })).blocked).toBe('library-missing');

    const empty = retentionService(w, [newRow(w)], { libraryHashes: [] });
    expect((await empty.service.run({ apply: true })).blocked).toBe('library-empty');
    expect(await w.store.has(w.orphan)).toBe(true);

    const noLog = retentionService(w, [], { libraryHashes: [] });
    expect((await noLog.service.run({ apply: false })).blocked).toBeNull();
  });
});
