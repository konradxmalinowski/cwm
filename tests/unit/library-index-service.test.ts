import { describe, expect, it } from 'vitest';

import { createUlidGenerator } from '../../src/core/ports/id-generator';
import { LibraryService } from '../../src/core/services/library/library-service';
import {
  FakeClock,
  MemoryLibraryStore,
  MemoryObjectStore,
  MemoryOperationLog,
  deterministicRandom,
  draft,
} from './library-fakes';
import { FakeIndex } from './library-index-fakes';

function setup(options: { index?: FakeIndex | null } = {}) {
  const timeline: string[] = [];
  const store = new MemoryLibraryStore();
  const originalWrite = store.write.bind(store);
  store.write = (id, files) => {
    timeline.push('files:write');
    return originalWrite(id, files);
  };
  const index = options.index === undefined ? new FakeIndex(timeline) : options.index;
  const clock = new FakeClock();
  const service = new LibraryService({
    store,
    objects: new MemoryObjectStore(),
    log: new MemoryOperationLog(),
    ids: createUlidGenerator(clock, deterministicRandom()),
    clock,
    index: () => index,
  });
  return { service, store, index, timeline };
}

describe('LibraryService i indeks biblioteki (ADR 0014)', () => {
  it('najpierw pliki, potem indeks', async () => {
    const { service, timeline } = setup();
    await service.create(draft({ slug: 'acme-a' }));
    expect(timeline).toEqual(['files:write', 'index:upsert']);
  });

  it('update podmienia wpis, usuniecie go kasuje', async () => {
    const { service, index } = setup();
    const created = await service.create(draft({ slug: 'acme-a' }));
    const updated = await service.update(
      created.item.id,
      draft({ slug: 'acme-a', body: 'nowa tresc\n' }),
    );
    expect(index!.entries.get(created.item.id)?.body).toBe('nowa tresc\n');
    expect(index!.entries.get(created.item.id)?.revision).toBe(updated.item.version.revision);

    const plan = await service.planDelete(created.item.id);
    await service.applyDelete(plan);
    expect(index!.entries.size).toBe(0);
  });

  it('wpis ma klucz kolizji z ADR 0017', async () => {
    const { service, index } = setup();
    const created = await service.create(draft({ slug: 'Acme-Mix' }));
    expect(index!.entries.get(created.item.id)?.slugKey).toBe('acme-mix');
  });

  it('awaria indeksu po zapisie plikow nie cofa zapisu i daje ostrzezenie', async () => {
    const { service, store, index } = setup();
    index!.failUpsert = true;

    const result = await service.create(draft({ slug: 'acme-a' }));

    expect(store.items.has(result.item.id)).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('index-update-failed');
    expect((await service.list()).items).toHaveLength(1);
  });

  it('po awarii indeksu slugi i wyszukiwanie wracaja do plikow', async () => {
    const { service, store, index } = setup();
    await service.syncIndex({ force: true });
    expect(service.search('acme')).not.toBeNull();

    index!.failUpsert = true;
    await service.create(draft({ slug: 'acme-a' }));
    expect(service.search('acme')).toBeNull();

    const before = store.readItemJsonCalls;
    await expect(service.create(draft({ slug: 'ACME-A' }))).rejects.toMatchObject({
      reason: 'slug-collision',
    });
    expect(store.readItemJsonCalls).toBeGreaterThan(before);
  });

  it('gdy indeks jest gotowy, slugi nie czytaja item.json', async () => {
    const { service, store } = setup();
    await service.create(draft({ slug: 'acme-a' }));
    await service.syncIndex({ force: true });
    store.readItemJsonCalls = 0;

    await service.create(draft({ slug: 'acme-b' }));
    await expect(service.create(draft({ slug: 'ACME-A' }))).rejects.toMatchObject({
      reason: 'slug-collision',
    });

    expect(store.readItemJsonCalls).toBe(0);
  });

  it('indeks jeszcze niewypelniony nie jest zrodlem slugow ani wyszukiwania', async () => {
    const { service, store } = setup();
    expect(service.search('acme')).toBeNull();
    await service.create(draft({ slug: 'acme-a' }));
    store.readItemJsonCalls = 0;
    await expect(service.create(draft({ slug: 'acme-a' }))).rejects.toMatchObject({
      reason: 'slug-collision',
    });
    expect(store.readItemJsonCalls).toBeGreaterThan(0);
  });

  it('wyjatek z indeksu przy czytaniu slugow wraca do plikow', async () => {
    const { service, index } = setup();
    await service.create(draft({ slug: 'acme-a' }));
    await service.syncIndex({ force: true });
    index!.failSlugs = true;
    await expect(service.create(draft({ slug: 'acme-a' }))).rejects.toMatchObject({
      reason: 'slug-collision',
    });
    expect(service.search('acme')).toBeNull();
  });

  it('bez indeksu serwis pracuje na plikach', async () => {
    const { service } = setup({ index: null });
    const created = await service.create(draft({ slug: 'acme-a' }));
    expect(created.warnings.map((w) => w.code)).not.toContain('index-update-failed');
    expect(service.search('acme')).toBeNull();
    expect((await service.syncIndex()).status).toBe('unavailable');
  });

  describe('syncIndex', () => {
    it('nie rusza indeksu, gdy liczba elementow sie zgadza', async () => {
      const { service, index } = setup();
      await service.create(draft({ slug: 'acme-a' }));
      await service.create(draft({ slug: 'acme-b' }));

      const report = await service.syncIndex();

      expect(report.status).toBe('current');
      expect(index!.calls).not.toContain('replaceAll');
      expect(service.search('x')).not.toBeNull();
    });

    it('wypelnia z plikow, gdy liczba sie rozjezdza, i zwraca prawdziwa liczbe', async () => {
      const { service, index } = setup();
      await service.create(draft({ slug: 'acme-a' }));
      await service.create(draft({ slug: 'acme-b' }));
      index!.entries.clear();

      const report = await service.syncIndex();

      expect(report).toMatchObject({ status: 'rebuilt', restored: 2, failed: [] });
      expect(index!.entries.size).toBe(2);
    });

    it('force wypelnia mimo zgodnej liczby', async () => {
      const { service, index } = setup();
      await service.create(draft({ slug: 'acme-a' }));
      const report = await service.syncIndex({ force: true });
      expect(report.status).toBe('rebuilt');
      expect(index!.calls).toContain('replaceAll');
    });

    it('elementy, ktorych nie da sie wczytac, trafiaja do failed z powodem, a reszta jest w indeksie', async () => {
      const { service, store, index } = setup();
      const good = await service.create(draft({ slug: 'acme-good' }));
      const broken = await service.create(draft({ slug: 'acme-broken' }));
      const files = store.items.get(broken.item.id)!;
      store.items.set(broken.item.id, {
        ...files,
        itemJson: new TextEncoder().encode('{nie json'),
      });
      store.items.set('nie-ulid', files);

      const report = await service.syncIndex({ force: true });

      expect(report.restored).toBe(1);
      expect(index!.entries.has(good.item.id)).toBe(true);
      expect(report.failed.map((f) => f.id).sort()).toEqual([broken.item.id, 'nie-ulid'].sort());
      expect(report.failed.every((f) => f.reason.length > 0)).toBe(true);
    });

    it('element niespojny jest w indeksie po nazwie, ale liczony jako niewczytany', async () => {
      const { service, store, index } = setup();
      const created = await service.create(draft({ slug: 'acme-a' }));
      const files = store.items.get(created.item.id)!;
      store.items.set(created.item.id, { ...files, body: new TextEncoder().encode('zmienione\n') });

      const report = await service.syncIndex({ force: true });

      expect(report.restored).toBe(0);
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0]?.reason).toMatch(/nie zgadzaja/);
      expect(index!.slugs().map((s) => s.slug)).toEqual(['acme-a']);
    });

    it('wyjatek z indeksu odbiera mu zaufanie', async () => {
      const { service, index } = setup();
      await service.syncIndex({ force: true });
      expect(service.search('x')).not.toBeNull();
      index!.replaceAll = () => {
        throw new Error('dysk pelny');
      };
      await expect(service.syncIndex({ force: true })).rejects.toThrow(/dysk pelny/);
      expect(service.search('x')).toBeNull();
    });

    it('prepare idzie w kolejce zapisow, przed wypelnieniem, i odbiera zaufanie na czas wymiany', async () => {
      const { service, index } = setup();
      await service.syncIndex({ force: true });
      const order: string[] = [];

      const pending = service.syncIndex({
        force: true,
        prepare: () => {
          order.push(`prepare:trusted=${service.search('x') !== null}`);
        },
      });
      const write = service.create(draft({ slug: 'acme-after' })).then(() => order.push('create'));
      await Promise.all([pending, write]);

      expect(order).toEqual(['prepare:trusted=false', 'create']);
      expect(index!.entries.size).toBe(1);
    });
  });
});
