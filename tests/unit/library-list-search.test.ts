import { describe, expect, it } from 'vitest';

import { createUlidGenerator } from '../../src/core/ports/id-generator';
import { LibraryService } from '../../src/core/services/library/library-service';
import { registerLibraryHandlers } from '../../src/main/ipc/handlers/library';
import { IpcRegistry } from '../../src/main/ipc/registry';
import type { LibraryListDto, Result } from '../../src/shared/ipc/library-contract';
import {
  FakeClock,
  MemoryLibraryStore,
  MemoryObjectStore,
  MemoryOperationLog,
  deterministicRandom,
  draft,
} from './library-fakes';
import { FakeIndex } from './library-index-fakes';

async function setup() {
  const index = new FakeIndex();
  const clock = new FakeClock();
  const service = new LibraryService({
    store: new MemoryLibraryStore(),
    objects: new MemoryObjectStore(),
    log: new MemoryOperationLog(),
    ids: createUlidGenerator(clock, deterministicRandom()),
    clock,
    index: () => index,
  });
  const alfa = await service.create(
    draft({
      slug: 'acme-alfa',
      content: {
        title: 'Alfa',
        description: 'pierwszy',
        descriptionOrigin: 'source',
        body: 'zawiera srodek-slowa\n',
      },
    }),
  );
  const beta = await service.create(
    draft({
      slug: 'acme-beta',
      content: { title: 'Beta', description: 'drugi', descriptionOrigin: 'source', body: 'x\n' },
    }),
  );

  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const registry = new IpcRegistry({
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  });
  registerLibraryHandlers(registry, { service: () => service });
  const list = async (payload: unknown) =>
    (await handlers.get('library:list')?.({}, payload)) as Result<LibraryListDto>;
  return { index, service, alfa, beta, list };
}

describe('library:list z zapytaniem', () => {
  it('uzywa wynikow indeksu, gdy jest gotowy', async () => {
    const t = await setup();
    await t.service.syncIndex({ force: true });
    t.index.searchResult = [t.beta.item.id];

    const result = await t.list({ query: 'cokolwiek' });

    expect(result.ok && result.value.items.map((i) => i.slug)).toEqual(['acme-beta']);
    expect(t.index.calls).toContain('search');
  });

  it('bez indeksu zostaje filtr podlancucha po plikach (tryb awaryjny)', async () => {
    const t = await setup();
    // Indeks nie byl wypelniany, wiec nie jest zaufany.
    const result = await t.list({ query: 'srodek' });
    expect(result.ok && result.value.items.map((i) => i.slug)).toEqual(['acme-alfa']);
    expect(t.index.calls).not.toContain('search');
  });

  it('zapytanie bez slow (null z indeksu) wraca do filtra po plikach', async () => {
    const t = await setup();
    await t.service.syncIndex({ force: true });
    t.index.searchResult = null;
    const result = await t.list({ query: 'acme-be' });
    expect(result.ok && result.value.items.map((i) => i.slug)).toEqual(['acme-beta']);
  });

  it('puste zapytanie nie pyta indeksu i zwraca wszystko', async () => {
    const t = await setup();
    await t.service.syncIndex({ force: true });
    t.index.calls.length = 0;
    const result = await t.list({ query: '   ' });
    expect(result.ok && result.value.items).toHaveLength(2);
    expect(t.index.calls).not.toContain('search');
  });

  it('awaria wyszukiwania w indeksie nie psuje listy', async () => {
    const t = await setup();
    await t.service.syncIndex({ force: true });
    t.index.failSearch = true;
    const result = await t.list({ query: 'srodek' });
    expect(result.ok && result.value.items.map((i) => i.slug)).toEqual(['acme-alfa']);
  });
});
